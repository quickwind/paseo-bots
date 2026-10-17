import { appendFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { localDay, parseLog, type LogEntry } from "../shared/activity";
import { INBOX_FILE, MEMORY_MAX_BYTES, MEMORY_MAX_LINES } from "../shared/memory-maintenance";
import { botDataPath } from "./bot-home";
import { dropLink, realDirUnder } from "./managed-files";

// OpenMausBot's budget: the first MEMORY_MAX_LINES lines or MEMORY_MAX_BYTES bytes of MEMORY.md go into every chat.
export const MAIN_MEMORY = "MEMORY.md";

export function memoryFolder(botId: string): string {
  return botDataPath(botId);
}

export function memoryFilePath(botId: string, name: string): string {
  return name === MAIN_MEMORY ? join(botDataPath(botId), MAIN_MEMORY) : join(botDataPath(botId), "memory", name);
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function cutToBytes(text: string, limit: number): string {
  let out = "";
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char, "utf8");
    if (bytes > limit) break;
    out += char;
  }
  return out;
}

function trimForPrompt(text: string): string {
  const lines = text.split("\n").slice(0, MEMORY_MAX_LINES);
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (Buffer.byteLength(next, "utf8") > MEMORY_MAX_BYTES) {
      // A first line over the limit still gives its first part, cut between characters.
      if (!out) out = cutToBytes(line, MEMORY_MAX_BYTES);
      break;
    }
    out = next;
  }
  return out;
}

export async function injectedMemory(botId: string): Promise<string> {
  return trimForPrompt(await readText(memoryFilePath(botId, MAIN_MEMORY)));
}

export async function listMemory(botId: string) {
  const files: { name: string; bytes: number; lines: number; topic: boolean }[] = [];
  const main = await readText(memoryFilePath(botId, MAIN_MEMORY));
  files.push({ name: MAIN_MEMORY, bytes: Buffer.byteLength(main, "utf8"), lines: main ? main.split("\n").length : 0, topic: false });
  try {
    for (const name of (await readdir(join(botDataPath(botId), "memory"))).sort()) {
      if (!name.endsWith(".md")) continue;
      const path = join(botDataPath(botId), "memory", name);
      if (!(await stat(path)).isFile()) continue;
      const text = await readText(path);
      files.push({ name, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length, topic: true });
    }
  } catch {
    // No topic files yet.
  }
  const injected = trimForPrompt(main);
  return {
    folder: botDataPath(botId),
    files,
    injectedLines: injected ? injected.split("\n").length : 0,
    injectedBytes: Buffer.byteLength(injected, "utf8"),
  };
}

export async function readMemory(botId: string, name: string) {
  return { text: await readText(memoryFilePath(botId, name)) };
}

// ---------------------------------------------------------------- daily log

const LOG_DAY = /^\d{4}-\d{2}-\d{2}$/;

function logFolder(botId: string): string {
  return join(botDataPath(botId), "memory", "log");
}

function logPath(botId: string, day: string): string {
  if (!LOG_DAY.test(day)) throw new Error(`Not a log day: ${day}`);
  return join(logFolder(botId), `${day}.md`);
}

/** Adds a line to today's log, memory/log/YYYY-MM-DD.md. */
export async function appendDailyLog(botId: string, line: string, at = new Date()): Promise<void> {
  // The bot can replace memory/log, or today's file, with a link; neither is followed.
  await realDirUnder(botDataPath(botId), "memory", "log");
  const path = logPath(botId, localDay(at));
  await dropLink(path);
  await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

/** The log's days, newest first, with how many lines each has. */
export async function listLogDays(botId: string) {
  const names = await readdir(logFolder(botId)).catch(() => [] as string[]);
  const days = names.filter((name) => LOG_DAY.test(name.replace(/\.md$/, "")) && name.endsWith(".md")).map((name) => name.replace(/\.md$/, ""));
  const out: { day: string; lines: number }[] = [];
  for (const day of days.sort().reverse()) {
    const text = await readText(logPath(botId, day));
    out.push({ day, lines: text.split("\n").filter((line) => line.trim()).length });
  }
  return { days: out };
}

export async function readLogDay(botId: string, day: string) {
  return { text: await readText(logPath(botId, day)) };
}

export async function deleteLogDay(botId: string, day: string) {
  await rm(logPath(botId, day), { force: true });
  return { ok: true };
}

/** Log entries from the last `days` days (today included), oldest first. */
export async function recentLogEntries(botId: string, days: number, now = new Date()): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
    entries.push(...parseLog(day, await readText(logPath(botId, day))));
  }
  return entries;
}

/** Every memory file with its text, as the bot sees the paths: MEMORY.md, memory/<topic>.md and memory/log/<day>.md. */
export async function memoryTexts(botId: string): Promise<{ path: string; text: string }[]> {
  const files = [{ path: MAIN_MEMORY, text: await readText(memoryFilePath(botId, MAIN_MEMORY)) }];
  const topics = await readdir(join(botDataPath(botId), "memory")).catch(() => [] as string[]);
  for (const name of topics.filter((entry) => entry.endsWith(".md")).sort()) files.push({ path: `memory/${name}`, text: await readText(memoryFilePath(botId, name)) });
  for (const { day } of (await listLogDays(botId)).days) files.push({ path: `memory/log/${day}.md`, text: await readText(logPath(botId, day)) });
  return files.filter((file) => file.text);
}

// ---------------------------------------------------------------- maintenance

export function inboxPath(botId: string): string {
  return memoryFilePath(botId, INBOX_FILE);
}

export async function memoryUsage(botId: string): Promise<{ lines: number; bytes: number }> {
  const text = await readText(memoryFilePath(botId, MAIN_MEMORY));
  return { lines: text ? text.split("\n").length : 0, bytes: Buffer.byteLength(text, "utf8") };
}

/** The topic files (memory/*.md, the inbox included) with their first non-empty line. */
export async function topicIndex(botId: string): Promise<{ name: string; firstLine: string }[]> {
  const names = (await readdir(join(botDataPath(botId), "memory")).catch(() => [] as string[])).filter((name) => name.endsWith(".md")).sort();
  const out: { name: string; firstLine: string }[] = [];
  for (const name of names) {
    const text = await readText(memoryFilePath(botId, name));
    out.push({ name, firstLine: text.split("\n").find((line) => line.trim())?.trim().slice(0, 120) ?? "" });
  }
  return out;
}

/** Bytes of real notes in the inbox: blank lines and headings do not count, so an inbox the tidy chat "emptied" with a blank line stays empty. */
export async function inboxBytes(botId: string): Promise<number> {
  const notes = (await readText(inboxPath(botId)))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return Buffer.byteLength(notes.join("\n"), "utf8");
}

/** The log keeps minutes, so a line from the minute a tidy started in is counted: it may have come after the start. */
const startOfMinute = (date: Date) => Math.floor(date.getTime() / 60_000) * 60_000;

/** Daily-log lines written after `since` (all of the last 31 days when null), and the log files that hold them. */
export async function newLogLines(botId: string, since: Date | null, now = new Date()): Promise<{ count: number; files: string[] }> {
  let count = 0;
  const files: string[] = [];
  for (let back = 30; back >= 0; back--) {
    const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
    const entries = parseLog(day, await readText(logPath(botId, day))).filter((entry) => !since || entry.at.getTime() >= startOfMinute(since));
    if (entries.length) {
      count += entries.length;
      files.push(logPath(botId, day));
    }
  }
  return { count, files };
}
