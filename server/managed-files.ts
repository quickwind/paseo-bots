import { lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// Folders the plugin owns inside a bot's folder (setup/, history/): they hold exactly the files the
// plugin last wrote, so a sync both writes what is wanted and removes what is not.

/**
 * Makes sure `dir` is a real folder: a link in its place (a bot can make one with its shell) is
 * removed rather than followed, so the plugin never writes into or deletes from somewhere else.
 */
export async function realDir(dir: string): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  if (info?.isSymbolicLink()) await unlink(dir);
  await mkdir(dir, { recursive: true });
}

/**
 * Makes sure each folder in `parts` below `root` is a real folder, creating them. Links among them are
 * removed rather than followed, so a write below never lands outside `root`.
 */
export async function realDirUnder(root: string, ...parts: string[]): Promise<string> {
  let dir = root;
  await mkdir(dir, { recursive: true });
  for (const part of parts.flatMap((entry) => entry.split(/[\\/]/)).filter(Boolean)) {
    dir = join(dir, part);
    await realDir(dir);
  }
  return dir;
}

/** Removes `path` when it is a link, so an append or write goes to a file of its own and not to the link's target. */
export async function dropLink(path: string): Promise<void> {
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) await unlink(path);
}

/** Windows will not replace a file while someone has it open (a reader, a scanner); it says one of these for a moment. */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_TRIES = 20;

/** Writes `text` to `path` through a temporary file and a rename; `mode` keeps a file private (0o600) from the start. */
export async function writeAtomic(path: string, text: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary, text, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (attempt >= RENAME_TRIES || !BUSY.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10 * attempt, 50)));
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), relative)));
    else out.push(relative);
  }
  return out;
}

/** Makes `dir` hold exactly `files` (paths relative to it, with "/" separators). Unchanged text is not rewritten. */
export async function syncManaged(dir: string, files: readonly { path: string; text: string }[]): Promise<void> {
  await realDir(dir);
  const wanted = new Set(files.map((file) => file.path));
  for (const file of files) {
    const target = join(dir, ...file.path.split("/"));
    await realDirUnder(dir, ...file.path.split("/").slice(0, -1));
    const current = await readFile(target, "utf8").catch(() => null);
    if (current !== file.text) await writeAtomic(target, file.text);
  }
  for (const existing of await listFiles(dir)) if (!wanted.has(existing)) await rm(join(dir, ...existing.split("/")), { force: true });
  // Empty folders left behind.
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && (await listFiles(join(dir, entry.name))).length === 0) await rm(join(dir, entry.name), { recursive: true, force: true });
  }
}

/** Removes the folder when it exists. */
export async function clearManaged(dir: string): Promise<void> {
  if (await stat(dir).then(() => true, () => false)) await rm(dir, { recursive: true, force: true });
}
