import { describe, expect, it } from "vitest";
import { rememberSent, sentAttachments } from "../client/sent-attachments";
import type { ComposerAttachment } from "../shared/attachments";

const file = { id: "a1", name: "shot.png" } as unknown as ComposerAttachment;

describe("attachments remembered for the messages that carried them", () => {
  it("are found by the message id, whichever bot asks", () => {
    rememberSent("msg-1", "fix this", [file], "bot-a");
    expect(sentAttachments({ text: "fix this", messageId: "msg-1" }, "bot-a")).toEqual([file]);
    expect(sentAttachments({ text: "other text", clientMessageId: "msg-1" }, "bot-b")).toEqual([file]);
  });

  it("are found by the text for a provider that gives messages ids of its own, but only in the same bot's chats", () => {
    rememberSent("msg-2", "see the screenshot", [file], "bot-a");
    expect(sentAttachments({ text: "see the screenshot", messageId: "provider-id" }, "bot-a")).toEqual([file]);
    // Another bot's message with the same words did not carry the picture.
    expect(sentAttachments({ text: "see the screenshot", messageId: "provider-id" }, "bot-b")).toEqual([]);
  });
});
