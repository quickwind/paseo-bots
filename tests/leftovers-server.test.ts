import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillDeleteRpc } from "../shared/rpc";
import { MEMORY_MAX_BYTES } from "../shared/memory-maintenance";
import { fakeHost, makeBot } from "./helpers";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aydo-leftovers-"));
  process.env.PASEO_HOME = home;
});
afterEach(async () => {
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("skill ids", () => {
  it("never name a folder outside the skills folder", async () => {
    const { librarySkillPath } = await import("../server/library");
    expect(() => librarySkillPath("..")).toThrow();
    expect(() => librarySkillPath(".")).toThrow();
    expect(() => librarySkillPath("a/b")).toThrow();
    expect(librarySkillPath("my.skill-2")).toContain("my.skill-2");
    expect(skillDeleteRpc.input.safeParse({ id: ".." }).success).toBe(false);
    expect(skillDeleteRpc.input.safeParse({ id: "my.skill" }).success).toBe(true);
  });
});

describe("the memory that reaches the prompt", () => {
  it("is the first part of the file even when its first line is longer than the limit", async () => {
    const { injectedMemory } = await import("../server/memory");
    const { botDataPath } = await import("../server/bot-home");
    await mkdir(botDataPath("scout"), { recursive: true });
    await writeFile(join(botDataPath("scout"), "MEMORY.md"), `${"悟".repeat(20_000)}\nsecond line`);
    const text = await injectedMemory("scout");
    expect(text.length).toBeGreaterThan(1_000);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MEMORY_MAX_BYTES);
    expect(text).not.toContain("�");
  });
});

describe("log lines since the last tidy", () => {
  it("counts a line from the same minute the tidy started in, as the log only keeps minutes", async () => {
    const { newLogLines } = await import("../server/memory");
    const { botDataPath } = await import("../server/bot-home");
    const day = new Date(2026, 9, 17, 10, 30);
    await mkdir(join(botDataPath("scout"), "memory", "log"), { recursive: true });
    await writeFile(join(botDataPath("scout"), "memory", "log", "2026-10-17.md"), '- 10:05 · from chat "Plan" · Done.\n');
    expect((await newLogLines("scout", new Date(2026, 9, 17, 10, 5, 10), day)).count).toBe(1);
    expect((await newLogLines("scout", new Date(2026, 9, 17, 10, 6, 10), day)).count).toBe(0);
  });
});

describe("a turn that ends when the chat cannot be looked up", () => {
  it("still frees the bot, so it is not counted as working for two hours", async () => {
    const { turnEnded, turnStarted } = await import("../server/activity");
    const { MemoryJournal } = await import("../server/journal");
    const { ChatActivity, SaveTracker } = await import("../server/maintenance");
    const bot = makeBot({ id: "scout" });
    const host = fakeHost([bot]);
    let reachable = true;
    host.attach({ agents: { ref: () => ({ refresh: async () => { if (!reachable) throw new Error("offline"); return { agent: { status: "idle", labels: { "aydo.bot": "scout" }, title: "Plan" } }; } }) } } as never);
    const activity = new ChatActivity();
    const maintenance = { activity, saves: new SaveTracker(), tidy: null };
    const agent = { id: "chat-1", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/", title: "Plan" };
    const journal = new MemoryJournal();
    await turnStarted(host, journal, { agent, turnId: "t" } as never, maintenance);
    expect(activity.busy("scout")).toBe(true);
    reachable = false;
    await turnEnded(host, journal, { finished: async () => {} }, { agent, turnId: "t", outcome: { kind: "completed" }, timeline: [] } as never, maintenance);
    expect(activity.busy("scout")).toBe(false);
  });
});
