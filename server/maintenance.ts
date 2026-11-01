import { nextSaveState } from "../shared/memory-maintenance";

/** A turn whose end was never reported stops counting as running after this. */
const STALE_TURN_MS = 2 * 3_600_000;

/** Which chats of each bot have a turn running, from the plugin's own turn events. */
export class ChatActivity {
  private readonly running = new Map<string, Map<string, number>>();

  started(botId: string, agentId: string, at = Date.now()): void {
    const chats = this.running.get(botId) ?? new Map<string, number>();
    chats.set(agentId, at);
    this.running.set(botId, chats);
  }

  ended(botId: string, agentId: string): void {
    this.running.get(botId)?.delete(agentId);
  }

  busy(botId: string, now = Date.now()): boolean {
    return [...(this.running.get(botId)?.values() ?? [])].some((startedAt) => now - startedAt < STALE_TURN_MS);
  }
}

/** Per chat: whether it was already asked in this fill of its context window, and whether its next turn is the save turn. */
export class SaveTracker {
  private readonly asked = new Map<string, boolean>();
  private readonly saving = new Set<string>();

  /** Whether to ask this chat to save now, given its context use. */
  decide(agentId: string, percent: number | null, threshold: number): boolean {
    const next = nextSaveState(this.asked.get(agentId) ?? false, percent, threshold);
    this.asked.set(agentId, next.asked);
    return next.ask;
  }

  /** The save message was sent: the chat's next finished turn is the save turn. */
  markSent(agentId: string): void {
    this.saving.add(agentId);
  }

  /** True once, for the turn that was the save turn. */
  consume(agentId: string): boolean {
    return this.saving.delete(agentId);
  }
}
