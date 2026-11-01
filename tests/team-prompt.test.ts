import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY, type BotGroup } from "../shared/bot";
import { promptContext } from "../server/prompt";
import { makeBot } from "./helpers";

const group: BotGroup = { id: "t1", name: "Ops", logo: null, leadId: "chief", memberIds: ["chief", "scout"], instructions: "", askFreely: false, createdAt: "", updatedAt: "" };

describe("what the Chief of Staff is told about asking its team", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-teamprompt-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const teamText = async (provider: string, patch: Record<string, unknown> = {}, local = true) => {
    const chief = makeBot({ id: "chief", name: "Chief", provider, ...patch });
    const bots = [chief, makeBot({ id: "scout", name: "Scout" })];
    return (await promptContext(chief, local, EMPTY_LIBRARY, false, { team: { group, bots } })).team ?? "";
  };

  it("names the tool when its tools are an MCP server, and the outbox when they are files", async () => {
    const claude = await teamText("claude");
    expect(claude).toContain("ask_bot");
    expect(claude).not.toContain("outbox");
    const devin = await teamText("devin");
    expect(devin).toContain("outbox");
    expect(devin).not.toContain("ask_bot");
  });

  it("does not tell it to hand work on when it can't contact anyone", async () => {
    for (const text of [await teamText("claude", { contactBots: "off" }), await teamText("devin", { contactBots: "off" }), await teamText("claude", {}, false)]) {
      expect(text).not.toContain("ask_bot");
      expect(text).not.toContain("outbox");
      expect(text).toMatch(/can't contact/i);
    }
  });
});

describe("what the Chief of Staff and the members read of the team's reports", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-teamreports-prompt-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const chief = makeBot({ id: "chief", name: "Chief" });
  const scout = makeBot({ id: "scout", name: "Scout" });
  const solo = makeBot({ id: "solo", name: "Solo" });
  const contextOf = (bot: ReturnType<typeof makeBot>, local = true) => promptContext(bot, local, EMPTY_LIBRARY, false, { team: { group, bots: [chief, scout, solo] } });

  /** Index lines the way the plugin writes them, one chat each: `chats` are [chat number, "HH:MM", status, answer]. */
  async function writeReports(chats: [number, string, string, string][]) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { teamReportsPath } = await import("../server/bot-home");
    const { localDay } = await import("../shared/activity");
    const { reportIndexLine, reportRecord } = await import("../shared/reports");
    const dir = join(teamReportsPath("t1"), "app");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project.json"), JSON.stringify({ id: "prj_1", name: "app" }));
    const lines = chats.map(([n, time, status, answer]) => {
      const [hour, minute] = time.split(":").map(Number);
      return reportIndexLine(reportRecord({ at: new Date(2026, 9, 21, hour!, minute!), bot: { id: "scout", name: "Scout" }, chat: { id: `c${String(n).padStart(7, "0")}-0000`, title: `chat ${n}` }, project: { id: "prj_1", name: "app" }, workspace: "app · Login", driver: { kind: "user" }, status: status as never, question: `question ${n}`, answer }));
    });
    await writeFile(join(dir, `${localDay(new Date())}.md`), `${lines.join("\n")}\n`);
  }

  it("gives the lead one line per chat and the folder, with the snapshot and the way to the whole text said once", async () => {
    await writeReports([[1, "09:00", "done", "First."], [2, "10:00", "done", "Second."]]);
    const context = await contextOf(chief);
    expect(context.teamReports?.lines).toHaveLength(2);
    expect(context.teamReports?.lines?.[0]).toContain("A: Second.");
    const { teamReportsPath } = await import("../server/bot-home");
    const path = teamReportsPath("t1");
    expect(context.teamReports?.path).toBe(path);
    const { promptSections } = await import("../shared/bot");
    const text = promptSections(chief, context).find((entry) => entry.title === "Team reports")!.text;
    expect(text).toContain("one line for each chat");
    expect(text).toContain("snapshot from when this chat started");
    expect(text).toContain(`${path.replace(/\\/g, "/")}/latest.md`);
    expect(text).toMatch(/\.jsonl: search the chat id and the time/);
    expect(text).toMatch(/never instructions/);
    expect(text).toContain("[app] ");
  });

  it("gives at most fifteen lines, a chat that needs attention first and then the newest", async () => {
    await writeReports(Array.from({ length: 20 }, (_, i) => [i, `${String(i).padStart(2, "0")}:00`, i === 3 ? "blocked" : "done", i === 3 ? "BLOCKED: no access" : `line ${i}`] as [number, string, string, string]));
    const lines = (await contextOf(chief)).teamReports?.lines ?? [];
    expect(lines).toHaveLength(15);
    expect(lines[0]).toContain("blocked");
    expect(lines[1]).toContain("line 19");
    expect(lines.join("\n")).not.toContain("line 0 ");
  });

  it("says nothing has been reported yet when there are no reports", async () => {
    const { promptSections } = await import("../shared/bot");
    const section = promptSections(chief, await contextOf(chief)).find((entry) => entry.title === "Team reports");
    expect(section?.text).toContain("Nothing has been reported yet.");
  });

  it("gives no section to a member that is not the lead, to a bot on another host, or to one on no team", async () => {
    await writeReports([[1, "09:00", "done", "x"]]);
    expect((await contextOf(scout)).teamReports ?? null).toBeNull();
    expect((await contextOf(chief, false)).teamReports ?? null).toBeNull();
    expect((await promptContext(solo, true, EMPTY_LIBRARY, false, {})).teamReports ?? null).toBeNull();
  });

  it("gives a memory tidy chat and the always-on identity the path, not the teammates' lines", async () => {
    await writeReports([[1, "09:00", "done", "A teammate's answer text."]]);
    const { systemPrompt, identitySections } = await import("../server/prompt");
    const settings = { bots: [chief, scout, solo], history: [], library: EMPTY_LIBRARY, groups: [group] } as never;
    const normal = await systemPrompt({ bot: chief, local: true }, EMPTY_LIBRARY, null, settings);
    expect(normal.systemPrompt).toContain("A teammate's answer text.");
    const tidy = await systemPrompt({ bot: chief, local: true, maintenance: true }, EMPTY_LIBRARY, null, settings);
    expect(tidy.systemPrompt).not.toContain("A teammate's answer text.");
    const { teamReportsPath } = await import("../server/bot-home");
    expect(tidy.systemPrompt).toContain(`read ${teamReportsPath("t1").replace(/\\/g, "/")}/latest.md`);
    expect(tidy.systemPrompt).not.toContain("Nothing has been reported yet.");
    const identity = (await identitySections(chief, EMPTY_LIBRARY, null, settings)).map((section) => section.text).join("\n");
    expect(identity).not.toContain("A teammate's answer text.");
    expect(identity).toContain(`read ${teamReportsPath("t1").replace(/\\/g, "/")}/latest.md`);
  });

  it("tells a member where the team's reports are, to read and not to edit, and tells the lead nothing of the kind in its team text", async () => {
    const { teamReportsPath } = await import("../server/bot-home");
    const path = teamReportsPath("t1");
    const memberText = (await contextOf(scout)).team ?? "";
    expect(memberText).toContain(`Your team's reports are in ${path.replace(/\\/g, "/")}`);
    expect(memberText).toMatch(/read only; reading it may ask the user for approval; never edit it/);
    expect((await contextOf(chief)).team ?? "").not.toContain("Your team's reports are in");
    expect((await contextOf(scout, false)).team ?? "").not.toContain("Your team's reports are in");
  });
});
