import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Approvals } from "../server/approvals";
import { getApproval } from "../server/approvals-store";
import { forgetOwnSends } from "../server/chat-send";
import { BOT_TOOLS } from "../server/tools";
import { listApprovalsTool, requestApprovalTool, withdrawApprovalTool } from "../server/tools/approvals";
import { fakeHost, makeBot } from "./helpers";

describe("the approval tools", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-approval-tools-"));
    process.env.PASEO_HOME = home;
    forgetOwnSends();
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  function setup(labels: Record<string, string> = {}) {
    const arch = makeBot({ id: "arch", name: "Architect" });
    const dev = makeBot({ id: "dev", name: "Dev" });
    const host = fakeHost([arch, dev]);
    host.attach({ workspaces: { list: async () => ({ entries: [] }) }, agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: { "aydo.bot": "arch", ...labels }, title: "Plan chat", workspaceId: null } }), send: async () => {} }) } } as never);
    const approvals = new Approvals(host, async () => {}, { interruptDelayMs: 1_000_000 });
    const relay = { approvals } as never;
    const caller = (bot: typeof arch, agentId = "chat-1") => ({ bot, agentId, host, relay });
    return { arch, dev, approvals, caller };
  }

  it("are on the bots server and run without the user's tool prompt", () => {
    const names = BOT_TOOLS.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["request_approval", "list_approvals", "withdraw_approval"]));
  });

  it("request_approval makes a pending approval and says to stop", async () => {
    const { arch, caller } = setup();
    const reply = await requestApprovalTool.run({ title: "Use Postgres", text: "Because." }, caller(arch));
    expect(reply).toMatch(/Approval a-[a-f0-9]{10}/);
    expect(reply).toMatch(/stop/i);
    const id = /a-[a-f0-9]{10}/.exec(reply)![0];
    expect(await getApproval(id)).toMatchObject({ status: "pending", botId: "arch", agentId: "chat-1" });
  });

  it("request_approval refuses with the reason when the service does", async () => {
    const { arch, caller } = setup();
    await requestApprovalTool.run({ title: "One", text: "x" }, caller(arch));
    await expect(requestApprovalTool.run({ title: "Two", text: "x" }, caller(arch))).rejects.toThrow(/one at a time/i);
  });

  it("list_approvals shows only the caller's own, newest first, and can filter", async () => {
    const { arch, dev, caller } = setup();
    await requestApprovalTool.run({ title: "Mine", text: "x" }, caller(arch, "chat-1"));
    await requestApprovalTool.run({ title: "Theirs", text: "x" }, caller(dev, "chat-2"));
    const all = await listApprovalsTool.run({}, caller(arch));
    expect(all).toContain("Mine");
    expect(all).not.toContain("Theirs");
    expect(await listApprovalsTool.run({ status: "approved" }, caller(arch))).toMatch(/no approved approvals/i);
  });

  it("withdraw_approval withdraws the caller's own chat's approval and refuses someone else's", async () => {
    const { arch, dev, caller } = setup();
    const reply = await requestApprovalTool.run({ title: "Mine", text: "x" }, caller(arch, "chat-1"));
    const id = /a-[a-f0-9]{10}/.exec(reply)![0];
    await expect(withdrawApprovalTool.run({ id }, caller(dev, "chat-2"))).rejects.toThrow(/not yours/i);
    expect(await withdrawApprovalTool.run({ id }, caller(arch, "chat-1"))).toMatch(/withdrawn/i);
    expect((await getApproval(id))?.status).toBe("withdrawn");
  });

  it("are not offered to a memory tidy chat", async () => {
    const { arch, caller } = setup({ "aydo.tidy": "arch" });
    expect(await requestApprovalTool.available!(caller(arch))).toBe(false);
    const normal = setup();
    expect(await requestApprovalTool.available!(normal.caller(normal.arch))).toBe(true);
  });
});
