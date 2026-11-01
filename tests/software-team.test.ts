import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The example team (docs/blueprints/software-team): its team file is built from the markdown beside it, and imports.

const dir = join(__dirname, "..", "docs", "blueprints", "software-team");
const read = async (name: string) => (await readFile(join(dir, name), "utf8")).replace(/\r\n/g, "\n").trim();

describe("the software team example", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-team-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("has a team file that matches its markdown (run node scripts/build-software-team.mjs after editing the markdown)", async () => {
    const file = JSON.parse(await read("software-team.team.json")) as { bots: { bot: { name: string; soul: string } }[]; teams: { instructions: string }[] };
    expect(file.teams[0]!.instructions.replace(/\r\n/g, "\n")).toBe(await read("team.md"));
    const souls = Object.fromEntries(file.bots.map((entry) => [entry.bot.name, entry.bot.soul.replace(/\r\n/g, "\n")]));
    expect(souls).toEqual({ Admin: await read("admin.md"), Architect: await read("architect.md"), Designer: await read("designer.md"), Developer: await read("developer.md") });
  });

  it("imports as four bots in one team led by the admin, with the team's text as its shared instructions", async () => {
    const { importTeam } = await import("../server/share");
    const result = await importTeam({ json: await readFile(join(dir, "software-team.team.json"), "utf8") });
    expect(result.bots.map((entry) => entry.bot.name)).toEqual(["Admin", "Architect", "Designer", "Developer"]);
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]).toMatchObject({ name: "Software team", lead: 0, members: [0, 1, 2, 3] });
    expect(result.teams[0]!.instructions.replace(/\r\n/g, "\n")).toBe(await read("team.md"));
    expect(result.teams[0]!.instructions.length).toBeLessThan(20_000);
    // No provider and no model in the file: the import fills in the default provider.
    expect(result.bots.map((entry) => [entry.bot.provider, entry.bot.model])).toEqual([["", null], ["", null], ["", null], ["", null]]);
  });

  it("says the three approval points with the titles the bots use, that only the user decides, and when to stop", async () => {
    const text = await read("team.md");
    for (const title of ["Architecture: <feature>", "Design: <feature>", "Acceptance: <feature>"]) expect(text).toContain(title);
    expect(text).toMatch(/Only the user can give it/);
    expect(text).toMatch(/stop and do nothing else/i);
    expect(text).toMatch(/BLOCKED/);
    expect(text).toMatch(/never into the project's main branch|Nobody merges\s+into the main branch/i);
  });

  it("gives the admin the lead's job and nobody else the admin's", async () => {
    const admin = await read("admin.md");
    expect(admin).toMatch(/memory\/projects\/<project>\.md/);
    expect(admin).toMatch(/Do not hand work to anyone but the architect/);
    expect(await read("designer.md")).toMatch(/review/i);
    expect(await read("developer.md")).toMatch(/BLOCKED/);
  });
});
