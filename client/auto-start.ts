/**
 * Whether a selected, not yet started chat should send its prompt now. "Set up with the bot"
 * selects a new chat that carries a prompt. Each click makes a new selection object, so a request
 * that was already sent is recognised by identity (`handled`), and the next click starts again even
 * when the new-chat pane was already open and did not remount.
 */
export function pendingAutoStart(selection: { chatId: string | null; prompt?: string }, handled: unknown, ready: boolean): boolean {
  return ready && selection.chatId === null && Boolean(selection.prompt) && handled !== selection;
}
