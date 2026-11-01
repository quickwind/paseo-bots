import { z } from "zod";
import type { BotGroup } from "./bot";
import { teamOf } from "./groups";

// Creating a workspace in a project: what a bot may ask for, and whose permission remembers a project.

const hasControl = (text: string) => /[\p{Cc}]/u.test(text);

export const CreateWorkspaceInput = z.object({
  project: z.string().min(1).max(200).describe("The project: its name, id or root folder."),
  title: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((title) => !hasControl(title), "The title can't contain control characters.")
    .describe('A short name for the piece of work, like "Login page".'),
  worktree: z.boolean().default(false).describe("True for a git worktree on its own branch (the project must be a git repository); false for a plain folder inside the project."),
  branch: z.string().max(100).optional().describe("The worktree's branch; defaults to the title as a folder-style name."),
  base: z.string().max(100).optional().describe("The branch the worktree starts from; defaults to the project's current one."),
  approval: z.string().max(40).optional().describe("The id of an approval the user gave for this work, when your instructions say it needs one."),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInput>;

/** A title as a folder name: lower case, letters, digits and . _ - only. May come out empty. */
export function folderNameFor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60)
    .replace(/[-.]+$/g, "");
}

const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,99}$/;
const branchProblem = (name: string): boolean => !BRANCH.test(name) || name.includes("..") || name.endsWith("/") || name.endsWith(".lock");

/** What is wrong with a request, as a sentence the bot can act on, or null. */
export function workspaceInputProblem(input: CreateWorkspaceInput): string | null {
  if (!input.worktree && (input.branch !== undefined || input.base !== undefined)) return "A branch or base only makes sense with worktree set to true.";
  if (input.branch !== undefined && branchProblem(input.branch)) return `"${input.branch}" is not a branch name I can use: letters, digits and . _ - / only, not starting with - or /, no "..".`;
  if (input.base !== undefined && branchProblem(input.base)) return `"${input.base}" is not a branch name I can use: letters, digits and . _ - / only, not starting with - or /, no "..".`;
  if (!input.worktree && folderNameFor(input.title) === "") return "That title leaves no folder name. Use a title with letters or digits.";
  if (input.worktree && input.branch === undefined && folderNameFor(input.title) === "") return "That title leaves no name for a branch. Give a branch name.";
  return null;
}

/** Whose permission a remembered project belongs to: the bot's team, or the bot itself when it has no team. */
export function grantScope(botId: string, groups: readonly BotGroup[]): string {
  const team = teamOf(botId, groups);
  return team ? `team:${team.id}` : `bot:${botId}`;
}

/** The scope an RPC names: exactly one of a team and a bot. */
export function scopeOf(input: { teamId?: string; botId?: string }): string {
  if (!input.teamId === !input.botId) throw new Error("Name a team or a bot.");
  return input.teamId ? `team:${input.teamId}` : `bot:${input.botId}`;
}

/** A workspace as "project · title", so two workspaces with one title in two projects can be told apart. */
export function workspaceLabel(workspace: { title: string; projectName?: string | null }): string {
  return workspace.projectName ? `${workspace.projectName} · ${workspace.title}` : workspace.title;
}
