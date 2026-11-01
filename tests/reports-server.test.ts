import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDay } from "../shared/activity";
import type { BotGroup } from "../shared/bot";
import { fakeHost, makeBot } from "./helpers";

const NOW = "2026-10-20T00:00:00.000Z";
const team: BotGroup = { id: "t1", name: "Crew", logo: null, leadId: "lead", memberIds: ["lead", "dev"], instructions: "", askFreely: false, createdAt: NOW, updatedAt: NOW };
const lead = makeBot({ id: "lead", name: "Chief" });
const dev = makeBot({ id: "dev", name: "Dev" });
const solo = makeBot({ id: "solo", name: "Solo" });
const app = { id: "prj_aaaa1111", name: "app" };

describe("team reports v2: the store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-reports2-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });
  const store = () => import("../server/reports");
  const homeOf = () => import("../server/bot-home");
  const records = () => import("../shared/reports");
  const host = () => fakeHost([lead, dev, solo], undefined, [team]);
  const root = async () => (await homeOf()).teamReportsPath("t1");
  const day = () => localDay(new Date());

  async function rec(over: Record<string, unknown> = {}) {
    const { reportRecord } = await records();
    return reportRecord({
      at: new Date(),
      bot: { id: "dev", name: "Dev" },
      chat: { id: "a1b2c3d4-0000-4000-8000-000000000000", title: "A chat" },
      project: app,
      workspace: "app · Login",
      driver: { kind: "user" },
      status: "done",
      question: "Write notes.md",
      answer: "Done: notes.md written.",
      ...over,
    } as never);
  }

  it("is under Reports/<team>, and the plugin's data holds nothing of the v1 layout", async () => {
    const { teamReportsPath, pluginDataPath } = await homeOf();
    expect(teamReportsPath("t1")).toBe(join(pluginDataPath(), "shared", "Reports", "t1"));
  });

  it("writes a member's record whole to the jsonl and as an index line to the md, which starts with a header", async () => {
    const { recordReport } = await store();
    const { reportIndexLine } = await records();
    const record = await rec();
    expect(await recordReport(host(), { bot: dev, record })).toBe(true);
    const dir = join(await root(), "app");
    const jsonl = (await readFile(join(dir, `${day()}.jsonl`), "utf8")).trim().split("\n");
    expect(jsonl).toHaveLength(1);
    expect(JSON.parse(jsonl[0]!)).toEqual(record);
    const md = (await readFile(join(dir, `${day()}.md`), "utf8")).trim().split("\n");
    expect(md[0]).toMatch(/^<!-- Written by the Bots plugin\./);
    expect(md[0]).toContain("jsonl");
    expect(md[1]).toBe(reportIndexLine(record));
    expect(JSON.parse(await readFile(join(dir, "project.json"), "utf8"))).toEqual(app);
  });

  it("writes the lead's own record too, and nothing for a bot on no team", async () => {
    const { recordReport } = await store();
    expect(await recordReport(host(), { bot: lead, record: await rec({ bot: { id: "lead", name: "Chief" } }) })).toBe(true);
    expect(await recordReport(host(), { bot: solo, record: await rec({ bot: { id: "solo", name: "Solo" } }) })).toBe(false);
    expect((await readFile(join(await root(), "app", `${day()}.jsonl`), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("writes nothing and makes no folder for a bot on no team", async () => {
    const { recordReport } = await store();
    await recordReport(host(), { bot: solo, record: await rec() });
    await expect(readdir(await root())).rejects.toThrow();
  });

  it("keeps two projects with one name apart", async () => {
    const { recordReport } = await store();
    await recordReport(host(), { bot: dev, record: await rec() });
    await recordReport(host(), { bot: dev, record: await rec({ project: { id: "prj_bbbb2222", name: "app" } }) });
    expect((await readdir(await root())).filter((name) => name !== "latest.md").sort()).toEqual(["app", "app-2222"]);
  });

  it("keeps every record whole when twenty finish at the same moment, with one header", async () => {
    const { recordReport } = await store();
    const h = host();
    await Promise.all(Array.from({ length: 20 }, async (_, i) => recordReport(h, { bot: dev, record: await rec({ answer: `answer ${i} ${"x".repeat(300)}`, chat: { id: `c${String(i).padStart(7, "0")}-0000`, title: `chat ${i}` } }) })));
    const dir = join(await root(), "app");
    const jsonl = (await readFile(join(dir, `${day()}.jsonl`), "utf8")).trim().split("\n");
    expect(jsonl).toHaveLength(20);
    expect(new Set(jsonl.map((line) => JSON.parse(line).chat.id)).size).toBe(20);
    const md = (await readFile(join(dir, `${day()}.md`), "utf8")).trim().split("\n");
    expect(md.filter((line) => line.startsWith("<!--"))).toHaveLength(1);
    expect(md.filter((line) => line.startsWith("- "))).toHaveLength(20);
  });

  it("rewrites latest.md with one line per chat, a blocked chat first", async () => {
    const { recordReport } = await store();
    const h = host();
    await recordReport(h, { bot: dev, record: await rec({ chat: { id: "aaaaaaaa-0", title: "fine" }, answer: "all good" }) });
    await recordReport(h, { bot: dev, record: await rec({ chat: { id: "aaaaaaaa-0", title: "fine" }, answer: "still good" }) });
    await recordReport(h, { bot: dev, record: await rec({ chat: { id: "bbbbbbbb-0", title: "stuck" }, status: "blocked", answer: "BLOCKED: no access" }) });
    await recordReport(h, { bot: dev, record: await rec({ chat: { id: "cccccccc-0", title: "newest" }, answer: "newest chat" }) });
    const text = await readFile(join(await root(), "latest.md"), "utf8");
    expect(text).toMatch(/^<!-- Written by the Bots plugin\./);
    const lines = text.split("\n").filter((line) => line.startsWith("[app]"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("blocked");
    expect(lines[1]).toContain("newest chat");
    expect(lines[2]).toContain("still good");
    expect(lines[2]).toContain("2 turns that day");
  });

  it("replaces a link where a project's folder goes, and leaves what it pointed at alone", async () => {
    const { recordReport } = await store();
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "keep.txt"), "keep");
    await mkdir(await root(), { recursive: true });
    await symlink(elsewhere, join(await root(), "app"), "dir");
    await recordReport(host(), { bot: dev, record: await rec() });
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);
    expect(await readdir(join(await root(), "app"))).toContain(`${day()}.jsonl`);
  });

  it("does not read another team's lines through a link a lead planted, nor a project name through one", async () => {
    const { recordReport, teamStatusLines } = await store();
    const h = host();
    await recordReport(h, { bot: dev, record: await rec({ chat: { id: "aaaaaaaa-0", title: "mine" }, answer: "my own answer" }) });
    const other = join(home, "other-team");
    await mkdir(other);
    const { reportIndexLine } = await records();
    await writeFile(join(other, "stolen.md"), `${reportIndexLine(await rec({ chat: { id: "ffffffff-0", title: "theirs" }, answer: "SECRET OF THE OTHER TEAM" }))}\n`);
    await writeFile(join(other, "project.json"), JSON.stringify({ id: "prj_x", name: "stolen project name" }));
    const dir = join(await root(), "app");
    await symlink(join(other, "stolen.md"), join(dir, `${localDay(new Date(Date.now() - 86_400_000))}.md`));
    await rm(join(dir, "project.json"));
    await symlink(join(other, "project.json"), join(dir, "project.json"));
    const lines = (await teamStatusLines("t1", 10)).join("\n");
    expect(lines).toContain("my own answer");
    expect(lines).not.toContain("SECRET OF THE OTHER TEAM");
    expect(lines).not.toContain("stolen project name");
  });

  it("gives the per-chat view of the last three days for the lead's prompt", async () => {
    const { recordReport, teamStatusLines } = await store();
    const h = host();
    await recordReport(h, { bot: dev, record: await rec({ chat: { id: "aaaaaaaa-0", title: "a" }, answer: "first" }) });
    await recordReport(h, { bot: dev, record: await rec({ chat: { id: "bbbbbbbb-0", title: "b" }, answer: "second" }) });
    const lines = await teamStatusLines("t1", 10);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("A: second");
    expect(await teamStatusLines("t1", 1)).toHaveLength(1);
    expect(await teamStatusLines("t-none", 5)).toEqual([]);
  });
});
