import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isBotsProjectRoot } from "../shared/chat";
import { allPages } from "../shared/pages";
import { grantScope, workspaceInputProblem, folderNameFor, type CreateWorkspaceInput } from "../shared/workspaces";
import { samePath } from "../shared/identity";
import { TIDY_LABEL } from "../shared/memory-maintenance";
import { proposalReply, type Proposal } from "../shared/proposals";
import type { Bot } from "../shared/bot";
import { citeApproval } from "./approvals";
import { sendIntoChat } from "./chat-send";
import type { BotsHost } from "./host";
import type { PaseoApi } from "./paseo";
import { allowProject, projectAllowed } from "./project-grants";
import { createProposal } from "./proposals";

// Workspaces in the user's projects: listing them, and creating one for a bot. A project the bot's team has
// not used asks the user on a card first; Allow creates the workspace and remembers the project.

export interface WorkspaceListing {
  id: string;
  title: string;
  directory: string;
  projectId: string;
  projectName: string;
}

export interface ProjectRef {
  id: string;
  name: string;
  root: string;
}

type WorkspaceEntry = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];
type ProjectEntry = Awaited<ReturnType<PaseoApi["projects"]["list"]>>["projects"][number];

const projectName = (project: ProjectEntry) => (project as { projectCustomName?: string | null }).projectCustomName || project.projectDisplayName;
const isArchiving = (entry: WorkspaceEntry) => !!(entry as { archivingAt?: string | null }).archivingAt;
const directoryOf = (entry: WorkspaceEntry) => entry.workspaceDirectory ?? entry.projectRootPath;
const titleOf = (entry: WorkspaceEntry) => (entry as { title?: string | null }).title || (entry as { name?: string }).name || "Untitled";

/** Every workspace the host has, page after page (it hands out 200 at a time). */
async function workspaceEntries(paseo: PaseoApi): Promise<WorkspaceEntry[]> {
  return allPages((cursor) => paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
}

/** The workspaces of every project that are not being archived, by project name and then title. */
export async function listWorkspaces(paseo: PaseoApi): Promise<WorkspaceListing[]> {
  const entries = await workspaceEntries(paseo);
  return entries
    .filter((entry) => !isArchiving(entry) && !isBotsProjectRoot(entry.projectRootPath))
    .map((entry) => ({ id: entry.id, title: titleOf(entry), directory: directoryOf(entry), projectId: entry.projectId, projectName: entry.projectDisplayName }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.title.localeCompare(b.title));
}

const labelOfListing = (listing: WorkspaceListing) => `${listing.projectName} · ${listing.title}`;

/** A workspace by id, by title in any case, or by its "project · title" label; or why it can't be told which. */
export async function resolveWorkspace(paseo: PaseoApi, ref: string): Promise<WorkspaceListing | { problem: string }> {
  const list = await listWorkspaces(paseo);
  const wanted = ref.trim();
  const lower = wanted.toLowerCase();
  const byId = list.find((listing) => listing.id === wanted);
  if (byId) return byId;
  const byTitle = list.filter((listing) => listing.title.toLowerCase() === lower);
  const matches = byTitle.length > 0 ? byTitle : list.filter((listing) => labelOfListing(listing).toLowerCase() === lower);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return { problem: `More than one workspace is called "${wanted}": ${matches.map((listing) => `${labelOfListing(listing)} (${listing.directory})`).join(", ")}. Use its id or its "project · title" name.` };
  const names = list.slice(0, 10).map(labelOfListing);
  return { problem: `There is no workspace "${wanted}".${names.length ? ` Workspaces: ${names.join(", ")}${list.length > names.length ? ", ..." : ""}.` : " There are no workspaces yet."}` };
}

/** The project workspace a chat runs in; null for a chat in a bot's own folder, or one that is not there. */
export async function workspaceOfChat(paseo: PaseoApi, agentId: string, listing?: readonly WorkspaceListing[]): Promise<WorkspaceListing | null> {
  const snapshot = await paseo.agents.ref(agentId).refresh().catch(() => null);
  const id = (snapshot?.agent as { workspaceId?: string | null } | undefined)?.workspaceId;
  if (!id) return null;
  return (listing ?? (await listWorkspaces(paseo))).find((entry) => entry.id === id) ?? null;
}

/** A project by id, by root folder, or by name in any case; or why it can't be told which. */
export async function resolveProject(paseo: PaseoApi, ref: string): Promise<ProjectRef | { problem: string }> {
  // The plugin's own Bots project holds the bots' folders; it is not a place for work.
  const projects = (await paseo.projects.list()).projects.filter((project) => !isBotsProjectRoot(project.projectRootPath));
  const wanted = ref.trim();
  const ref_ = (project: ProjectEntry): ProjectRef => ({ id: project.projectId, name: projectName(project), root: project.projectRootPath });
  const exact = projects.find((project) => project.projectId === wanted) ?? projects.find((project) => samePath(project.projectRootPath, wanted));
  if (exact) return ref_(exact);
  const named = projects.filter((project) => projectName(project).toLowerCase() === wanted.toLowerCase());
  if (named.length === 1) return ref_(named[0]!);
  if (named.length > 1) return { problem: `More than one project is called "${wanted}": ${named.map((project) => project.projectRootPath).join(", ")}. Use the project's root folder instead.` };
  const names = projects.map(projectName);
  return { problem: `There is no project "${wanted}".${names.length ? ` Projects: ${names.join(", ")}.` : " There are no projects yet."}` };
}

const created = (title: string, id: string, folder: string) => `Workspace "${title}" created: id ${id}, folder ${folder}.`;

/** Makes the folder for a plain-folder workspace: one new folder directly under the project's root, never through a link. */
async function ensureFolder(path: string): Promise<void> {
  const found = await lstat(path).catch(() => null);
  if (!found) return mkdir(path);
  if (found.isSymbolicLink()) throw new Error(`${path} is a link, so I won't use it. Pick another title.`);
  if (!found.isDirectory()) throw new Error(`${path} exists and is not a folder. Pick another title.`);
}

/** Creates the workspace. A worktree starts a branch (Paseo adds a number when the name is taken); a folder is made inside the project root. */
export async function createWorkspace(paseo: PaseoApi, project: ProjectRef, input: CreateWorkspaceInput): Promise<string> {
  if (input.worktree) {
    const branchName = input.branch ?? folderNameFor(input.title);
    const handle = await paseo.workspaces.create({ title: input.title, source: { kind: "worktree", projectId: project.id, ...(input.base ? { baseBranch: input.base } : {}), branchName } });
    return `${created(input.title, handle.id, handle.directory ?? "unknown")} Paseo adds a number to the branch name when it was taken; run git branch in the folder to see the real one.`;
  }
  const path = join(project.root, folderNameFor(input.title));
  const entries = await workspaceEntries(paseo);
  const have = entries.find((entry) => !isArchiving(entry) && entry.projectId === project.id && samePath(directoryOf(entry), path));
  if (have) return `Workspace "${input.title}" already exists: id ${have.id}, folder ${directoryOf(have)}.`;
  await ensureFolder(path);
  const handle = await paseo.workspaces.create({ title: input.title, source: { kind: "directory", path, projectId: project.id } });
  return created(input.title, handle.id, handle.directory ?? path);
}

export interface WorkspaceCaller {
  bot: Bot;
  agentId: string;
  host: BotsHost;
}

/** What a create_workspace call does: create at once in a project the bot's team remembered, else put a card in the chat. */
export async function requestWorkspace(caller: WorkspaceCaller, input: CreateWorkspaceInput): Promise<string> {
  const problem = workspaceInputProblem(input);
  if (problem) throw new Error(problem);
  // A memory tidy chat reads untrusted text unattended, so it creates nothing (ask_bot refuses it too).
  const chat = await caller.host.chatOf(caller.agentId).catch(() => null);
  if (chat?.labels[TIDY_LABEL]) throw new Error("A memory tidy chat can't create workspaces.");
  if (input.approval) {
    const cited = await citeApproval(caller.host, { bot: caller.bot, agentId: caller.agentId }, input.approval, "create_workspace");
    if (!cited.ok) throw new Error(cited.reason);
  }
  const paseo = caller.host.requirePaseo();
  const project = await resolveProject(paseo, input.project);
  if ("problem" in project) throw new Error(project.problem);
  const scope = grantScope(caller.bot.id, (await caller.host.values())?.groups ?? []);
  if (await projectAllowed(scope, project.id)) return createWorkspace(paseo, project, input);
  const proposal = await createProposal({ botId: caller.bot.id, agentId: caller.agentId, kind: "workspace", data: { project, input, scope } });
  return proposalReply(proposal.id, `a new workspace "${input.title}" in ${project.name}`);
}

async function tell(host: BotsHost, agentId: string, text: string): Promise<void> {
  await sendIntoChat(host.requirePaseo(), agentId, `[Aydo] ${text}`).catch((error: unknown) => console.error("aydo: couldn't tell a chat about a workspace", error));
}

/** The user allowed it: create the workspace, remember the project for the scope, and tell the chat what happened. */
export async function workspaceApproved(proposal: Extract<Proposal, { kind: "workspace" }>, host: BotsHost): Promise<void> {
  const { project, input, scope } = proposal.data;
  let text: string;
  try {
    text = await createWorkspace(host.requirePaseo(), project, input);
  } catch (error) {
    return tell(host, proposal.agentId, `The workspace could not be created: ${error instanceof Error ? error.message : String(error)}`);
  }
  const note = await allowProject(scope, { id: project.id, name: project.name }).then(
    () => "",
    (error: unknown) => ` The project could not be remembered: ${error instanceof Error ? error.message : String(error)}`,
  );
  await tell(host, proposal.agentId, `${text}${note}`);
}

/** The user said no. */
export function workspaceRefused(proposal: Extract<Proposal, { kind: "workspace" }>, host: BotsHost): Promise<void> {
  return tell(host, proposal.agentId, `The user did not allow a workspace in ${proposal.data.project.name}. Don't ask again unless the user tells you to.`);
}
