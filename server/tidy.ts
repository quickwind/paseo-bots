import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import { foldText } from "../shared/activity";
import type { Bot } from "../shared/bot";
import { checkTidyResult, editApprovingMode, FORCE_BACKOFF_MS, publicModelFrom, TIDY_LABEL, tidyDecision, tidyPrompt, type TidyDecision } from "../shared/memory-maintenance";
import type { TidyStatus } from "../shared/rpc";
import { newUuid } from "../shared/uuid";
import { botDataPath, pluginDataPath } from "./bot-home";
import { startChat } from "./chats";
import type { BotsHost } from "./host";
import type { ChatActivity } from "./maintenance";
import { inboxBytes, inboxPath, memoryUsage, newLogLines, topicIndex } from "./memory";
import type { Relay } from "./relay";

const TICK_MS = 60_000;
const DAY_MS = 24 * 3_600_000;
/** A tidy run whose chat never reported its end stops counting as running after this. */
const STALE_RUN_MS = 3 * 3_600_000;

interface LastRun {
  at: string;
  status: "running" | "succeeded" | "failed";
  agentId: string | null;
  reason: string;
  note: string | null;
  flags: string[];
  /** MEMORY.md before the run, to check the result against. */
  before: { lines: number; bytes: number };
}

interface TidyRecord {
  lastRunAt: string | null;
  runs: string[];
  blockedUntil: string | null;
  last: LastRun | null;
}

const EMPTY: TidyRecord = { lastRunAt: null, runs: [], blockedUntil: null, last: null };
const statePath = () => join(pluginDataPath(), "tidy.json");

/**
 * The bot a tidy chat runs as: the bot's own settings stripped to what memory needs (no skills,
 * MCP servers, playbooks or saved approvals, no contact with other bots, and its home folder as
 * the working folder), on `pick` when given, in a mode that approves edits where the provider has
 * one. Another provider gets its own mode.
 */
export function tidyBot(bot: Bot, pick: { provider: string; model: string | null } | null, modes: readonly { id: string }[] = []): Bot {
  const same = !pick || pick.provider === bot.provider;
  return {
    ...bot,
    provider: pick?.provider ?? bot.provider,
    model: pick ? pick.model : bot.model,
    modeId: editApprovingMode(same ? bot.modeId : null, modes),
    thinkingOptionId: same && !pick ? bot.thinkingOptionId : null,
    skillIds: [],
    mcpServerIds: [],
    alwaysAllow: [],
    playbooks: [],
    routines: [],
    contactBots: "off",
    cwd: null,
  };
}

/** Tidies each bot's memory on an interval, in a normal chat of the bot that the journal watches like any other. */
export class MemoryTidy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private chain: Promise<void> = Promise.resolve();
  private queue: Promise<unknown> = Promise.resolve();
  /** Replaceable in tests. */
  private startChat = startChat;

  constructor(
    private readonly host: BotsHost,
    private readonly relay: Relay,
    private readonly activity: ChatActivity,
  ) {
    host.onAttach(() => {
      if (this.timer) return;
      this.timer = setInterval(() => {
        if (!this.ticking) void this.tick();
      }, TICK_MS);
      void this.tick();
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private update<T>(botId: string, change: (record: TidyRecord) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const all = await this.readAll();
      const record = all[botId] ?? { ...EMPTY, runs: [] };
      const result = await change(record);
      all[botId] = record;
      await mkdir(pluginDataPath(), { recursive: true });
      await writeFile(statePath(), JSON.stringify(all, null, 2), "utf8");
      return result;
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async readAll(): Promise<Record<string, TidyRecord>> {
    try {
      return JSON.parse(await readFile(statePath(), "utf8")) as Record<string, TidyRecord>;
    } catch {
      return {};
    }
  }

  /** Test seam: makes the next tick treat the bot as never tidied. */
  async forgetLastRun(botId: string): Promise<void> {
    await this.update(botId, (record) => {
      record.lastRunAt = null;
    });
  }

  async status(botId: string): Promise<TidyStatus> {
    const bot = await this.host.bot(botId);
    const record = (await this.readAll())[botId] ?? EMPTY;
    const now = Date.now();
    const running = record.last?.status === "running" && now - Date.parse(record.last.at) < STALE_RUN_MS;
    const last = record.last ? { at: record.last.at, status: running || record.last.status !== "running" ? record.last.status : ("failed" as const), reason: record.last.reason, note: record.last.note, flags: record.last.flags } : null;
    const due = record.lastRunAt && bot ? new Date(Date.parse(record.lastRunAt) + bot.memory.tidy.everyMinutes * 60_000).toISOString() : null;
    // A tidy chat stopped at a permission prompt looks like a slow one unless it is asked.
    const waiting = running && record.last?.agentId ? await this.waitingForApproval(record.last.agentId) : false;
    return {
      enabled: bot?.memory.tidy.enabled ?? false,
      running,
      waiting,
      lastRunAt: record.lastRunAt,
      last,
      nextDueAt: due,
      blockedUntil: record.blockedUntil && Date.parse(record.blockedUntil) > now ? record.blockedUntil : null,
      runsToday: record.runs.filter((at) => now - Date.parse(at) < DAY_MS).length,
    };
  }

  private async waitingForApproval(agentId: string): Promise<boolean> {
    const snapshot = await this.host.paseo?.agents.ref(agentId).refresh().catch(() => null);
    return (snapshot?.agent.pendingPermissions?.length ?? 0) > 0;
  }

  async runNow(botId: string): Promise<TidyStatus> {
    const bot = await this.host.bot(botId);
    if (!bot) throw new Error("There's no such bot.");
    if (bot.hostId) throw new Error("Memory is tidied on the host that stores the bot.");
    const decision = await this.consider(bot, true);
    if (!decision.run) {
      throw new Error(decision.reason === "busy" ? "A chat of this bot is working; try again when it is done." : "It already ran six times today.");
    }
    return this.status(botId);
  }

  /** One pass over the bots; passes run one after another, so a caller never skips because another is still going. */
  tick(): Promise<void> {
    const run = this.chain.then(() => this.pass());
    this.chain = run.catch(() => {});
    return run;
  }

  private async pass(): Promise<void> {
    if (!this.host.paseo) return;
    this.ticking = true;
    try {
      for (const bot of await this.host.bots()) {
        if (bot.archived || bot.hostId || !bot.memory.tidy.enabled) continue;
        await this.consider(bot, false).catch((error: unknown) => console.error("bot-crew: memory tidy failed to start", error));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async consider(bot: Bot, force: boolean): Promise<TidyDecision> {
    const record = (await this.readAll())[bot.id] ?? EMPTY;
    const now = Date.now();
    if (record.last?.status === "running") {
      if (now - Date.parse(record.last.at) < STALE_RUN_MS) return { run: false, reason: "busy" };
      await this.abandon(bot.id, record.last);
    }
    const usage = await memoryUsage(bot.id);
    const logs = await newLogLines(bot.id, record.lastRunAt ? new Date(record.lastRunAt) : null);
    const decision = tidyDecision({
      now,
      lastRunAt: record.lastRunAt ? Date.parse(record.lastRunAt) : null,
      everyMinutes: bot.memory.tidy.everyMinutes,
      force,
      busy: this.activity.busy(bot.id),
      runsLast24h: record.runs.filter((at) => now - Date.parse(at) < DAY_MS).length,
      blockedUntil: record.blockedUntil ? Date.parse(record.blockedUntil) : null,
      inboxBytes: await inboxBytes(bot.id),
      newLogLines: logs.count,
      memoryLines: usage.lines,
      memoryBytes: usage.bytes,
    });
    if (decision.run) await this.start(bot, decision.reason, usage, logs.files);
    return decision;
  }

  /** The provider's snapshot entries and Paseo's Metadata generation candidates, for choosing the tidy model. */
  private async providers() {
    const paseo = this.host.paseo;
    const [config, snapshot] = await Promise.all([paseo?.config.get().catch(() => null), paseo?.providers.snapshot().catch(() => null)]);
    return { config, entries: snapshot?.entries ?? [] };
  }

  private async start(bot: Bot, reason: string, before: { lines: number; bytes: number }, logPaths: string[]): Promise<void> {
    const { config, entries } = await this.providers();
    const setting = bot.memory.tidy;
    let pick: { provider: string; model: string | null } | null = null;
    if (setting.source === "model" && setting.model) pick = { provider: bot.provider, model: setting.model };
    else if (setting.source === "public") {
      const ready = new Set(entries.filter((entry) => entry.status === "ready").map((entry) => entry.provider));
      pick = publicModelFrom(config).find((candidate) => ready.has(candidate.provider)) ?? null;
    }
    const modes = entries.find((entry) => entry.provider === (pick?.provider ?? bot.provider))?.modes ?? [];
    const topics = (await topicIndex(bot.id)).filter((topic) => topic.name !== "inbox.md");
    const prompt = tidyPrompt({
      memoryPath: join(botDataPath(bot.id), "MEMORY.md"),
      topicPaths: topics.map((topic) => join(botDataPath(bot.id), "memory", topic.name)),
      inboxPath: inboxPath(bot.id),
      logPaths,
    });
    // The run is recorded before the chat exists: a chat that fails at once can report its end
    // before startChat returns, and that end must find the run.
    const agentId = newUuid();
    const at = new Date().toISOString();
    await this.update(bot.id, (record) => {
      record.lastRunAt = at;
      record.runs = [...record.runs.filter((entry) => Date.now() - Date.parse(entry) < DAY_MS), at];
      record.last = { at, status: "running", agentId, reason, note: null, flags: [], before };
    });
    try {
      await this.startChat(this.host, this.relay, tidyBot(bot, pick, modes), { prompt, title: "Memory tidy", labels: { [TIDY_LABEL]: bot.id }, agentId });
    } catch (error) {
      // Visible on the Status row, and counted as a run so it waits an interval instead of retrying every minute.
      const note = error instanceof Error ? error.message : String(error);
      await this.update(bot.id, (record) => {
        if (record.last?.agentId === agentId) Object.assign(record.last, { status: "failed", note });
      });
      console.error("bot-crew: couldn't start a memory tidy chat", error);
    }
  }

  /** A run that never reported its end: mark it failed, and close its chat so stuck ones do not pile up. */
  private async abandon(botId: string, last: LastRun): Promise<void> {
    await this.update(botId, (record) => {
      if (record.last?.agentId !== last.agentId || record.last.status !== "running") return;
      Object.assign(record.last, { status: "failed", note: "It never finished." });
      // A stuck forced run counts as not having helped.
      if (record.last.reason === "over-budget") record.blockedUntil = new Date(Date.now() + FORCE_BACKOFF_MS).toISOString();
    });
    if (last.agentId) await this.host.paseo?.agents.ref(last.agentId).archive().catch(() => null);
  }

  /** A tidy chat's turn ended: check what it left, record it, and archive the chat when all is well. */
  async finished(botId: string, agentId: string, outcome: PluginTurnOutcome, reply: string): Promise<void> {
    const result = await this.update(botId, async (record) => {
      if (!record.last || record.last.agentId !== agentId || record.last.status !== "running") return null;
      const after = await memoryUsage(botId);
      const failed = outcome.kind !== "completed";
      const check = failed ? { flags: [] as string[], stillOver: false } : checkTidyResult(record.last.before, after);
      Object.assign(record.last, {
        status: failed ? "failed" : "succeeded",
        note: failed ? (outcome.kind === "failed" ? outcome.error.message : "Stopped before it finished.") : reply.trim() ? foldText(reply, 400) : null,
        flags: check.flags,
      });
      const forced = record.last.reason === "over-budget";
      if (forced && (failed || check.stillOver)) record.blockedUntil = new Date(Date.now() + FORCE_BACKOFF_MS).toISOString();
      else if (!failed) record.blockedUntil = null;
      return { clean: !failed && check.flags.length === 0 };
    });
    if (result?.clean) await this.host.paseo?.agents.ref(agentId).archive().catch(() => null);
  }
}
