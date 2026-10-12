import type { PromptSection } from "./bot";

// A bot's identity (persona, standing instructions, memory, skills) reaches Devin as an always-on
// rule file in the bot's folder: Devin has no system prompt channel over ACP, but it reads
// `.devin/rules/*.md` that say `trigger: always_on`, and takes a snapshot when a chat is created.

/** Where Devin looks for rules, relative to a chat's working folder. */
export const RULES_DIR = ".devin/rules";
export const IDENTITY_FILE = "bot-identity";
/** Devin truncates an always-on rule at 32 KiB; stay a little under. */
export const IDENTITY_MAX_BYTES = 32_000;

const HEADER = "---\ntrigger: always_on\n---\n<!-- Written by the Bots plugin from this bot's settings. Do not edit: changes are overwritten. -->\n\n";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

export interface IdentityPlan {
  files: { name: string; text: string }[];
  /** What the user should know: the identity needed several files, or part of it was cut. */
  note: string | null;
}

/** Cuts text into pieces of at most `limit` bytes at line breaks (inside a line only when one line is longer). */
function cutAtLines(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let current = "";
  const push = () => {
    if (current) pieces.push(current);
    current = "";
  };
  for (const line of text.split("\n")) {
    if (bytes(line) > limit) {
      push();
      let part = "";
      for (const char of Array.from(line)) {
        if (bytes(part + char) > limit) {
          pieces.push(part);
          part = "";
        }
        part += char;
      }
      current = part;
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (bytes(candidate) <= limit) current = candidate;
    else {
      push();
      current = line;
    }
  }
  push();
  return pieces;
}

/** The rule files for a bot's prompt sections: one, or several when it is over the limit. */
export function planIdentityFiles(sections: readonly PromptSection[]): IdentityPlan {
  const capacity = IDENTITY_MAX_BYTES - bytes(HEADER);
  const chunks: string[] = [];
  let current = "";
  let cut = false;
  for (const section of sections) {
    const text = section.text.trim();
    if (!text) continue;
    const pieces = bytes(text) > capacity ? ((cut = true), cutAtLines(text, capacity)) : [text];
    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (bytes(candidate) <= capacity) current = candidate;
      else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
  }
  if (current || chunks.length === 0) chunks.push(current);
  const files = chunks.map((chunk, index) => ({ name: `${IDENTITY_FILE}${index === 0 ? "" : `-${index + 1}`}.md`, text: `${HEADER}${chunk}\n` }));
  const notes: string[] = [];
  if (files.length > 1) notes.push(`The identity is ${files.length} files because it is over 32 KB, the most Devin reads from one rule.`);
  if (cut) notes.push("One long section was cut at line breaks across files; shorten it (the memory, or the standing instructions) to keep it whole.");
  return { files, note: notes.length ? notes.join(" ") : null };
}

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const isDrivePath = (path: string) => /^[a-z]:\//i.test(path);

/** Whether two paths name the same folder; Windows drive paths compare without regard to case. */
export function samePath(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return isDrivePath(left) || isDrivePath(right) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Whether a chat sends the bot's prompt itself. A Devin chat in the bot's own folder reads the
 * identity from its rules file instead, so the prompt would only be there twice. A Devin chat in
 * the user's own folder (the bot's working folder setting) gets no file written there, and any
 * other provider takes the prompt natively.
 */
export function sendsPromptInChat(provider: string, cwd: string, botHome: string): boolean {
  return !(/^devin(\b|$)/.test(provider) && samePath(cwd, botHome));
}
