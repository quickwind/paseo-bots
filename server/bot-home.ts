import { lstat, mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "./managed-files";

// The plugin SDK has no data-directory API; other plugins use
// `$PASEO_HOME/plugin-data/<plugin-id>`, so this follows that convention.
function pluginDataRoot(): string {
  return join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data");
}

export function pluginDataPath(): string {
  return join(pluginDataRoot(), "aydo");
}

/**
 * One folder for every bot that uses the managed folder. Paseo files each agent
 * under the workspace of its folder, so sharing it keeps all bot chats in a
 * single workspace; Paseo names the project after the folder, hence "Aydo" (it was "Bots" until build 65).
 */
export function botsHomePath(): string {
  // Nested because macOS folders are case-insensitive and "bots" held per-bot folders in v0.1.
  return join(pluginDataPath(), "shared", "Aydo");
}

/** The folder of versions before build 65. Kept as a link to botsHomePath so chats and workspaces made there still work. */
function previousHomePath(): string {
  return join(pluginDataPath(), "shared", "Bots");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

let migration: Promise<void> | null = null;

/**
 * Earlier versions used a folder called "home", which Paseo showed as a "home"
 * project. Move it to "Bots" and leave a link behind so existing chats keep
 * their working folder.
 */
function migrateLegacyHome(): Promise<void> {
  migration ??= (async () => {
    const legacy = join(pluginDataPath(), "home");
    const target = botsHomePath();
    const info = await lstat(legacy).catch(() => null);
    if (info && !info.isSymbolicLink() && info.isDirectory() && !(await exists(target))) {
      await mkdir(join(target, ".."), { recursive: true });
      await rename(legacy, target);
      await symlink(target, legacy, "dir");
    }
    // "Bots" to "Aydo": the project is named after the folder. The old name stays as a link.
    const previous = previousHomePath();
    const old = await lstat(previous).catch(() => null);
    if (old && !old.isSymbolicLink() && old.isDirectory() && !(await exists(target))) {
      await rename(previous, target);
      await symlink(target, previous, "dir");
    }
  })().catch((error: unknown) => console.error("aydo: couldn't move the assistants folder", error));
  return migration;
}

/**
 * A team's report folder (Reports/<team id>): latest.md, and one folder per project with a .jsonl (the whole records) and an
 * .md (the index) for each day. The team's, not the lead's: a lead can change. A team never sees another team's folder.
 */
export function teamReportsPath(teamId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(teamId)) throw new Error("A team id is letters, digits, _ and - only.");
  return join(pluginDataPath(), "shared", "Reports", teamId);
}

/**
 * Each bot's own folder: the working folder of its workspace, and where its
 * memory, skills and uploads live so its chats can read and update them.
 */
export function botDataPath(botId: string): string {
  return join(botsHomePath(), botId);
}

/**
 * Paseo shows an icon.svg in a project's folder as the project icon. The Bots project gets
 * the plugin's sidebar glyph (Lucide's Bot) in white on a tile shaped and coloured like the
 * project icons Paseo draws itself (project-icon-view.tsx: 25% corners, the muted identity
 * blue), so it reads on light and dark themes alike.
 */
const PROJECT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#5179b0"/><g transform="translate(12.8 12.8) scale(1.6)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></g></svg>`;

export async function ensureBotsHome() {
  await migrateLegacyHome();
  const path = botsHomePath();
  await mkdir(path, { recursive: true });
  // Replaced, not written through: a bot's shell could have made either a link.
  await writeAtomic(join(path, "README.md"), "aydo: one folder per assistant, each the working folder of that assistant's workspace.\n");
  await writeAtomic(join(path, "icon.svg"), PROJECT_ICON);
  return { path };
}

/** Moves data kept under `.bots/<id>` by the previous version into the bot's own folder. */
async function adoptLegacyData(botId: string, target: string): Promise<void> {
  const legacy = join(botsHomePath(), ".bots", botId);
  const names = await readdir(legacy).catch(() => null);
  if (!names) return;
  for (const name of names) {
    const destination = join(target, name);
    if (!(await exists(destination))) await rename(join(legacy, name), destination);
  }
  await rm(legacy, { recursive: true, force: true });
}

export async function ensureBotHome({ botId }: { botId: string }) {
  const { path: root } = await ensureBotsHome();
  const path = botDataPath(botId);
  await mkdir(path, { recursive: true });
  await adoptLegacyData(botId, path);
  return { root, path };
}
