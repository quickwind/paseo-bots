import { describe, expect, it } from "vitest";
import { promptSections, type BotGroup } from "../shared/bot";
import { ASK_PREAPPROVED_LABEL, askLimit, askPreapproval, groupBots, mayAskWithoutAsking, OTHER_BOTS_TAB, saveTeam, tabOf, teamLogoOf, teamOf, teamPrompt, teamTabs, withoutBot } from "../shared/groups";
import { LOGO_SIZE, MOTIF_NAMES, teamLogo, type TeamLogoImage } from "../shared/team-logo";
import { makeBot } from "./helpers";

const NOW = "2026-09-27T00:00:00.000Z";
const team = (patch: Partial<BotGroup> = {}): BotGroup => ({ id: "t1", name: "Ops", logo: null, leadId: "chief", memberIds: ["chief", "scout", "inbox"], instructions: "", askFreely: false, createdAt: NOW, updatedAt: NOW, ...patch });
const bots = [makeBot({ id: "chief", name: "Chief", title: "Runs the house" }), makeBot({ id: "scout", name: "Scout", title: "Researcher" }), makeBot({ id: "inbox", name: "Inbox", archived: true }), makeBot({ id: "solo", name: "Solo" })];

describe("teams", () => {
  it("finds a bot's team and its live members", () => {
    expect(teamOf("scout", [team()])?.id).toBe("t1");
    expect(teamOf("solo", [team()])).toBeNull();
    const { lead, members } = groupBots(team(), bots);
    expect(lead?.name).toBe("Chief");
    expect(members.map((bot) => bot.name)).toEqual(["Scout"]);
  });

  it("tells the lead to coordinate and members who leads", () => {
    const withInstructions = team({ instructions: "Keep account numbers out of replies." });
    const chief = teamPrompt(withInstructions, bots[0]!, bots);
    expect(chief).toMatch(/^You are the Chief of Staff of the "Ops" team and the user's main contact for it\./);
    expect(chief).toContain("Teammates:\n- Scout: Researcher");
    expect(chief).toContain("Shared instructions for the team. The user manages them for every bot on the team; you can't edit them.\nKeep account numbers out of replies.");
    const scout = teamPrompt(withInstructions, bots[1]!, bots);
    expect(scout).toMatch(/^You're on the "Ops" team\. Chief leads it\./);
    expect(scout).toContain("- Chief (Chief of Staff): Runs the house");
    expect(promptSections(bots[1]!, { memory: "", memoryPath: null, recentWork: [], playbooks: [], team: scout, skills: [], paseoTools: false, botTools: false }).map((section) => section.title)).toEqual(["Persona", "Team"]);
  });

  it("keeps a bot on one team and drops leads that aren't members", () => {
    const other = team({ id: "t2", name: "Home", leadId: "solo", memberIds: ["solo"] });
    const moved = saveTeam([team(), other], null, { name: "New", logo: null, leadId: "scout", memberIds: ["scout", "solo"], instructions: "" }, "t3", NOW);
    expect(moved.map((group) => [group.id, group.leadId, group.memberIds])).toEqual([
      ["t1", "chief", ["chief", "inbox"]],
      ["t2", null, []],
      ["t3", "scout", ["scout", "solo"]],
    ]);
    expect(saveTeam([team()], "t1", { name: "Ops", logo: null, leadId: "ghost", memberIds: ["chief"], instructions: "" }, "x", NOW)[0]!.leadId).toBeNull();
    expect(withoutBot([team()], "chief", NOW)[0]).toMatchObject({ leadId: null, memberIds: ["scout", "inbox"] });
  });
});

describe("team tabs", () => {
  it("has none without teams", () => {
    expect(teamTabs([], bots)).toEqual([]);
  });

  it("gives each team a tab, lead first, then the bots without a team", () => {
    const listed = bots.filter((bot) => !bot.archived);
    const tabs = teamTabs([team({ memberIds: ["scout", "chief"] })], listed);
    expect(tabs.map((tab) => [tab.id, tab.bots.map((bot) => bot.id)])).toEqual([
      ["t1", ["chief", "scout"]],
      [OTHER_BOTS_TAB, ["solo"]],
    ]);
    expect(tabOf("scout", [team()])).toBe("t1");
    expect(tabOf("solo", [team()])).toBe(OTHER_BOTS_TAB);
  });

  it("leaves out Other bots when every bot is on a team", () => {
    expect(teamTabs([team({ memberIds: ["chief", "scout", "inbox", "solo"] })], bots).map((tab) => tab.id)).toEqual(["t1"]);
  });
});

describe("team logos", () => {
  it("draws older teams from their id", () => {
    expect(teamLogoOf(team())).toEqual({ seed: "t1", palette: null, imageUrl: null });
    const logo = { seed: "abc", palette: 2, imageUrl: null };
    expect(teamLogoOf(team({ logo }))).toBe(logo);
  });

  it("is deterministic and follows the pinned colour", () => {
    expect(teamLogo("abc")).toEqual(teamLogo("abc"));
    expect(teamLogo("abc", 3).motif).toBe(teamLogo("abc", 7).motif);
    expect(teamLogo("abc", 3).background).not.toBe(teamLogo("abc", 7).background);
    expect(teamLogo("abc", 3, { dark: true }).rows).toEqual(teamLogo("abc", 3).rows);
  });

  it("reaches every motif and fits each in the grid with a free edge for the rounded tile", () => {
    const logos = new Map<string, TeamLogoImage>();
    for (let seed = 0; logos.size < MOTIF_NAMES.length && seed < 5000; seed++) {
      const logo = teamLogo(`seed-${seed}`, 0);
      if (!logos.has(logo.motif)) logos.set(logo.motif, logo);
    }
    expect([...logos.keys()].sort()).toEqual([...MOTIF_NAMES].sort());
    for (const [motif, { rows }] of logos) {
      expect(rows).toHaveLength(LOGO_SIZE);
      for (const runs of rows) expect(runs.reduce((width, run) => width + run.width, 0)).toBe(LOGO_SIZE);
      for (const y of [0, LOGO_SIZE - 1]) expect(rows[y]!.every((run) => run.color === null), `${motif} row ${y}`).toBe(true);
      for (const runs of rows) expect(runs[0]!.x === 0 && runs[0]!.color === null && runs[runs.length - 1]!.color === null, motif).toBe(true);
    }
  });
});

describe("asking inside a team", () => {
  it("lets teammates ask each other without asking the user only when the team allows it", () => {
    const free = [team({ askFreely: true })];
    expect(mayAskWithoutAsking("chief", "scout", free)).toBe(true);
    expect(mayAskWithoutAsking("scout", "chief", free)).toBe(true);
    expect(mayAskWithoutAsking("scout", "solo", free)).toBe(false);
    expect(mayAskWithoutAsking("solo", "scout", free)).toBe(false);
    expect(mayAskWithoutAsking("chief", "scout", [team()])).toBe(false);
    // Two teams: only inside the one that allows it.
    const other = team({ id: "t2", leadId: "solo", memberIds: ["solo"], askFreely: true });
    expect(mayAskWithoutAsking("solo", "scout", [team({ askFreely: true }), other])).toBe(false);
  });

  it("gives the Chief of Staff a higher hourly limit than the others", () => {
    expect(askLimit("chief", [team()])).toBe(20);
    expect(askLimit("scout", [team()])).toBe(5);
    expect(askLimit("solo", [team()])).toBe(5);
  });

  it("keeps the switch when a team is saved, and it starts off", () => {
    const draft = { name: "Ops", logo: null, leadId: "chief", memberIds: ["chief", "scout"], instructions: "" };
    expect(saveTeam([], null, draft, "t9", NOW)[0]!.askFreely).toBe(false);
    expect(saveTeam([], null, { ...draft, askFreely: true }, "t9", NOW)[0]!.askFreely).toBe(true);
  });

  it("tells the Chief of Staff how it can ask, and not to when it can't", () => {
    const chief = bots[0]!;
    const by = (how: "tool" | "file" | "none", patch = {}) => teamPrompt(team(), { ...chief, ...patch }, bots, how);
    expect(by("tool")).toContain("ask_bot");
    expect(by("tool")).toMatch(/several teammates at once/i);
    expect(by("file")).toContain("outbox");
    expect(by("file")).not.toContain("ask_bot");
    expect(by("file")).toMatch(/several teammates at once/i);
    for (const none of [by("none"), by("tool", { contactBots: "off" })]) {
      expect(none).not.toContain("ask_bot");
      expect(none).not.toContain("outbox");
      expect(none).toMatch(/can't contact/i);
    }
    // A member's text does not depend on it.
    expect(teamPrompt(team(), bots[1]!, bots, "none")).toMatch(/^You're on the "Ops" team\./);
  });
});

describe("how ask_bot was pre-approved when a chat started", () => {
  it("records the basis: the bot is set to Allow, or its team lets members ask freely", () => {
    expect(ASK_PREAPPROVED_LABEL).toBe("bot-crew.ask-preapproved");
    expect(askPreapproval(makeBot({ contactBots: "allow" }), false)).toBe("all");
    expect(askPreapproval(makeBot({ contactBots: "allow" }), true)).toBe("all");
    expect(askPreapproval(makeBot({ contactBots: "ask" }), true)).toBe("team");
    expect(askPreapproval(makeBot({ contactBots: "ask" }), false)).toBeNull();
    expect(askPreapproval(makeBot({ contactBots: "off" }), true)).toBeNull();
  });
});
