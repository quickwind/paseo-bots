import { englishTranslate, type Translate } from "./translate";

/** An absolute path on this computer: `/…`, `~`, a Windows drive (`C:\…`) or a UNC path (`\\server\…`). */
const LOCAL_FOLDER = /^(\/|~([\\/]|$)|[A-Za-z]:[\\/]|\\\\)/;

/** Whether a skill's source is a folder on this computer, which an update can read again without a network. */
export function isLocalFolder(source: string): boolean {
  return LOCAL_FOLDER.test(source.trim());
}

/** The folder a skill import reads from. Skills come from this computer only, never from the network. */
export function parseSkillFolder(input: string, t: Translate = englishTranslate): string {
  const folder = input.trim();
  if (!isLocalFolder(folder)) {
    throw new Error(t("library.skillFolderPath"));
  }
  return folder;
}

/** Reads `name` and `description` from SKILL.md frontmatter. */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const read = (key: string) => {
    const line = match?.[1]?.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}:`));
    const value = line?.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
    return value ? value : null;
  };
  return { name: read("name"), description: read("description") };
}

export function sanitizeSkillName(name: string): string {
  // No leading dots: "." and ".." would name a folder outside the library.
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return clean || "skill";
}

/** SKILL.md with the frontmatter agents read: a name that matches the folder and a one-line description. */
export function skillMarkdown(id: string, description: string, body: string): string {
  const line = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${id}\ndescription: ${line}\n---\n\n${body.trim()}\n`;
}

/** SKILL.md without its frontmatter. */
export function skillBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** /learn: the bot drafts a skill from the chat and proposes it with propose_skill. */
export const LEARN_COMMAND = { name: "learn", description: "Save what the bot just did as a skill", argumentHint: "[what to focus on]" };

export function learnPrompt(focus = ""): string {
  const topic = focus.trim().replace(/[.!?]*$/, ".");
  const about = focus.trim() ? ` Focus on: ${topic}` : "";
  return `Turn what you just did into a reusable skill: the steps that worked, what to check, and what a good result looks like.${about} Then propose it with the propose_skill tool so I can review it. Don't write the skill file yourself.`;
}

/** The message /learn sends, or null when the text isn't /learn. */
export function expandLearn(text: string): string | null {
  const match = /^\/learn(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? learnPrompt(match[1] ?? "") : null;
}

/**
 * Things worth a second look before a skill reaches a bot. They warn; the user decides.
 *
 * Adapted from OpenMausBot's scanSkillText (shared/skill-md.ts; Apache License 2.0, Copyright 2026 Milind Soni and OpenMausBot
 * contributors; see NOTICE and licenses/Apache-2.0.txt). Changed here: different thresholds and wording, two more checks.
 */
export function scanSkillText(text: string, t: Translate = englishTranslate): string[] {
  const warnings: string[] = [];
  if (/[A-Za-z0-9+/]{400,}={0,2}/.test(text)) warnings.push(t("library.warnEncodedBlob"));
  if (/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(text)) warnings.push(t("library.warnPipeToShell"));
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(text)) warnings.push(t("library.warnInvisible"));
  if (/\b(ignore|disregard)\b[^\n]{0,30}\b(previous|prior|above|all)\b[^\n]{0,20}\binstructions\b/i.test(text)) warnings.push(t("library.warnIgnore"));
  if (/\b(rm\s+-rf\s+[~/]|mkfs\b|dd\s+if=)/.test(text)) warnings.push(t("library.warnErase"));
  return warnings;
}
