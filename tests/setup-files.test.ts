import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotSettingsValues } from "../shared/bot";
import { EMPTY_LIBRARY } from "../shared/bot";
import { writeSetupFiles } from "../server/setup-files";
import { makeBot } from "./helpers";

const providers = { providers: { snapshot: async () => ({ entries: [{ provider: "claude", enabled: true, status: "ready", models: [{ id: "opus", label: "Opus", isDefault: true }], modes: [{ id: "default", label: "Ask" }] }] }) } };
const valuesOf = (bots: ReturnType<typeof makeBot>[], extra: Partial<BotSettingsValues> = {}): BotSettingsValues => ({ bots, history: [], library: EMPTY_LIBRARY, ...extra });

describe("the setup files a bot with file tools reads", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-setupfiles-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });
  const dirOf = async (botId: string) => join((await import("../server/bot-home")).botDataPath(botId), "setup");

  it("lists the workspaces, or says they can't be read right now", async () => {
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const entries = [{ id: "wks_1", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-x", name: "x", title: "Login", archivingAt: null }];
    await writeSetupFiles(scout, valuesOf([scout]), { ...providers, workspaces: { list: async () => ({ entries }) } } as never);
    const dir = await dirOf("scout");
    expect(await readFile(join(dir, "workspaces.md"), "utf8")).toContain("- Login (id wks_1) in app: /work/app-x");
    await writeSetupFiles(scout, valuesOf([scout]), providers as never);
    expect(await readFile(join(dir, "workspaces.md"), "utf8")).toContain("can't be read right now");
  });

  it("lists the bot's own approvals, newest first, and says when there are none", async () => {
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    await writeSetupFiles(scout, valuesOf([scout]), providers as never);
    const dir = await dirOf("scout");
    expect(await readFile(join(dir, "approvals.md"), "utf8")).toContain("You have no approvals");
    const { createApproval, resolveApproval } = await import("../server/approvals-store");
    const mine = await createApproval({ botId: "scout", botName: "Scout", agentId: "c1", chatTitle: "t", teamId: null, project: null, workspace: null, title: "Use Postgres", text: "x", file: null });
    await resolveApproval(mine.id, { status: "approved", note: "go on", decidedBy: "user" });
    await createApproval({ botId: "other", botName: "Other", agentId: "c2", chatTitle: "t", teamId: null, project: null, workspace: null, title: "Not mine", text: "x", file: null });
    await writeSetupFiles(scout, valuesOf([scout]), providers as never);
    const text = await readFile(join(dir, "approvals.md"), "utf8");
    expect(text).toContain(`${mine.id} · approved · "Use Postgres"`);
    expect(text).toContain("go on");
    expect(text).not.toContain("Not mine");
  });

  it("writes an overview of all bots and one file per bot with its instructions", async () => {
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin", soul: "Find sources." });
    const inbox = makeBot({ id: "inbox", name: "Inbox", soul: "Triage mail." });
    await writeSetupFiles(scout, valuesOf([scout, inbox]), providers as never);
    const dir = await dirOf("scout");
    const overview = await readFile(join(dir, "overview.md"), "utf8");
    for (const part of ["Scout", "Inbox", "claude", "opus", "default"]) expect(overview).toContain(part);
    expect(await readFile(join(dir, "bots", "scout.md"), "utf8")).toContain("Find sources.");
    expect(await readFile(join(dir, "bots", "inbox.md"), "utf8")).toContain("Triage mail.");
  });

  it("leaves out archived bots' files and removes files of bots that are gone", async () => {
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const old = makeBot({ id: "old", name: "Old", archived: true });
    const dir = await dirOf("scout");
    await mkdir(join(dir, "bots"), { recursive: true });
    await writeFile(join(dir, "bots", "gone.md"), "stale");
    await writeSetupFiles(scout, valuesOf([scout, old]), providers as never);
    expect((await readdir(join(dir, "bots"))).sort()).toEqual(["scout.md"]);
  });

  it("writes nothing for a bot whose tools are an MCP server, and removes files from before", async () => {
    const claude = makeBot({ id: "cl", provider: "claude" });
    const dir = await dirOf("cl");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "overview.md"), "old");
    await writeSetupFiles(claude, valuesOf([claude]), providers as never);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
    const forced = makeBot({ id: "fo", provider: "claude" });
    await writeSetupFiles(forced, valuesOf([forced], { toolMode: "files" }), providers as never);
    expect(await readdir(await dirOf("fo"))).toContain("overview.md");
  });

  it("leaves no temporary files and rewrites with the current settings", async () => {
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin", soul: "v1" });
    await writeSetupFiles(scout, valuesOf([scout]), providers as never);
    await writeSetupFiles({ ...scout, soul: "v2" }, valuesOf([{ ...scout, soul: "v2" }]), providers as never);
    const dir = await dirOf("scout");
    expect(await readFile(join(dir, "bots", "scout.md"), "utf8")).toContain("v2");
    expect((await readdir(dir)).sort()).toEqual(["approvals.md", "bots", "overview.md", "proposal-format.md", "workspaces.md"]);
    expect(await readdir(join(dir, "bots"))).toEqual(["scout.md"]);
  });

  it("copes with a host that cannot list providers", async () => {
    const scout = makeBot({ id: "scout", provider: "devin" });
    await writeSetupFiles(scout, valuesOf([scout]), null);
    expect(await readFile(join(await dirOf("scout"), "overview.md"), "utf8")).toContain("Bots (1)");
  });

  it("also describes the three proposal formats with the fields the tools take", async () => {
    const scout = makeBot({ id: "scout", provider: "devin" });
    await writeSetupFiles(scout, valuesOf([scout]), providers as never);
    const text = await readFile(join(await dirOf("scout"), "proposal-format.md"), "utf8");
    for (const part of ["changes", "summary", "instructions", "schedule", "description", "update_bot"]) expect(text).toContain(part);
  });

  it("does not delete what a link in place of the setup folder points at", async () => {
    const { symlink } = await import("node:fs/promises");
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "keep.txt"), "x");
    const dir = await dirOf("scout");
    await mkdir(join(dir, ".."), { recursive: true });
    await symlink(elsewhere, dir);
    const scout = makeBot({ id: "scout", provider: "devin" });
    await writeSetupFiles(scout, valuesOf([scout]), providers as never);
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);
    expect(await readdir(dir)).toContain("overview.md");
  });
});
