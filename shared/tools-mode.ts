import { z } from "zod";

/**
 * How a bot gets the plugin's tools (reading the setup, proposing changes, asking another bot,
 * searching its chats). "mcp" is an MCP server added to the chat. "files" is a set of files in the
 * bot's folder, for providers that cannot use the plugin's MCP server (Devin, where MCP is not
 * allowed). "auto" picks files for Devin and MCP for everything else.
 */
export const ToolModeSchema = z.enum(["auto", "files", "mcp"]);
export type ToolMode = z.infer<typeof ToolModeSchema>;

export function usesFiles(mode: ToolMode | undefined, provider: string): boolean {
  if (mode === "files") return true;
  if (mode === "mcp") return false;
  return /^devin(\b|$)/.test(provider);
}
