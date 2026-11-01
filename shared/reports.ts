import { foldText, localTime, redactSecrets } from "./activity";
import type { BotGroup } from "./bot";
import { TIDY_LABEL } from "./memory-maintenance";

// The facts of a finished turn that the daily log and the team's reports share: who drove it, how it ended,
// and one bracket that says so. Pure; the server looks the facts up (server/reports.ts, server/activity.ts).

export type TurnDriver = { kind: "user" } | { kind: "bot"; name: string; via: "assignment" | "question" } | { kind: "routine" } | { kind: "plugin" };
export type TurnStatus = "started" | "done" | "blocked" | "failed" | "stopped" | "stalled" | "waiting";

/** Who made this turn happen, from the last user message of the chat (the markers the plugin puts on messages it sends). */
export function turnDriver(input: { lastUserMessage: string | null; userMessages: number; routine: boolean }): TurnDriver {
  if (input.routine && input.userMessages === 1) return { kind: "routine" };
  const text = (input.lastUserMessage ?? "").trimStart();
  // The user's answer to an approval comes as a message from the plugin, but the turn it starts is the user's decision at work.
  if (text.startsWith("[Aydo, from the user]")) return { kind: "user" };
  const assignment = /^\[Assignment from ([^,\]]+),/.exec(text);
  if (assignment) return { kind: "bot", name: assignment[1]!.trim(), via: "assignment" };
  const question = /^\[Message from ([^,\]]+),/.exec(text);
  if (question) return { kind: "bot", name: question[1]!.trim(), via: "question" };
  if (/^\[(Aydo|Reply from|Report from)\b/.test(text)) return { kind: "plugin" };
  return { kind: "user" };
}

/** How a turn ended: a reply that starts with the capitalised word BLOCKED (as an assignment asks) is a bot saying it cannot go on. */
export function turnStatus(outcome: "completed" | "failed" | "canceled", reply: string): TurnStatus {
  if (outcome === "failed") return "failed";
  if (outcome === "canceled") return "stopped";
  return /^\s*BLOCKED\b/.test(reply) ? "blocked" : "done";
}

const driverText = (driver: TurnDriver): string => {
  switch (driver.kind) {
    case "user":
      return "by the user";
    case "bot":
      return `${driver.via === "assignment" ? "assigned" : "asked"} by ${driver.name}`;
    case "routine":
      return "routine";
    case "plugin":
      return "by the plugin";
  }
};

/** Square brackets in a title or a name would end the bracket early and hide the line (and its status) from the lead. */
const plain = (text: string) => text.replace(/\[/g, "(").replace(/\]/g, ")");

/** How a status reads in a line; the lead sees why a chat is quiet. */
const statusText = (status: TurnStatus): string => (status === "waiting" ? "waiting for approval" : status);

/** "app · Login · assigned by Mate · done": where (when in a project workspace), who drove it, how it ended. */
export function turnMeta(input: { workspace: string | null; driver: TurnDriver; status: TurnStatus }): string {
  return [input.workspace ? plain(input.workspace) : null, plain(driverText(input.driver)), statusText(input.status)].filter(Boolean).join(" · ");
}

/** A project's folder name under a team's reports: short, lower case, letters, digits and dashes. */
export function projectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "project";
}

// ---------------------------------------------------------------- records (team reports v2)

const RECORD_MAX = 20_000;
const cutText = (text: string): string => {
  const clean = redactSecrets(text);
  return clean.length > RECORD_MAX ? `${clean.slice(0, RECORD_MAX)}\n[cut at ${RECORD_MAX} characters]` : clean;
};

/** One finished turn of a team member in a project workspace: the whole question and the last answer, no tool calls. */
export interface ReportRecord {
  at: string;
  /** The local time (HH:MM) of the turn, as the index lines and latest.md show it: `at` is UTC. */
  localTime: string;
  bot: { id: string; name: string };
  chat: { id: string; title: string };
  project: { id: string; name: string };
  workspace: string;
  driver: TurnDriver;
  status: TurnStatus;
  question: string;
  answer: string;
}

export function reportRecord(input: Omit<ReportRecord, "at" | "localTime" | "question" | "answer"> & { at: Date; question: string; answer: string }): ReportRecord {
  return { ...input, at: input.at.toISOString(), localTime: localTime(input.at), question: cutText(input.question), answer: cutText(input.answer) };
}

/** A long answer by its first 160 and last 80 characters (the conclusion is often at the end). */
function answerPart(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  return flat.length <= 240 ? flat : `${flat.slice(0, 160).trimEnd()} … ${flat.slice(-80).trimStart()}`;
}

/** One line of a day's .md index: the record in short, with enough to find the whole record in the .jsonl (chat id and time). */
export function reportIndexLine(record: ReportRecord): string {
  const meta = turnMeta({ workspace: record.workspace, driver: record.driver, status: record.status });
  const question = foldText(record.question, 60);
  const answer = answerPart(record.answer);
  const text = [question ? `Q: ${question}` : "", answer ? `A: ${answer}` : ""].filter(Boolean).join(" · ");
  return `- ${localTime(new Date(record.at))} · ${record.bot.name} · "${foldText(record.chat.title.replace(/"/g, "'"), 60)}" · [${meta}]${text ? ` · ${text}` : ""} · chat ${record.chat.id.slice(0, 8)}`;
}

const INDEX_LINE = /^- (\d{2}:\d{2}) · (.+?) · "[^"]*" · \[([^\]]*)\](?: · (.*?))? · chat (\S+)$/;

/** The parts of an index line as `reportIndexLine` writes it; null for any other line. */
export function parseIndexLine(line: string): { time: string; bot: string; meta: string; text: string; chat: string } | null {
  const match = INDEX_LINE.exec(line.trim());
  return match ? { time: match[1]!, bot: match[2]!, meta: match[3]!, text: match[4] ?? "", chat: match[5]! } : null;
}

const NEEDS_ATTENTION = new Set(["blocked", "failed", "stalled", "waiting for approval"]);

/**
 * One line for each chat: its newest index line (with how many turns it had that day, and its chat id, which finds the record), the chats that need attention
 * first (blocked, failed, stalled, waiting for approval), then the newest first. Lines that are not in the shape the plugin writes are left out.
 */
export function statusLines(entries: readonly { project: string; day: string; line: string }[], max: number): string[] {
  type Parsed = NonNullable<ReturnType<typeof parseIndexLine>>;
  type Entry = { project: string; day: string; parsed: Parsed; order: number };
  interface Chat extends Entry { turns: number }
  const byChat = new Map<string, Entry[]>();
  entries.forEach(({ project, day, line }, order) => {
    const parsed = parseIndexLine(line);
    if (!parsed) return;
    const key = `${project}\u0000${parsed.chat}`;
    byChat.set(key, [...(byChat.get(key) ?? []), { project, day, parsed, order }]);
  });
  // Newer by day and time; a line written later wins a tie within the same minute.
  const newer = (a: Entry, b: Entry) => `${a.day} ${a.parsed.time}`.localeCompare(`${b.day} ${b.parsed.time}`) || a.order - b.order;
  const chats: Chat[] = [...byChat.values()].map((list) => {
    const newest = list.reduce((a, b) => (newer(b, a) >= 0 ? b : a));
    // A started or stalled line is not a turn of the chat.
    const turn = (entry: Entry) => !["started", "stalled"].includes(entry.parsed.meta.split(" · ").at(-1) ?? "");
    return { ...newest, turns: list.filter((entry) => entry.day === newest.day && turn(entry)).length };
  });
  const status = (chat: Chat) => chat.parsed.meta.split(" · ").at(-1) ?? "";
  const sorted = chats.sort((a, b) => Number(NEEDS_ATTENTION.has(status(b))) - Number(NEEDS_ATTENTION.has(status(a))) || newer(b, a));
  return sorted.slice(0, max).map((chat) => {
    const label = foldText(chat.project, 40);
    const where = chat.parsed.meta.startsWith(`${chat.project} · `) ? chat.parsed.meta.slice(chat.project.length + 3) : chat.parsed.meta;
    return `[${label}] ${chat.day} ${chat.parsed.time} · ${chat.parsed.bot} · ${where}${chat.parsed.text ? ` · ${chat.parsed.text}` : ""}${chat.turns > 1 ? ` · ${chat.turns} turns that day` : ""} · chat ${chat.parsed.chat}`;
  });
}

/** The question or task itself of a message another bot sent: the framing the plugin puts first (up to the first blank line) is left off. */
export function questionText(message: string): string {
  const framed = /^\[(?:Assignment from|Message from|Reply from|Report from)[^\]]*\]\s*\n\n([\s\S]*)$/.exec(message.trimStart());
  return framed ? framed[1]!.trim() : message;
}

/**
 * Whether a chat gets the team's report folder attached: the team's lead only, and not for a memory tidy chat (it reads
 * untrusted text unattended and must not be able to write the team's record). Members are told the path and read on demand.
 */
export function mayAttachReports(bot: { id: string }, group: BotGroup | null, labels: Record<string, string>): boolean {
  return !!group && group.leadId === bot.id && !labels[TIDY_LABEL];
}
