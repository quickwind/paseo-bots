import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Files the plugin keeps its state in are read while they are written, and a crash must not leave half of one.
// They are written through writeAtomic (temporary file, then rename). A direct writeFile is for the cases below only.
const DIRECT_WRITES_OK: Record<string, string> = {
  "managed-files.ts": "writeAtomic itself",
  "identity.ts": "writes its own temporary file and renames it",
  "history-files.ts": "writes its own temporary file and renames it",
  "share.ts": "imports into the folder of a bot that was just created",
  "library.ts": "skill files a person edits, in a folder of their own",
  "uploads.ts": "a new file with a name of its own",
};

async function serverFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await serverFiles(join(dir, entry.name))));
    else if (entry.name.endsWith(".ts")) out.push(join(dir, entry.name));
  }
  return out;
}

describe("state files", () => {
  it("are written through writeAtomic, not with a plain writeFile", async () => {
    const root = join(__dirname, "..", "server");
    const offenders: string[] = [];
    for (const file of await serverFiles(root)) {
      const name = file.slice(root.length + 1);
      if (DIRECT_WRITES_OK[name]) continue;
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (/\bwriteFile\(/.test(line)) offenders.push(`${name}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
