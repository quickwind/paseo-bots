import type { Bot } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import { ASK_PREAPPROVED_LABEL, askPreapproval, teamOf } from "../shared/groups";
import { sendsPromptInChat } from "../shared/identity";
import { usesFiles } from "../shared/tools-mode";
import { newUuid } from "../shared/uuid";
import { ensureBotHome } from "./bot-home";
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
export async function startChat(host: BotsHost, relay: Relay, bot: Bot, input: { prompt: string; title: string; labels: Record<string, string>; agentId?: string }): Promise<string> {
  const paseo = host.requirePaseo();
  if (bot.hostId) throw new Error(`${bot.name} runs on another host, so its chats can't be started from here.`);
  const library = await host.library();
  const home = await ensureBotHome({ botId: bot.id });
  const settings = await host.values();
  return withBotLock(bot.id, async () => {
    // The saved bot, not `bot`: a maintenance chat runs as a trimmed copy that must not become the identity.
    await writeIdentity((await host.bot(bot.id)) ?? bot, library, { paseo, settings }).catch((error: unknown) => console.error(`bot-crew: couldn't write ${bot.name}'s identity`, error));
    const { systemPrompt: system } = await systemPrompt({ bot, local: true, message: input.prompt }, library, paseo, settings);
    const agentId = input.agentId ?? newUuid();
    const askFreely = !!teamOf(bot.id, settings?.groups ?? [])?.askFreely;
    const tools = usesFiles(settings?.toolMode, bot.provider) ? null : await relay.mountTools(bot.id, agentId);
    // ask_bot runs without a prompt in this chat when the bot or its team allows it. The chat remembers why,
    // so turning the setting off later still stops it (the tool permission was fixed when the chat started).
    const preapproved = tools ? askPreapproval(bot, askFreely) : null;
    const placement = bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root };
    return startBotChat(paseo, {
      bot,
      library,
      agentId,
      // A provider that cannot use the plugin's MCP server (Devin) gets the tools as files instead.
      plugin: tools ? { tools, ...(askFreely ? { askFreely: true } : {}) } : {},
      placement,
      prompt: input.prompt,
      systemPrompt: sendsPromptInChat(bot.provider, placement.path, home.path) ? system : "",
      title: input.title,
      labels: preapproved ? { ...input.labels, [ASK_PREAPPROVED_LABEL]: preapproved } : input.labels,
    });
  });
}
