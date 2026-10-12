import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASK_REQUEST_LABEL, Asks } from "../server/asks";
import { getProposal } from "../server/proposals";
import { fakeHost, makeBot } from "./helpers";

describe("asking another bot through a file", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-asks-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(asker: Partial<ReturnType<typeof makeBot>> = {}, others: ReturnType<typeof makeBot>[] = []) {
    const chief = makeBot({ id: "chief", name: "Chief", provider: "devin", contactBots: "allow", ...asker });
    const scout = makeBot({ id: "scout", name: "Scout", provider: "claude" });
    const host = fakeHost([chief, scout, ...others]);
    const sent: { agentId: string; text: string }[] = [];
    const status: Record<string, string> = {};
    host.attach({ agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { status: status[agentId] ?? "idle", labels: {} } }), send: async (text: string) => void sent.push({ agentId, text }) }) } } as never);
    const asks = new Asks(host, null as never);
    const started: { bot: string; prompt: string; labels: Record<string, string> }[] = [];
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_host, _relay, bot, input) => {
      const given = input as { prompt: string; labels: Record<string, string> };
      started.push({ bot: (bot as { id: string }).id, prompt: given.prompt, labels: given.labels });
      return `target-${started.length}`;
    };
    const from = { bot: chief, agentId: "asker-chat", labels: {} as Record<string, string> };
    return { chief, scout, host, asks, sent, status, started, from };
  }
  const labelsOf = (started: { labels: Record<string, string> }) => started.labels[ASK_REQUEST_LABEL]!;

  it("refuses when the bot may not contact others, when it was itself asked, and for a target that is not there", async () => {
    const off = await setup({ contactBots: "off" });
    expect(await off.asks.request(off.from, { to: "Scout", message: "hi" })).toMatchObject({ ok: false, text: expect.stringContaining("not allowed") });
    const loop = await setup();
    expect(await loop.asks.request({ ...loop.from, labels: { "paseo-bots.asked-by": "scout" } }, { to: "Scout", message: "hi" })).toMatchObject({ ok: false, text: expect.stringContaining("asked by another bot") });
    const missing = await setup({}, [makeBot({ id: "old", name: "Old", archived: true })]);
    expect((await missing.asks.request(missing.from, { to: "Old", message: "hi" })).text).toContain("Ask one of: Scout");
    expect((await missing.asks.request(missing.from, { to: "Chief", message: "hi" })).ok).toBe(false);
    expect(missing.started).toEqual([]);
  });

  it("starts the other bot's chat at once when the bot may ask freely, framed as another bot's message", async () => {
    const { asks, started, from } = await setup();
    const result = await asks.request(from, { to: "scout", message: "How many unread mails?" });
    expect(result).toMatchObject({ ok: true, proposalId: null });
    expect(started).toHaveLength(1);
    expect(started[0]!.bot).toBe("scout");
    expect(started[0]!.prompt).toContain("not from your user");
    expect(started[0]!.prompt).toContain("How many unread mails?");
    expect(started[0]!.labels["paseo-bots.asked-by"]).toBe("chief");
    expect(result.text).toContain("answer");
  });

  it("waits for the user's approval when the setting is ask, runs nothing, then runs it when approved", async () => {
    const { asks, started, from } = await setup({ contactBots: "ask" });
    const result = await asks.request(from, { to: "Scout", message: "Check the invoices" });
    expect(result.ok).toBe(true);
    expect(result.proposalId).toMatch(/^p-/);
    expect(started).toEqual([]);
    const proposal = (await getProposal(result.proposalId!))!;
    expect(proposal).toMatchObject({ kind: "ask", status: "pending", agentId: "asker-chat", botId: "chief", data: { toBotId: "scout", toName: "Scout", message: "Check the invoices" } });
    await asks.approved(proposal as never);
    expect(started).toHaveLength(1);
    expect(started[0]!.bot).toBe("scout");
  });

  it("tells the asking chat when the user said no", async () => {
    const { asks, sent, started, from } = await setup({ contactBots: "ask" });
    const proposal = (await getProposal((await asks.request(from, { to: "Scout", message: "Check the invoices" })).proposalId!))!;
    await asks.refused(proposal as never);
    expect(started).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "asker-chat" });
    expect(sent[0]!.text).toContain("did not allow");
  });

  it("sends the other bot's answer into the asking chat, once, framed as information", async () => {
    const { asks, sent, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    const labels = { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) };
    await asks.answered({ agentId: "target-1", labels, outcome: { kind: "completed" }, reply: "Three unread, one urgent." });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("asker-chat");
    expect(sent[0]!.text).toContain("Three unread, one urgent.");
    expect(sent[0]!.text).toContain("Scout");
    expect(sent[0]!.text).toMatch(/not the user|not from the user/i);
    await asks.answered({ agentId: "target-1", labels, outcome: { kind: "completed" }, reply: "later chatter" });
    expect(sent).toHaveLength(1);
  });

  it("keeps the answer for an asking chat that is busy, and delivers it after that chat's next turn", async () => {
    const { asks, sent, status, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    status["asker-chat"] = "running";
    await asks.answered({ agentId: "target-1", labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "Three." });
    expect(sent).toEqual([]);
    await asks.deliver("asker-chat");
    expect(sent).toEqual([]);
    status["asker-chat"] = "idle";
    await asks.deliver("asker-chat");
    expect(sent).toHaveLength(1);
    await asks.deliver("asker-chat");
    expect(sent).toHaveLength(1);
  });

  it("says so when the other bot could not answer", async () => {
    const { asks, sent, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    await asks.answered({ agentId: "target-1", labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "failed", error: { message: "not signed in" } }, reply: "" });
    expect(sent[0]!.text).toContain("could not answer");
    expect(sent[0]!.text).toContain("not signed in");
  });

  it("ignores the end of a chat that is not an answer to a request", async () => {
    const { asks, sent } = await setup();
    await asks.answered({ agentId: "other", labels: {}, outcome: { kind: "completed" }, reply: "x" });
    await asks.answered({ agentId: "other", labels: { [ASK_REQUEST_LABEL]: "r-unknown" }, outcome: { kind: "completed" }, reply: "x" });
    expect(sent).toEqual([]);
  });

  it("closes a request nobody answered in thirty minutes, and tells the asking chat", async () => {
    const { asks, sent, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    await asks.sweep(Date.now() + 10 * 60_000);
    expect(sent).toEqual([]);
    await asks.sweep(Date.now() + 31 * 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("no answer");
    await asks.sweep(Date.now() + 90 * 60_000);
    expect(sent).toHaveLength(1);
  });
});
