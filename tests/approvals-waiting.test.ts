import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASK_REQUEST_LABEL, Asks } from "../server/asks";
import { createApproval, resolveApproval } from "../server/approvals-store";
import { loadRequests } from "../server/ask-store";
import { allowProject } from "../server/project-grants";
import { turnFacts } from "../server/turn-facts";
import { EMPTY_LIBRARY } from "../shared/bot";
import { reportIndexLine, reportRecord, statusLines, turnDriver, turnMeta } from "../shared/reports";
import { fakeHost, makeBot } from "./helpers";

// An assignment whose chat waits for the user's approval is not finished by the turn that ended to wait.

const waiting = (agentId: string, botId = "scout") => createApproval({ botId, botName: "Scout", agentId, chatTitle: "t", teamId: null, project: null, workspace: null, title: "Design", text: "x", file: null });

describe("an assignment while its chat waits for approval", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-waiting-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup() {
    const chief = makeBot({ id: "chief", name: "Chief", provider: "claude", contactBots: "allow" });
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const host = fakeHost([chief, scout], EMPTY_LIBRARY, []);
    const sent: { agentId: string; text: string }[] = [];
    const entries = [{ id: "wks_1", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-login", name: "login", title: "Login", archivingAt: null }];
    host.attach({ workspaces: { list: async () => ({ entries }) }, agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, workspaceId: "wks_1" } }), send: async (text: string) => void sent.push({ agentId, text }) }) } } as never);
    const asks = new Asks(host, null as never);
    const started: { agentId: string; labels: Record<string, string> }[] = [];
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_h, _r, _b, input) => {
      const given = input as { agentId: string; labels: Record<string, string> };
      started.push({ agentId: given.agentId, labels: given.labels });
      return given.agentId;
    };
    await allowProject("bot:chief", { id: "p1", name: "app" });
    const from = { bot: chief, agentId: "asker-chat", labels: {} as Record<string, string> };
    await asks.request(from, { to: "Scout", message: "Design the login page", workspace: "Login", assign: true });
    const chat = started[0]!.agentId;
    const answer = (reply: string) => asks.answered({ agentId: chat, labels: { [ASK_REQUEST_LABEL]: started[0]!.labels[ASK_REQUEST_LABEL]! }, outcome: { kind: "completed" }, reply });
    return { asks, sent, chat, answer, host };
  }

  it("is not answered by the turn that ended to wait, and nothing is pushed to the assigning chat", async () => {
    const { asks, sent, chat, answer } = await setup();
    const approval = await waiting(chat);
    await answer("I asked the user to approve the design.");
    expect(sent.filter((message) => message.agentId === "asker-chat")).toEqual([]);
    expect((await loadRequests())[0]!.status).toBe("running");
    await resolveApproval(approval.id, { status: "approved", note: "", decidedBy: "user" });
    await asks.approvalDecided(chat);
    await answer("Designed it; the files are in docs/.");
    expect((await loadRequests())[0]!.status).toBe("answered");
    expect(sent.filter((message) => message.agentId === "asker-chat")[0]!.text).toContain("Designed it");
  });

  it("does not close an assignment after 12 hours while its approval waits, and counts the 12 hours from the decision", async () => {
    const { asks, chat } = await setup();
    const approval = await waiting(chat);
    const now = Date.now();
    await asks.sweep(now + 13 * 3_600_000);
    expect((await loadRequests())[0]!.status).toBe("running");
    await resolveApproval(approval.id, { status: "approved", note: "", decidedBy: "user" });
    await asks.approvalDecided(chat);
    const restarted = Date.parse((await loadRequests())[0]!.startedAt!);
    expect(restarted).toBeGreaterThanOrEqual(now);
    await asks.sweep(restarted + 11 * 3_600_000);
    expect((await loadRequests())[0]!.status).toBe("running");
    await asks.sweep(restarted + 13 * 3_600_000);
    expect((await loadRequests())[0]!.status).toBe("closed");
  });
});

describe("the status of a turn that waits for approval", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-waiting2-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });
  const hostFor = () => {
    const host = fakeHost([makeBot({ id: "scout", name: "Scout" })]);
    host.attach({ workspaces: { list: async () => ({ entries: [{ id: "wks_1", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-login", name: "login", title: "Login", archivingAt: null }] }) }, agents: { ref: () => ({ refresh: async () => ({ agent: { workspaceId: "wks_1" } }) }) } } as never);
    return host;
  };
  const facts = (outcome: "completed" | "failed" | "canceled") => turnFacts(hostFor(), { agentId: "chat-1", chat: { routineId: null, labels: {} }, timeline: [{ type: "user_message", text: "go" }], outcome: { kind: outcome } as never, reply: "ok" });

  it("is waiting for approval when the chat has a pending approval and the turn completed or was stopped", async () => {
    await waiting("chat-1");
    expect((await facts("completed")).status).toBe("waiting");
    expect((await facts("canceled")).status).toBe("waiting");
    expect((await facts("failed")).status).toBe("failed");
    expect((await facts("completed")).meta).toBe("app · Login · by the user · waiting for approval");
  });

  it("is done again once the approval is decided", async () => {
    const approval = await waiting("chat-1");
    await resolveApproval(approval.id, { status: "approved", note: "", decidedBy: "user" });
    expect((await facts("completed")).status).toBe("done");
  });

  it("puts a waiting chat among the ones that need attention, and says why", () => {
    const rec = (status: never, chatId: string, hour: number) => reportRecord({ at: new Date(2026, 9, 21, hour, 0), bot: { id: "scout", name: "Scout" }, chat: { id: chatId, title: "c" }, project: { id: "p1", name: "app" }, workspace: "app · Login", driver: { kind: "user" }, status, question: "q", answer: "a" });
    const entries = [
      { project: "app", day: "2026-10-21", line: reportIndexLine(rec("waiting" as never, "aa000000", 8)) },
      { project: "app", day: "2026-10-21", line: reportIndexLine(rec("done" as never, "bb000000", 11)) },
    ];
    const lines = statusLines(entries, 5);
    expect(lines[0]).toContain("waiting for approval");
    expect(lines[0]).toContain("chat aa000000");
  });

  it("names the user as the driver of the turn that follows a decision message", () => {
    expect(turnDriver({ lastUserMessage: '[Aydo, from the user] Approved: "Design" (a-0123456789). You may go on.', userMessages: 3, routine: false })).toEqual({ kind: "user" });
    expect(turnMeta({ workspace: null, driver: { kind: "user" }, status: "waiting" as never })).toBe("by the user · waiting for approval");
  });
});

describe("a Devin bot that is assigned work and asks for approval", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-waiting3-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("is not reported as finished by the turn that wrote the approval file, and is not asked to save", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { turnEnded } = await import("../server/activity");
    const { FileTools } = await import("../server/file-tools");
    const { Approvals } = await import("../server/approvals");
    const { MemoryJournal } = await import("../server/journal");
    const { ChatActivity, SaveTracker } = await import("../server/maintenance");
    const { botDataPath } = await import("../server/bot-home");
    const chief = makeBot({ id: "chief", name: "Chief", provider: "claude", contactBots: "allow" });
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const host = fakeHost([chief, scout], EMPTY_LIBRARY, []);
    const sent: { agentId: string; text: string }[] = [];
    const entries = [{ id: "wks_1", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-login", name: "login", title: "Login", archivingAt: null }];
    host.attach({ workspaces: { list: async () => ({ entries }) }, agents: { ref: (agentId: string) => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, workspaceId: "wks_1", title: "t", lastUsage: { contextWindowUsedTokens: 95, contextWindowMaxTokens: 100 } } }), timeline: { append: async () => {}, refetch: async () => ({ entries: [] }) }, send: async (text: string) => void sent.push({ agentId, text }) }) } } as never);
    const asks = new Asks(host, null as never);
    const started: { agentId: string; labels: Record<string, string> }[] = [];
    (asks as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_h, _r, _b, input) => {
      const given = input as { agentId: string; labels: Record<string, string> };
      started.push({ agentId: given.agentId, labels: given.labels });
      return given.agentId;
    };
    await allowProject("bot:chief", { id: "p1", name: "app" });
    await asks.request({ bot: chief, agentId: "asker-chat", labels: {} }, { to: "Scout", message: "Design the login page", workspace: "Login", assign: true });
    const chat = started[0]!.agentId;
    host.chatOf = async (agentId: string) => (agentId === chat ? { botId: "scout", title: "Chief → Design", routineId: null, labels: started[0]!.labels } : null);
    const approvals = new Approvals(host, async (c) => { await asks.approvalDecided(c); await asks.deliver(c); }, { interruptDelayMs: 1_000_000 });
    const activity = new ChatActivity();
    const fileTools = new FileTools(host, null as never, asks as never, activity, approvals);
    const outbox = join(botDataPath("scout"), "outbox");
    await mkdir(outbox, { recursive: true });
    await writeFile(join(outbox, "approval-a1.json"), JSON.stringify({ kind: "approval", title: "Design", text: "Please approve the design." }));
    const timeline = [{ type: "user_message", text: "[Assignment from Chief, another bot...]\n\nDesign the login page" }, { type: "tool_call", detail: { type: "edit", filePath: "Wrote ./outbox/approval-a1.json" } }, { type: "assistant_message", text: "I asked the user to approve the design." }] as never;
    await turnEnded(host, new MemoryJournal(), { finished: async () => {} }, { agent: { id: chat, workspaceId: null, parentAgentId: null, provider: "devin", cwd: "/", title: null }, turnId: "t1", outcome: { kind: "completed" }, timeline }, { activity, saves: new SaveTracker(), tidy: null, fileTools, asks });
    expect((await loadRequests())[0]!.status).toBe("running");
    expect(sent.filter((message) => message.agentId === "asker-chat")).toEqual([]);
    expect(sent.filter((message) => message.agentId === chat)).toEqual([]);
  });
});
