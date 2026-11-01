import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApproval, takeHeld } from "../server/approvals-store";
import { ProposalNotices } from "../server/proposal-notices";
import type { Proposal } from "../shared/proposals";

const base = { botId: "b", agentId: "chat-1", createdAt: "", resolvedAt: null };
const changes = { ...base, id: "p-1", status: "accepted", kind: "changes", data: { summary: "Rename to Scout", changes: [], provider: "" } } as Proposal;
const skill = { ...base, id: "p-2", status: "accepted", kind: "skill", data: { name: "triage", description: "d", text: "t" } } as Proposal;
const ask = { ...base, id: "p-3", status: "accepted", kind: "ask", data: { requestId: "r", toBotId: "x", toName: "X", message: "m" } } as Proposal;

function setup() {
  const sent: { agentId: string; text: string }[] = [];
  const status: Record<string, string> = {};
  const gone = new Set<string>();
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => {
          if (gone.has(agentId)) throw new Error("no such chat");
          return { agent: { status: status[agentId] ?? "idle" } };
        },
        send: async (text: string) => void sent.push({ agentId, text }),
      }),
    },
  };
  const notices = new ProposalNotices(() => paseo as never, 0);
  return { notices, sent, status, gone };
}

describe("telling a chat what the user did with its proposal", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-notices-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("holds the notice while the chat waits for an approval", async () => {
    const { notices, sent } = setup();
    await createApproval({ botId: "b", botName: "B", agentId: "chat-1", chatTitle: "t", teamId: null, project: null, workspace: null, title: "T", text: "x", file: null });
    notices.add(changes, "accepted");
    await notices.flush("chat-1");
    expect(sent).toEqual([]);
    expect(await takeHeld("chat-1")).toHaveLength(1);
  });

  it("tells the chat about an accepted and a dismissed proposal, as data from the plugin", async () => {
    const { notices, sent } = setup();
    notices.add(changes, "accepted");
    await notices.flush("chat-1");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("p-1");
    expect(sent[0]!.text).toContain("accepted");
    expect(sent[0]!.text).toContain("Rename to Scout");
    notices.add({ ...skill, status: "dismissed" } as Proposal, "dismissed");
    await notices.flush("chat-1");
    expect(sent[1]!.text).toContain("dismissed");
  });

  it("leaves ask proposals to the asks code", async () => {
    const { notices, sent } = setup();
    notices.add(ask, "accepted");
    await notices.flush("chat-1");
    expect(sent).toEqual([]);
  });

  it("joins several notices for one chat into one message", async () => {
    const { notices, sent } = setup();
    notices.add(changes, "accepted");
    notices.add(skill, "accepted");
    await notices.flush("chat-1");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("p-1");
    expect(sent[0]!.text).toContain("p-2");
  });

  it("waits while the chat is working and sends when it is idle", async () => {
    const { notices, sent, status } = setup();
    status["chat-1"] = "running";
    notices.add(changes, "accepted");
    await notices.flush("chat-1");
    expect(sent).toEqual([]);
    status["chat-1"] = "idle";
    await notices.flush("chat-1");
    expect(sent).toHaveLength(1);
    await notices.flush("chat-1");
    expect(sent).toHaveLength(1);
  });

  it("drops the notice when the chat is gone", async () => {
    const { notices, sent, gone } = setup();
    gone.add("chat-1");
    notices.add(changes, "accepted");
    await notices.flush("chat-1");
    gone.delete("chat-1");
    await notices.flush("chat-1");
    expect(sent).toEqual([]);
  });
});
