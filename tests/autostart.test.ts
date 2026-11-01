import { describe, expect, it } from "vitest";
import { pendingAutoStart } from "../client/auto-start";

describe("a chat that starts itself with a prompt (Set up with the bot)", () => {
  const selection = { botId: "b", chatId: null, prompt: "Let's set you up." };

  it("starts once the host is ready", () => {
    expect(pendingAutoStart(selection, null, true)).toBe(true);
  });

  it("waits for the host, and does nothing without a prompt or for an existing chat", () => {
    expect(pendingAutoStart(selection, null, false)).toBe(false);
    const quiet = { botId: "b", chatId: null };
    expect(pendingAutoStart(quiet, null, true)).toBe(false);
    const existing = { ...selection, chatId: "chat-1" };
    expect(pendingAutoStart(existing, null, true)).toBe(false);
  });

  it("does not start the same request twice", () => {
    expect(pendingAutoStart(selection, selection, true)).toBe(false);
  });

  it("starts again for a new request, even with the same words and the pane already open", () => {
    const again = { ...selection };
    expect(pendingAutoStart(again, selection, true)).toBe(true);
  });
});
