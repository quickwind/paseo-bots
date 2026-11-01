import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnTimeline } from "../server/turn-timeline";
import { newUuid } from "../shared/uuid";
import { fakeHost, makeBot } from "./helpers";

const user = (text: string) => ({ type: "user_message", text });
const bot = (text: string) => ({ type: "assistant_message", text });
const tool = (name: string) => ({ type: "tool_call", name, callId: name, status: "completed", detail: { type: "unknown", input: null, output: null }, error: null });

/** A chat of `items` (oldest first) that serves pages the way the daemon does: the tail first, then what is before a cursor. */
function chatOf(items: unknown[], pageSize: number) {
  const calls: unknown[] = [];
  const paseo = {
    agents: {
      ref: () => ({
        timeline: {
          refetch: async (options: { direction?: string; cursor?: { seq: number }; limit?: number } = {}) => {
            calls.push(options);
            const end = options.direction === "before" ? options.cursor!.seq : items.length;
            const start = Math.max(0, end - (options.limit ?? pageSize));
            const slice = items.slice(start, end).map((item, index) => ({ item, timestamp: "2026-10-31T10:00:00.000Z", seq: start + index }));
            return { entries: slice, hasOlder: start > 0, startCursor: start > 0 ? { seq: start } : null, error: null };
          },
        },
      }),
    },
  };
  return { paseo: paseo as never, calls };
}

describe("the timeline of a turn that ended (Paseo 0.13 and later send it empty)", () => {
  it("is what the event carried, when it carried something", async () => {
    const { paseo, calls } = chatOf([user("old")], 10);
    expect(await turnTimeline(paseo, "a", [user("given")] as never)).toEqual([user("given")]);
    expect(calls).toEqual([]);
  });

  it("is read from the chat when the event's is empty, oldest first", async () => {
    const { paseo } = chatOf([user("hi"), tool("Read"), bot("done")], 50);
    expect(await turnTimeline(paseo, "a", [])).toEqual([user("hi"), tool("Read"), bot("done")]);
  });

  it("goes back page by page until two messages of the user are in, so a long turn is whole", async () => {
    const items = [user("first"), bot("ok"), user("second"), ...Array.from({ length: 12 }, (_, n) => tool(`t${n}`)), bot("all done")];
    const { paseo, calls } = chatOf(items, 5);
    const got = (await turnTimeline(paseo, "a", [], 5)) as { type: string }[];
    expect(got.map((item) => item.type).filter((type) => type === "user_message")).toHaveLength(2);
    expect(got.at(-1)).toEqual(bot("all done"));
    expect(got.at(0)).toEqual(user("first"));
    expect(calls.length).toBeGreaterThan(1);
  });

  it("stops at the start of the chat", async () => {
    const { paseo, calls } = chatOf([user("only"), bot("hi")], 1);
    expect(await turnTimeline(paseo, "a", [], 1)).toEqual([user("only"), bot("hi")]);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("is empty, and does not throw, when the chat cannot be read or there is no Paseo", async () => {
    const failing = { agents: { ref: () => ({ timeline: { refetch: async () => { throw new Error("daemon busy"); } } }) } } as never;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await turnTimeline(failing, "a", [])).toEqual([]);
    expect(await turnTimeline(null, "a", [])).toEqual([]);
    const refused = { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries: [], hasOlder: false, startCursor: null, error: "no such chat" }) } }) } } as never;
    expect(await turnTimeline(refused, "a", [])).toEqual([]);
    spy.mockRestore();
  });
});

describe("a turn that ends with an empty timeline is still logged and reported", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-turntimeline-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("reads the reply and the tools from the chat", async () => {
    const { turnEnded } = await import("../server/activity");
    const { MemoryJournal } = await import("../server/journal");
    const { recentLogEntries } = await import("../server/memory");
    const host = fakeHost([makeBot({ id: "bot-e", name: "Scout" })]);
    host.chatOf = async () => ({ botId: "bot-e", title: "Invoices", routineId: null, labels: {} });
    const { paseo } = chatOf([user("Send the Q3 invoices"), tool("mcp__apps__GMAIL_SEND"), bot("Sent the three Q3 invoices to Acme.")], 50);
    (host as unknown as { attach(api: unknown): void }).attach(paseo);
    const agent = { id: newUuid(), workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/", title: null };
    await turnEnded(host, new MemoryJournal(), { finished: async () => {} }, { agent, turnId: "t", outcome: { kind: "completed" }, timeline: [] } as never);
    const [entry] = await recentLogEntries("bot-e", 1);
    expect(entry).toMatchObject({ chat: "Invoices", text: expect.stringContaining("Sent the three Q3 invoices to Acme.") });
    expect(entry!.text).toContain("apps/GMAIL_SEND");
  });
});
