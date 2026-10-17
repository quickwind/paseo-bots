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
    const gone = new Set<string>();
    host.attach({ agents: { ref: (agentId: string) => ({ refresh: async () => { if (gone.has(agentId)) throw new Error("no such chat"); return { agent: { status: status[agentId] ?? "idle", labels: {} } }; }, send: async (text: string) => void sent.push({ agentId, text }) }) } } as never);
    const asks = new Asks(host, null as never);
    const started: { bot: string; prompt: string; labels: Record<string, string>; agentId: string }[] = [];
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_host, _relay, bot, input) => {
      const given = input as { prompt: string; labels: Record<string, string>; agentId: string };
      started.push({ bot: (bot as { id: string }).id, prompt: given.prompt, labels: given.labels, agentId: given.agentId });
      return given.agentId;
    };
    const from = { bot: chief, agentId: "asker-chat", labels: {} as Record<string, string> };
    return { chief, scout, host, asks, sent, status, gone, started, from };
  }
  const labelsOf = (started: { labels: Record<string, string> }) => started.labels[ASK_REQUEST_LABEL]!;

  it("refuses when the bot may not contact others, when it was itself asked, and for a target that is not there", async () => {
    const off = await setup({ contactBots: "off" });
    expect(await off.asks.request(off.from, { to: "Scout", message: "hi" })).toMatchObject({ ok: false, text: expect.stringContaining("not allowed") });
    const loop = await setup();
    expect(await loop.asks.request({ ...loop.from, labels: { "bot-crew.asked-by": "scout" } }, { to: "Scout", message: "hi" })).toMatchObject({ ok: false, text: expect.stringContaining("asked by another bot") });
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
    expect(started[0]!.labels["bot-crew.asked-by"]).toBe("chief");
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
    await asks.answered({ agentId: started[0]!.agentId, labels, outcome: { kind: "completed" }, reply: "Three unread, one urgent." });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("asker-chat");
    expect(sent[0]!.text).toContain("Three unread, one urgent.");
    expect(sent[0]!.text).toContain("Scout");
    expect(sent[0]!.text).toMatch(/not the user|not from the user/i);
    await asks.answered({ agentId: started[0]!.agentId, labels, outcome: { kind: "completed" }, reply: "later chatter" });
    expect(sent).toHaveLength(1);
  });

  it("keeps the answer for an asking chat that is busy, and delivers it after that chat's next turn", async () => {
    const { asks, sent, status, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    status["asker-chat"] = "running";
    await asks.answered({ agentId: started[0]!.agentId, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "Three." });
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
    await asks.answered({ agentId: started[0]!.agentId, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "failed", error: { message: "not signed in" } }, reply: "" });
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

  it("keeps the answer of a chat whose turn ends before it has even been started", async () => {
    const { asks, sent, from } = await setup();
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_host, _relay, _bot, input) => {
      const given = input as { labels: Record<string, string>; agentId: string };
      await asks.answered({ agentId: given.agentId, labels: given.labels, outcome: { kind: "completed" }, reply: "fast answer" });
      return given.agentId;
    };
    await asks.request(from, { to: "Scout", message: "How many?" });
    expect(sent.map((message) => message.text).join("\n")).toContain("fast answer");
  });

  it("counts the half hour from when the question was sent, and never closes one that waits for the user", async () => {
    const { asks, sent, from } = await setup({ contactBots: "ask" });
    const t0 = Date.now();
    let now = t0;
    (asks as unknown as { now: () => number }).now = () => now;
    const result = await asks.request(from, { to: "Scout", message: "Check the invoices" });
    now = t0 + 3 * 3_600_000;
    await asks.sweep(now);
    expect(sent).toEqual([]);
    await asks.approved((await getProposal(result.proposalId!))! as never);
    await asks.sweep(now + 10 * 60_000);
    expect(sent).toEqual([]);
    await asks.sweep(now + 31 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("delivers a waiting answer exactly once even when two deliveries run together", async () => {
    const { asks, sent, status, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    status["asker-chat"] = "running";
    await asks.answered({ agentId: started[0]!.agentId, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "Three." });
    status["asker-chat"] = "idle";
    await Promise.all([asks.deliver("asker-chat"), asks.deliver("asker-chat")]);
    expect(sent).toHaveLength(1);
  });

  it("keeps an answer that could not be sent, and sends it next time", async () => {
    const { asks, sent, status, started, from, host } = await setup();
    await asks.request(from, { to: "Scout", message: "again" });
    status["asker-chat"] = "running";
    await asks.answered({ agentId: started[0]!.agentId, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "Four." });
    status["asker-chat"] = "idle";
    let fail = true;
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: {} } }), send: async (text: string) => { if (fail) throw new Error("offline"); sent.push({ agentId: "asker-chat", text }); } }) } } as never);
    await asks.deliver("asker-chat");
    expect(sent).toEqual([]);
    fail = false;
    await asks.deliver("asker-chat");
    expect(sent).toHaveLength(1);
  });

  it("stops a chat from asking more than five times an hour, so two bots cannot keep each other busy", async () => {
    const { asks, from } = await setup();
    for (let index = 0; index < 5; index++) expect((await asks.request(from, { to: "Scout", message: `q${index}` })).ok).toBe(true);
    const sixth = await asks.request(from, { to: "Scout", message: "q5" });
    expect(sixth.ok).toBe(false);
    expect(sixth.text).toContain("too many");
  });

  it("sends a follow-up to the same bot into the chat it already has with it, and its answer comes back", async () => {
    const { asks, sent, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many unread?" });
    const chat = started[0]!.agentId;
    await asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "Three." });
    sent.length = 0;
    const second = await asks.request(from, { to: "Scout", message: "And how many are urgent?" });
    expect(second.ok).toBe(true);
    expect(started).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe(chat);
    expect(sent[0]!.text).toContain("not from your user");
    expect(sent[0]!.text).toContain("And how many are urgent?");
    sent.length = 0;
    await asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "One." });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("asker-chat");
    expect(sent[0]!.text).toContain("One.");
  });

  it("starts a new chat for a follow-up when the first one is gone", async () => {
    const { asks, gone, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "first" });
    await asks.answered({ agentId: started[0]!.agentId, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "x" });
    gone.add(started[0]!.agentId);
    await asks.request(from, { to: "Scout", message: "second" });
    expect(started).toHaveLength(2);
  });

  it("starts its own chat for another asking chat, which has not talked to that bot yet", async () => {
    const { asks, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "first" });
    await asks.answered({ agentId: started[0]!.agentId, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "x" });
    await asks.request({ ...from, agentId: "another-chat" }, { to: "Scout", message: "second" });
    expect(started).toHaveLength(2);
  });

  it("holds a follow-up while the other bot is still on the last question, and sends it when that chat is free", async () => {
    const { asks, sent, status, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "first question" });
    const chat = started[0]!.agentId;
    status[chat] = "running";
    const second = await asks.request(from, { to: "Scout", message: "second question" });
    expect(second.ok).toBe(true);
    expect(started).toHaveLength(1);
    expect(sent.filter((message) => message.agentId === chat)).toEqual([]);

    status[chat] = "idle";
    await asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "One." });
    expect(sent.some((message) => message.agentId === "asker-chat" && message.text.includes("One."))).toBe(true);
    const intoChat = sent.filter((message) => message.agentId === chat);
    expect(intoChat).toHaveLength(1);
    expect(intoChat[0]!.text).toContain("second question");
    expect(intoChat[0]!.text).toContain("not from your user");

    sent.length = 0;
    await asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "Two." });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ agentId: "asker-chat" });
    expect(sent[0]!.text).toContain("Two.");
    expect(started).toHaveLength(1);
  });

  it("sends a held follow-up when the other chat finishes a turn that was not an answer to us", async () => {
    const { asks, sent, status, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "first question" });
    const chat = started[0]!.agentId;
    await asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "One." });
    status[chat] = "running";
    await asks.request(from, { to: "Scout", message: "second question" });
    expect(sent.filter((message) => message.agentId === chat)).toEqual([]);
    status[chat] = "idle";
    await asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "someone chatted here" });
    expect(sent.filter((message) => message.agentId === chat).map((message) => message.text).join("\n")).toContain("second question");
  });

  it("starts a new chat when the last question to that bot was over an hour ago", async () => {
    const { asks, started, from } = await setup();
    const t0 = Date.now();
    let now = t0;
    (asks as unknown as { now: () => number }).now = () => now;
    await asks.request(from, { to: "Scout", message: "first" });
    await asks.answered({ agentId: started[0]!.agentId, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "x" });
    now = t0 + 59 * 60_000;
    await asks.request(from, { to: "Scout", message: "soon after" });
    expect(started).toHaveLength(1);
    now = t0 + 59 * 60_000 + 61 * 60_000;
    await asks.request(from, { to: "Scout", message: "much later" });
    expect(started).toHaveLength(2);
  });

  it("closes a held follow-up that never got its turn, and does not send it afterwards", async () => {
    const { asks, sent, status, started, from } = await setup();
    const t0 = Date.now();
    let now = t0;
    (asks as unknown as { now: () => number }).now = () => now;
    await asks.request(from, { to: "Scout", message: "first" });
    const chat = started[0]!.agentId;
    status[chat] = "running";
    await asks.request(from, { to: "Scout", message: "held" });
    now = t0 + 40 * 60_000;
    await asks.sweep(now);
    expect(sent.filter((message) => message.agentId === "asker-chat").map((message) => message.text).join("\n")).toContain("no answer");
    status[chat] = "idle";
    sent.length = 0;
    await asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "late" });
    expect(sent.filter((message) => message.text.includes("held"))).toEqual([]);
  });

  it("does not close a question asked with ask_bot as unanswered: that tool waits for the answer itself", async () => {
    const { asks, sent } = await setup();
    const { updateRequests } = await import("../server/ask-store");
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await updateRequests((requests) => void requests.push({ id: "r-tool", fromBot: "chief", fromChat: "asker-chat", toBot: "scout", toName: "Scout", toChat: "some-chat", message: "q", createdAt: old, startedAt: old, status: "running", via: "tool", unsent: [] }));
    await asks.sweep();
    expect(sent).toEqual([]);
  });
});
