import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_APPROVAL_FILE_BYTES, type Approval } from "../shared/approvals";

// The file a bot names with its approval (a plan in markdown, say): read whole now, so the user approves
// exactly what the card shows and a later edit cannot change what was approved.

export type ApprovalFileResult = { ok: true; file: NonNullable<Approval["file"]> } | { ok: false; reason: string };

/** `allowed` are the absolute folders the file may be in; a relative path is taken from the first. */
export async function readApprovalFile(input: { path: string; allowed: readonly string[] }): Promise<ApprovalFileResult> {
  const first = input.allowed[0];
  if (!first) return { ok: false, reason: "No folder to read a file from." };
  // A relative path is taken from the first folder that has it (the chat's workspace, then the bot's own folder).
  const candidates = isAbsolute(input.path) ? [resolve(input.path)] : input.allowed.map((dir) => resolve(dir, input.path));
  let path = candidates[0]!;
  for (const candidate of candidates) {
    if (await lstat(candidate).then(() => true, () => false)) {
      path = candidate;
      break;
    }
  }
  const root = input.allowed.map((dir) => resolve(dir)).find((dir) => path.startsWith(dir + sep));
  if (!root) return { ok: false, reason: `The file ${input.path} is outside the folders it may be in (your folder and this chat's workspace).` };
  // Every part below the folder must be a real file or folder: a link (a bot can make one with its shell) is never followed.
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) return { ok: false, reason: `The file ${input.path} was not found.` };
    if (info.isSymbolicLink()) return { ok: false, reason: `The file ${input.path} is, or is inside, a link; the plugin does not read through links.` };
  }
  const info = await lstat(path);
  if (!info.isFile()) return { ok: false, reason: `${input.path} is not a file.` };
  if (info.size > MAX_APPROVAL_FILE_BYTES) return { ok: false, reason: `The file ${input.path} is too big (${info.size} bytes; the most is ${MAX_APPROVAL_FILE_BYTES}, 200 KB).` };
  const bytes = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: `The file ${input.path} is not text (it is not valid UTF-8).` };
  }
  if (text.includes("\u0000")) return { ok: false, reason: `The file ${input.path} is not text (it contains a NUL byte).` };
  return { ok: true, file: { path, text, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length } };
}
