// The plugin's own tools, served to every local bot chat as the MCP server
// "bots": other bots, past chats, the setup, and proposals (skills, routines,
// setup changes, app connections) the user confirms in the chat.

export const TOOLS_MCP_NAME = "bots";

const BOT_TOOL_NAMES = ["list_bots", "ask_bot", "check_chat", "search_chats", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app"] as const;
export type BotToolName = (typeof BOT_TOOL_NAMES)[number];

/**
 * Tools that only read or only propose something the user confirms, so they
 * run without a permission prompt. Asking another bot is left to the bot's
 * "Contact other bots" setting.
 */
export const QUIET_TOOLS: readonly BotToolName[] = ["list_bots", "check_chat", "search_chats", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app"];

/**
 * The bot tool a timeline tool call is, whatever the provider calls it:
 * Claude `mcp__bots__ask_bot`, Codex `bots.ask_bot`, others `bots_ask_bot`.
 */
export function botToolName(name: string): BotToolName | null {
  const match = /^(?:mcp__)?bots(?:__|\.|_)([a-z_]+)$/.exec(name.trim());
  const tool = match?.[1];
  return tool && (BOT_TOOL_NAMES as readonly string[]).includes(tool) ? (tool as BotToolName) : null;
}

/** Providers that accept exact MCP tool grants (Paseo refuses the chat for others). */
export function supportsToolGrants(provider: string): boolean {
  return /^(claude|codex|opencode)(\b|$)/.test(provider);
}

/** The prompt section for the plugin's own tools, given to chats that get them (bots on the plugin's host). */
export function botToolsPrompt(canAsk: boolean): string {
  const others = canAsk ? "list_bots to see the other bots and ask_bot to ask one for help (check_chat follows up; to ask several at once, call ask_bot with wait set to false for each of them, then check_chat for each answer)" : "list_bots to see the other bots";
  return `Your own tools come from the MCP server "bots". Use propose_routine for your own recurring or webhook-started work (rather than Paseo schedules) and propose_skill to keep a way of working for next time. When the user asks you to set up or change bots, teams, skills, MCP servers or defaults, read get_setup and put all the changes in one propose_changes call. The user confirms proposals on a card in the chat. Use search_chats to look through your past chats and daily log, and ${others}.`;
}

/**
 * The prompt section for a bot whose tools are files in its folder (no MCP server): what to read,
 * where to write what the user should confirm, and the shapes of those files.
 */
export function botFilesPrompt(bot: { contactBots: string }, home: string): string {
  return [
    `Your own tools are files in your folder ${home}. Use your file tools to read and write them.`,
    "",
    `Read the setup: ${home}/setup/overview.md lists the bots (name, role, provider, whether they may contact others), the teams, the library\'s skills and external servers, what new bots start with, and the providers with their model and mode ids. ${home}/setup/bots/<bot id>.md describes one bot in full. They are kept up to date for you; do not edit them. Read ${home}/setup/proposal-format.md before writing a proposal that is more than a few fields.`,
    "",
    `Search your past chats: ${home}/history/ has a transcript of each recent chat of yours, and your memory is ${home}/MEMORY.md and ${home}/memory/. Search them with your file search.`,
    "",
    `Propose something for the user to confirm (changes to the setup, a routine, a skill): write ONE JSON file into ${home}/proposals/. Name it <kind>-<YYYYMMDD-HHMM>-<4 random letters>.json so the name is unique every time, and write it as the last step of your turn. The user sees a card in this chat and decides. Do not apply anything yourself. If a file is not accepted you are told here, and the reason is in ${home}/proposals/done/<name>.result.txt; write a corrected file under a new name. The shapes:`,
    '{"kind":"changes","summary":"one line for the card","changes":[{"type":"update_bot","bot":"<a bot name>","title":"...","description":"...","instructions":"..."}]}',
    '{"kind":"routine","name":"Morning check","instructions":"what to do on each run","schedule":{"type":"daily","time":"08:30"}}',
    '{"kind":"skill","name":"weekly-report","description":"when to use it","instructions":"markdown steps"}',
    ...(bot.contactBots === "off"
      ? []
      : [
          "",
          `Ask another bot for help: write ONE JSON file per question into ${home}/outbox/, named ask-<YYYYMMDD-HHMM>-<4 random letters>.json (a different name for each), as the last step of your turn, and then end your turn. To ask several bots at once, write all their files in the same turn. Each answer arrives as its own message when that bot is done, so you do not wait for the slowest. The other bot works in a chat of its own and its answer arrives in this chat as a message, framed as information from another bot. ${bot.contactBots === "ask" ? "The user is asked first and may say no. " : ""}A chat started by another bot can't ask further. The names of the bots are in ${home}/setup/overview.md.`,
          '{"kind":"ask","to":"<a bot name>","message":"what you need, written so it works without this chat"}',
        ]),
  ].join("\n");
}
