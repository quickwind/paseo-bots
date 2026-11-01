import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { ensureBotHome, ensureBotsHome } from "./server/bot-home";
import { turnEnded, turnStarted } from "./server/activity";
import { CommandAllowlist } from "./server/commands";
import { Approvals } from "./server/approvals";
import { Asks } from "./server/asks";
import { getApproval, listApprovals, readAudit } from "./server/approvals-store";
import { ProposalNotices } from "./server/proposal-notices";
import { FileTools } from "./server/file-tools";
import { identityStatus, refreshIdentities, refreshIdentity, withBotLock, writeIdentity } from "./server/identity";
import { MemoryJournal } from "./server/journal";
import { ChatActivity, SaveTracker } from "./server/maintenance";
import { deleteLogDay, listLogDays, listMemory, readLogDay, readMemory } from "./server/memory";
import { systemPrompt } from "./server/prompt";
import { RoutineScheduler } from "./server/scheduler";
import { MemoryTidy } from "./server/tidy";
import { exportBot, exportTeam, importBot, importTeam } from "./server/share";
import { deleteSkill, importSkills, migrateBotSkills, readSkill, writeSkill } from "./server/library";
import { probeMcpServer } from "./server/mcp-probe";
import { mcpSources } from "./server/mcp-sources";
import { BotsHost } from "./server/host";
import { Relay } from "./server/relay";
import { acceptProposal, dismissProposal, getProposal } from "./server/proposals";
import { teamOf } from "./shared/groups";
import { readHostCaps } from "./server/host-caps";
import { mayAttachReports } from "./shared/reports";
import { ensureTeamReports, sweepReports } from "./server/reports";
import { listGrants, revokeProject } from "./server/project-grants";
import { workspaceApproved, workspaceRefused } from "./server/workspaces";
import { scopeOf } from "./shared/workspaces";
import { BOT_TOOLS } from "./server/tools";
import { saveUpload } from "./server/uploads";
import { botSettings, EMPTY_LIBRARY } from "./shared/bot";
import { shellCommand } from "./shared/commands";
import {
  commandAllowRpc,
  commandListRpc,
  projectGrantListRpc,
  hostCapsRpc,
  projectGrantRevokeRpc,
  commandRemoveRpc,
  ensureBotHomeRpc,
  exportBotRpc,
  exportTeamRpc,
  helloRpc,
  importBotRpc,
  importTeamRpc,
  memoryDeleteRpc,
  memoryJournalRpc,
  memoryListRpc,
  memoryLogDeleteRpc,
  memoryLogRpc,
  memoryReadRpc,
  identityStatusRpc,
  memoryUndoRpc,
  tidyRunRpc,
  tidyStatusRpc,
  memoryWriteRpc,
  mountRpc,
  mcpProbeRpc,
  mcpSourcesRpc,
  approvalAuditRpc,
  approvalDecideRpc,
  approvalGetRpc,
  approvalListRpc,
  approvalWithdrawRpc,
  proposalAcceptRpc,
  proposalDismissRpc,
  proposalGetRpc,
  routineRunNowRpc,
  routineStatusRpc,
  routineWebhookRpc,
  skillDeleteRpc,
  skillImportRpc,
  skillReadRpc,
  skillWriteRpc,
  systemPromptRpc,
  uploadRpc,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  // Writes the Bots project icon.
  void ensureBotsHome()
    .then(migrateBotSkills)
    .catch((error: unknown) => console.error("aydo: couldn't prepare the Bots folder", error));
  const settings = server.registerSettings(botSettings);
  const library = async () => {
    const state = await settings.read();
    return state.status === "ready" ? (state.values.library ?? EMPTY_LIBRARY) : EMPTY_LIBRARY;
  };
  const host = new BotsHost(settings);
  // Devin reads each bot's identity from a rules file in its folder: write them at start and whenever the settings change.
  let identityTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshSoon = () => {
    if (identityTimer) clearTimeout(identityTimer);
    identityTimer = setTimeout(() => void refreshIdentities(host), 1000);
  };
  const stopWatchingSettings = settings.subscribe(() => {
    refreshSoon();
    // A bot that was deleted can no longer answer its approvals.
    setTimeout(() => void approvals.sweep().catch((error: unknown) => console.error("aydo: couldn't sweep the approvals", error)), 1500);
  });
  host.onAttach(refreshSoon);
  // Bots' tools go through this relay; it reads the saved settings on every call.
  const relay = new Relay(host, BOT_TOOLS);
  void relay.start().catch((error: unknown) => console.error("aydo: couldn't start the relay", error));
  const scheduler = new RoutineScheduler(host, relay);
  const journal = new MemoryJournal();
  const chatActivity = new ChatActivity();
  const tidy = new MemoryTidy(host, relay, chatActivity);
  const asks = new Asks(host, relay);
  relay.asks = asks;
  // After a decision the asks restart their stall clocks and deliver the reports that waited for the chat.
  const approvals = new Approvals(host, async (chat) => {
    await asks.approvalDecided(chat);
    await asks.deliver(chat);
  });
  relay.approvals = approvals;
  const sweepApprovals = () => void approvals.sweep().catch((error: unknown) => console.error("aydo: couldn't sweep the approvals", error));
  host.onAttach(sweepApprovals);
  const maintenance = { activity: chatActivity, saves: new SaveTracker(), tidy, fileTools: new FileTools(host, relay, asks, chatActivity, approvals), asks };
  const notices = new ProposalNotices(() => host.paseo);
  // A question nobody answered is closed after half an hour.
  // Reports: whole records are kept while a project is active and go thirty days after its last workspace is archived.
  const sweepReportsNow = () => void sweepReports(host).catch((error: unknown) => console.error("aydo: couldn't sweep the team reports", error));
  host.onAttach(sweepReportsNow);
  const reportsTimer = setInterval(sweepReportsNow, 6 * 3_600_000);
  const approvalsTimer = setInterval(() => void approvals.sweep().catch((error: unknown) => console.error("aydo: couldn't sweep the approvals", error)), 5 * 60_000);
  const asksTimer = setInterval(() => void asks.sweep().catch((error: unknown) => console.error("aydo: couldn't close old requests", error)), 5 * 60_000);
  const commands = new CommandAllowlist();
  // Every handler and hook receives the plugin's Paseo API; features that start chats need it.
  const attach = ({ paseo }: PluginHandlerContext) => host.attach(paseo);

  server.handle(helloRpc, (_input, context) => {
    attach(context);
    return { scheduler: scheduler.running };
  });
  server.handle(ensureBotHomeRpc, async (input, context) => {
    attach(context);
    const home = await ensureBotHome(input);
    const team = teamOf(input.botId, (await host.values())?.groups ?? []);
    return { ...home, reports: team && mayAttachReports({ id: input.botId }, team, {}) ? await ensureTeamReports(team.id).catch(() => null) : null };
  });
  server.handle(systemPromptRpc, async (input, context) => {
    const [saved, settings] = [await library(), await host.values()];
    // The app creates its chats itself, right after asking for the prompt: Devin finds the identity in the bot's folder.
    if (input.local && !input.bot.hostId) {
      await withBotLock(input.bot.id, () => writeIdentity(input.bot, saved, { paseo: context.paseo, settings })).catch((error: unknown) => console.error(`aydo: couldn't write ${input.bot.name}'s identity`, error));
    }
    return systemPrompt(input, saved, context.paseo, settings);
  });
  server.handle(memoryListRpc, ({ botId }) => listMemory(botId));
  server.handle(identityStatusRpc, ({ botId }) => identityStatus(host, botId));
  server.handle(tidyStatusRpc, ({ botId }) => tidy.status(botId));
  server.handle(tidyRunRpc, ({ botId }, context) => {
    attach(context);
    return tidy.runNow(botId);
  });
  server.handle(memoryReadRpc, ({ botId, name }) => readMemory(botId, name));
  server.handle(memoryWriteRpc, async ({ botId, name, text }) => {
    await journal.write(botId, name, text);
    return { ok: true };
  });
  server.handle(memoryDeleteRpc, async ({ botId, name }) => {
    await journal.write(botId, name, null);
    return { ok: true };
  });
  server.handle(memoryJournalRpc, async ({ botId }) => ({
    entries: (await journal.list(botId)).map(({ before, ...entry }) => ({ ...entry, canUndo: entry.kind === "created" || before !== null })),
  }));
  server.handle(memoryUndoRpc, async ({ botId, id }) => {
    await journal.undo(botId, id);
    return { ok: true };
  });
  server.handle(memoryLogRpc, async ({ botId, day }) => ({ ...(await listLogDays(botId)), text: day ? (await readLogDay(botId, day)).text : null }));
  server.handle(memoryLogDeleteRpc, ({ botId, day }) => deleteLogDay(botId, day));
  server.handle(skillImportRpc, importSkills);
  server.handle(skillReadRpc, readSkill);
  server.handle(skillWriteRpc, writeSkill);
  server.handle(skillDeleteRpc, deleteSkill);
  server.handle(mcpProbeRpc, probeMcpServer);
  server.handle(mcpSourcesRpc, () => mcpSources());
  server.handle(mountRpc, async ({ botId, agentId }) => ({ tools: await relay.mountTools(botId, agentId) }));
  server.handle(proposalGetRpc, async ({ id }) => ({ proposal: await getProposal(id) }));
  server.handle(proposalAcceptRpc, async ({ id }, context) => {
    const accepted = await acceptProposal(id);
    if (accepted.proposal.kind === "ask") {
      attach(context);
      await asks.approved(accepted.proposal);
    } else {
      attach(context);
      notices.add(accepted.proposal, "accepted");
    }
    if (accepted.proposal.kind === "workspace") {
      attach(context);
      await workspaceApproved(accepted.proposal, host);
    }
    return accepted;
  });
  server.handle(proposalDismissRpc, async ({ id }, context) => {
    const proposal = await dismissProposal(id);
    if (proposal.kind === "ask") {
      attach(context);
      await asks.refused(proposal);
    } else {
      attach(context);
      notices.add(proposal, "dismissed");
    }
    if (proposal.kind === "workspace") {
      attach(context);
      await workspaceRefused(proposal, host);
    }
    return { proposal };
  });
  server.handle(approvalGetRpc, async ({ id }) => ({ approval: await getApproval(id) }));
  server.handle(approvalListRpc, async ({ status }) => {
    const all = await listApprovals();
    const pending = all.filter((entry) => entry.status === "pending");
    // Summaries only: the text and the file are fetched with the one approval a card shows.
    const light = (status === "pending" ? pending : all).map(({ text: _text, file: _file, ...summary }) => summary);
    return { approvals: light, pending: pending.length };
  });
  server.handle(approvalDecideRpc, async (input, context) => {
    attach(context);
    return { approval: await approvals.decide(input.id, input) };
  });
  server.handle(approvalWithdrawRpc, async ({ id }, context) => {
    attach(context);
    return { approval: await approvals.withdraw(id, "user") };
  });
  server.handle(approvalAuditRpc, async ({ approvalId, limit }) => ({ events: await readAudit({ ...(approvalId ? { approvalId } : {}), limit: limit ?? 200 }) }));
  server.handle(routineStatusRpc, (_input, context) => {
    attach(context);
    return scheduler.status();
  });
  server.handle(routineRunNowRpc, ({ botId, routineId }, context) => {
    attach(context);
    return scheduler.runNow(botId, routineId);
  });
  server.handle(routineWebhookRpc, ({ routineId, rotate }) => scheduler.webhookUrl(routineId, rotate));
  server.handle(hostCapsRpc, () => readHostCaps());
  server.handle(projectGrantListRpc, async (input) => ({ projects: await listGrants(scopeOf(input)) }));
  server.handle(projectGrantRevokeRpc, async ({ projectId, ...scope }) => ({ ok: await revokeProject(scopeOf(scope), projectId) }));
  server.handle(commandListRpc, async ({ botId }) => ({ rules: await commands.list(botId) }));
  server.handle(commandAllowRpc, async ({ botId, command, cwd }) => ({ rule: await commands.add(botId, command, cwd) }));
  server.handle(commandRemoveRpc, async ({ botId, id }) => ({ ok: await commands.remove(botId, id) }));
  server.handle(exportBotRpc, async (input) => exportBot(input, await library()));
  server.handle(importBotRpc, importBot);
  server.handle(exportTeamRpc, async (input) => exportTeam(input, await library()));
  server.handle(importTeamRpc, importTeam);
  server.handle(uploadRpc, saveUpload);
  server.on("agent.turn_started", async (event, context) => {
    host.attach(context.paseo);
    await approvals.turnStarted(event.agent.id).catch((error: unknown) => console.error("aydo: couldn't note a turn in a waiting chat", error));
    await turnStarted(host, journal, event, maintenance).catch((error: unknown) => console.error("aydo: couldn't check memory before a turn", error));
  });
  // A bot's saved commands (exact command, exact folder) are approved here instead of asking.
  server.on("agent.permission_requested", async ({ agent, request }, context) => {
    host.attach(context.paseo);
    const shell = shellCommand(request, agent.cwd);
    if (!shell) return;
    const chat = await host.chatOf(agent.id);
    if (!chat || !(await commands.matches(chat.botId, shell.command, shell.cwd))) return;
    await context.paseo.agents
      .ref(agent.id)
      .respondToPermission({ requestId: request.id, response: { behavior: "allow" } })
      .catch((error: unknown) => console.error("aydo: couldn't approve an allowed command", error));
  });
  // An archived chat can no longer answer: its waiting approval is withdrawn and what was held for it dropped.
  server.on("agent.archived", async ({ agent }, context) => {
    host.attach(context.paseo);
    await approvals.withdrawForChat(agent.id).catch((error: unknown) => console.error("aydo: couldn't withdraw an approval of an archived chat", error));
  });
  server.on("agent.turn_ended", async (event, context) => {
    host.attach(context.paseo);
    // What was held while a decision waited for this turn to end goes out now.
    await approvals.release(event.agent.id).catch((error: unknown) => console.error("aydo: couldn't release held messages", error));
    await turnEnded(host, journal, scheduler, event, maintenance).catch((error: unknown) => console.error("aydo: couldn't record a turn", error));
    void notices.flush(event.agent.id);
    // The memory may have changed in this turn, and a chat created next reads it from the identity file.
    const botId = await host.botIdOf(event.agent.id).catch(() => null);
    if (botId) void refreshIdentity(host, botId);
  });

  return () => {
    scheduler.stop();
    tidy.stop();
    notices.stop();
    stopWatchingSettings();
    clearInterval(asksTimer);
    clearInterval(approvalsTimer);
    clearInterval(reportsTimer);
    if (identityTimer) clearTimeout(identityTimer);
    relay.stop();
  };
}
