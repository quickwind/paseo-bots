import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotGroup } from "../shared/bot";
import { fakeHost, makeBot } from "./helpers";

const NOW = "2026-10-20T00:00:00.000Z";
const team: BotGroup = { id: "t1", name: "Crew", logo: null, leadId: "lead", memberIds: ["lead", "dev"], instructions: "", askFreely: false, createdAt: NOW, updatedAt: NOW };
const DAY = 86_400_000;
const T0 = new Date(2026, 9, 21, 12, 0);
const after = (days: number) => new Date(T0.getTime() + days * DAY);

describe("how long a team's reports are kept", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-sweep-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const reportsRoot = async () => join((await import("../server/bot-home")).pluginDataPath(), "shared", "Reports");
  const sweep = () => import("../server/reports");

  /** A host whose Paseo lists these project ids as having an active workspace (or fails to list when `null`). */
  function hostWith(activeProjects: string[] | null) {
    const host = fakeHost([makeBot({ id: "lead", name: "Chief" }), makeBot({ id: "dev", name: "Dev" })], undefined, [team]);
    host.attach({
      workspaces: {
        list: async () => {
          if (activeProjects === null) throw new Error("the daemon is busy");
          return { entries: activeProjects.map((projectId, i) => ({ id: `wks_${i}`, projectId, projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: `/work/app-${i}`, name: `w${i}`, title: null, archivingAt: null })) };
        },
      },
    } as never);
    return host;
  }
  async function makeProject(teamId: string, folder: string, id: string, files: Record<string, string>) {
    const dir = join(await reportsRoot(), teamId, folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project.json"), JSON.stringify({ id, name: folder }));
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return dir;
  }
  const project = async (dir: string) => JSON.parse(await readFile(join(dir, "project.json"), "utf8")) as { id: string; name: string; inactiveSince?: string };

  it("keeps everything while the project has an active workspace, and clears a clock that was running", async () => {
    const { sweepReports } = await sweep();
    const dir = await makeProject("t1", "app", "prj_1", { "2026-09-01.jsonl": "{}\n", "2026-09-01.md": "- x\n" });
    await writeFile(join(dir, "project.json"), JSON.stringify({ id: "prj_1", name: "app", inactiveSince: new Date(T0.getTime() - 40 * DAY).toISOString() }));
    const result = await sweepReports(hostWith(["prj_1"]), after(0));
    expect(result).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect((await readdir(dir)).sort()).toEqual(["2026-09-01.jsonl", "2026-09-01.md", "project.json"]);
    expect((await project(dir)).inactiveSince).toBeUndefined();
  });

  it("starts the thirty days when the last workspace is gone, and removes the whole records only then, keeping the index", async () => {
    const { sweepReports } = await sweep();
    const dir = await makeProject("t1", "app", "prj_1", { "2026-09-01.jsonl": "{}\n", "2026-09-02.jsonl": "{}\n", "2026-09-01.md": "- x\n" });
    expect(await sweepReports(hostWith([]), after(0))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect((await project(dir)).inactiveSince).toBe(after(0).toISOString());
    expect(await sweepReports(hostWith([]), after(29))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect(await readdir(dir)).toContain("2026-09-01.jsonl");
    expect(await sweepReports(hostWith([]), after(31))).toEqual({ removedRecords: 2, removedTeams: 0 });
    expect((await readdir(dir)).sort()).toEqual(["2026-09-01.md", "project.json"]);
  });

  it("starts over when the project gets a workspace again", async () => {
    const { sweepReports } = await sweep();
    const dir = await makeProject("t1", "app", "prj_1", { "2026-09-01.jsonl": "{}\n" });
    await sweepReports(hostWith([]), after(0));
    await sweepReports(hostWith(["prj_1"]), after(20));
    await sweepReports(hostWith([]), after(25));
    expect(await sweepReports(hostWith([]), after(40))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect(await readdir(dir)).toContain("2026-09-01.jsonl");
  });

  it("removes the oldest days of a project that is over the size cap, and keeps the index", async () => {
    const { sweepReports } = await sweep();
    const dir = await makeProject("t1", "app", "prj_1", { "2026-09-01.jsonl": "a".repeat(60), "2026-09-02.jsonl": "b".repeat(60), "2026-09-03.jsonl": "c".repeat(60), "2026-09-01.md": "- x\n" });
    expect(await sweepReports(hostWith(["prj_1"]), after(0), { sizeCap: 100 })).toEqual({ removedRecords: 2, removedTeams: 0 });
    expect((await readdir(dir)).sort()).toEqual(["2026-09-01.md", "2026-09-03.jsonl", "project.json"]);
  });

  it("removes the folder of a team that is gone thirty days after it was first noticed gone, and never one that exists", async () => {
    const { sweepReports } = await sweep();
    const gone = await makeProject("t-gone", "app", "prj_9", { "2026-09-01.md": "- x\n" });
    const alive = await makeProject("t1", "app", "prj_1", { "2026-09-01.md": "- y\n" });
    expect(await sweepReports(hostWith(["prj_1", "prj_9"]), after(0))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect(await sweepReports(hostWith(["prj_1", "prj_9"]), after(29))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect(await readdir(gone)).toContain("2026-09-01.md");
    expect(await sweepReports(hostWith(["prj_1", "prj_9"]), after(31))).toEqual({ removedRecords: 0, removedTeams: 1 });
    await expect(readdir(join(await reportsRoot(), "t-gone"))).rejects.toThrow();
    expect(await readdir(alive)).toContain("2026-09-01.md");
    expect(await readdir(join(await reportsRoot(), "t1"))).not.toContain(".gone");
  });

  it("deletes nothing when the workspaces cannot be listed, or the settings cannot be read", async () => {
    const { sweepReports } = await sweep();
    const dir = await makeProject("t1", "app", "prj_1", { "2026-09-01.jsonl": "{}\n" });
    await writeFile(join(dir, "project.json"), JSON.stringify({ id: "prj_1", name: "app", inactiveSince: new Date(T0.getTime() - 90 * DAY).toISOString() }));
    await makeProject("t-gone", "app", "prj_9", { "2026-09-01.md": "- x\n" });
    expect(await sweepReports(hostWith(null), after(0))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect(await readdir(dir)).toContain("2026-09-01.jsonl");
    const unattached = fakeHost([], undefined, [team]);
    expect(await sweepReports(unattached, after(0))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect(await readdir(dir)).toContain("2026-09-01.jsonl");
  });

  it("forgets a team's gone-marker once the team exists, so a later real deletion gets its thirty days", async () => {
    const { sweepReports } = await sweep();
    const dir = await makeProject("t1", "app", "prj_1", { "2026-09-01.md": "- x\n" });
    await writeFile(join(await reportsRoot(), "t1", ".gone"), new Date(T0.getTime() - 90 * DAY).toISOString());
    expect(await sweepReports(hostWith(["prj_1"]), after(0))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect(await readdir(join(await reportsRoot(), "t1"))).not.toContain(".gone");
    expect(await readdir(dir)).toContain("2026-09-01.md");
  });

  it("deletes nothing when the host's list of workspaces is longer than it will hand out", async () => {
    const { sweepReports } = await sweep();
    const dir = await makeProject("t1", "app", "prj_1", { "2026-09-01.jsonl": "{}\n" });
    await writeFile(join(dir, "project.json"), JSON.stringify({ id: "prj_1", name: "app", inactiveSince: new Date(T0.getTime() - 90 * DAY).toISOString() }));
    const host = fakeHost([makeBot({ id: "lead", name: "Chief" })], undefined, [team]);
    host.attach({ workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "again" } }) } } as never);
    expect(await sweepReports(host, after(0))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect(await readdir(dir)).toContain("2026-09-01.jsonl");
  });

  it("skips a folder that is not a team's, and a team folder's stray files", async () => {
    const { sweepReports } = await sweep();
    const root = await reportsRoot();
    await mkdir(join(root, "not a team id!"), { recursive: true });
    await writeFile(join(root, "stray.txt"), "x");
    await makeProject("t1", "app", "prj_1", {});
    await writeFile(join(root, "t1", "latest.md"), "x");
    expect(await sweepReports(hostWith(["prj_1"]), after(0))).toEqual({ removedRecords: 0, removedTeams: 0 });
    expect((await readdir(root)).sort()).toEqual(["not a team id!", "stray.txt", "t1"]);
  });
});
