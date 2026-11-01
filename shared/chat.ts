import type { WireAttachment } from "./attachments";
import { BOT_LABEL, buildAgentConfig, defaultModelId, type Bot, type Library, type PluginServers } from "./bot";
import { folderAccessOptions } from "./folder-access";
import { ASK_PREAPPROVED_LABEL, askPreapproval } from "./groups";
import { NO_HOST_CAPS, type HostCaps } from "./host-caps";
import { samePath } from "./identity";
import { foldText } from "./activity";
import { englishTranslate, type Translate } from "./translate";

/** Label on chats started by a routine, carrying the routine id. */
export const ROUTINE_LABEL = "aydo.routine";
/** Longest title Paseo accepts (protocol/agent-title-limits.ts). */
const MAX_TITLE_CHARS = 200;

/** Older chats were titled "[Bot Name] …"; places grouped by bot show them without the prefix. */
export function displayTitle(title: string | null | undefined, t: Translate = englishTranslate): string {
  return (title ?? "").replace(/^\[[^\]]*\]\s*/, "") || t("text.chat.newChat");
}

/** Where a bot's chats live. */
export interface BotPlacement {
  /** The bot's own folder: its workspace's working folder. */
  path: string;
  /** Folder of the shared Bots project, or null when the bot has its own working folder. */
  projectRoot: string | null;
}

const normalize = (path: string | null | undefined) => (path ?? "").replace(/\/+$/, "");

// The part of Paseo's API these helpers use. Shared code may only import the plugin SDK's
// root, so the app and the server pass their Paseo API in, and it's checked against this.

interface ChatWorkspace {
  projectId: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  title?: string | null;
}

interface WorkspaceHandle {
  current(): ChatWorkspace | null;
  refresh(): Promise<ChatWorkspace | null>;
  setTitle(title: string): Promise<unknown>;
  archive(): Promise<unknown>;
  readonly agents: {
    create(options: {
      agentId?: string;
      config: ReturnType<typeof buildAgentConfig>;
      labels: Record<string, string>;
      prompt: string;
      title?: string;
      images?: { data: string; mimeType: string }[];
      attachments?: WireAttachment[];
      clientMessageId?: string;
    }): Promise<{ readonly id: string }>;
  };
}

export interface ChatApi {
  readonly projects: { list(): Promise<{ projects: ChatWorkspace[] }> };
  readonly workspaces: {
    list(): Promise<{ entries: ChatWorkspace[] }>;
    ref(workspace: string | ChatWorkspace): WorkspaceHandle;
    open(path: string): Promise<WorkspaceHandle>;
    create(options: { title: string; source: { kind: "directory"; path: string; projectId?: string } }): Promise<WorkspaceHandle>;
  };
  readonly providers: { snapshot(): Promise<{ entries: { provider: string; models?: { id: string; isDefault?: boolean; isSelectable?: boolean }[] }[] }> };
}

/**
 * The Bots project: one Paseo project for the plugin, one workspace per bot.
 * Paseo registers a project the first time a folder is opened; that opening
 * also creates a workspace for the project folder itself, which is archived so
 * the project only lists bot workspaces.
 */
async function botsProjectId(api: ChatApi, root: string): Promise<string> {
  const { projects } = await api.projects.list();
  const existing = projects.find((project) => normalize(project.projectRootPath) === normalize(root));
  if (existing) return existing.projectId;
  const rootWorkspace = await api.workspaces.open(root);
  const snapshot = rootWorkspace.current() ?? (await rootWorkspace.refresh());
  if (!snapshot) throw new Error("Paseo didn't register the Aydo project.");
  await rootWorkspace.archive().catch(() => undefined);
  return snapshot.projectId;
}

/**
 * Whether a workspace is at `path`. A workspace made before the folder was renamed (shared/Bots) is at the same place:
 * the old name is a link to the new folder.
 */
function isPlacementPath(workspace: ChatWorkspace, path: string): boolean {
  const here = toSlashes(path);
  const there = toSlashes(workspace.workspaceDirectory ?? workspace.projectRootPath);
  return there === here || there === here.replace(BOTS_ROOT_SUFFIXES[0]!, BOTS_ROOT_SUFFIXES[1]!);
}

/** Finds the bot's workspace (by its folder) or creates it, and keeps its title in step with the bot's name. */
async function ensureBotWorkspace(api: ChatApi, bot: Bot, placement: BotPlacement) {
  const { entries } = await api.workspaces.list();
  const mine = entries.find(
    (workspace) =>
      isPlacementPath(workspace, placement.path) &&
      // A custom folder can have other workspaces; only the one named after the bot is the bot's.
      (placement.projectRoot !== null || workspace.title === bot.name),
  );
  if (mine) {
    const handle = api.workspaces.ref(mine);
    if (mine.title !== bot.name) await handle.setTitle(bot.name);
    return handle;
  }
  const projectId = placement.projectRoot ? await botsProjectId(api, placement.projectRoot) : undefined;
  return api.workspaces.create({
    title: bot.name,
    source: { kind: "directory", path: placement.path, ...(projectId ? { projectId } : {}) },
  });
}

const toSlashes = (path: string | null | undefined) => normalize((path ?? "").replace(/\\/g, "/"));
/**
 * Where the managed folders live under Paseo's data folder (server/bot-home.ts botsHomePath): "Aydo", and "Bots" for the
 * folder of earlier versions, which stays a link to it and is still the root of workspaces made before the rename.
 */
const BOTS_ROOT_SUFFIXES = ["/plugin-data/aydo/shared/Aydo", "/plugin-data/aydo/shared/Bots"];

/** The suffix of `path` that is a managed root, or null. */
function rootSuffix(path: string): string | null {
  return BOTS_ROOT_SUFFIXES.find((suffix) => path.endsWith(suffix)) ?? null;
}

/** Whether a project root is the plugin's own project (the folder is named Aydo), where the assistants' folders live. */
export function isBotsProjectRoot(root: string | null | undefined): boolean {
  return rootSuffix(toSlashes(root)) !== null;
}

/** The id of the bot a workspace folder belongs to (a direct child of the Bots folder), or null. */
export function botIdOfDirectory(directory: string | null | undefined): string | null {
  const folder = toSlashes(directory);
  const suffix = BOTS_ROOT_SUFFIXES.find((candidate) => folder.includes(`${candidate}/`));
  if (!suffix) return null;
  const id = folder.slice(folder.indexOf(`${suffix}/`) + suffix.length + 1);
  return id !== "" && !id.includes("/") ? id : null;
}

/** The Bots project's workspaces whose folder is named after a bot that is not in `liveBotIds` (a deleted bot's). */
export function orphanedBotWorkspaces<T extends ChatWorkspace>(entries: readonly T[], liveBotIds: ReadonlySet<string>): T[] {
  return entries.filter((workspace) => {
    const root = toSlashes(workspace.projectRootPath);
    const folder = toSlashes(workspace.workspaceDirectory);
    if (!isBotsProjectRoot(root) || !folder.startsWith(`${root}/`)) return false;
    const id = folder.slice(root.length + 1);
    return id !== "" && !id.includes("/") && !liveBotIds.has(id);
  });
}

/** Archives the workspaces of deleted bots, so the sidebar stops listing them. Their chats stay in Paseo's history. */
export async function archiveOrphanBotWorkspaces(api: ChatApi, liveBotIds: ReadonlySet<string>): Promise<number> {
  const { entries } = await api.workspaces.list();
  let archived = 0;
  for (const workspace of orphanedBotWorkspaces(entries, liveBotIds)) {
    if (await api.workspaces.ref(workspace).archive().then(() => true, () => false)) archived++;
  }
  return archived;
}

/** Renames the bot's workspace after the bot is renamed; does nothing if it doesn't exist yet. */
export async function syncBotWorkspaceTitle(api: ChatApi, bot: Bot, placement: BotPlacement): Promise<void> {
  if (placement.projectRoot === null) return;
  const { entries } = await api.workspaces.list();
  const mine = entries.find((workspace) => isPlacementPath(workspace, placement.path));
  if (mine && mine.title !== bot.name) await api.workspaces.ref(mine).setTitle(bot.name);
}

export interface StartChatInput {
  bot: Bot;
  /** Resolves the bot's MCP servers. */
  library: Library;
  /** The chat's agent id, picked in advance so its tools URL can name it. */
  agentId?: string;
  /** The plugin's servers for this chat (its tools), from the relay on the bot's host. */
  plugin?: PluginServers;
  placement: BotPlacement;
  prompt: string;
  systemPrompt: string;
  /** Defaults to Paseo's own title derived from the prompt. */
  title?: string;
  labels?: Record<string, string>;
  images?: { data: string; mimeType: string }[];
  attachments?: WireAttachment[];
  clientMessageId?: string;
  /** The bot's own folder. When the chat runs in another folder it is attached to the session, so memory writes need no approval. */
  home?: string;
  /** More folders to attach whatever the chat's folder is, such as the team's report folder. */
  extraFolders?: readonly string[];
  /** An existing workspace to start the chat in (a project's), instead of the bot's own. */
  workspace?: { id: string; path: string };
  /** What the host does for providers the plugin cannot see into. */
  hostCaps?: HostCaps;
}

/**
 * Starts a chat (a thread in the bot's workspace) with the bot's configuration
 * and sends the first message. Used by the app and by the routine scheduler.
 */
export async function startBotChat(api: ChatApi, input: StartChatInput): Promise<string> {
  const { bot } = input;
  const model = bot.model ?? (await resolveDefaultModel(api, bot.provider));
  const workspace = input.workspace ? api.workspaces.ref(input.workspace.id) : await ensureBotWorkspace(api, bot, input.placement);
  const chatFolder = input.workspace?.path ?? input.placement.path;
  // The bot's own folder (when the chat runs elsewhere) and any extra folders, except the folder the chat runs in.
  const folders = [...(input.home ? [input.home] : []), ...(input.extraFolders ?? [])].filter((folder) => !samePath(chatFolder, folder));
  const attached = folders.length > 0 ? folderAccessOptions(bot.provider, folders, input.hostCaps ?? NO_HOST_CAPS) : null;
  // ask_bot runs without a prompt in this chat when the bot or its team allows it. The chat remembers why, so turning
  // the setting off later still stops it (the tool permission itself is fixed when the chat starts).
  const preapproved = input.plugin?.tools ? askPreapproval(bot, !!input.plugin.askFreely) : null;
  // A chat in a project's workspace sits among that project's other chats in the host's list: its title says whose it is.
  // (displayTitle drops the bracket in places that already group by assistant.)
  const title = input.title ?? (input.workspace ? `[${bot.name}] ${foldText(input.prompt, 60)}`.trim() : undefined);
  const agent = await workspace.agents.create({
    ...(input.agentId ? { agentId: input.agentId } : {}),
    config: buildAgentConfig(bot, input.library, model, input.systemPrompt, input.plugin, attached ?? undefined),
    labels: { [BOT_LABEL]: bot.id, ...(preapproved ? { [ASK_PREAPPROVED_LABEL]: preapproved } : {}), ...input.labels },
    prompt: input.prompt,
    ...(title ? { title: title.slice(0, MAX_TITLE_CHARS) } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  });
  return agent.id;
}

async function resolveDefaultModel(api: ChatApi, provider: string): Promise<string> {
  const snapshot = await api.providers.snapshot();
  const entry = snapshot.entries.find((candidate) => candidate.provider === provider);
  const model = defaultModelId(entry?.models ?? []);
  if (!model) throw new Error(`${provider} has no models available. Pick a model in the assistant's settings.`);
  return model;
}
