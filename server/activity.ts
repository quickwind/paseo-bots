import type { PluginLifecycleEvents, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { lastTurn, logLine } from "../shared/activity";
import { contextPercent, savePrompt, TIDY_LABEL } from "../shared/memory-maintenance";
import { newUuid } from "../shared/uuid";
import type { BotsHost } from "./host";
import type { MemoryJournal } from "./journal";
import type { ChatActivity, SaveTracker } from "./maintenance";
import { appendDailyLog, inboxPath } from "./memory";
import type { RoutineScheduler } from "./scheduler";

// What happens around each turn of a bot's chat: the journal notes memory
// changes, the daily log gets a line saying what the bot did, and a chat whose
// context is filling up is asked to save its notes.

/** Pieces of memory maintenance; turns work without them. */
export interface Maintenance {
  activity: ChatActivity;
  saves: SaveTracker;
  tidy: { finished(botId: string, agentId: string, outcome: PluginTurnOutcome, reply: string): Promise<void> } | null;
}

export async function turnStarted(host: BotsHost, journal: MemoryJournal, { agent }: PluginLifecycleEvents["agent.turn_started"], maintenance?: Maintenance): Promise<void> {
  const botId = await host.botIdOf(agent.id);
  if (!botId) return;
  maintenance?.activity.started(botId, agent.id);
  await journal.begin(botId);
}

export async function turnEnded(host: BotsHost, journal: MemoryJournal, scheduler: Pick<RoutineScheduler, "finished">, { agent, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"], maintenance?: Maintenance): Promise<void> {
  const chat = await host.chatOf(agent.id);
  if (!chat) return;
  const { botId } = chat;
  maintenance?.activity.ended(botId, agent.id);
  const title = chat.title?.trim() || agent.title?.trim() || "Untitled chat";
  await journal.end(botId, { id: agent.id, title });
  const { reply, tools } = lastTurn(timeline);
  const isTidy = Boolean(chat.labels[TIDY_LABEL]);
  const wasSave = maintenance?.saves.consume(agent.id) ?? false;
  if (isTidy) {
    // A tidy turn is the app's own work; logging it would look like new material to the next tidy.
    await maintenance?.tidy?.finished(botId, agent.id, outcome, reply);
    return;
  }
  if (chat.routineId) await scheduler.finished(chat.routineId, agent.id, outcome, reply);
  if (outcome.kind === "canceled") return;
  // A save turn is the app's own request; logging it would make "recent work" say "Saved."
  if (!wasSave) {
    const line = logLine({ at: new Date(), chat: title, reply, tools, failure: outcome.kind === "failed" ? outcome.error.message : null });
    if (line) await appendDailyLog(botId, line);
  }
  if (maintenance && !wasSave && !chat.routineId && outcome.kind === "completed") await askToSave(host, maintenance, botId, agent.id);
}

/** Over the bot's threshold and idle: put one save request into the chat. */
async function askToSave(host: BotsHost, maintenance: Maintenance, botId: string, agentId: string): Promise<void> {
  const bot = await host.bot(botId);
  if (!bot || !bot.memory.saveAt.enabled || bot.hostId) return;
  const snapshot = await host.paseo?.agents.ref(agentId).refresh().catch(() => null);
  const agent = snapshot?.agent;
  if (!agent) return;
  // The user may already have sent the next message; ask after that turn instead. Checking this
  // before `decide` matters: `decide` records that the chat was asked.
  if (agent.status === "running" || agent.status === "initializing") return;
  const percent = contextPercent(agent.lastUsage as { contextWindowUsedTokens?: number | null; contextWindowMaxTokens?: number | null } | null | undefined);
  if (!maintenance.saves.decide(agentId, percent, bot.memory.saveAt.percent)) return;
  maintenance.saves.markSent(agentId);
  await host.paseo!.agents
    .ref(agentId)
    .send(savePrompt(inboxPath(botId)), { messageId: newUuid() } as never)
    .catch((error: unknown) => {
      maintenance.saves.consume(agentId);
      console.error("paseo-bots: couldn't ask a chat to save its notes", error);
    });
}
