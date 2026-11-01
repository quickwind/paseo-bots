import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApproval, holdMessage, resolveApproval, takeHeld } from "../server/approvals-store";
import { isOwnSend, markOwnSend, releaseHeld, sendIntoChat } from "../server/chat-send";

const pending = (agentId: string) => createApproval({ botId: "b", botName: "B", agentId, chatTitle: "t", teamId: null, project: null, workspace: null, title: "T", text: "x", file: null });

function fakePaseo() {
  const sent: { agentId: string; text: string }[] = [];
  const paseo = { agents: { ref: (agentId: string) => ({ send: async (text: string) => void sent.push({ agentId, text }) }) } };
  return { paseo: paseo as never, sent };
}

describe("the plugin's one way into a chat", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-chatsend-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("sends when nothing waits in the chat", async () => {
    const { paseo, sent } = fakePaseo();
    expect(await sendIntoChat(paseo, "chat-1", "hello")).toBe("sent");
    expect(sent).toEqual([{ agentId: "chat-1", text: "hello" }]);
  });

  it("holds the message while the chat has a pending approval, and only for that chat", async () => {
    const { paseo, sent } = fakePaseo();
    await pending("chat-1");
    expect(await sendIntoChat(paseo, "chat-1", "hello")).toBe("held");
    expect(await sendIntoChat(paseo, "chat-2", "other")).toBe("sent");
    expect(sent).toEqual([{ agentId: "chat-2", text: "other" }]);
    expect(await takeHeld("chat-1")).toEqual(["hello"]);
  });

  it("sends a decided approval's chat normally again", async () => {
    const { paseo, sent } = fakePaseo();
    const made = await pending("chat-1");
    await resolveApproval(made.id, { status: "approved", note: "", decidedBy: "user" });
    expect(await sendIntoChat(paseo, "chat-1", "hello")).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("releases what was held in order as one message, once", async () => {
    const { paseo, sent } = fakePaseo();
    await holdMessage("chat-1", "one");
    await holdMessage("chat-1", "two");
    expect(await releaseHeld(paseo, "chat-1")).toBe(2);
    expect(sent).toEqual([{ agentId: "chat-1", text: "one\n\ntwo" }]);
    expect(await releaseHeld(paseo, "chat-1")).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("keeps held messages when the release cannot send", async () => {
    await holdMessage("chat-1", "one");
    const broken = { agents: { ref: () => ({ send: async () => { throw new Error("gone"); } }) } } as never;
    expect(await releaseHeld(broken, "chat-1")).toBe(0);
    expect(await takeHeld("chat-1")).toEqual(["one"]);
  });

  it("remembers its own sends for thirty seconds", () => {
    markOwnSend("chat-1", 1_000);
    expect(isOwnSend("chat-1", 20_000)).toBe(true);
    expect(isOwnSend("chat-1", 40_000)).toBe(false);
    expect(isOwnSend("chat-never-sent-to", 1_000)).toBe(false);
  });
});
