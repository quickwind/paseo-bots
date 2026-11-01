import type { PluginLifecycleEvents, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { lastTurn, logLine } from "../shared/activity";
import { reportRecord } from "../shared/reports";
import { workspaceLabel } from "../shared/workspaces";
import { contextPercent, savePrompt, TIDY_LABEL } from "../shared/memory-maintenance";
import type { BotsHost } from "./host";
import type { MemoryJournal } from "./journal";
import { ASK_REQUEST_LABEL, type Asks } from "./asks";
import type { FileTools } from "./file-tools";
import type { ChatActivity, SaveTracker } from "./maintenance";
import { appendDailyLog, inboxPath } from "./memory";
import type { RoutineScheduler } from "./scheduler";
import { pendingFor } from "./approvals-store";
import { sendIntoChat } from "./chat-send";
import { recordReport } from "./reports";
import { turnFacts } from "./turn-facts";
import { turnTimeline } from "./turn-timeline";

// What happens around each turn of a bot's chat: the journal notes memory
// changes, the daily log gets a line saying what the bot did, and a chat whose
// context is filling up is asked to save its notes.

/** Pieces of memory maintenance; turns work without them. */
export interface Maintenance {
  activity: ChatActivity;
  saves: SaveTracker;
  tidy: { finished(botId: string, agentId: string, outcome: PluginTurnOutcome, reply: string): Promise<void> } | null;
  /** For bots whose tools are files: reads their proposal files after a turn. */
  fileTools?: Pick<FileTools, "afterTurn" | "discardTurn"> | null;
  /** For a chat started to answer another bot: its reply goes back to the asking chat. */
  asks?: Pick<Asks, "answered"> | null;
}

export async function turnStarted(host: BotsHost, journal: MemoryJournal, { agent }: PluginLifecycleEvents["agent.turn_started"], maintenance?: Maintenance): Promise<void> {
  const botId = await host.botIdOf(agent.id);
  if (!botId) return;
  maintenance?.activity.started(botId, agent.id);
  await journal.begin(botId);
}

export async function turnEnded(host: BotsHost, journal: MemoryJournal, scheduler: Pick<RoutineScheduler, "finished">, event: PluginLifecycleEvents["agent.turn_ended"], maintenance?: Maintenance): Promise<void> {
  const { agent, outcome } = event;
  const chat = await host.chatOf(agent.id);
  if (!chat) {
    // The chat could not be looked up (the daemon was busy): a bot whose turn started here is still freed, or it would count as working for hours.
    const known = await host.botIdOf(agent.id);
    if (known) maintenance?.activity.ended(known, agent.id);
    return;
  }
  const { botId } = chat;
  maintenance?.activity.ended(botId, agent.id);
  const title = chat.title?.trim() || agent.title?.trim() || "Untitled chat";
  await journal.end(botId, { id: agent.id, title });
  // Paseo 0.13 and later send the event with an empty timeline: the turn is read from the chat.
  const timeline = await turnTimeline(host.paseo, agent.id, event.timeline);
  const { reply, tools } = lastTurn(timeline);
  const isTidy = Boolean(chat.labels[TIDY_LABEL]);
  // A bot on files asks for approval by writing a file, which exists as an approval only once the plugin has read it: read it
  // before the turn is reported (an assignment whose chat waits for approval is not finished) or logged (`waiting`).
  if (!isTidy && outcome.kind !== "canceled" && maintenance?.fileTools) {
    const filesBot = await host.bot(botId);
    if (filesBot && !filesBot.hostId) {
      await maintenance.fileTools.afterTurn({ bot: filesBot, agentId: agent.id, timeline, labels: chat.labels }).catch((error: unknown) => console.error("aydo: couldn't read the bot's proposal files", error));
    }
  }
  if (chat.labels[ASK_REQUEST_LABEL]) await maintenance?.asks?.answered({ agentId: agent.id, labels: chat.labels, outcome, reply }).catch((error: unknown) => console.error("aydo: couldn't pass on a bot's answer", error));
  const wasSave = maintenance?.saves.consume(agent.id) ?? false;
  if (isTidy) {
    // A tidy turn is the app's own work; logging it would look like new material to the next tidy.
    await maintenance?.tidy?.finished(botId, agent.id, outcome, reply);
    // It runs in the bot's folder and may have written tool files (an injected note could ask it to); none of them are accepted.
    const bot = maintenance?.fileTools ? await host.bot(botId) : null;
    if (bot && !bot.hostId) await maintenance!.fileTools!.discardTurn({ bot, timeline }).catch((error: unknown) => console.error("aydo: couldn't settle a tidy chat's tool files", error));
    return;
  }
  if (chat.routineId) await scheduler.finished(chat.routineId, agent.id, outcome, reply);
  // A save turn is the app's own request; logging it would make "recent work" say "Saved."
  if (!wasSave) {
    const facts = await turnFacts(host, { agentId: agent.id, chat, timeline, outcome, reply });
    // A stopped turn is logged too (with whatever it had said so far): that the user stopped it is worth knowing.
    const line = logLine({ at: new Date(), chat: title, reply, tools, failure: outcome.kind === "failed" ? outcome.error.message : null, meta: facts.meta, stopped: outcome.kind === "canceled" });
    if (line) await appendDailyLog(botId, line);
    // A team member's turn in a project workspace is also kept, whole, in the team's reports.
    const bot = facts.workspace ? await host.bot(botId) : null;
    if (bot && facts.workspace) {
      const record = reportRecord({
        at: new Date(),
        bot: { id: bot.id, name: bot.name },
        chat: { id: agent.id, title },
        project: { id: facts.workspace.projectId, name: facts.workspace.projectName },
        workspace: workspaceLabel(facts.workspace),
        driver: facts.driver,
        status: facts.status,
        question: facts.question,
        answer: outcome.kind === "failed" ? `(turn failed: ${outcome.error.message})` : reply,
      });
      await recordReport(host, { bot, record }).catch((error: unknown) => console.error("aydo: couldn't write a team report", error));
    }
  }
  if (outcome.kind === "canceled") return;
  if (maintenance && !wasSave && !chat.routineId && outcome.kind === "completed") await askToSave(host, maintenance, botId, agent.id);
}

/** Over the bot's threshold and idle: put one save request into the chat. */
export async function askToSave(host: BotsHost, maintenance: Maintenance, botId: string, agentId: string): Promise<void> {
  const bot = await host.bot(botId);
  if (!bot || !bot.memory.saveAt.enabled || bot.hostId) return;
  const snapshot = await host.paseo?.agents.ref(agentId).refresh().catch(() => null);
  const agent = snapshot?.agent;
  if (!agent) return;
  // The user may already have sent the next message; ask after that turn instead. Checking this
  // before `decide` matters: `decide` records that the chat was asked.
  if (agent.status === "running" || agent.status === "initializing") return;
  const percent = contextPercent(agent.lastUsage as { contextWindowUsedTokens?: number | null; contextWindowMaxTokens?: number | null } | null | undefined);
  // A chat that waits for the user's approval is asked after the decision, not now.
  if (await pendingFor(agentId)) return;
  if (!maintenance.saves.decide(agentId, percent, bot.memory.saveAt.percent)) return;
  maintenance.saves.markSent(agentId);
  await sendIntoChat(host.paseo!, agentId, savePrompt(inboxPath(botId))).catch((error: unknown) => {
      maintenance.saves.consume(agentId);
      console.error("aydo: couldn't ask a chat to save its notes", error);
    });
}
