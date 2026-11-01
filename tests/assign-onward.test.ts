import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASK_REQUEST_LABEL, Asks } from "../server/asks";
import { allowProject } from "../server/project-grants";
import { ASSIGN_DEPTH_LABEL, ASKED_BY_LABEL, askBot, assignBot, MAX_ASSIGN_DEPTH } from "../server/tools/bots";
import { EMPTY_LIBRARY } from "../shared/bot";
import { fakeHost, makeBot } from "./helpers";

// A chat started by an assignment may assign onward (architect to designer to developer), to a limited depth; it still may not ask.

describe("assigning onward from an assigned chat", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-onward-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup() {
    const scout = makeBot({ id: "scout", name: "Scout", provider: "claude", contactBots: "allow" });
    const mate = makeBot({ id: "mate", name: "Mate", provider: "claude" });
    const host = fakeHost([scout, mate], EMPTY_LIBRARY, []);
    const entries = [{ id: "wks_1", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-login", name: "login", title: "Login", archivingAt: null }];
    host.attach({ workspaces: { list: async () => ({ entries }) }, agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, workspaceId: "wks_1" } }), send: async () => {} }) } } as never);
    const asks = new Asks(host, null as never);
    const started: { bot: string; labels: Record<string, string>; workspace?: { id: string; path: string } }[] = [];
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_h, _r, bot, input) => {
      const given = input as { labels: Record<string, string>; agentId: string; workspace?: { id: string; path: string } };
      started.push({ bot: (bot as { id: string }).id, labels: given.labels, workspace: given.workspace });
      return given.agentId;
    };
    await allowProject("bot:scout", { id: "p1", name: "app" });
    return { scout, mate, host, asks, started };
  }
  const assigned = (depth: number) => ({ [ASKED_BY_LABEL]: "chief", [ASK_REQUEST_LABEL]: "r-0000", [ASSIGN_DEPTH_LABEL]: String(depth) });

  it("starts the next chat one level deeper, in the workspace the assigning chat runs in", async () => {
    const { scout, asks, started } = await setup();
    const result = await asks.request({ bot: scout, agentId: "scout-chat", labels: assigned(1) }, { to: "Mate", message: "Design it", assign: true });
    expect(result.ok).toBe(true);
    expect(started).toHaveLength(1);
    expect(started[0]!.bot).toBe("mate");
    expect(started[0]!.labels[ASSIGN_DEPTH_LABEL]).toBe("2");
    expect(started[0]!.labels[ASKED_BY_LABEL]).toBe("scout");
    expect(started[0]!.workspace).toEqual({ id: "wks_1", path: "/work/app-login" });
  });

  it("starts a first-level assignment at depth 1", async () => {
    const { scout, asks, started } = await setup();
    await asks.request({ bot: scout, agentId: "lead-chat", labels: {} }, { to: "Mate", message: "Do it", assign: true });
    expect(started[0]!.labels[ASSIGN_DEPTH_LABEL]).toBe("1");
  });

  it("refuses at the depth limit, and says so", async () => {
    const { scout, asks, started } = await setup();
    const result = await asks.request({ bot: scout, agentId: "scout-chat", labels: assigned(MAX_ASSIGN_DEPTH) }, { to: "Mate", message: "Too deep", assign: true });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/depth|too many/i);
    expect(started).toEqual([]);
  });

  it("still refuses a question from an assigned chat, and an assignment from a chat that only answers a question", async () => {
    const { scout, asks, started } = await setup();
    const ask = await asks.request({ bot: scout, agentId: "scout-chat", labels: assigned(1) }, { to: "Mate", message: "A question?" });
    expect(ask).toMatchObject({ ok: false, text: expect.stringMatching(/can't ask/) });
    const loop = await asks.request({ bot: scout, agentId: "scout-chat", labels: { [ASKED_BY_LABEL]: "chief", [ASK_REQUEST_LABEL]: "r-1111" } }, { to: "Mate", message: "Hand on", assign: true });
    expect(loop).toMatchObject({ ok: false, text: expect.stringMatching(/can't assign/) });
    expect(started).toEqual([]);
  });

  it("offers assign_bot to an assigned chat and ask_bot only to a chat that was not started by a bot", async () => {
    const { scout, host } = await setup();
    const caller = (labels: Record<string, string>) => {
      const h = fakeHost([scout], EMPTY_LIBRARY, []);
      h.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: { "aydo.bot": "scout", ...labels } } }) }) } } as never);
      return { bot: scout, agentId: "c", host: h, relay: null as never };
    };
    void host;
    expect(await assignBot.available!(caller(assigned(1)))).toBe(true);
    expect(await askBot.available!(caller(assigned(1)))).toBe(false);
    expect(await assignBot.available!(caller({ [ASKED_BY_LABEL]: "chief", [ASK_REQUEST_LABEL]: "r-2222" }))).toBe(false);
    expect(await assignBot.available!(caller({}))).toBe(true);
    expect(await assignBot.available!(caller({ "aydo.tidy": "scout" }))).toBe(false);
  });
});
