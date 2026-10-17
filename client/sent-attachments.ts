import type { ComposerAttachment } from "../shared/attachments";

// Paseo's timeline keeps only the text of user messages, so attachments sent
// from this app are remembered for the session, like Paseo's own composer does.
interface Sent {
  messageId: string;
  botId: string;
  text: string;
  attachments: ComposerAttachment[];
}

const sent: Sent[] = [];

export function rememberSent(messageId: string, text: string, attachments: ComposerAttachment[], botId: string): void {
  if (attachments.length > 0) sent.push({ messageId, botId, text, attachments });
}

/**
 * Matches by message id, then by text for providers that assign their own ids. The text match is only
 * among this bot's own messages, newest first: the same words sent elsewhere carried no such files.
 */
export function sentAttachments(item: { text: string; messageId?: string; clientMessageId?: string }, botId: string | null): ComposerAttachment[] {
  const ids = [item.messageId, item.clientMessageId].filter(Boolean);
  const byId = sent.find((entry) => ids.includes(entry.messageId));
  if (byId) return byId.attachments;
  return [...sent].reverse().find((entry) => entry.botId === botId && entry.text === item.text.trim())?.attachments ?? [];
}

export function newMessageId(): string {
  return "msg-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
