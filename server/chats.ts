import type { Bot } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import { teamOf } from "../shared/groups";
import { sendsPromptInChat } from "../shared/identity";
import { usesFiles } from "../shared/tools-mode";
import { newUuid } from "../shared/uuid";
import { ensureBotHome } from "./bot-home";
import { readHostCaps } from "./host-caps";
import { TIDY_LABEL } from "../shared/memory-maintenance";
import { mayAttachReports } from "../shared/reports";
import { ensureTeamReports } from "./reports";
import type { BotsHost } from "./host";
import { withBotLock, writeIdentity } from "./identity";
import { systemPrompt } from "./prompt";
import type { Relay } from "./relay";

/**
 * Starts a chat for a bot on this host, the way the app does: its system
 * prompt, its folder, and the plugin's tools. Routines and
 * requests from other bots start chats with it.
 *
 * Devin reads the bot's identity from a rules file in the bot's folder when its session is
 * created, so writing that file and creating the chat go one after another per bot.
 */
export async function startChat(host: BotsHost, relay: Relay, bot: Bot, input: { prompt: string; title: string; labels: Record<string, string>; agentId?: string; workspace?: { id: string; path: string } }): Promise<string> {
  const paseo = host.requirePaseo();
  if (bot.hostId) throw new Error(`${bot.name} runs on another host, so its chats can't be started from here.`);
  const library = await host.library();
  const home = await ensureBotHome({ botId: bot.id });
  const settings = await host.values();
  return withBotLock(bot.id, async () => {
    // The saved bot, not `bot`: a maintenance chat runs as a trimmed copy that must not become the identity.
    await writeIdentity((await host.bot(bot.id)) ?? bot, library, { paseo, settings }).catch((error: unknown) => console.error(`aydo: couldn't write ${bot.name}'s identity`, error));
    const { systemPrompt: system } = await systemPrompt({ bot, local: true, message: input.prompt, maintenance: Boolean(input.labels[TIDY_LABEL]) }, library, paseo, settings);
    const agentId = input.agentId ?? newUuid();
    const askFreely = !!teamOf(bot.id, settings?.groups ?? [])?.askFreely;
    const tools = usesFiles(settings?.toolMode, bot.provider, bot.toolMode) ? null : await relay.mountTools(bot.id, agentId);
    const placement = bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root };
    // What the host announced it does for Devin (stock Paseo announces nothing).
    const hostCaps = readHostCaps();
    // The team's lead gets the team's report folder attached (not its members, and not a memory tidy chat).
    const team = teamOf(bot.id, settings?.groups ?? []);
    const reports = team && mayAttachReports(bot, team, input.labels) ? await ensureTeamReports(team.id).catch(() => null) : null;
    return startBotChat(paseo, {
      bot,
      library,
      agentId,
      home: home.path,
      ...(reports ? { extraFolders: [reports] } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
      hostCaps,
      // A provider that cannot use the plugin's MCP server (Devin) gets the tools as files instead.
      plugin: tools ? { tools, ...(askFreely ? { askFreely: true } : {}) } : {},
      placement,
      prompt: input.prompt,
      systemPrompt: sendsPromptInChat(bot.provider, input.workspace?.path ?? placement.path, home.path, hostCaps) ? system : "",
      title: input.title,
      labels: input.labels,
    });
  });
}
