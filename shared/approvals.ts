import { z } from "zod";
import { botToolName } from "./bot-tools";
import { englishTranslate, type Translate } from "./translate";

// An approval is a matter a bot puts to the user and then waits for. Unlike a proposal card it blocks the asking
// chat until the user decides, and every one is recorded for audit (docs/specs/2026-10-21-approvals-design.md).

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "withdrawn"]);

const NamedSchema = z.object({ id: z.string(), name: z.string() });

export const ApprovalSchema = z.object({
  id: z.string().regex(/^a-[a-f0-9]{10}$/),
  botId: z.string(),
  botName: z.string(),
  /** The asking chat. */
  agentId: z.string(),
  chatTitle: z.string(),
  teamId: z.string().nullable(),
  project: NamedSchema.nullable(),
  workspace: z.string().nullable(),
  title: z.string().min(1).max(200),
  text: z.string().max(20_000),
  /** The file the bot named, read whole at ask time so the user approves exactly what was shown. */
  file: z.object({ path: z.string(), text: z.string(), sha256: z.string(), bytes: z.number() }).nullable(),
  status: ApprovalStatusSchema,
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.enum(["user", "asking-bot", "plugin"]).nullable(),
  /** The user's note on an approval, or the reason for a rejection. */
  note: z.string(),
  /** Whether the chat was interrupted after the ask (null: it was idle already). */
  interrupted: z.boolean().nullable(),
  /** How many turns started in the chat while it waited. */
  woken: z.number(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export interface AuditEvent {
  event: "asked" | "decided" | "withdrawn" | "woken" | "cited" | "interrupted";
  approvalId: string;
  /** What was asked, so the audit still says what an approval was after the state file has let it go. */
  title: string;
  /** UTC. */
  at: string;
  atLocal: string;
  bot: { id: string; name: string };
  chat: { id: string; title: string };
  team: string | null;
  project: { id: string; name: string } | null;
  workspace: string | null;
  detail?: Record<string, unknown>;
}

/** The card of an approval: a tool call that made one, or a plugin item the plugin posts for a bot on files. */
export const APPROVAL_CARD = { kind: "approval", version: 1 } as const;
export const ApprovalCardSchema = z.object({ approvalId: z.string() });

export const MAX_APPROVAL_FILE_BYTES = 200 * 1024;

const APPROVAL_ID = /\bapproval (a-[a-f0-9]{10})\b/i;

/** What the ask tool tells the bot; the card finds the approval from it. */
export function approvalReply(id: string, title: string): string {
  return `Approval ${id}: the user decides on "${title}" on a card in this chat. Stop now and do nothing else until the answer arrives here as a message. Don't decide it yourself.`;
}

export function approvalIdInText(text: string): string | null {
  return APPROVAL_ID.exec(text)?.[1]?.toLowerCase() ?? null;
}

/** The approval a finished request_approval call made, from its output (text or MCP content blocks). */
export function approvalIdOf(call: { name: string; status: string; detail: unknown }): string | null {
  if (call.status !== "completed" || botToolName(call.name) !== "request_approval") return null;
  const detail = call.detail as { output?: unknown } | null;
  const output = detail && typeof detail === "object" && "output" in detail ? detail.output : null;
  return approvalIdInText(typeof output === "string" ? output : JSON.stringify(output ?? null));
}

/** The message that tells the asking chat what the user decided. The user's note is quoted on one line, as data. */
export function decisionMessage(approval: Pick<Approval, "id" | "title" | "status" | "note">): string {
  const verdict = approval.status === "approved" ? "Approved" : approval.status === "rejected" ? "Rejected" : "Withdrawn";
  const note = approval.note.replace(/\s+/g, " ").trim();
  const follow = approval.status === "approved" ? "You may go on." : approval.status === "rejected" ? "Don't go on with it. Talk it over with the user here, revise it, and ask again if it still needs approval." : "It is no longer waiting.";
  return `[Aydo, from the user] ${verdict}: "${approval.title}" (${approval.id}).${note ? ` Note: ${JSON.stringify(note)}.` : ""} ${follow}`;
}

/** What waits first (the oldest has waited longest), then the decided ones, newest first. */
/** An approval without its text and file: what the list and the nav need, small enough to poll. */
export type ApprovalSummary = Omit<Approval, "text" | "file">;

export function sortApprovals<T extends ApprovalSummary>(list: readonly T[]): T[] {
  const waiting = list.filter((entry) => entry.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const decided = list.filter((entry) => entry.status !== "pending").sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  return [...waiting, ...decided];
}

/** One row of the list: the bot, the matter and how it stands. */
export function approvalSummary(approval: ApprovalSummary, t: Translate = englishTranslate): string {
  const note = approval.note.replace(/\s+/g, " ").trim();
  const state =
    approval.status === "pending"
      ? t("text.approval.waiting")
      : note && approval.status !== "withdrawn"
        ? t("text.approval.stateWithNote", { status: t(`text.approval.status.${approval.status}`), note })
        : t(`text.approval.status.${approval.status}`);
  return t("text.approval.summary", { bot: approval.botName, title: approval.title, state });
}
