import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASK_REQUEST_LABEL, Asks } from "../server/asks";
import { teamReportsPath } from "../server/bot-home";
import { createApproval, resolveApproval, takeHeld } from "../server/approvals-store";
import { allowProject, projectAllowed } from "../server/project-grants";
import { localDay } from "../shared/activity";
import { getProposal } from "../server/proposals";
import type { BotGroup } from "../shared/bot";
import { EMPTY_LIBRARY } from "../shared/bot";
import { fakeHost, makeBot } from "./helpers";

describe("asking another bot through a file", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-asks-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(asker: Partial<ReturnType<typeof makeBot>> = {}, others: ReturnType<typeof makeBot>[] = [], groups: BotGroup[] = []) {
    const chief = makeBot({ id: "chief", name: "Chief", provider: "devin", contactBots: "allow", ...asker });
    const scout = makeBot({ id: "scout", name: "Scout", provider: "claude" });
    const host = fakeHost([chief, scout, ...others], EMPTY_LIBRARY, groups);
    const sent: { agentId: string; text: string }[] = [];
    const status: Record<string, string> = {};
    const gone = new Set<string>();
    const workspaceOf: Record<string, string> = {};
    const entries = [
      { id: "wks_1", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-login", name: "login", title: "Login", archivingAt: null },
      { id: "wks_2", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-docs", name: "docs", title: "Docs", archivingAt: null },
    ];
    host.attach({ workspaces: { list: async () => ({ entries }) }, agents: { ref: (agentId: string) => ({ refresh: async () => { if (gone.has(agentId)) throw new Error("no such chat"); return { agent: { status: status[agentId] ?? "idle", labels: {}, workspaceId: workspaceOf[agentId] } }; }, send: async (text: string) => void sent.push({ agentId, text }) }) } } as never);
    const asks = new Asks(host, null as never);
    const started: { bot: string; prompt: string; labels: Record<string, string>; agentId: string; title: string; workspace?: { id: string; path: string } }[] = [];
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_host, _relay, bot, input) => {
      const given = input as { prompt: string; labels: Record<string, string>; agentId: string; title: string; workspace?: { id: string; path: string } };
      started.push({ bot: (bot as { id: string }).id, prompt: given.prompt, labels: given.labels, agentId: given.agentId, title: given.title, workspace: given.workspace });
      return given.agentId;
    };
    const from = { bot: chief, agentId: "asker-chat", labels: {} as Record<string, string> };
    return { chief, scout, host, asks, sent, status, gone, started, from, workspaceOf };
  }
  const labelsOf = (started: { labels: Record<string, string> }) => started.labels[ASK_REQUEST_LABEL]!;

  it("refuses when the bot may not contact others, when it was itself asked, and for a target that is not there", async () => {
    const off = await setup({ contactBots: "off" });
    expect(await off.asks.request(off.from, { to: "Scout", message: "hi" })).toMatchObject({ ok: false, text: expect.stringContaining("not allowed") });
    const loop = await setup();
    expect(await loop.asks.request({ ...loop.from, labels: { "aydo.asked-by": "scout" } }, { to: "Scout", message: "hi" })).toMatchObject({ ok: false, text: expect.stringContaining("asked by another bot") });
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
    expect(started[0]!.labels["aydo.asked-by"]).toBe("chief");
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

  const waiting = (agentId: string) => createApproval({ botId: "chief", botName: "Chief", agentId, chatTitle: "t", teamId: null, project: null, workspace: null, title: "T", text: "x", file: null });

  it("keeps a report for an asking chat that waits for an approval, and delivers it after the decision", async () => {
    const { asks, sent, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    const approval = await waiting("asker-chat");
    await asks.answered({ agentId: started[0]!.agentId, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "Three." });
    await asks.deliver("asker-chat");
    expect(sent).toEqual([]);
    await resolveApproval(approval.id, { status: "approved", note: "", decidedBy: "user" });
    await asks.deliver("asker-chat");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Three.");
  });

  it("holds a follow-up for a chat that waits for an approval", async () => {
    const { asks, sent, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "first" });
    const chat = started[0]!.agentId;
    await asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: labelsOf(started[0]!) }, outcome: { kind: "completed" }, reply: "One." });
    await waiting(chat);
    sent.length = 0;
    await asks.request(from, { to: "Scout", message: "second" });
    expect(sent.filter((message) => message.agentId === chat)).toEqual([]);
    expect(started).toHaveLength(1);
    expect((await takeHeld(chat))[0]).toContain("second");
  });

  const approvedFor = async (agentId: string, botId: string) => {
    const made = await createApproval({ botId, botName: "Chief", agentId, chatTitle: "t", teamId: null, project: null, workspace: null, title: "T", text: "x", file: null });
    return made;
  };

  it("an assignment that cites an approval needs it approved: pending, made up and rejected ones are refused and start nothing", async () => {
    const { asks, started, from, workspaceOf } = await setup();
    workspaceOf["asker-chat"] = "wks_1";
    const pendingOne = await approvedFor("other-chat", "chief");
    for (const approval of [pendingOne.id, "a-ffffffffff"]) {
      const refused = await asks.request(from, { to: "Scout", message: "Build it", assign: true, approval });
      expect(refused.ok).toBe(false);
      expect(refused.text).toMatch(/approval/i);
    }
    await resolveApproval(pendingOne.id, { status: "rejected", note: "no", decidedBy: "user" });
    expect((await asks.request(from, { to: "Scout", message: "Build it", assign: true, approval: pendingOne.id })).ok).toBe(false);
    expect(started).toEqual([]);
  });

  it("an assignment that cites an approved approval of the same bot goes ahead", async () => {
    const { asks, started, from, workspaceOf } = await setup();
    workspaceOf["asker-chat"] = "wks_1";
    const made = await approvedFor("other-chat", "chief");
    await resolveApproval(made.id, { status: "approved", note: "", decidedBy: "user" });
    const result = await asks.request(from, { to: "Scout", message: "Build it", assign: true, approval: made.id });
    expect(result.ok).toBe(true);
    expect(started).toHaveLength(1);
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

  it("counts a held follow-up's half hour from when the user approved it, not from when it was asked", async () => {
    const { asks, sent, status, started, from } = await setup({ contactBots: "ask" });
    const t0 = Date.now();
    let now = t0;
    (asks as unknown as { now: () => number }).now = () => now;
    const first = await asks.request(from, { to: "Scout", message: "first" });
    await asks.approved((await getProposal(first.proposalId!))! as never);
    status[started[0]!.agentId] = "running";
    const second = await asks.request(from, { to: "Scout", message: "held" });
    // Still inside the hour a chat is reused for, so the follow-up is held behind the busy chat.
    now = t0 + 50 * 60_000;
    await asks.approved((await getProposal(second.proposalId!))! as never);
    const heldId = ((await getProposal(second.proposalId!))! as { data: { requestId: string } }).data.requestId;
    const closedHeld = () => sent.filter((message) => message.text.includes(heldId) && message.text.includes("no answer"));
    await asks.sweep(now + 10 * 60_000);
    expect(closedHeld()).toEqual([]);
    await asks.sweep(now + 31 * 60_000);
    expect(closedHeld()).toHaveLength(1);
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

  describe("an ask_bot question the tool stopped waiting for", () => {
    const toolRequest = async (patch: Record<string, unknown> = {}) => {
      const { updateRequests } = await import("../server/ask-store");
      const now = new Date().toISOString();
      await updateRequests((requests) => void requests.push({ id: "r-tool", fromBot: "chief", fromChat: "asker-chat", toBot: "scout", toName: "Scout", toChat: "tool-chat", message: "q", createdAt: now, startedAt: now, status: "running", via: "tool", unsent: [], ...patch } as never));
    };
    const answer = (asks: Asks) => asks.answered({ agentId: "tool-chat", labels: { [ASK_REQUEST_LABEL]: "r-tool" }, outcome: { kind: "completed" }, reply: "Seven unread." });

    it("is not pushed into the asking chat while the tool still waits for the answer", async () => {
      const { asks, sent } = await setup();
      await toolRequest();
      await answer(asks);
      expect(sent).toEqual([]);
    });

    it("is pushed into the asking chat once the tool has given up waiting", async () => {
      const { asks, sent } = await setup();
      await toolRequest();
      const { detachRequest } = await import("../server/ask-store");
      expect(await detachRequest("r-tool")).toBe("detached");
      await answer(asks);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ agentId: "asker-chat" });
      expect(sent[0]!.text).toContain("Seven unread.");
      expect(sent[0]!.text).toContain("r-tool");
    });

    it("tells the tool the answer is already there when the other chat finished first", async () => {
      await setup();
      await toolRequest({ status: "answered" });
      const { detachRequest } = await import("../server/ask-store");
      expect(await detachRequest("r-tool")).toBe("answered");
      expect(await detachRequest("r-nothing")).toBe("gone");
    });

    it("is closed after half an hour like a question asked through a file", async () => {
      const { asks, sent } = await setup();
      const old = new Date(Date.now() - 31 * 60_000).toISOString();
      await toolRequest({ startedAt: old, createdAt: old, detached: true });
      await asks.sweep();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain("30 minutes");
    });
  });

  describe("inside a team that allows asking freely", () => {
    const crew = (patch: Partial<BotGroup> = {}): BotGroup => ({ id: "t1", name: "Ops", logo: null, leadId: "chief", memberIds: ["chief", "scout"], instructions: "", askFreely: true, createdAt: "", updatedAt: "", ...patch });

    it("sends a teammate's question at once, with no card, although the bot is set to ask first", async () => {
      const { asks, started, from } = await setup({ contactBots: "ask" }, [], [crew()]);
      const result = await asks.request(from, { to: "Scout", message: "Count the mails" });
      expect(result).toMatchObject({ ok: true, proposalId: null });
      expect(started.map((entry) => entry.bot)).toEqual(["scout"]);
    });

    it("still asks the user about someone outside the team, when the team does not allow it, and never overrides Off", async () => {
      const outside = makeBot({ id: "solo", name: "Solo" });
      const a = await setup({ contactBots: "ask" }, [outside], [crew()]);
      expect((await a.asks.request(a.from, { to: "Solo", message: "hi" })).proposalId).toMatch(/^p-/);
      const b = await setup({ contactBots: "ask" }, [], [crew({ askFreely: false })]);
      expect((await b.asks.request(b.from, { to: "Scout", message: "hi" })).proposalId).toMatch(/^p-/);
      const c = await setup({ contactBots: "off" }, [], [crew()]);
      expect(await c.asks.request(c.from, { to: "Scout", message: "hi" })).toMatchObject({ ok: false });
      expect(a.started.concat(b.started, c.started)).toEqual([]);
    });
  });

  it("lets the Chief of Staff ask more often than the others in an hour", async () => {
    const group: BotGroup = { id: "t1", name: "Ops", logo: null, leadId: "chief", memberIds: ["chief", "scout"], instructions: "", askFreely: false, createdAt: "", updatedAt: "" };
    const lead = await setup({}, [], [group]);
    const results = [];
    for (let index = 0; index < 21; index++) results.push(await lead.asks.request(lead.from, { to: "Scout", message: `q${index}` }));
    expect(results.filter((result) => result.ok)).toHaveLength(20);
    expect(results[20]!.text).toContain("too many");
    // Here Scout leads and Chief is only a member.
    const member = await setup({}, [], [{ ...group, leadId: "scout" }]);
    const tries = [];
    for (let index = 0; index < 6; index++) tries.push(await member.asks.request({ ...member.from, agentId: "member-chat" }, { to: "Scout", message: `q${index}` }));
    expect(tries.filter((result) => result.ok)).toHaveLength(5);
  });
});

describe("assigning work to another bot in a workspace", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-assign-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(asker: Partial<ReturnType<typeof makeBot>> = {}, groups: BotGroup[] = [], granted = true) {
    const chief = makeBot({ id: "chief", name: "Chief", provider: "claude", contactBots: "allow", ...asker });
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const host = fakeHost([chief, scout], EMPTY_LIBRARY, groups);
    const sent: { agentId: string; text: string }[] = [];
    const workspaceOf: Record<string, string> = {};
    const entries = [
      { id: "wks_1", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-login", name: "login", title: "Login", archivingAt: null },
      { id: "wks_2", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-docs", name: "docs", title: "Docs", archivingAt: null },
      { id: "wks_3", projectId: "p2", projectDisplayName: "shop", projectRootPath: "/work/shop", workspaceDirectory: "/work/shop-docs", name: "docs", title: "Docs", archivingAt: null },
    ];
    host.attach({ workspaces: { list: async () => ({ entries }) }, agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, workspaceId: workspaceOf[agentId] } }), send: async (text: string) => void sent.push({ agentId, text }) }) } } as never);
    const asks = new Asks(host, null as never);
    const started: { bot: string; prompt: string; title: string; labels: Record<string, string>; agentId: string; workspace?: { id: string; path: string } }[] = [];
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_host, _relay, bot, input) => {
      const given = input as (typeof started)[number];
      started.push({ bot: (bot as { id: string }).id, prompt: given.prompt, title: given.title, labels: given.labels, agentId: given.agentId, workspace: given.workspace });
      return given.agentId;
    };
    // The user has already allowed the app project for this bot, so assignments there need no card (see "asks the user first" below).
    if (granted) await allowProject("bot:chief", { id: "p1", name: "app" });
    const from = { bot: chief, agentId: "asker-chat", labels: {} as Record<string, string> };
    return { chief, scout, asks, sent, started, from, workspaceOf, entries };
  }

  it("starts the other bot's chat in the named workspace, with the task framed as another bot's message", async () => {
    const { asks, started, from } = await setup();
    const result = await asks.request(from, { to: "Scout", message: "Write notes.md with the word MANGO.", workspace: "Login", assign: true });
    expect(result).toMatchObject({ ok: true, proposalId: null });
    expect(started).toHaveLength(1);
    expect(started[0]!.bot).toBe("scout");
    expect(started[0]!.workspace).toEqual({ id: "wks_1", path: "/work/app-login" });
    expect(started[0]!.prompt).toContain("Assignment from Chief");
    expect(started[0]!.prompt).toContain("not from your user");
    expect(started[0]!.prompt).toContain('"app · Login"');
    expect(started[0]!.prompt).toContain("/work/app-login");
    expect(started[0]!.prompt).toContain("Write notes.md with the word MANGO.");
    expect(started[0]!.prompt).toContain("BLOCKED");
    expect(started[0]!.title).toBe("Chief → Write notes.md with the word MANGO.");
    expect(started[0]!.labels["aydo.asked-by"]).toBe("chief");
    expect(started[0]!.labels["aydo.ask-request"]).toMatch(/^r-/);
    expect(result.text).toMatch(/report/i);
  });

  it("uses the workspace the assigning chat runs in when none is named", async () => {
    const { asks, started, from, workspaceOf } = await setup();
    workspaceOf["asker-chat"] = "wks_2";
    await asks.request(from, { to: "Scout", message: "Tidy the docs.", assign: true });
    expect(started[0]!.workspace).toEqual({ id: "wks_2", path: "/work/app-docs" });
  });

  it("refuses, and starts nothing, when the assigning chat is in no project workspace and names none", async () => {
    const { asks, started, from } = await setup();
    const result = await asks.request(from, { to: "Scout", message: "Do it.", assign: true });
    expect(result).toMatchObject({ ok: false, text: "You are not working in a project workspace. Name the workspace to assign in, or use ask_bot." });
    expect(started).toEqual([]);
  });

  it("refuses an unknown workspace and one whose name is shared, saying which exist", async () => {
    const { asks, started, from } = await setup();
    const unknown = await asks.request(from, { to: "Scout", message: "Do it.", workspace: "Nowhere" });
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("app · Login");
    const shared = await asks.request(from, { to: "Scout", message: "Do it.", workspace: "Docs" });
    expect(shared.ok).toBe(false);
    expect(shared.text).toContain("/work/app-docs");
    expect(shared.text).toContain("/work/shop-docs");
    expect(started).toEqual([]);
  });

  it("makes a card that names the workspace when the setting is ask, starts nothing until approved, then starts in the workspace", async () => {
    const { asks, started, from } = await setup({ contactBots: "ask" });
    const result = await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    expect(result.proposalId).toMatch(/^p-/);
    expect(started).toEqual([]);
    const proposal = (await getProposal(result.proposalId!))!;
    expect(proposal).toMatchObject({ kind: "ask", status: "pending", data: { toBotId: "scout", message: "Write notes.md.", workspace: { id: "wks_1", title: "Login", directory: "/work/app-login" } } });
    await asks.approved(proposal as never);
    expect(started).toHaveLength(1);
    expect(started[0]!.workspace).toEqual({ id: "wks_1", path: "/work/app-login" });
  });

  it("pushes the report of the assigned chat back, framed as a report from another bot", async () => {
    const { asks, sent, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    await asks.answered({ agentId: started[0]!.agentId, labels: { "aydo.ask-request": started[0]!.labels["aydo.ask-request"]! }, outcome: { kind: "completed" }, reply: "Done: notes.md is in the folder." });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("asker-chat");
    expect(sent[0]!.text).toMatch(/^\[Report from Scout on your assignment r-[a-f0-9]+\./);
    expect(sent[0]!.text).toContain("Done: notes.md is in the folder.");
    expect(sent[0]!.text).toMatch(/not from the user/i);
  });

  it("does not close an assignment at half an hour, but does after twelve hours", async () => {
    const { asks, sent, from } = await setup();
    await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    await asks.sweep(Date.now() + 31 * 60_000);
    expect(sent).toEqual([]);
    await asks.sweep(Date.now() + 11 * 3_600_000);
    expect(sent).toEqual([]);
    await asks.sweep(Date.now() + 12 * 3_600_000 + 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("got no answer in 12 hours");
  });

  it("never sends an assignment into a chat an earlier question started", async () => {
    const { asks, sent, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    await asks.answered({ agentId: started[0]!.agentId, labels: { "aydo.ask-request": started[0]!.labels["aydo.ask-request"]! }, outcome: { kind: "completed" }, reply: "Three." });
    sent.length = 0;
    await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    expect(started).toHaveLength(2);
    expect(started[1]!.workspace).toEqual({ id: "wks_1", path: "/work/app-login" });
    expect(sent).toEqual([]);
  });

  it("keeps the loop guard: a chat another bot started cannot assign", async () => {
    const { asks, started, from } = await setup();
    const result = await asks.request({ ...from, labels: { "aydo.asked-by": "scout" } }, { to: "Scout", message: "Do it.", workspace: "Login" });
    expect(result).toMatchObject({ ok: false, text: "You were started by another bot, so you can't assign work to a bot yourself. Do your own task and report back." });
    expect(started).toEqual([]);
  });

  it("asks the assigned bot to name the workspace in its report, so the assigner can tell which one it was", async () => {
    const { asks, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    expect(started[0]!.prompt).toContain('Name the workspace "app · Login" in your report.');
  });

  it("leaves a plain question unchanged: no workspace, thirty minutes, and it may go into the chat it already has", async () => {
    const { asks, started, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    expect(started[0]!.workspace).toBeUndefined();
    expect(started[0]!.prompt).toContain("not from your user");
    expect(started[0]!.prompt).not.toContain("Assignment from");
  });

  it("asks the user first, even when the bot may ask freely, for a project it has not used; Allow remembers the project", async () => {
    const { asks, started, from } = await setup({}, [], false);
    const result = await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    expect(result.proposalId).toMatch(/^p-/);
    expect(started).toEqual([]);
    const proposal = (await getProposal(result.proposalId!))!;
    expect(proposal).toMatchObject({ kind: "ask", data: { workspace: { id: "wks_1", title: "Login", directory: "/work/app-login", projectId: "p1", projectName: "app" } } });
    expect(await projectAllowed("bot:chief", "p1")).toBe(false);
    await asks.approved(proposal as never);
    expect(started).toHaveLength(1);
    expect(await projectAllowed("bot:chief", "p1")).toBe(true);
    // From then on the same project needs no card.
    const again = await asks.request(from, { to: "Scout", message: "Another.", workspace: "wks_2" });
    expect(again.proposalId).toBeNull();
    expect(started).toHaveLength(2);
  });

  it("does not ask for the workspace the assigning chat itself runs in, named or not", async () => {
    const { asks, started, from, workspaceOf } = await setup({}, [], false);
    workspaceOf["asker-chat"] = "wks_2";
    expect((await asks.request(from, { to: "Scout", message: "One.", assign: true })).proposalId).toBeNull();
    expect((await asks.request(from, { to: "Scout", message: "Two.", workspace: "wks_2" })).proposalId).toBeNull();
    expect(started).toHaveLength(2);
    expect((await asks.request(from, { to: "Scout", message: "Three.", workspace: "wks_3" })).proposalId).toMatch(/^p-/);
    expect(started).toHaveLength(2);
  });

  it("closes the request and tells the assigning chat when the workspace is gone by the time the user allows it", async () => {
    const { asks, started, sent, from, entries } = await setup({ contactBots: "ask" });
    const result = await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    entries.splice(0, 1);
    await asks.approved((await getProposal(result.proposalId!))! as never);
    expect(started).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe("asker-chat");
    expect(sent[0]!.text).toContain('the workspace "app · Login" is no longer available');
  });

  it("starts a plain question in a new chat, not queued behind an assignment that is still running", async () => {
    const { asks, started, sent, from } = await setup();
    await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    await asks.request(from, { to: "Scout", message: "How is it going?" });
    expect(started).toHaveLength(2);
    expect(started[1]!.workspace).toBeUndefined();
    expect(sent).toEqual([]);
  });
});


describe("assignments in the team's reports", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-assignreports-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });
  const NOWISO = "2026-10-20T00:00:00.000Z";
  const team: BotGroup = { id: "t1", name: "Crew", logo: null, leadId: "chief", memberIds: ["chief", "scout"], instructions: "", askFreely: false, createdAt: NOWISO, updatedAt: NOWISO };

  async function setup() {
    const chief = makeBot({ id: "chief", name: "Chief", provider: "claude", contactBots: "allow" });
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const host = fakeHost([chief, scout], EMPTY_LIBRARY, [team]);
    const entries = [{ id: "wks_1", projectId: "prj_1111aaaa", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-login", name: "login", title: "Login", archivingAt: null }];
    host.attach({ workspaces: { list: async () => ({ entries }) }, agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: {} } }), send: async () => {} }) } } as never);
    const asks = new Asks(host, null as never);
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_h, _r, _b, input) => (input as { agentId: string }).agentId;
    await allowProject("bot:chief", { id: "prj_1111aaaa", name: "app" });
    await allowProject("team:t1", { id: "prj_1111aaaa", name: "app" });
    return { asks, from: { bot: chief, agentId: "chief-chat", labels: {} as Record<string, string> } };
  }
  const dayFile = (ext: "md" | "jsonl") => readFile(join(teamReportsPath("t1"), "app", `${localDay(new Date())}.${ext}`), "utf8").catch(() => "");

  it("writes a started record for the bot that was assigned: the task as the question, no answer", async () => {
    const { asks, from } = await setup();
    await asks.request(from, { to: "Scout", message: "Write notes.md with the word MANGO.", workspace: "Login" });
    const [record] = (await dayFile("jsonl")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(record).toMatchObject({ bot: { id: "scout", name: "Scout" }, chat: { title: "Chief → Write notes.md with the word MANGO." }, project: { id: "prj_1111aaaa", name: "app" }, workspace: "app · Login", driver: { kind: "bot", name: "Chief", via: "assignment" }, status: "started", question: "Write notes.md with the word MANGO.", answer: "" });
    expect(await dayFile("md")).toContain("[app · Login · assigned by Chief · started] · Q: Write notes.md with the word MANGO. · chat ");
  });

  it("writes a stalled record when an assignment is closed after twelve hours", async () => {
    const { asks, from } = await setup();
    await asks.request(from, { to: "Scout", message: "Write notes.md.", workspace: "Login" });
    await asks.sweep(Date.now() + 12 * 3_600_000 + 60_000);
    expect(await dayFile("md")).toContain("[app · Login · assigned by Chief · stalled] · Q: Write notes.md. · A: no report in 12 hours");
  });

  it("writes nothing for a plain question", async () => {
    const { asks, from } = await setup();
    await asks.request(from, { to: "Scout", message: "How many?" });
    expect(await dayFile("jsonl")).toBe("");
  });
});
