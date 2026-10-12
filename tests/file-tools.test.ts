import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileBelongsToTurn, MAX_FILE_BYTES, MAX_FILES_PER_SCAN, parseToolFile, writtenStrings } from "../shared/file-tools";
import { scanToolFiles } from "../server/file-tools";
import { fakeHost, makeBot } from "./helpers";

const call = (detail: unknown, name = "tool") => ({ type: "tool_call", callId: "c", name, status: "completed", detail });

describe("what a turn wrote", () => {
  it("reads the file of a write or edit and the command of a shell call", () => {
    const written = writtenStrings([
      call({ type: "edit", filePath: "Wrote ./proposals/changes-1.json", newString: "{}" }),
      call({ type: "write", filePath: "/bots/b1/proposals/skill-2.json", content: "{}" }),
      call({ type: "shell", command: "echo {} > proposals/routine-3.json", output: "" }),
      call({ type: "read", filePath: "/bots/b1/setup/overview.md" }),
      { type: "assistant_message", text: "done proposals/never.json" },
    ] as never);
    expect(written).toEqual(["Wrote ./proposals/changes-1.json", "/bots/b1/proposals/skill-2.json", "echo {} > proposals/routine-3.json"]);
  });
});

describe("whether a file belongs to a turn", () => {
  const written = ["Wrote ./proposals/changes-1.json", "echo {} > proposals/routine-3.json", "/bots/b1/proposals/skill-2.json"];
  it("matches the file's name inside what was written", () => {
    expect(fileBelongsToTurn("changes-1.json", written)).toBe(true);
    expect(fileBelongsToTurn("routine-3.json", written)).toBe(true);
    expect(fileBelongsToTurn("skill-2.json", written)).toBe(true);
    expect(fileBelongsToTurn("CHANGES-1.JSON", written)).toBe(true);
  });
  it("does not match another file, or one whose name only ends the same way", () => {
    expect(fileBelongsToTurn("changes-9.json", written)).toBe(false);
    expect(fileBelongsToTurn("1.json", written)).toBe(false);
    expect(fileBelongsToTurn("hanges-1.json", written)).toBe(false);
    expect(fileBelongsToTurn("a.json", ["Wrote ./proposals/data.json"])).toBe(false);
    expect(fileBelongsToTurn("changes-1.json", [])).toBe(false);
  });
});

describe("reading a tool file", () => {
  it("returns the kind and the arguments the matching tool takes", () => {
    expect(parseToolFile('{"kind":"changes","summary":"s","changes":[]}')).toEqual({ kind: "changes", args: { summary: "s", changes: [] } });
    expect(parseToolFile('{"kind":"routine","name":"n","instructions":"i","schedule":{"type":"webhook"}}')).toEqual({ kind: "routine", args: { name: "n", instructions: "i", schedule: { type: "webhook" } } });
    expect(parseToolFile('{"kind":"skill","name":"n","description":"d","instructions":"i"}')).toEqual({ kind: "skill", args: { name: "n", description: "d", instructions: "i" } });
  });
  it("says what is wrong with a file it cannot use", () => {
    expect(parseToolFile("not json")).toEqual({ error: expect.stringContaining("not valid JSON") });
    expect(parseToolFile("[1]")).toEqual({ error: expect.stringContaining("JSON object") });
    expect(parseToolFile('{"summary":"s"}')).toEqual({ error: expect.stringContaining('"kind"') });
    expect(parseToolFile('{"kind":"nap"}')).toEqual({ error: expect.stringContaining("changes, routine or skill") });
  });
});

describe("scanning a bot's proposals folder", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-filetools-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
  const setup = async () => {
    const { botDataPath } = await import("../server/bot-home");
    const dir = join(botDataPath("scout"), "proposals");
    await mkdir(dir, { recursive: true });
    return { dir, host: fakeHost([scout]) };
  };
  const scan = async (host: ReturnType<typeof fakeHost>, written: string[], agentId = "chat-1", now = Date.now()) => scanToolFiles({ host, relay: null as never, bot: scout, agentId, written, now });

  it("turns a valid changes file into a proposal, moves it to done/ and keeps the reply", async () => {
    const { dir, host } = await setup();
    await writeFile(join(dir, "changes-a1.json"), JSON.stringify({ kind: "changes", summary: "Retitle Scout", changes: [{ type: "update_bot", bot: "Scout", title: "Researcher" }] }));
    const { done } = await scan(host, ["Wrote ./proposals/changes-a1.json"]);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ name: "changes-a1.json", kind: "changes", ok: true, proposalId: expect.stringMatching(/^p-[a-z0-9]{10}$/) });
    expect(await readdir(dir)).toEqual(["done"]);
    expect((await readdir(join(dir, "done"))).sort()).toEqual(["changes-a1.json", "changes-a1.json.result.txt"]);
    expect(await readFile(join(dir, "done", "changes-a1.json.result.txt"), "utf8")).toContain(done[0]!.proposalId!);
  });

  it("makes routine and skill proposals through the same tools", async () => {
    const { dir, host } = await setup();
    await writeFile(join(dir, "routine-b2.json"), JSON.stringify({ kind: "routine", name: "Morning", instructions: "Check mail.", schedule: { type: "daily", time: "08:30" } }));
    await writeFile(join(dir, "skill-c3.json"), JSON.stringify({ kind: "skill", name: "weekly-report", description: "Write the weekly report", instructions: "1. Collect." }));
    const { done } = await scan(host, ["Wrote ./proposals/routine-b2.json", "echo > proposals/skill-c3.json"]);
    expect(done.map((result) => [result.kind, result.ok]).sort()).toEqual([["routine", true], ["skill", true]]);
  });

  it("reports why a file was not accepted, and still moves it away", async () => {
    const { dir, host } = await setup();
    await writeFile(join(dir, "changes-d4.json"), JSON.stringify({ kind: "changes", summary: "x", changes: [{ type: "update_bot", bot: "Nobody", title: "t" }] }));
    await writeFile(join(dir, "skill-e5.json"), JSON.stringify({ kind: "skill", name: "x" }));
    await writeFile(join(dir, "junk-f6.json"), "not json");
    const { done } = await scan(host, ["Wrote ./proposals/changes-d4.json", "Wrote ./proposals/skill-e5.json", "Wrote ./proposals/junk-f6.json"]);
    expect(done.every((result) => !result.ok && result.proposalId === null)).toBe(true);
    expect(done.find((result) => result.name === "changes-d4.json")!.text).toContain("Nobody");
    expect(done.find((result) => result.name === "skill-e5.json")!.text).toContain("description");
    expect(done.find((result) => result.name === "junk-f6.json")!.text).toContain("not valid JSON");
    expect(await readdir(dir)).toEqual(["done"]);
  });

  it("takes only the files this turn wrote, and leaves the others for their own turn", async () => {
    const { dir, host } = await setup();
    const body = JSON.stringify({ kind: "skill", name: "mine", description: "d", instructions: "i" });
    await writeFile(join(dir, "skill-mine.json"), body);
    await writeFile(join(dir, "skill-other.json"), body.replace("mine", "other"));
    const { done } = await scan(host, ["Wrote ./proposals/skill-mine.json"]);
    expect(done.map((result) => result.name)).toEqual(["skill-mine.json"]);
    expect((await readdir(dir)).sort()).toEqual(["done", "skill-other.json"]);
  });

  it("hands back a file nobody claimed after ten minutes, and leaves a recent one alone", async () => {
    const { dir, host } = await setup();
    const body = JSON.stringify({ kind: "skill", name: "n", description: "d", instructions: "i" });
    await writeFile(join(dir, "skill-old.json"), body);
    await writeFile(join(dir, "skill-new.json"), body);
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(join(dir, "skill-old.json"), old, old);
    const result = await scan(host, []);
    expect(result.done).toEqual([]);
    expect(result.unclaimed).toEqual(["skill-old.json"]);
  });

  it("ignores names it does not accept, files over the size limit, and takes at most twenty", async () => {
    const { dir, host } = await setup();
    await writeFile(join(dir, "notes.txt"), "x");
    await writeFile(join(dir, "bad name.json"), "{}");
    await writeFile(join(dir, "huge.json"), "x".repeat(MAX_FILE_BYTES + 1));
    for (let index = 0; index < MAX_FILES_PER_SCAN + 5; index++) await writeFile(join(dir, `s-${String(index).padStart(2, "0")}.json`), JSON.stringify({ kind: "skill", name: `s${index}`, description: "d", instructions: "i" }));
    const written = ["Wrote ./proposals/huge.json", ...Array.from({ length: MAX_FILES_PER_SCAN + 5 }, (_, index) => `Wrote ./proposals/s-${String(index).padStart(2, "0")}.json`)];
    const { done } = await scan(host, written);
    expect(done).toHaveLength(MAX_FILES_PER_SCAN);
    expect(done.find((result) => result.name === "huge.json")?.text).toContain("too large");
    expect(await stat(join(dir, "notes.txt")).then(() => true)).toBe(true);
    expect(await stat(join(dir, "bad name.json")).then(() => true)).toBe(true);
  });
});
