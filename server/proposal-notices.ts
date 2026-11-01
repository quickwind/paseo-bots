import type { Proposal } from "../shared/proposals";
import { sendIntoChat } from "./chat-send";
import type { PaseoApi } from "./paseo";

// When the user accepts or dismisses a bot's proposal card, the chat that made it is told, so the bot
// need not wait for the user to type "done". Notices for one chat are joined into one message, and
// wait while the chat is working. They are kept in memory only: after a restart the card still shows
// what happened, and nothing is sent late.

function describe(proposal: Proposal, action: "accepted" | "dismissed"): string | null {
  if (proposal.kind === "ask" || proposal.kind === "workspace") return null; // the asks code and the workspace code report these
  if (action === "dismissed") return `Proposal ${proposal.id} was dismissed by the user. Nothing was saved.`;
  switch (proposal.kind) {
    case "changes":
      return `Proposal ${proposal.id} was accepted by the user and is being applied: ${proposal.data.summary}`;
    case "skill":
      return `Proposal ${proposal.id} was accepted by the user: the skill "${proposal.data.name}" is saved.`;
    case "routine":
      return `Proposal ${proposal.id} was accepted by the user: the routine "${proposal.data.name}" is saved.`;
  }
}

export class ProposalNotices {
  private readonly waiting = new Map<string, string[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** `delayMs` lets several clicks in a row go out as one message. */
  constructor(
    private readonly paseo: () => PaseoApi | null,
    private readonly delayMs = 1_500,
  ) {}

  /** Remembers what the user did and sends it soon (or when the chat's turn ends, if it is working). */
  add(proposal: Proposal, action: "accepted" | "dismissed"): void {
    const text = describe(proposal, action);
    if (!text || !proposal.agentId) return;
    this.waiting.set(proposal.agentId, [...(this.waiting.get(proposal.agentId) ?? []), text]);
    clearTimeout(this.timers.get(proposal.agentId));
    this.timers.set(
      proposal.agentId,
      setTimeout(() => void this.flush(proposal.agentId).catch((error: unknown) => console.error("aydo: couldn't tell a chat about its proposal", error)), this.delayMs),
    );
  }

  /** Sends what waits for the chat if it is idle; a chat that is gone loses its notices. */
  async flush(agentId: string): Promise<void> {
    if (!this.waiting.has(agentId)) return;
    const paseo = this.paseo();
    if (!paseo) return;
    const chat = paseo.agents.ref(agentId);
    const snapshot = await chat.refresh().catch(() => null);
    if (!snapshot) {
      this.waiting.delete(agentId);
      return;
    }
    if (snapshot.agent.status === "running" || snapshot.agent.status === "initializing") return;
    const texts = this.waiting.get(agentId);
    this.waiting.delete(agentId);
    if (!texts?.length) return;
    try {
      // Held while the chat waits for an approval (server/chat-send.ts).
      await sendIntoChat(paseo, agentId, `[Aydo] ${texts.join("\n")}`);
    } catch (error) {
      console.error("aydo: couldn't tell a chat about its proposal", error);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
