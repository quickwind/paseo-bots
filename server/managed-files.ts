import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// Folders the plugin owns inside a bot's folder (setup/, history/): they hold exactly the files the
// plugin last wrote, so a sync both writes what is wanted and removes what is not.

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
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
  const wanted = new Set(files.map((file) => file.path));
  for (const file of files) {
    const target = join(dir, ...file.path.split("/"));
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
