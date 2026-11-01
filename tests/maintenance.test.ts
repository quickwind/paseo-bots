import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotSchema } from "../shared/bot";
import { DEFAULT_BOT_MEMORY, NEW_BOT_MEMORY, newMemory } from "../shared/memory-maintenance";
import { newBot } from "../shared/templates";
import { makeBot } from "./helpers";

describe("bot memory settings", () => {
  it("parses a bot saved before the feature, with both features off", () => {
    const { memory, ...old } = makeBot();
    expect(memory).toBeDefined();
    const parsed = BotSchema.parse(old);
    expect(parsed.memory).toEqual(DEFAULT_BOT_MEMORY);
    expect(parsed.memory.tidy.enabled).toBe(false);
    expect(parsed.memory.saveAt.enabled).toBe(false);
  });

  it("starts new bots with both features on", () => {
    expect(newBot("claude").memory).toEqual(NEW_BOT_MEMORY);
    expect(NEW_BOT_MEMORY.tidy).toMatchObject({ enabled: true, everyMinutes: 240, source: "public" });
    expect(NEW_BOT_MEMORY.saveAt).toMatchObject({ enabled: true, percent: 70 });
  });

  it("starts new Devin bots with tidy off, as it spends the user's Devin quota, and keeps the rest", () => {
    const devin = newBot("devin").memory;
    expect(devin.tidy).toMatchObject({ enabled: false, everyMinutes: 240, source: "public" });
    expect(devin.saveAt).toEqual(NEW_BOT_MEMORY.saveAt);
    expect(newBot("claude").memory.tidy.enabled).toBe(true);
    expect(newMemory("devin")).toEqual(devin);
    expect(newMemory("codex")).toEqual(NEW_BOT_MEMORY);
  });

  it("keeps the values in range", () => {
    expect(() => BotSchema.parse({ ...makeBot(), memory: { tidy: { everyMinutes: 5 } } })).toThrow();
    expect(() => BotSchema.parse({ ...makeBot(), memory: { saveAt: { percent: 99 } } })).toThrow();
  });
});

import {
  checkTidyResult,
  contextPercent,
  editApprovingMode,
  FORCE_BACKOFF_MS,
  nextSaveState,
  overBudget,
  publicModelFrom,
  savePrompt,
  tidyDecision,
  tidyPrompt,
  type TidyFacts,
} from "../shared/memory-maintenance";

describe("context use", () => {
  it("is a percentage, or null when the provider reports none", () => {
    expect(contextPercent({ contextWindowUsedTokens: 140_000, contextWindowMaxTokens: 200_000 })).toBe(70);
    expect(contextPercent({ contextWindowUsedTokens: 1 })).toBeNull();
    expect(contextPercent({ contextWindowUsedTokens: 5, contextWindowMaxTokens: 0 })).toBeNull();
    expect(contextPercent(null)).toBeNull();
    expect(contextPercent(undefined)).toBeNull();
  });
});

describe("when a chat is asked to save", () => {
  it("asks once per fill, and again after usage has dropped (a compaction)", () => {
    let state = { ask: false, asked: false };
    const step = (percent: number | null) => (state = nextSaveState(state.asked, percent, 70));
    expect(step(50)).toEqual({ ask: false, asked: false });
    expect(step(72)).toEqual({ ask: true, asked: true });
    expect(step(80)).toEqual({ ask: false, asked: true });
    expect(step(30)).toEqual({ ask: false, asked: false });
    expect(step(71)).toEqual({ ask: true, asked: true });
  });

  it("does nothing when the provider reports no usage, and keeps what it knew", () => {
    expect(nextSaveState(false, null, 70)).toEqual({ ask: false, asked: false });
    expect(nextSaveState(true, null, 70)).toEqual({ ask: false, asked: true });
  });
});

const HOUR = 3_600_000;
function facts(patch: Partial<TidyFacts> = {}): TidyFacts {
  return { now: 100 * HOUR, lastRunAt: 90 * HOUR, everyMinutes: 240, force: false, busy: false, runsLast24h: 0, blockedUntil: null, inboxBytes: 0, newLogLines: 0, memoryLines: 40, memoryBytes: 3_000, ...patch };
}

describe("when memory is tidied", () => {
  it("waits for the interval", () => {
    expect(tidyDecision(facts({ lastRunAt: 98 * HOUR, inboxBytes: 10 }))).toEqual({ run: false, reason: "not-due" });
  });

  it("runs for new material, and skips when there is none", () => {
    expect(tidyDecision(facts({ inboxBytes: 10 }))).toEqual({ run: true, reason: "new-material" });
    expect(tidyDecision(facts({ newLogLines: 3 }))).toEqual({ run: true, reason: "new-material" });
    expect(tidyDecision(facts())).toEqual({ run: false, reason: "nothing-new" });
  });

  it("still runs once when the laptop was asleep for days", () => {
    expect(tidyDecision(facts({ lastRunAt: 1 * HOUR, newLogLines: 2 }))).toEqual({ run: true, reason: "new-material" });
  });

  it("runs on a first run with nothing recorded", () => {
    expect(tidyDecision(facts({ lastRunAt: null, newLogLines: 1 }))).toEqual({ run: true, reason: "new-material" });
  });

  it("forces a run when memory is over 80% of the limit", () => {
    expect(overBudget(160, 1000)).toBe(false);
    expect(overBudget(161, 1000)).toBe(true);
    expect(overBudget(10, 19_201)).toBe(true);
    expect(tidyDecision(facts({ memoryLines: 170 }))).toEqual({ run: true, reason: "over-budget" });
  });

  it("backs off after a forced run that did not help", () => {
    const now = 100 * HOUR;
    expect(tidyDecision(facts({ memoryLines: 170, blockedUntil: now + FORCE_BACKOFF_MS }))).toEqual({ run: false, reason: "backoff" });
    expect(tidyDecision(facts({ memoryLines: 170, blockedUntil: now - 1 }))).toEqual({ run: true, reason: "over-budget" });
  });

  it("never runs while a chat of the bot is working, or past six runs a day", () => {
    expect(tidyDecision(facts({ inboxBytes: 10, busy: true }))).toEqual({ run: false, reason: "busy" });
    expect(tidyDecision(facts({ inboxBytes: 10, runsLast24h: 6 }))).toEqual({ run: false, reason: "daily-limit" });
  });

  it("run now skips the interval and the nothing-new rule, but not busy or the daily limit", () => {
    expect(tidyDecision(facts({ force: true, lastRunAt: 99 * HOUR }))).toEqual({ run: true, reason: "manual" });
    expect(tidyDecision(facts({ force: true, busy: true }))).toEqual({ run: false, reason: "busy" });
    expect(tidyDecision(facts({ force: true, runsLast24h: 6 }))).toEqual({ run: false, reason: "daily-limit" });
  });
});

describe("the prompts", () => {
  it("tell the tidy chat where things are, the budget, and that the inputs are untrusted", () => {
    const text = tidyPrompt({ memoryPath: "/b/MEMORY.md", topicPaths: ["/b/memory/clients.md"], inboxPath: "/b/memory/inbox.md", logPaths: ["/b/memory/log/2026-10-10.md"] });
    for (const part of ["/b/MEMORY.md", "/b/memory/clients.md", "/b/memory/inbox.md", "/b/memory/log/2026-10-10.md", "150 lines", "untrusted", "Never store secrets"]) {
      expect(text).toContain(part);
    }
  });

  it("asks a chat to append notes to the inbox and nothing else", () => {
    const text = savePrompt("/b/memory/inbox.md");
    expect(text).toContain("/b/memory/inbox.md");
    expect(text).toContain("not from the user");
    expect(text).toContain("20 lines");
  });
});

describe("checking a tidy result", () => {
  const before = { lines: 180, bytes: 20_000 };
  it("accepts a smaller file", () => {
    expect(checkTidyResult(before, { lines: 120, bytes: 12_000 })).toEqual({ flags: [], stillOver: false });
  });
  it("flags an empty or missing file", () => {
    expect(checkTidyResult(before, null).flags).toContain("MEMORY.md is empty or missing");
    expect(checkTidyResult(before, { lines: 0, bytes: 0 }).flags).toContain("MEMORY.md is empty or missing");
  });
  it("flags a file that shrank by more than half", () => {
    expect(checkTidyResult(before, { lines: 20, bytes: 2_000 }).flags).toContain("MEMORY.md shrank by more than half");
  });
  it("reports memory that is still over 80%", () => {
    const result = checkTidyResult(before, { lines: 190, bytes: 21_000 });
    expect(result.stillOver).toBe(true);
    expect(result.flags).toContain("MEMORY.md is still over the budget");
  });
});

describe("the public model", () => {
  it("reads the candidates from Paseo's Metadata generation setting, wherever the config puts it", () => {
    const providers = [{ provider: "devin", model: "swe-free" }, { provider: "claude" }];
    const want = [{ provider: "devin", model: "swe-free" }, { provider: "claude", model: null }];
    expect(publicModelFrom({ config: { metadataGeneration: { providers } } })).toEqual(want);
    expect(publicModelFrom({ config: { agents: { metadataGeneration: { providers } } } })).toEqual(want);
    expect(publicModelFrom({ metadataGeneration: { providers } })).toEqual(want);
  });
  it("gives nothing for a config without the setting", () => {
    expect(publicModelFrom({ config: {} })).toEqual([]);
    expect(publicModelFrom(null)).toEqual([]);
    expect(publicModelFrom({ config: { metadataGeneration: { providers: [{ model: "x" }, 4] } } })).toEqual([]);
  });
});

import { ChatActivity, SaveTracker } from "../server/maintenance";

describe("which chats are running", () => {
  it("is busy while a chat of the bot has a turn running", () => {
    const activity = new ChatActivity();
    expect(activity.busy("b1")).toBe(false);
    activity.started("b1", "chat-1", 1000);
    expect(activity.busy("b1", 2000)).toBe(true);
    expect(activity.busy("b2", 2000)).toBe(false);
    activity.ended("b1", "chat-1");
    expect(activity.busy("b1", 3000)).toBe(false);
  });

  it("stops counting a turn whose end was never seen", () => {
    const activity = new ChatActivity();
    activity.started("b1", "chat-1", 0);
    expect(activity.busy("b1", 3 * 3_600_000)).toBe(false);
  });
});

describe("the save tracker", () => {
  it("asks once per fill and recognises the save turn when it ends", () => {
    const saves = new SaveTracker();
    expect(saves.decide("c1", 50, 70)).toBe(false);
    expect(saves.decide("c1", 75, 70)).toBe(true);
    saves.markSent("c1");
    expect(saves.decide("c1", 80, 70)).toBe(false);
    expect(saves.consume("c1")).toBe(true);
    expect(saves.consume("c1")).toBe(false);
    expect(saves.decide("c1", 20, 70)).toBe(false);
    expect(saves.decide("c1", 71, 70)).toBe(true);
  });
  it("tracks chats separately", () => {
    const saves = new SaveTracker();
    expect(saves.decide("c1", 90, 70)).toBe(true);
    expect(saves.decide("c2", 90, 70)).toBe(true);
  });
});

describe("memory files for maintenance", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-maint-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("reads usage, the topic index, the inbox and new log lines", async () => {
    const memory = await import("../server/memory");
    const { botDataPath } = await import("../server/bot-home");
    const folder = botDataPath("m1");
    await mkdir(join(folder, "memory", "log"), { recursive: true });
    await writeFile(join(folder, "MEMORY.md"), "# Memory\n- likes short answers\n");
    await writeFile(join(folder, "memory", "clients.md"), "# Clients\nAcme is the big one.\n");
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    await writeFile(join(folder, "memory", "log", "2026-10-10.md"), '- 09:00 · from chat "A" · did a thing\n- 10:00 · from chat "A" · did another\n');
    await writeFile(join(folder, "memory", "log", "2026-10-11.md"), '- 08:30 · from chat "B" · newest\n');

    expect(await memory.memoryUsage("m1")).toEqual({ lines: 3, bytes: 31 });
    expect(await memory.topicIndex("m1")).toEqual([
      { name: "clients.md", firstLine: "# Clients" },
      { name: "inbox.md", firstLine: "- note" },
    ]);
    expect(await memory.inboxBytes("m1")).toBe(6);
    expect(memory.inboxPath("m1")).toBe(join(folder, "memory", "inbox.md"));

    const now = new Date(2026, 9, 11, 12, 0);
    expect((await memory.newLogLines("m1", null, now)).count).toBe(3);
    const since = new Date(2026, 9, 10, 9, 30);
    const recent = await memory.newLogLines("m1", since, now);
    expect(recent.count).toBe(2);
    expect(recent.files.map((path) => path.endsWith("2026-10-10.md") || path.endsWith("2026-10-11.md"))).toEqual([true, true]);
    // An inbox the tidy chat "emptied" with a blank line or a heading is still empty.
    for (const text of ["", "\n", "# Inbox\n\n", "  \n## Notes\n"]) {
      await writeFile(join(folder, "memory", "inbox.md"), text);
      expect(await memory.inboxBytes("m1")).toBe(0);
    }
    expect(await memory.inboxBytes("nobody")).toBe(0);
    expect(await memory.memoryUsage("nobody")).toEqual({ lines: 0, bytes: 0 });
  });
});

import { promptSections, type PromptContext } from "../shared/bot";

function context(patch: Partial<PromptContext> = {}): PromptContext {
  return { memory: "- likes short answers", memoryPath: "/b/MEMORY.md", recentWork: [], playbooks: [], skills: [], paseoTools: false, botTools: false, ...patch };
}
const memoryText = (bot: ReturnType<typeof makeBot>, ctx: PromptContext) => promptSections(bot, ctx).find((section) => section.title === "Memory")!.text;

describe("the Memory part of the prompt", () => {
  it("is unchanged for a bot with maintenance off and nothing to list", () => {
    const text = memoryText(makeBot(), context());
    expect(text).not.toContain("inbox");
    expect(text).not.toContain("Topic files");
  });

  it("says how full MEMORY.md is and lists the topic files", () => {
    const text = memoryText(makeBot(), context({ memoryUsage: { lines: 141, bytes: 15_300 }, topics: [{ name: "clients.md", firstLine: "# Clients" }] }));
    expect(text).toContain("141 of 200 lines");
    expect(text).toContain("15.3 of 24 KB");
    expect(text).toContain("memory/clients.md: # Clients");
  });

  it("explains the inbox when maintenance is on", () => {
    const bot = makeBot({ memory: NEW_BOT_MEMORY });
    const text = memoryText(bot, context({ memoryUsage: { lines: 3, bytes: 80 }, topics: [] }));
    expect(text).toContain("memory/inbox.md");
    expect(text).toContain("when you learn it");
  });
});

import { turnEnded, turnStarted } from "../server/activity";
import { MemoryJournal } from "../server/journal";
import { fakeHost } from "./helpers";

function fakePaseo(chat: { status?: string; used?: number; max?: number; labels?: Record<string, string> }) {
  const sent: { agentId: string; text: string }[] = [];
  const api = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => ({
          agent: {
            id: agentId,
            status: chat.status ?? "idle",
            title: "Planning",
            labels: { "aydo.bot": "bot-s", ...(chat.labels ?? {}) },
            lastUsage: chat.used === undefined ? null : { contextWindowUsedTokens: chat.used, contextWindowMaxTokens: chat.max ?? 100 },
          },
        }),
        send: async (text: string) => void sent.push({ agentId, text }),
      }),
    },
  };
  return { api, sent };
}

const ended = (agentId: string) =>
  ({ agent: { id: agentId, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/", title: "Planning" }, turnId: "t", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "Done." }] }) as never;

describe("saving when the context fills up", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-save-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function run(chat: Parameters<typeof fakePaseo>[0], botPatch = {}) {
    const bot = makeBot({ id: "bot-s", memory: NEW_BOT_MEMORY, ...botPatch });
    const host = fakeHost([bot]);
    const { api, sent } = fakePaseo(chat);
    host.attach(api as never);
    const m = { activity: new ChatActivity(), saves: new SaveTracker(), tidy: null };
    await turnEnded(host, new MemoryJournal(), { finished: async () => {} }, ended("chat-1"), m);
    return { sent, m, host };
  }

  it("sends one save message when usage is over the threshold", async () => {
    const { sent } = await run({ used: 75 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Memory save");
    expect(sent[0]!.text).toContain("inbox.md");
  });

  it("sends nothing under the threshold, with no usage reported, or with the feature off", async () => {
    expect((await run({ used: 40 })).sent).toHaveLength(0);
    expect((await run({})).sent).toHaveLength(0);
    expect((await run({ used: 90 }, { memory: DEFAULT_BOT_MEMORY })).sent).toHaveLength(0);
  });

  it("does not interrupt a chat that is already working again, and asks after that turn", async () => {
    expect((await run({ used: 90, status: "running" })).sent).toHaveLength(0);
  });

  it("leaves maintenance and routine chats alone", async () => {
    expect((await run({ used: 90, labels: { "aydo.tidy": "bot-s" } })).sent).toHaveLength(0);
    expect((await run({ used: 90, labels: { "aydo.routine": "rt-1" } })).sent).toHaveLength(0);
  });

  it("does not log the save turn, or ask again from it", async () => {
    const bot = makeBot({ id: "bot-s", memory: NEW_BOT_MEMORY });
    const host = fakeHost([bot]);
    const { api, sent } = fakePaseo({ used: 80 });
    host.attach(api as never);
    const journal = new MemoryJournal();
    const m = { activity: new ChatActivity(), saves: new SaveTracker(), tidy: null };
    await turnEnded(host, journal, { finished: async () => {} }, ended("chat-2"), m); // the real turn: logged, then asks
    expect(sent).toHaveLength(1);
    await turnEnded(host, journal, { finished: async () => {} }, ended("chat-2"), m); // the save turn: not logged, no second ask
    expect(sent).toHaveLength(1);
    const { botDataPath } = await import("../server/bot-home");
    const { localDay } = await import("../shared/activity");
    const log = await readFile(join(botDataPath("bot-s"), "memory", "log", `${localDay(new Date())}.md`), "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
  });

  it("tracks running turns for the tidy service", async () => {
    const host = fakeHost([makeBot({ id: "bot-s" })]);
    host.attach(fakePaseo({}).api as never);
    const m = { activity: new ChatActivity(), saves: new SaveTracker(), tidy: null };
    await turnStarted(host, new MemoryJournal(), { agent: { id: "chat-3" }, turnId: "t" } as never, m);
    expect(m.activity.busy("bot-s")).toBe(true);
    await turnEnded(host, new MemoryJournal(), { finished: async () => {} }, ended("chat-3"), m);
    expect(m.activity.busy("bot-s")).toBe(false);
  });
});

describe("a mode that lets a tidy chat edit memory without asking", () => {
  const claude = [{ id: "plan" }, { id: "default" }, { id: "acceptEdits" }, { id: "bypassPermissions" }];
  it("picks the edit-approving mode over a stricter one", () => {
    expect(editApprovingMode("default", claude)).toBe("acceptEdits");
    expect(editApprovingMode(null, claude)).toBe("acceptEdits");
  });
  it("prefers it even over a bypass mode, since the chat reads untrusted text unattended", () => {
    expect(editApprovingMode("bypassPermissions", claude)).toBe("acceptEdits");
    expect(editApprovingMode("acceptEdits", claude)).toBe("acceptEdits");
  });
  it("keeps a permissive mode when the provider has no edit-approving one", () => {
    expect(editApprovingMode("bypassPermissions", [{ id: "default" }, { id: "bypassPermissions" }])).toBe("bypassPermissions");
  });
  it("keeps the current mode when the provider has no such mode", () => {
    expect(editApprovingMode("ask", [{ id: "ask" }, { id: "plan" }])).toBe("ask");
    expect(editApprovingMode(null, [])).toBeNull();
  });
});

import { MemoryTidy, tidyBot } from "../server/tidy";

describe("the bot a tidy chat runs as", () => {
  const bot = makeBot({ id: "b", provider: "claude", model: "opus", modeId: "default", skillIds: ["s"], mcpServerIds: ["m"], cwd: "/work", contactBots: "allow", alwaysAllow: ["a/b"], playbooks: [{ id: "p", name: "p", triggers: ["x"], instructions: "i" }] });
  const modes = [{ id: "default" }, { id: "acceptEdits" }];
  it("keeps the bot's own model and drops everything but memory access", () => {
    const tidy = tidyBot(bot, null, modes);
    expect(tidy).toMatchObject({ provider: "claude", model: "opus", modeId: "acceptEdits", skillIds: [], mcpServerIds: [], cwd: null, contactBots: "off", alwaysAllow: [], playbooks: [], routines: [] });
  });
  it("drops a bypass mode for the edit-approving one", () => {
    expect(tidyBot({ ...bot, modeId: "bypassPermissions" }, null, [{ id: "default" }, { id: "acceptEdits" }, { id: "bypassPermissions" }]).modeId).toBe("acceptEdits");
  });
  it("uses another provider's model with that provider's own edit mode", () => {
    expect(tidyBot(bot, { provider: "devin", model: "swe-free" }, [{ id: "ask" }, { id: "auto-edit" }])).toMatchObject({ provider: "devin", model: "swe-free", modeId: "auto-edit", thinkingOptionId: null });
    expect(tidyBot(bot, { provider: "devin", model: "swe-free" }, [])).toMatchObject({ modeId: null });
  });
  it("uses a model of the bot's own provider", () => {
    expect(tidyBot(bot, { provider: "claude", model: "haiku" }, modes)).toMatchObject({ provider: "claude", model: "haiku", modeId: "acceptEdits" });
  });
});

describe("the tidy service", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-tidy-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(patch: Partial<ReturnType<typeof makeBot>> = {}) {
    const bot = makeBot({ id: "tb", memory: { ...NEW_BOT_MEMORY, tidy: { ...NEW_BOT_MEMORY.tidy, source: "bot" } }, ...patch });
    const host = fakeHost([bot]);
    const archived: string[] = [];
    const activity = new ChatActivity();
    const tidy = new MemoryTidy(host, { mountTools: async () => ({}) } as never, activity);
    const started: { bot: ReturnType<typeof makeBot>; prompt: string; labels: Record<string, string>; agentId: string }[] = [];
    const hooks: { onStart?: (agentId: string) => Promise<void>; fail?: Error } = {};
    (tidy as unknown as { startChat: (...args: unknown[]) => Promise<string> }).startChat = async (_host, _relay, chatBot, input) => {
      const given = input as { prompt: string; labels: Record<string, string>; agentId: string };
      if (hooks.fail) throw hooks.fail;
      started.push({ bot: chatBot as never, prompt: given.prompt, labels: given.labels, agentId: given.agentId });
      await hooks.onStart?.(given.agentId);
      return given.agentId;
    };
    // Attaching starts the service, so the stand-in for starting a chat is in place first.
    const pending = new Set<string>();
    const api = {
      pending,
      agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, pendingPermissions: pending.has(id) ? [{ id: "p" }] : [] } }), archive: async () => void archived.push(id) }) },
      providers: { snapshot: async () => ({ entries: [{ provider: "claude", enabled: true, status: "ready", modes: [{ id: "default", label: "Ask" }, { id: "acceptEdits", label: "Edits" }] }] }) },
      config: { get: async () => ({ config: {} }) },
    };
    host.attach(api as never);
    tidy.stop();
    await tidy.tick();
    const { botDataPath } = await import("../server/bot-home");
    const folder = botDataPath("tb");
    await mkdir(join(folder, "memory"), { recursive: true });
    await writeFile(join(folder, "MEMORY.md"), "# Memory\n- a fact\n");
    return { bot, host, tidy, activity, started, archived, folder, hooks, api };
  }

  it("does not run when there is nothing new, and runs when the inbox has notes", async () => {
    const { tidy, started, folder } = await setup();
    await tidy.tick();
    expect(started).toHaveLength(0);
    await writeFile(join(folder, "memory", "inbox.md"), "- remember Acme\n");
    await tidy.tick();
    expect(started).toHaveLength(1);
    expect(started[0]!.labels).toEqual({ "aydo.tidy": "tb" });
    expect(started[0]!.prompt).toContain("inbox.md");
    expect(started[0]!.bot.cwd).toBeNull();
    expect(started[0]!.bot.modeId).toBe("acceptEdits");
    expect((await tidy.status("tb")).running).toBe(true);
  });

  it("waits for a working chat, and does not start a second run while one is going", async () => {
    const { tidy, activity, started, folder } = await setup();
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    activity.started("tb", "chat-x");
    await tidy.tick();
    expect(started).toHaveLength(0);
    activity.ended("tb", "chat-x");
    await tidy.tick();
    expect(started).toHaveLength(1);
    await tidy.tick();
    expect(started).toHaveLength(1);
  });

  it("finishes a run: records it, flags a big shrink, and keeps a flagged chat", async () => {
    const { tidy, archived, folder, started } = await setup();
    await writeFile(join(folder, "MEMORY.md"), "x\n".repeat(100));
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    await tidy.runNow("tb");
    await writeFile(join(folder, "MEMORY.md"), "# Memory\n- a\n");
    await tidy.finished("tb", started[0]!.agentId, { kind: "completed" }, "Merged.");
    const status = await tidy.status("tb");
    expect(status.running).toBe(false);
    expect(status.last).toMatchObject({ status: "succeeded", note: "Merged.", flags: ["MEMORY.md shrank by more than half"] });
    expect(archived).toEqual([]);
  });

  it("archives the chat of a clean run", async () => {
    const { tidy, archived, folder, started } = await setup();
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    await tidy.runNow("tb");
    await tidy.finished("tb", started[0]!.agentId, { kind: "completed" }, "Done.");
    expect(archived).toEqual([started[0]!.agentId]);
  });

  it("ignores the end of a chat it did not start", async () => {
    const { tidy, folder } = await setup();
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    await tidy.runNow("tb");
    await tidy.finished("tb", "someone-else", { kind: "completed" }, "x");
    expect((await tidy.status("tb")).running).toBe(true);
  });

  it("backs off for a day when a forced run leaves memory over budget", async () => {
    const { tidy, started, folder } = await setup();
    await writeFile(join(folder, "MEMORY.md"), "line\n".repeat(190));
    await tidy.tick();
    expect(started).toHaveLength(1);
    await tidy.finished("tb", started[0]!.agentId, { kind: "completed" }, "Tried.");
    expect((await tidy.status("tb")).blockedUntil).not.toBeNull();
    await tidy.forgetLastRun("tb");
    await tidy.tick();
    expect(started).toHaveLength(1);
  });

  it("keeps the backoff when a manual run leaves memory over budget", async () => {
    const { tidy, started, folder } = await setup();
    await writeFile(join(folder, "MEMORY.md"), "line\n".repeat(190));
    await tidy.tick();
    await tidy.finished("tb", started[0]!.agentId, { kind: "completed" }, "Tried.");
    const blocked = (await tidy.status("tb")).blockedUntil;
    expect(blocked).not.toBeNull();
    await tidy.runNow("tb");
    await tidy.finished("tb", started[1]!.agentId, { kind: "completed" }, "Tried again.");
    expect((await tidy.status("tb")).blockedUntil).toBe(blocked);
  });

  it("does nothing for a bot with tidy off or on another host", async () => {
    const off = await setup({ memory: DEFAULT_BOT_MEMORY });
    await writeFile(join(off.folder, "memory", "inbox.md"), "- note\n");
    await off.tidy.tick();
    expect(off.started).toHaveLength(0);
    const remote = await setup({ hostId: "other" });
    await writeFile(join(remote.folder, "memory", "inbox.md"), "- note\n");
    await remote.tidy.tick();
    expect(remote.started).toHaveLength(0);
  });

  it("settles a run whose chat ends before start returns", async () => {
    const { tidy, hooks, folder } = await setup();
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    hooks.onStart = (agentId) => tidy.finished("tb", agentId, { kind: "failed", error: { message: "not signed in" } }, "");
    await tidy.runNow("tb");
    const status = await tidy.status("tb");
    expect(status.running).toBe(false);
    expect(status.last).toMatchObject({ status: "failed", note: "not signed in" });
  });

  it("records a chat that could not be started, and waits an interval before trying again", async () => {
    const { tidy, hooks, started, folder } = await setup();
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    hooks.fail = new Error("claude has no models available");
    await tidy.tick();
    const status = await tidy.status("tb");
    expect(status.running).toBe(false);
    expect(status.last).toMatchObject({ status: "failed", note: "claude has no models available" });
    hooks.fail = undefined;
    await tidy.tick();
    expect(started).toHaveLength(0);
  });

  it("says when the tidy chat is waiting for an approval", async () => {
    const { tidy, started, api, folder } = await setup();
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    await tidy.tick();
    expect((await tidy.status("tb")).waiting).toBe(false);
    api.pending.add(started[0]!.agentId);
    expect((await tidy.status("tb")).waiting).toBe(true);
  });

  it("archives a run that never finished before starting the next", async () => {
    const { tidy, started, archived, folder } = await setup();
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    await tidy.tick();
    const first = started[0]!.agentId;
    const state = JSON.parse(await readFile(join(home, "plugin-data", "aydo", "tidy.json"), "utf8"));
    state.tb.last.at = new Date(Date.now() - 4 * 3_600_000).toISOString();
    state.tb.lastRunAt = state.tb.last.at;
    await writeFile(join(home, "plugin-data", "aydo", "tidy.json"), JSON.stringify(state));
    await tidy.tick();
    expect(archived).toContain(first);
    expect(started).toHaveLength(2);
  });

  it("starts one tidy chat when run now is pressed twice at once", async () => {
    const { tidy, folder, started } = await setup();
    await writeFile(join(folder, "memory", "inbox.md"), "- note\n");
    const results = await Promise.allSettled([tidy.runNow("tb"), tidy.runNow("tb")]);
    expect(started).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await tidy.status("tb")).runsToday).toBe(1);
  });

  it("run now refuses while a chat of the bot is working", async () => {
    const { tidy, activity } = await setup();
    activity.started("tb", "chat-x");
    await expect(tidy.runNow("tb")).rejects.toThrow("A chat of this assistant is working");
  });
});

import { describeTidy, intervalLabel } from "../client/panel/maintenance-text";

describe("maintenance texts", () => {
  it("names intervals", () => {
    expect(intervalLabel(60)).toBe("Every hour");
    expect(intervalLabel(240)).toBe("Every 4 hours");
    expect(intervalLabel(30)).toBe("Every 30 minutes");
    expect(intervalLabel(1440)).toBe("Every day");
  });

  const status = (patch = {}) => ({ running: false, waiting: false, last: null, blockedUntil: null, ...patch });
  const now = new Date("2026-10-11T12:00:00.000Z");
  it("says what tidy last did", () => {
    expect(describeTidy(status(), now)).toBe("Not run yet");
    expect(describeTidy(status({ running: true }), now)).toBe("Tidying now...");
    expect(describeTidy(status({ running: true, waiting: true }), now)).toContain("approve");
    expect(describeTidy(status({ last: { at: "2026-10-11T09:00:00.000Z", status: "succeeded", reason: "new-material", note: "Merged.", flags: [] } }), now)).toBe("Last run 3 hours ago: Merged.");
    expect(describeTidy(status({ last: { at: "2026-10-11T09:00:00.000Z", status: "failed", reason: "manual", note: "boom", flags: [] } }), now)).toContain("failed: boom");
    expect(describeTidy(status({ last: { at: "2026-10-11T11:59:30.000Z", status: "succeeded", reason: "manual", note: null, flags: ["MEMORY.md shrank by more than half"] } }), now)).toContain("Please review: MEMORY.md shrank by more than half");
    expect(describeTidy(status({ blockedUntil: "2026-10-12T09:00:00.000Z" }), now)).toContain("could not shrink");
  });
});
