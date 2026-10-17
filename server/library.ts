import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import type { LibrarySkill } from "../shared/bot";
import { parseSkillFolder, parseSkillFrontmatter, sanitizeSkillName } from "../shared/skills";
import { botDataPath, botsHomePath, pluginDataPath } from "./bot-home";
import { realDirUnder } from "./managed-files";

// The shared skill library: one folder per skill under plugin-data/library/skills.
// Bots that use the managed folder get a link to each of their skills in
// <bot>/skills, so the agent reads them inside its own working folder.

const MAX_SKILLS = 30;
const MAX_FILES_PER_SKILL = 40;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LISTED_FILES = 100;

export type ImportedSkill = Pick<LibrarySkill, "id" | "description" | "source">;

function librarySkillsPath(): string {
  return join(pluginDataPath(), "library", "skills");
}

export function librarySkillPath(id: string): string {
  return join(librarySkillsPath(), id);
}

async function saveSkill(files: Map<string, string>, source: string, fallbackName: string): Promise<ImportedSkill> {
  const meta = parseSkillFrontmatter(files.get("SKILL.md") ?? "");
  const id = sanitizeSkillName(meta.name ?? fallbackName);
  const dir = librarySkillPath(id);
  await rm(dir, { recursive: true, force: true });
  for (const [path, text] of files) {
    const target = join(dir, ...path.split("/"));
    if (!target.startsWith(dir + sep)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
  return { id, description: meta.description ?? "", source };
}

const MAX_SEARCH_DEPTH = 4;
const SKIPPED_FOLDERS = new Set(["node_modules", ".git"]);

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

/** Folders at or under `root` that hold a SKILL.md, shallowest first. */
async function findSkillFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_SKILLS) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) found.push(dir);
    if (depth >= MAX_SEARCH_DEPTH) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name) && !entry.name.startsWith(".")) await walk(join(dir, entry.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

/** The text files of one skill folder, keyed by their path inside it; symlinks, big and binary files are left out. */
async function readSkillFiles(dir: string, nested: readonly string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    if (files.size >= MAX_FILES_PER_SKILL) return;
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      // Nested skills are imported on their own.
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name) && !nested.includes(path)) await walk(path);
      } else if (entry.isFile() && files.size < MAX_FILES_PER_SKILL && (await stat(path)).size <= MAX_FILE_BYTES) {
        const text = await readFile(path, "utf8");
        if (!text.includes("\0")) files.set(relative(dir, path).split(sep).join("/"), text);
      }
    }
  };
  await walk(dir);
  return files;
}

/** Copies the skills in a folder on this computer into the library: every folder under it that has a SKILL.md. */
export async function importSkills({ source: input }: { source: string }): Promise<{ skills: ImportedSkill[] }> {
  const root = resolve(expandHome(parseSkillFolder(input)));
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${root} isn't a folder on this computer.`);
  const folders = await findSkillFolders(root);
  if (folders.length === 0) throw new Error(`No SKILL.md found in ${root}.`);
  const skills: ImportedSkill[] = [];
  for (const dir of folders) {
    const files = await readSkillFiles(dir, folders.filter((other) => other !== dir));
    skills.push(await saveSkill(files, dir, basename(dir)));
  }
  return { skills };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return files.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 of a library skill's SKILL.md, or null when it's missing. */
export async function skillSha(id: string): Promise<string | null> {
  const text = await readFile(join(librarySkillPath(id), "SKILL.md"), "utf8").catch(() => null);
  return text === null ? null : sha256(text);
}

export async function readSkill({ id }: { id: string }) {
  const dir = librarySkillPath(id);
  const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null);
  return { text: text ?? "", sha: text === null ? null : sha256(text), missing: text === null, path: join(dir, "SKILL.md"), files: await listFiles(dir) };
}

/** Writes SKILL.md, creating the skill folder if needed. Returns its frontmatter description and hash. */
export async function writeSkill({ id, text }: { id: string; text: string }) {
  const dir = librarySkillPath(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), text, "utf8");
  return { description: parseSkillFrontmatter(text).description ?? "", sha: sha256(text) };
}

export async function deleteSkill({ id }: { id: string }) {
  await rm(librarySkillPath(id), { recursive: true, force: true });
  return { ok: true };
}

/**
 * Before the library, skills lived in each bot's skills folder. Moves them into
 * the library (the first copy of a name wins; later ones stay where they are).
 */
export async function migrateBotSkills(): Promise<void> {
  const bots = await readdir(botsHomePath(), { withFileTypes: true }).catch(() => []);
  for (const bot of bots) {
    if (!bot.isDirectory()) continue;
    const skillsDir = join(botsHomePath(), bot.name, "skills");
    const skills = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
    for (const skill of skills) {
      if (!skill.isDirectory()) continue;
      const target = librarySkillPath(skill.name);
      if (await lstat(target).catch(() => null)) continue;
      await mkdir(librarySkillsPath(), { recursive: true });
      await rename(join(skillsDir, skill.name), target);
    }
  }
}

/**
 * Points <bot>/skills/<id> at each library skill the bot uses and removes links
 * to skills it no longer uses. Returns the SKILL.md path to give the agent for
 * each skill: the link, or the library copy when a link can't be made.
 */
export async function linkBotSkills(botId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const dir = join(botDataPath(botId), "skills");
  const paths = new Map<string, string>();
  await realDirUnder(botDataPath(botId), "skills").catch(() => {});
  const existing = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of existing) {
    if (entry.isSymbolicLink() && !ids.includes(entry.name)) await unlink(join(dir, entry.name)).catch(() => {});
  }
  for (const id of ids) {
    const target = librarySkillPath(id);
    const link = join(dir, id);
    const info = await lstat(link).catch(() => null);
    let linked = false;
    if (info?.isSymbolicLink()) {
      linked = (await readlink(link).catch(() => "")) === target;
      if (!linked) await unlink(link).catch(() => {});
    }
    if (!info || (info.isSymbolicLink() && !linked)) {
      // "junction" lets Windows link folders without admin rights; other systems ignore it.
      linked = await symlink(target, link, "junction").then(
        () => true,
        () => false,
      );
    }
    paths.set(id, join(linked ? link : target, "SKILL.md"));
  }
  return paths;
}
