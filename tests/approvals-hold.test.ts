import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApproval, resolveApproval, takeHeld } from "../server/approvals-store";
import { botDataPath } from "../server/bot-home";
import { FileTools } from "../server/file-tools";
import { SaveTracker } from "../server/maintenance";
import { DEFAULT_BOT_MEMORY } from "../shared/memory-maintenance";
import { fakeHost, makeBot } from "./helpers";

// While a chat waits for an approval, nothing the plugin would send into it goes out: it is held.

const waiting = (agentId: string) => createApproval({ botId: "scout", botName: "Scout", agentId, chatTitle: "t", teamId: null, project: null, workspace: null, title: "T", text: "x", file: null });

describe("what the plugin sends into a waiting chat", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-hold-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("holds the memory save request, and asks again after the decision", async () => {
    const { askToSave } = await import("../server/activity");
    const bot = makeBot({ id: "scout", name: "Scout", memory: { ...DEFAULT_BOT_MEMORY, saveAt: { enabled: true, percent: 70 } } });
    const host = fakeHost([bot]);
    const sent: string[] = [];
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", lastUsage: { contextWindowUsedTokens: 90, contextWindowMaxTokens: 100 } } }), send: async (text: string) => void sent.push(text) }) } } as never);
    const maintenance = { activity: null as never, saves: new SaveTracker(), tidy: null };
    const approval = await waiting("chat-1");
    await askToSave(host, maintenance, "scout", "chat-1");
    expect(sent).toEqual([]);
    expect(await takeHeld("chat-1")).toEqual([]);
    await resolveApproval(approval.id, { status: "approved", note: "", decidedBy: "user" });
    await askToSave(host, maintenance, "scout", "chat-1");
    expect(sent).toHaveLength(1);
  });

  it("holds a notice about a file that was not accepted", async () => {
    const bot = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const host = fakeHost([bot]);
    const sent: string[] = [];
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, title: "Chat", cwd: "/x" } }), timeline: { append: async () => {}, refetch: async () => ({ entries: [] }) }, send: async (text: string) => void sent.push(text) }) } } as never);
    const dir = join(botDataPath("scout"), "proposals");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bad-1.json"), "nope");
    await waiting("chat-1");
    const files = new FileTools(host, null as never, null, null);
    await files.afterTurn({ bot, agentId: "chat-1", timeline: [{ type: "tool_call", detail: { type: "edit", filePath: "Wrote ./proposals/bad-1.json" } }] });
    expect(sent).toEqual([]);
    expect((await takeHeld("chat-1"))[0]).toContain("bad-1.json");
  });
});
