import { randomBytes } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { localDay, localTime } from "../shared/activity";
import type { Approval, AuditEvent } from "../shared/approvals";
import { pluginDataPath } from "./bot-home";
import { dropLink, realDirUnder, writeAtomic } from "./managed-files";

// Approvals wait in one file (with the messages held for chats that wait); the audit is a separate append-only
// file outside every bot's folder. Pending approvals are never trimmed; only the newest decided ones are kept.

const KEEP_DECIDED = 500;

interface State {
  approvals: Approval[];
  held: Record<string, string[]>;
}

type NewApproval = Omit<Approval, "id" | "status" | "createdAt" | "decidedAt" | "decidedBy" | "note" | "interrupted" | "woken">;

const statePath = () => join(pluginDataPath(), "approvals.json");
const auditDir = () => join(pluginDataPath(), "approvals");
const auditPath = () => join(auditDir(), "audit.jsonl");

async function load(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Partial<State>;
    return { approvals: parsed.approvals ?? [], held: parsed.held ?? {} };
  } catch {
    return { approvals: [], held: {} };
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** One read-modify-write at a time. */
function update<T>(change: (state: State) => T): Promise<T> {
  const run = async () => {
    const state = await load();
    const result = change(state);
    const decided = state.approvals.filter((entry) => entry.status !== "pending");
    const drop = new Set(decided.slice(0, Math.max(0, decided.length - KEEP_DECIDED)).map((entry) => entry.id));
    if (drop.size) state.approvals = state.approvals.filter((entry) => !drop.has(entry.id));
    await writeAtomic(statePath(), JSON.stringify(state, null, 2), 0o600);
    return result;
  };
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

export function createApproval(input: NewApproval): Promise<Approval> {
  const approval: Approval = { ...input, id: `a-${randomBytes(5).toString("hex")}`, status: "pending", createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null, note: "", interrupted: null, woken: 0 };
  return update((state) => {
    state.approvals.push(approval);
    return approval;
  });
}

/** Like createApproval, but nothing is made when the chat already has one waiting: the check and the add are one step, so two requests at once make one. */
export function createApprovalIfNone(input: NewApproval): Promise<Approval | null> {
  const approval: Approval = { ...input, id: `a-${randomBytes(5).toString("hex")}`, status: "pending", createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null, note: "", interrupted: null, woken: 0 };
  return update((state) => {
    if (state.approvals.some((entry) => entry.agentId === input.agentId && entry.status === "pending")) return null;
    state.approvals.push(approval);
    return approval;
  });
}

export async function getApproval(id: string): Promise<Approval | null> {
  return (await load()).approvals.find((entry) => entry.id === id) ?? null;
}

/** Newest first. */
export async function listApprovals(filter: { botId?: string; agentId?: string; status?: Approval["status"] } = {}): Promise<Approval[]> {
  return (await load()).approvals
    .filter((entry) => (!filter.botId || entry.botId === filter.botId) && (!filter.agentId || entry.agentId === filter.agentId) && (!filter.status || entry.status === filter.status))
    .reverse();
}

export async function pendingFor(agentId: string): Promise<Approval | null> {
  return (await load()).approvals.find((entry) => entry.agentId === agentId && entry.status === "pending") ?? null;
}

export function resolveApproval(id: string, change: { status: "approved" | "rejected" | "withdrawn"; note: string; decidedBy: NonNullable<Approval["decidedBy"]> }): Promise<Approval> {
  return update((state) => {
    const found = state.approvals.find((entry) => entry.id === id);
    if (!found) throw new Error("This approval is no longer available.");
    if (found.status !== "pending") throw new Error("It was already decided.");
    Object.assign(found, { status: change.status, note: change.note, decidedBy: change.decidedBy, decidedAt: new Date().toISOString() });
    return { ...found };
  });
}

export async function patchApproval(id: string, patch: Partial<Pick<Approval, "interrupted" | "woken">>): Promise<void> {
  await update((state) => {
    const found = state.approvals.find((entry) => entry.id === id);
    if (found) Object.assign(found, patch);
  });
}

/** Holds the message when the chat has an approval waiting, in one step with the check; false when it has none. */
export function holdIfPending(agentId: string, text: string): Promise<boolean> {
  return update((state) => {
    if (!state.approvals.some((entry) => entry.agentId === agentId && entry.status === "pending")) return false;
    (state.held[agentId] ??= []).push(text);
    return true;
  });
}

/** The chats that have messages held. */
export async function heldChats(): Promise<string[]> {
  return Object.keys((await load()).held);
}

export async function holdMessage(agentId: string, text: string): Promise<void> {
  await update((state) => void (state.held[agentId] ??= []).push(text));
}

/** Takes what is held for a chat and clears it in one step, so two releases never send the same message. */
export function takeHeld(agentId: string): Promise<string[]> {
  return update((state) => {
    const taken = state.held[agentId] ?? [];
    delete state.held[agentId];
    return taken;
  });
}

export async function dropHeld(agentId: string): Promise<void> {
  await takeHeld(agentId);
}

export function auditEvent(event: AuditEvent["event"], approval: Approval, detail?: Record<string, unknown>, now = new Date()): AuditEvent {
  return {
    event,
    approvalId: approval.id,
    title: approval.title,
    at: now.toISOString(),
    atLocal: `${localDay(now)} ${localTime(now)}`,
    bot: { id: approval.botId, name: approval.botName },
    chat: { id: approval.agentId, title: approval.chatTitle },
    team: approval.teamId,
    project: approval.project,
    workspace: approval.workspace,
    ...(detail ? { detail } : {}),
  };
}

let auditQueue: Promise<unknown> = Promise.resolve();

export function appendAudit(event: AuditEvent): Promise<void> {
  const run = async () => {
    await realDirUnder(pluginDataPath(), "approvals");
    await dropLink(auditPath());
    await appendFile(auditPath(), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  };
  const next = auditQueue.then(run);
  auditQueue = next.catch(() => {});
  return next;
}

/** Newest first. */
export async function readAudit(filter: { approvalId?: string; limit?: number } = {}): Promise<AuditEvent[]> {
  let text = "";
  try {
    text = await readFile(auditPath(), "utf8");
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AuditEvent);
    } catch {
      // A torn last line is skipped, not fatal.
    }
  }
  const found = filter.approvalId ? events.filter((event) => event.approvalId === filter.approvalId) : events;
  return found.reverse().slice(0, filter.limit ?? found.length);
}
