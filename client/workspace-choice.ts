import { isBotsProjectRoot } from "../shared/chat";
import { englishTranslate, type Translate } from "../shared/translate";

/** A workspace a new chat can be started in. */
export interface WorkspaceChoice {
  id: string;
  label: string;
  directory: string;
}

interface WorkspaceEntry {
  id: string;
  projectDisplayName: string;
  projectCustomName?: string | null;
  projectRootPath: string;
  workspaceDirectory?: string;
  name: string;
  title?: string | null;
  archivingAt?: string | null;
  workspaceKind?: string;
  worktreeSlug?: string;
}

/** "project · title", and for a worktree its folder name too when that is not the title, so two worktrees of one repository can be told apart. */
function labelOf(entry: WorkspaceEntry): string {
  const title = entry.title || entry.name;
  const slug = entry.workspaceKind === "worktree" && entry.worktreeSlug && entry.worktreeSlug !== title ? ` (${entry.worktreeSlug})` : "";
  return `${entry.projectCustomName || entry.projectDisplayName} · ${title}${slug}`;
}

/**
 * The workspaces of the user's projects, labelled "project · title" and sorted by that. Workspaces being
 * archived are left out, and so is everything in the plugin's own Bots project (the bots' own folders:
 * a chat there is the default, not a choice).
 */
export function workspaceChoices(entries: readonly WorkspaceEntry[]): WorkspaceChoice[] {
  return entries
    .filter((entry) => !entry.archivingAt && !isBotsProjectRoot(entry.projectRootPath))
    .map((entry) => ({ id: entry.id, label: labelOf(entry), directory: entry.workspaceDirectory ?? entry.projectRootPath }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Workspace id to label, for naming where a chat runs. */
export function workspaceLabels(choices: readonly WorkspaceChoice[]): ReadonlyMap<string, string> {
  return new Map(choices.map((choice) => [choice.id, choice.label]));
}

/** The project workspace a chat runs in, or null for a chat in the bot's own folder (those are not in the list). */
export function chatWhere(chat: { workspaceId?: string | null } | null | undefined, labels: ReadonlyMap<string, string>): string | null {
  return (chat?.workspaceId && labels.get(chat.workspaceId)) || null;
}

/** The host's words for a workspace that went away (no folder, not found) turned into ones a person can act on. */
export function friendlyStartError(message: string, t: Translate = englishTranslate): string {
  return /no available directory|workspace.*not found|not found.*workspace/i.test(message) ? t("surface.workspaceGone") : message;
}
