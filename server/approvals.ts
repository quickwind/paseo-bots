import { newUuid } from "../shared/uuid";
import { approvalReply, decisionMessage, type Approval } from "../shared/approvals";
import type { Bot } from "../shared/bot";
import { teamOf } from "../shared/groups";
import { TIDY_LABEL } from "../shared/memory-maintenance";
import { workspaceLabel } from "../shared/workspaces";
import { createApprovalIfNone, auditEvent, appendAudit, dropHeld, getApproval, heldChats, holdMessage, listApprovals, patchApproval, pendingFor, resolveApproval, takeHeld } from "./approvals-store";
import { readApprovalFile } from "./approvals-file";
import { botDataPath } from "./bot-home";
import { isOwnSend, markOwnSend } from "./chat-send";
import type { BotsHost } from "./host";
import { workspaceOfChat } from "./workspaces";

// A bot puts a matter to the user and waits. The card is decided by the user only (the RPCs in index.server.ts); the
// plugin stops the asking chat as far as it can, holds what it would send into it (server/chat-send.ts), checks an
// approval a bot cites, and records everything in the audit (docs/specs/2026-10-21-approvals-design.md).

const INTERRUPT_TEXT = "[Aydo] STOP: your request for the user's approval is waiting. Do not run anything else; reply only with the word WAITING. The user's answer will arrive here as a message.";

export interface AskResult {
  ok: boolean;
  text: string;
  approvalId: string | null;
}

type Who = "user" | "asking-bot" | "plugin";

export class Approvals {
  /**
   * `onDecided` is called with the asking chat after an approval is decided or withdrawn: the asks service restarts
   * its stall clocks and delivers the reports that waited.
   */
  constructor(
    private readonly host: BotsHost,
    private readonly onDecided: (agentId: string) => Promise<void>,
    private readonly options: { interruptDelayMs?: number } = {},
  ) {}

  /** A bot's request: check it, make the approval, and stop the chat if the bot goes on. */
  async request(from: { bot: Bot; agentId: string; labels: Record<string, string> }, args: { title: string; text: string; file?: string }): Promise<AskResult> {
    const fail = (text: string): AskResult => ({ ok: false, text, approvalId: null });
    const { bot, agentId } = from;
    if (bot.hostId) return fail("Approvals are only for bots on this host.");
    if (from.labels[TIDY_LABEL]) return fail("A memory tidy chat can't ask for approval.");
    const title = args.title.trim();
    if (!title) return fail("An approval needs a title.");
    const oneAtATime = "This chat already has an approval waiting for the user. One at a time: wait for the answer, or withdraw it with withdraw_approval.";
    if (await pendingFor(agentId)) return fail(oneAtATime);
    const paseo = this.host.requirePaseo();
    const workspace = await workspaceOfChat(paseo, agentId).catch(() => null);
    let file: Approval["file"] = null;
    if (args.file?.trim()) {
      const read = await readApprovalFile({ path: args.file.trim(), allowed: [...(workspace ? [workspace.directory] : []), botDataPath(bot.id)] });
      if (!read.ok) return fail(read.reason);
      file = read.file;
    }
    const groups = (await this.host.values())?.groups ?? [];
    const chat = await this.host.chatOf(agentId).catch(() => null);
    const approval = await createApprovalIfNone({
      botId: bot.id,
      botName: bot.name,
      agentId,
      chatTitle: chat?.title?.trim() || "Untitled chat",
      teamId: teamOf(bot.id, groups)?.id ?? null,
      project: workspace?.projectId ? { id: workspace.projectId, name: workspace.projectName ?? workspace.title } : null,
      workspace: workspace ? workspaceLabel(workspace) : null,
      title: title.slice(0, 200),
      text: args.text.slice(0, 20_000),
      file,
    });
    // Two requests at once from one chat: only one is made.
    if (!approval) return fail(oneAtATime);
    await appendAudit(auditEvent("asked", approval, { text: approval.text.slice(0, 2_000), ...(approval.file ? { file: { path: approval.file.path, sha256: approval.file.sha256, bytes: approval.file.bytes } } : {}) }));
    const delay = this.options.interruptDelayMs ?? 4_000;
    // A bot on files has ended its turn already; one on MCP may go on, and is stopped if it does.
    setTimeout(() => void this.interruptIfRunning(approval.id).catch((error: unknown) => console.error("aydo: couldn't stop a chat waiting for approval", error)), delay).unref?.();
    return { ok: true, text: approvalReply(approval.id, approval.title), approvalId: approval.id };
  }

  /** The chat is still running some time after the ask: interrupt its turn (the daemon interrupts on a send). */
  async interruptIfRunning(id: string): Promise<void> {
    const approval = await getApproval(id);
    if (!approval || approval.status !== "pending") return;
    const paseo = this.host.requirePaseo();
    const snapshot = await paseo.agents.ref(approval.agentId).refresh().catch(() => null);
    const status = snapshot?.agent.status;
    if (status !== "running" && status !== "initializing") {
      await patchApproval(id, { interrupted: false });
      return;
    }
    markOwnSend(approval.agentId);
    await paseo.agents.ref(approval.agentId).send(INTERRUPT_TEXT, { messageId: newUuid(), activeTurnBehavior: "interrupt" } as never);
    await patchApproval(id, { interrupted: true });
    await appendAudit(auditEvent("interrupted", approval));
  }

  /** The user decided. `click` is the card's marker of the click, kept in the audit as a weak check. */
  async decide(id: string, input: { approve: boolean; note: string; click: string }): Promise<Approval> {
    const note = input.note.trim();
    if (!input.approve && !note) throw new Error("Say what to change.");
    const approval = await resolveApproval(id, { status: input.approve ? "approved" : "rejected", note, decidedBy: "user" });
    await appendAudit(auditEvent("decided", approval, { approve: input.approve, status: approval.status, note: approval.note, click: input.click }));
    await this.finish(approval, true);
    return approval;
  }

  /** The asking bot (only for its own chat's approval), the user, or the plugin cancels a pending approval. */
  async withdraw(id: string, by: Who, askingChat?: string): Promise<Approval> {
    const current = await getApproval(id);
    if (by === "asking-bot" && current && current.agentId !== askingChat) throw new Error("That approval is not yours.");
    const approval = await resolveApproval(id, { status: "withdrawn", note: "", decidedBy: by });
    await appendAudit(auditEvent("withdrawn", approval, { by }));
    // The asking bot knows it withdrew; a message would only start another turn.
    await this.finish(approval, by === "user");
    return approval;
  }

  /** The chat was archived or its bot deleted: nothing can answer it, so the approval and what was held for it go. */
  async withdrawForChat(agentId: string): Promise<void> {
    const pending = await pendingFor(agentId);
    if (!pending) return;
    const approval = await resolveApproval(pending.id, { status: "withdrawn", note: "", decidedBy: "plugin" });
    await appendAudit(auditEvent("withdrawn", approval, { by: "plugin", reason: "the chat or its bot is gone" }));
    await dropHeld(agentId);
  }

  /**
   * Withdraws what nothing can answer: the approvals of a bot that was deleted or archived, and of a chat that no longer
   * exists. Does nothing when the bots cannot be read (a pending approval is worth more than a wrong withdrawal).
   */
  async sweep(): Promise<void> {
    await this.withdrawOrphans();
    await this.releaseStranded();
  }

  private async withdrawOrphans(): Promise<void> {
    const pending = await listApprovals({ status: "pending" });
    if (pending.length === 0) return;
    let bots: Bot[];
    try {
      bots = await this.host.bots();
    } catch {
      return;
    }
    const paseo = this.host.paseo;
    for (const approval of pending) {
      const bot = bots.find((entry) => entry.id === approval.botId);
      let gone = !bot || bot.archived;
      if (!gone && paseo) gone = await paseo.agents.ref(approval.agentId).refresh().then((snapshot) => !snapshot || Boolean(snapshot.agent.archivedAt)).catch(() => false); // an error is not "gone": it may be a busy daemon
      if (gone) await this.withdrawForChat(approval.agentId).catch((error: unknown) => console.error("aydo: couldn't withdraw an approval nobody can answer", error));
    }
  }

  /** Sends what is stranded: held messages of chats that wait for nothing (a decision that could not be told, a turn that was running). */
  async releaseStranded(): Promise<void> {
    for (const agentId of await heldChats()) await this.release(agentId).catch((error: unknown) => console.error("aydo: couldn't release held messages", error));
  }

  /** A turn started in a chat: if it waits for an approval and the plugin did not cause the turn, note it. */
  async turnStarted(agentId: string): Promise<void> {
    const pending = await pendingFor(agentId);
    if (!pending || isOwnSend(agentId)) return;
    await patchApproval(pending.id, { woken: pending.woken + 1 });
    await appendAudit(auditEvent("woken", pending, { count: pending.woken + 1 }));
  }

  checkCited(from: { bot: Bot; agentId: string }, id: string, action: string): Promise<CiteResult> {
    return citeApproval(this.host, from, id, action);
  }

  /**
   * After a decision: the decision (unless it needs no telling) and what was held go into the chat as one message, and only
   * when the chat is idle: a send into a running chat interrupts its turn, which would cut off an answer the user is
   * reading. Until then they stay held, and `release` sends them (at the next turn end, or in the sweep). The asks
   * restart their clocks and deliver the reports that waited.
   */
  private async finish(approval: Approval, tell: boolean): Promise<void> {
    const held = await takeHeld(approval.agentId);
    for (const text of [...(tell ? [decisionMessage(approval)] : []), ...held]) await holdMessage(approval.agentId, text);
    await this.onDecided(approval.agentId).catch((error: unknown) => console.error("aydo: couldn't restart a request after a decision", error));
    await this.release(approval.agentId);
  }

  /**
   * Sends what is held for a chat that no longer waits, as one message, once the chat is idle. A send that fails puts it back,
   * so a decision that could not be told is not lost.
   */
  async release(agentId: string): Promise<void> {
    if (await pendingFor(agentId)) return;
    const paseo = this.host.requirePaseo();
    const snapshot = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const status = snapshot?.agent.status;
    if (!snapshot || status === "running" || status === "initializing") return;
    const held = await takeHeld(agentId);
    if (held.length === 0) return;
    try {
      markOwnSend(agentId);
      await paseo.agents.ref(agentId).send(held.join("\n\n"), { messageId: newUuid() } as never);
    } catch (error) {
      console.error("aydo: couldn't send what was held for a chat; it stays held", error);
      for (const text of held) await holdMessage(agentId, text);
    }
  }
}

export type CiteResult = { ok: true } | { ok: false; reason: string };

/** Whether an approval a bot cites counts: it exists, is approved, and is the bot's own or its team's. Every check is audited. */
export async function citeApproval(host: BotsHost, from: { bot: Bot; agentId: string }, id: string, action: string): Promise<CiteResult> {
  const approval = await getApproval(id);
  if (!approval) return { ok: false, reason: `There is no approval ${id}.` };
  let reason: string | null = null;
  if (approval.status !== "approved") reason = `Approval ${id} is ${approval.status}, not approved. Wait for the user's answer.`;
  else if (approval.botId !== from.bot.id) {
    const groups = (await host.values())?.groups ?? [];
    const team = teamOf(from.bot.id, groups)?.id;
    if (!team || approval.teamId !== team) reason = `Approval ${id} was given to another bot and team, not to you.`;
  }
  await appendAudit(auditEvent("cited", approval, { action, by: from.bot.id, ok: reason === null, ...(reason ? { reason } : {}) }));
  return reason ? { ok: false, reason } : { ok: true };
}
