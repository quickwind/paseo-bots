import { z } from "zod";

/**
 * How a bot gets the plugin's tools (reading the setup, proposing changes, asking another bot,
 * searching its chats). "mcp" is an MCP server added to the chat. "files" is a set of files in the
 * bot's folder, for providers that cannot use the plugin's MCP server (Devin, where MCP is not
 * allowed, and Antigravity, which drops the servers it is given).
 *
 * The plugin's settings hold one default for every bot, and a bot may override it with its own `toolMode`.
 * "auto" is what older settings held (files for those two providers, MCP for the rest); it is no longer offered
 * and the settings migration turns it into "mcp" plus a "files" override on those bots. It is still read
 * (`usesFiles`) for a client that wrote it after the migration.
 */
export const ToolModeSchema = z.enum(["auto", "files", "mcp"]);
export type ToolMode = z.infer<typeof ToolModeSchema>;

/** What a bot can choose for itself: the global default is not a choice a bot makes. */
export const BotToolModeSchema = z.enum(["files", "mcp"]);
export type BotToolMode = z.infer<typeof BotToolModeSchema>;

/** Providers that cannot use the plugin's MCP server (the old "automatic" list). By name: a family also takes a suffix, like `devin-work`. */
export function filesOnlyProvider(provider: string): boolean {
  return /^(devin|antigravity)(\b|$)/.test(provider);
}

/** The bot's own choice, else the global default; a global value that was never chosen means the old by-provider rule. */
export function usesFiles(mode: ToolMode | undefined, provider: string, override?: BotToolMode): boolean {
  if (override) return override === "files";
  if (mode === "files") return true;
  if (mode === "mcp") return false;
  return filesOnlyProvider(provider);
}

/** A bot on a provider that cannot use MCP starts with its own "files" choice, unless it already has one. */
export function withToolModeFor<T extends { provider: string; toolMode?: BotToolMode | undefined }>(bot: T): T {
  return bot.toolMode || !filesOnlyProvider(bot.provider) ? bot : { ...bot, toolMode: "files" };
}
