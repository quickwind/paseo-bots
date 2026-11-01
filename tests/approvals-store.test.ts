import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const input = (over: Record<string, unknown> = {}) => ({
  botId: "bot-1",
  botName: "Architect",
  agentId: "chat-1",
  chatTitle: "Plan",
  teamId: "t1",
  project: { id: "prj_1", name: "app" },
  workspace: "app · main",
  title: "Use Postgres",
  text: "We will use Postgres.",
  file: null,
  ...over,
});

describe("approvals store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-approvals-"));
    process.env.PASEO_HOME = home;
    vi.resetModules();
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });
  const store = () => import("../server/approvals-store");
  const dataPath = async () => (await import("../server/bot-home")).pluginDataPath();

  it("creates a pending approval that can be read back and found by its chat", async () => {
    const { createApproval, getApproval, pendingFor } = await store();
    const made = await createApproval(input());
    expect(made.id).toMatch(/^a-[a-f0-9]{10}$/);
    expect(made.status).toBe("pending");
    expect((await getApproval(made.id))?.title).toBe("Use Postgres");
    expect((await pendingFor("chat-1"))?.id).toBe(made.id);
    expect(await pendingFor("chat-2")).toBeNull();
  });

  it("decides once; the second decision fails and changes nothing", async () => {
    const { createApproval, resolveApproval, getApproval } = await store();
    const made = await createApproval(input());
    const done = await resolveApproval(made.id, { status: "approved", note: "ok", decidedBy: "user" });
    expect(done.status).toBe("approved");
    expect(done.decidedAt).not.toBeNull();
    await expect(resolveApproval(made.id, { status: "rejected", note: "no", decidedBy: "user" })).rejects.toThrow("It was already decided.");
    expect((await getApproval(made.id))?.status).toBe("approved");
  });

  it("keeps all ten approvals created at once", async () => {
    const { createApproval, listApprovals } = await store();
    await Promise.all(Array.from({ length: 10 }, (_, index) => createApproval(input({ agentId: `chat-${index}` }))));
    expect(await listApprovals()).toHaveLength(10);
  });

  it("lists newest first and filters", async () => {
    const { createApproval, resolveApproval, listApprovals } = await store();
    const first = await createApproval(input({ title: "First" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createApproval(input({ title: "Second", botId: "bot-2", agentId: "chat-2" }));
    await resolveApproval(first.id, { status: "withdrawn", note: "", decidedBy: "asking-bot" });
    expect((await listApprovals()).map((entry) => entry.title)).toEqual(["Second", "First"]);
    expect((await listApprovals({ botId: "bot-2" })).map((entry) => entry.title)).toEqual(["Second"]);
    expect((await listApprovals({ status: "withdrawn" })).map((entry) => entry.title)).toEqual(["First"]);
  });

  it("patches the interrupted and woken facts", async () => {
    const { createApproval, patchApproval, getApproval } = await store();
    const made = await createApproval(input());
    await patchApproval(made.id, { interrupted: true, woken: 2 });
    const read = await getApproval(made.id);
    expect(read?.interrupted).toBe(true);
    expect(read?.woken).toBe(2);
  });

  it("holds messages across a restart and hands them out once, in order", async () => {
    const first = await store();
    await first.holdMessage("chat-1", "one");
    await first.holdMessage("chat-1", "two");
    await first.holdMessage("chat-2", "other");
    vi.resetModules();
    const second = await store();
    expect(await second.takeHeld("chat-1")).toEqual(["one", "two"]);
    expect(await second.takeHeld("chat-1")).toEqual([]);
    await second.dropHeld("chat-2");
    expect(await second.takeHeld("chat-2")).toEqual([]);
  });

  it("appends audit lines as JSONL and reads them newest first", async () => {
    const { createApproval, auditEvent, appendAudit, readAudit } = await store();
    const made = await createApproval(input());
    await appendAudit(auditEvent("asked", made, undefined, new Date("2026-10-21T01:00:00Z")));
    await appendAudit(auditEvent("decided", made, { click: "x" }, new Date("2026-10-21T02:00:00Z")));
    await appendAudit(auditEvent("woken", made, undefined, new Date("2026-10-21T03:00:00Z")));
    const lines = (await readFile(join(await dataPath(), "approvals", "audit.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const events = await readAudit({ approvalId: made.id });
    expect(events.map((entry) => entry.event)).toEqual(["woken", "decided", "asked"]);
    expect(events[1]?.detail).toEqual({ click: "x" });
    expect(events[0]).toMatchObject({ approvalId: made.id, bot: { id: "bot-1", name: "Architect" }, chat: { id: "chat-1", title: "Plan" }, team: "t1" });
    expect((await readAudit({ limit: 2 }))).toHaveLength(2);
  });

  it("trims decided approvals beyond 500 but never a pending one", async () => {
    const { createApproval, resolveApproval, listApprovals, pendingFor } = await store();
    const keep = await createApproval(input({ agentId: "chat-keep" }));
    for (let index = 0; index < 505; index++) {
      const made = await createApproval(input({ agentId: `c-${index}` }));
      await resolveApproval(made.id, { status: "approved", note: "", decidedBy: "user" });
    }
    const all = await listApprovals();
    expect(all.filter((entry) => entry.status !== "pending")).toHaveLength(500);
    expect((await pendingFor("chat-keep"))?.id).toBe(keep.id);
  }, 30_000);
});
