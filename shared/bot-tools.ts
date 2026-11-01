// The plugin's own tools, served to every local bot chat as the MCP server
// "bots": other bots, past chats, the setup, and proposals (skills, routines,
// setup changes, app connections) the user confirms in the chat.

export const TOOLS_MCP_NAME = "bots";

const BOT_TOOL_NAMES = ["list_bots", "ask_bot", "check_chat", "search_chats", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app", "list_workspaces", "create_workspace", "assign_bot", "request_approval", "list_approvals", "withdraw_approval"] as const;
export type BotToolName = (typeof BOT_TOOL_NAMES)[number];

/**
 * Tools that only read or only propose something the user confirms, so they
 * run without a permission prompt. Asking another bot is left to the bot's
 * "Contact other bots" setting.
 */
export const QUIET_TOOLS: readonly BotToolName[] = ["list_bots", "check_chat", "search_chats", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app", "list_workspaces", "create_workspace", "assign_bot", "request_approval", "list_approvals", "withdraw_approval"];

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
  const others = canAsk ? "list_bots to see the other bots and ask_bot to ask one for help (an answer that takes longer than a minute arrives in this chat as a message; check_chat looks at a chat yourself; to ask several at once, call ask_bot with wait set to false for each of them and carry on, each answer comes as its own message). To hand a task to another bot in a workspace of the user's projects, call assign_bot: it starts work there in a chat of its own, its report arrives in this chat as a message when it is done (it can take hours), so end your turn after assigning" : "list_bots to see the other bots";
  return `Your own tools come from the MCP server "bots". Use propose_routine for your own recurring or webhook-started work (rather than Paseo schedules) and propose_skill to keep a way of working for next time. When the user asks you to set up or change bots, teams, skills, MCP servers or defaults, read get_setup and put all the changes in one propose_changes call. The user confirms proposals on a card in the chat. Use list_workspaces to see where the user's projects keep their work and create_workspace from the "bots" server to open a workspace for a piece of work (a worktree or a folder), not Paseo's own tool of the same name, which skips the user's approval; the first time your team uses a project, a card in this chat asks the user. Use search_chats to look through your past chats and daily log, and ${others}. When your instructions or the user say a matter needs the user's approval, call request_approval with a title, the text and optionally a file, then stop and wait: the answer comes into this chat as a message, and only the user can give it. After an approval, cite its id in the approval field of the tool that starts the work (create_workspace has one); list_approvals finds the ids.`;
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
    '{"kind":"changes","summary":"one line for the card","changes":[{"type":"update_bot","bot":"<a bot name>","name":"<new name, to rename it>","title":"...","description":"...","instructions":"..."}]}',
    '{"kind":"routine","name":"Morning check","instructions":"what to do on each run","schedule":{"type":"daily","time":"08:30"}}',
    '{"kind":"skill","name":"weekly-report","description":"when to use it","instructions":"markdown steps"}',
    "",
    `Create a workspace for a piece of work in one of the user's projects (a git worktree on its own branch, or a plain folder inside the project): write ONE JSON file into ${home}/outbox/, named workspace-<YYYYMMDD-HHMM>-<4 random letters>.json (a different name each time), as the last step of your turn, and then end your turn. The first time your team uses a project, a card in this chat asks the user; after that it is created at once. Either way, a message here tells you where the workspace is. ${home}/setup/workspaces.md lists the workspaces that exist.`,
    '{"kind":"workspace","project":"<project name>","title":"Login page","worktree":true,"branch":"feature/login","base":"main"}',
    'Leave out "worktree", "branch" and "base" for a plain folder.',
    "",
    `Ask the user to approve a matter before you go on (a design, a plan, a decision, a result): write ONE JSON file into ${home}/outbox/, named approval-<YYYYMMDD-HHMM>-<4 random letters>.json (a different name each time), as the last step of your turn, and then end your turn and do nothing else. The user sees a card in this chat with your text and the file and decides; you cannot decide for them, and neither can another bot. The answer arrives in this chat as a message. If the user rejects it, talk it over with them and ask again with a new file. "file" is optional: a path in your folder or this chat's workspace (text, at most 200 KB). ${home}/setup/approvals.md lists your approvals and their ids. To withdraw one that still waits, write {"kind":"withdraw-approval","id":"a-..."}. After an approval, cite its id in an "approval" field of a workspace file or an assign file, when your instructions say the work needs one.`,
    '{"kind":"approval","title":"Use Postgres","text":"What you ask and why, in markdown.","file":"plan.md"}',
    ...(bot.contactBots === "off"
      ? []
      : [
          "",
          `Ask another bot for help: write ONE JSON file per question into ${home}/outbox/, named ask-<YYYYMMDD-HHMM>-<4 random letters>.json (a different name for each), as the last step of your turn, and then end your turn. To ask several bots at once, write all their files in the same turn. Each answer arrives as its own message when that bot is done, so you do not wait for the slowest. The other bot works in a chat of its own and its answer arrives in this chat as a message, framed as information from another bot. ${bot.contactBots === "ask" ? "The user is asked first and may say no. " : ""}A chat started by another bot can't ask further. The names of the bots are in ${home}/setup/overview.md.`,
          '{"kind":"ask","to":"<a bot name>","message":"what you need, written so it works without this chat"}',
          "",
          `Hand a task to another bot in a workspace of the user's projects: write ONE JSON file per assignment into ${home}/outbox/, named assign-<YYYYMMDD-HHMM>-<4 random letters>.json (a different name each time), as the last step of your turn, and then end your turn. The other bot works in a chat of its own in that workspace, and its report arrives in this chat as a message when it is done; that can take hours, so do not wait for it. ${bot.contactBots === "ask" ? "The user is asked first and may say no. " : ""}${home}/setup/workspaces.md lists the workspaces.`,
          '{"kind":"assign","to":"<a bot name>","task":"what to do, written so it works without this chat","workspace":"<a workspace name>"}',
          'Leave out "workspace" to use the workspace this chat runs in.',
        ]),
  ].join("\n");
}
