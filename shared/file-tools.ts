// The plugin's tools as files, for providers that cannot use its MCP server. The bot writes a JSON
// file into its proposals/ folder; the plugin reads it when the chat's turn ends.

export const PROPOSALS_DIR = "proposals";
export const OUTBOX_DIR = "outbox";
export const DONE_DIR = "done";
export const MAX_FILES_PER_SCAN = 20;
export const MAX_FILE_BYTES = 256 * 1024;
/** A file no chat's tool calls account for is given to a chat after this long. */
export const UNCLAIMED_AFTER_MS = 10 * 60_000;
export const FILE_NAME = /^[\w.-]+\.json$/;

type Item = { type?: string; detail?: { type?: string; filePath?: unknown; command?: unknown } | null };

/**
 * What a turn's tool calls wrote: the file of a write or edit call, and the command of a shell call.
 * Devin names the file in the call's title ("Wrote ./proposals/x.json"), so these are strings to
 * look for a file name in, not clean paths.
 */
export function writtenStrings(timeline: readonly unknown[]): string[] {
  const out: string[] = [];
  // Only the last turn: a name an earlier turn used must not let this chat claim a file written since by another.
  const lastUser = timeline.map((raw) => (raw as Item).type).lastIndexOf("user_message");
  for (const raw of timeline.slice(lastUser + 1)) {
    const item = raw as Item;
    if (item.type !== "tool_call" || !item.detail) continue;
    if ((item.detail.type === "write" || item.detail.type === "edit") && typeof item.detail.filePath === "string") out.push(item.detail.filePath);
    else if (item.detail.type === "shell" && typeof item.detail.command === "string") out.push(item.detail.command);
  }
  return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether one of the written strings names this file (its whole name, not the end of a longer one). */
export function fileBelongsToTurn(fileName: string, written: readonly string[]): boolean {
  const pattern = new RegExp(`(^|[^\\w.-])${escape(fileName)}($|[^\\w.-])`, "i");
  return written.some((text) => pattern.test(text));
}

export type ToolFileKind = "changes" | "routine" | "skill" | "ask";
const PROPOSAL_KINDS: readonly ToolFileKind[] = ["changes", "routine", "skill"];

/** The kind of a tool file and the arguments of the tool it stands for; `allowed` is what the folder it was found in takes. */
export function parseToolFile(text: string, allowed: readonly ToolFileKind[] = PROPOSAL_KINDS): { kind: ToolFileKind; args: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "The file is not valid JSON." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "The file must be one JSON object." };
  const { kind, ...args } = value as Record<string, unknown>;
  if (typeof kind !== "string") return { error: 'The file needs a "kind" field.' };
  if (!allowed.includes(kind as ToolFileKind)) {
    const list = allowed.length === 1 ? allowed[0]! : `${allowed.slice(0, -1).join(", ")} or ${allowed.at(-1)}`;
    return { error: `"kind" must be ${list} in this folder (got "${kind}").` };
  }
  return { kind: kind as ToolFileKind, args };
}
