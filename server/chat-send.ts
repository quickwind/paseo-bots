import { newUuid } from "../shared/uuid";
import { holdIfPending, holdMessage, takeHeld } from "./approvals-store";
import type { PaseoApi } from "./paseo";

// Everything the plugin sends into a chat goes through here. While the chat has an approval waiting for the user
// the message is held (kept in a file) and goes out after the decision (server/approvals.ts).

const OWN_SEND_MS = 30_000;
const ownSends = new Map<string, number>();

/** The plugin just sent something into this chat, so the turn that starts next is not a stranger's. */
export function markOwnSend(agentId: string, now = Date.now()): void {
  if (ownSends.size > 500) ownSends.clear();
  ownSends.set(agentId, now);
}

/** For tests: the memory of the plugin's own sends is per process. */
export function forgetOwnSends(): void {
  ownSends.clear();
}

export function isOwnSend(agentId: string, now = Date.now()): boolean {
  const at = ownSends.get(agentId);
  return at !== undefined && now - at < OWN_SEND_MS;
}

export async function sendIntoChat(paseo: PaseoApi, agentId: string, text: string): Promise<"sent" | "held"> {
  if (await holdIfPending(agentId, text)) return "held";
  // What an earlier failed send left held (a decision that could not be told) goes first, in the same message.
  const stranded = await takeHeld(agentId);
  try {
    markOwnSend(agentId);
    await paseo.agents.ref(agentId).send([...stranded, text].join("\n\n"), { messageId: newUuid() } as never);
  } catch (error) {
    for (const message of stranded) await holdMessage(agentId, message);
    throw error;
  }
  return "sent";
}

/** Sends what was held for a chat, in order, as one message. A send that fails puts it back. Returns how many were sent. */
export async function releaseHeld(paseo: PaseoApi, agentId: string): Promise<number> {
  const held = await takeHeld(agentId);
  if (held.length === 0) return 0;
  try {
    markOwnSend(agentId);
    await paseo.agents.ref(agentId).send(held.join("\n\n"), { messageId: newUuid() } as never);
    return held.length;
  } catch (error) {
    console.error("aydo: couldn't send held messages; they stay held", error);
    for (const text of held) await holdMessage(agentId, text);
    return 0;
  }
}
