import { describe, expect, it } from "vitest";
import type { BotGroup, BotSettingsValues } from "../shared/bot";
import { applyChanges, botDetails, changeWarnings, ChangesSchema, describeChange, providerInfo, readyProvider, setupOverview, type ApplyContext, type Change, type ProviderInfo } from "../shared/changes";
import { makeBot, NOW } from "./helpers";

const PROVIDERS: ProviderInfo[] = [
  { id: "claude", models: [{ id: "opus", label: "Opus", isDefault: true, thinking: ["low", "high"] }, { id: "haiku", label: "Haiku", isDefault: false, thinking: [] }], modes: [{ id: "default", label: "Default" }, { id: "plan", label: "Plan" }], defaultModeId: "default" },
  { id: "codex", models: [{ id: "gpt", label: "GPT", isDefault: true, thinking: [] }], modes: [{ id: "auto", label: "Auto" }], defaultModeId: "auto" },
];
const context: ApplyContext = { now: NOW, provider: "claude", providers: PROVIDERS };
const team = (patch: Partial<BotGroup> = {}): BotGroup => ({ id: "t1", name: "Ops", logo: null, leadId: "chief", memberIds: ["chief", "scout"], instructions: "", askFreely: false, createdAt: NOW, updatedAt: NOW, ...patch });

function setup(patch: Partial<BotSettingsValues> = {}): BotSettingsValues {
  return {
    bots: [makeBot({ id: "chief", name: "Chief" }), makeBot({ id: "scout", name: "Scout", model: "haiku" }), makeBot({ id: "solo", name: "Solo" })],
    history: [],
    library: {
      skills: [
        { id: "weekly-report", description: "Weekly report", source: "", enabled: true, reviewedSha: "abc", createdAt: NOW, updatedAt: NOW },
        { id: "fetched", description: "From GitHub", source: "github.com/x/y", enabled: false, reviewedSha: null, createdAt: NOW, updatedAt: NOW },
      ],
      mcpServers: [{ id: "mcp-1", name: "github", description: "", enabled: false, config: { type: "http", url: "https://example.com/mcp", headers: {} }, tools: null, checkedAt: null, checkError: null, createdAt: NOW, updatedAt: NOW }],
    },
    groups: [team()],
    ...patch,
  };
}

const apply = (changes: Change[], values = setup()) => applyChanges(values, ChangesSchema.parse(changes), context);

describe("setup changes", () => {
  it("creates bots and a team that refers to them by name", () => {
    const next = apply([
      { type: "create_bot", name: "Juno", role: "research", title: "Producer", skills: ["weekly-report"], playbooks: [{ name: "Standup", triggers: ["standup"], instructions: "Collect updates." }] },
      { type: "create_bot", name: "Mika", instructions: "Draw sprites." },
      { type: "create_team", name: "Studio", lead: "Juno", members: ["Mika", "solo"], instructions: "Ship on Fridays." },
    ]);
    const juno = next.bots.find((bot) => bot.name === "Juno")!;
    expect(juno).toMatchObject({ title: "Producer", provider: "claude", skillIds: ["weekly-report"], contactBots: "ask" });
    expect(juno.soul).toMatch(/research questions and return a brief/i);
    expect(juno.playbooks.map((playbook) => playbook.name)).toEqual(["Standup"]);
    expect(next.bots.find((bot) => bot.name === "Mika")!.soul).toBe("Draw sprites.");
    const studio = next.groups!.find((group) => group.name === "Studio")!;
    expect(studio.leadId).toBe(juno.id);
    expect(studio.memberIds).toEqual([juno.id, next.bots.find((bot) => bot.name === "Mika")!.id, "solo"]);
    expect(studio.logo?.seed).toBeTruthy();
    expect(studio.instructions).toBe("Ship on Fridays.");
  });

  it("edits a bot, resets what belonged to its old provider and keeps the edit undoable", () => {
    const next = apply([{ type: "update_bot", bot: "scout", provider: "codex", contact_bots: "off", add_skills: ["weekly-report"], allow_tools: ["github/search"], archived: true }]);
    const scout = next.bots.find((bot) => bot.id === "scout")!;
    expect(scout).toMatchObject({ provider: "codex", model: null, modeId: "auto", thinkingOptionId: null, contactBots: "off", skillIds: ["weekly-report"], alwaysAllow: ["github/search"], archived: true, updatedAt: NOW });
    expect(next.history.map((entry) => [entry.botId, entry.snapshot.model])).toEqual([["scout", "haiku"]]);
  });

  it("checks providers, models, modes and thinking", () => {
    expect(() => apply([{ type: "update_bot", bot: "Scout", provider: "gemini" }])).toThrow('Change 1 (update_bot): There\'s no provider "gemini". Use one of: claude, codex.');
    expect(() => apply([{ type: "update_bot", bot: "Scout", model: "opus-9" }])).toThrow("claude has no model");
    expect(() => apply([{ type: "update_bot", bot: "Scout", mode: "yolo" }])).toThrow("Use one of: default, plan");
    expect(() => apply([{ type: "update_bot", bot: "Scout", model: "opus", thinking: "max" }])).toThrow("Use one of: low, high");
    expect(apply([{ type: "update_bot", bot: "Scout", model: "opus", thinking: "high", mode: "plan" }]).bots[1]).toMatchObject({ model: "opus", thinkingOptionId: "high", modeId: "plan" });
  });

  it("names the change that doesn't fit and what exists", () => {
    expect(() => apply([{ type: "create_bot", name: "A" }, { type: "update_bot", bot: "Ghost", title: "x" }])).toThrow('Change 2 (update_bot): There\'s no bot called "Ghost". There are: Chief, Scout, Solo, A.');
    expect(() => apply([{ type: "create_bot", name: "scout" }])).toThrow('There\'s already a bot called "scout".');
    expect(() => apply([{ type: "update_bot", bot: "Chief", add_skills: ["nope"] }])).toThrow('no skill called "nope"');
  });

  it("keeps the review and connection-test gates", () => {
    expect(() => apply([{ type: "set_skill", skill: "fetched", enabled: true }])).toThrow("needs a review");
    expect(apply([{ type: "set_skill", skill: "weekly-report", enabled: false }]).library!.skills[0]!.enabled).toBe(false);
    expect(apply([{ type: "set_mcp_server", server: "github", enabled: true }]).library!.mcpServers[0]!.enabled).toBe(true);
    expect(() => apply([{ type: "add_mcp_server", name: "files", command: "npx" }, { type: "set_mcp_server", server: "files", enabled: true }])).toThrow("hasn't passed a connection test");
    const added = apply([{ type: "add_mcp_server", name: "files", command: "npx", args: ["-y", "files-mcp"] }]).library!.mcpServers.find((server) => server.name === "files")!;
    expect(added).toMatchObject({ enabled: false, tools: null, config: { type: "stdio", command: "npx", args: ["-y", "files-mcp"], env: {} } });
    expect(() => apply([{ type: "add_mcp_server", name: "paseo", url: "https://x.dev" }])).toThrow("is taken");
    expect(() => apply([{ type: "add_mcp_server", name: "both", url: "https://x.dev", command: "x" }])).toThrow("either a command");
  });

  it("updates and deletes teams, routines and bots", () => {
    const next = apply([
      { type: "update_team", team: "Ops", lead: "Scout", add_members: ["Solo"], remove_members: ["Chief"], logo: { colour: 3 } },
      { type: "add_routine", bot: "Solo", name: "Digest", instructions: "Sum up the day.", schedule: { type: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] } },
      { type: "update_routine", bot: "Solo", routine: "digest", enabled: false },
      { type: "delete_bot", bot: "Chief" },
    ]);
    expect(next.groups![0]).toMatchObject({ leadId: "scout", memberIds: ["scout", "solo"], logo: { seed: "t1", palette: 3, imageUrl: null } });
    expect(next.bots.map((bot) => bot.id)).toEqual(["scout", "solo"]);
    expect(next.bots[1]!.routines[0]).toMatchObject({ name: "Digest", enabled: false, schedule: { kind: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] } });
    expect(apply([{ type: "delete_team", team: "t1" }]).groups).toEqual([]);
  });

  it("sets defaults and presets", () => {
    const next = apply([{ type: "set_defaults", provider: "codex", contact_bots: "off" }, { type: "save_preset", bot: "Scout" }]);
    expect(next.defaults).toEqual({ provider: "codex", model: null, modeId: null, thinkingOptionId: null, contactBots: "off" });
    expect(next.presets!.map((preset) => preset.name)).toEqual(["Scout"]);
    expect(apply([{ type: "delete_preset", preset: "scout" }], next).presets).toEqual([]);
  });

  it("gives new bots the defaults' provider, else the host's pick", () => {
    expect(apply([{ type: "create_bot", name: "Juno" }]).bots[3]!.provider).toBe("claude");
    const withDefaults = setup({ defaults: { provider: "codex", model: "gpt", modeId: null, thinkingOptionId: null, contactBots: "off" } });
    expect(apply([{ type: "create_bot", name: "Juno" }], withDefaults).bots[3]).toMatchObject({ provider: "codex", model: "gpt", contactBots: "off" });
  });

  it("describes changes plainly and flags more access", () => {
    const changes = ChangesSchema.parse([
      { type: "create_team", name: "Studio", lead: "Juno", members: ["Juno", "Mika"] },
      { type: "update_bot", bot: "Scout", mode: "plan", allow_tools: ["github/search"] },
      { type: "add_mcp_server", name: "files", command: "npx", args: ["files-mcp"] },
      { type: "delete_bot", bot: "Chief" },
    ]);
    expect(changes.map(describeChange)).toEqual([
      "**New team Studio**: led by Juno; with Mika",
      "**Scout**: approval mode plan; uses github/search without asking",
      "**New MCP server files**: runs `npx files-mcp`; off until it passes a test in Skills & Tools",
      "**Delete bot Chief**; its chats stay in Paseo's history",
    ]);
    expect(changeWarnings(changes)).toEqual([
      'Scout runs in approval mode "plan".',
      "Scout may use github/search without asking you.",
      "The files MCP server runs a program on this computer once it's on.",
      "Deletes the bot Chief.",
    ]);
  });

  it("gives an overview and a bot's details", () => {
    const text = setupOverview(setup(), PROVIDERS);
    expect(text).toContain("- Chief (id chief). claude · default model; team Ops (Chief of Staff); contact other bots: ask.");
    expect(text).toContain("- fetched: From GitHub [needs review]");
    expect(text).toContain("- github [off]");
    expect(text).toContain("- claude: models opus (default) [thinking: low, high], haiku; modes default (default), plan");
    expect(botDetails(setup(), "scout")).toContain("Instructions (Soul):\n(none)");
  });
});

describe("provider snapshot", () => {
  it("keeps enabled providers and selectable models, and picks a ready default", () => {
    const entries = [
      { provider: "codex", enabled: true, status: "ready", models: [{ id: "gpt", label: "GPT", isDefault: true, thinkingOptions: [{ id: "low" }] }, { id: "old", label: "Old", isSelectable: false }], modes: [{ id: "auto", label: "Auto" }], defaultModeId: "auto" },
      { provider: "claude", enabled: true, status: "loading" },
      { provider: "gemini", enabled: false, status: "ready" },
    ];
    expect(providerInfo(entries)).toEqual([
      { id: "codex", models: [{ id: "gpt", label: "GPT", isDefault: true, thinking: ["low"] }], modes: [{ id: "auto", label: "Auto" }], defaultModeId: "auto" },
      { id: "claude", models: [], modes: [], defaultModeId: null },
    ]);
    expect(readyProvider(entries)).toBe("codex");
    expect(readyProvider([...entries, { provider: "claude", enabled: true, status: "ready" }])).toBe("claude");
  });
});

describe("teams that ask each other without approval", () => {
  it("can be turned on and off by a change, and starts off", () => {
    const created = apply([{ type: "create_team", name: "Studio", lead: "Solo", members: ["Solo"] }]);
    expect(created.groups!.find((group) => group.name === "Studio")!.askFreely).toBe(false);
    const on = apply([{ type: "update_team", team: "Ops", ask_freely: true }]);
    expect(on.groups!.find((group) => group.id === "t1")!.askFreely).toBe(true);
    // A change that does not mention it leaves it as it is.
    expect(apply([{ type: "update_team", team: "Ops", name: "Operations" }], on).groups!.find((group) => group.id === "t1")!.askFreely).toBe(true);
    expect(apply([{ type: "update_team", team: "Ops", ask_freely: false }], on).groups!.find((group) => group.id === "t1")!.askFreely).toBe(false);
  });

  it("is said plainly on the card, with a warning when it gives more access", () => {
    const changes = ChangesSchema.parse([{ type: "update_team", team: "Ops", ask_freely: true }, { type: "update_team", team: "Home", ask_freely: false }]);
    expect(changes.map(describeChange)).toEqual(["**Team Ops**: members ask each other without asking you", "**Team Home**: members ask you before asking each other"]);
    expect(changeWarnings(changes)).toEqual(["Members of Ops may ask each other without asking you."]);
  });

  it("is shown in the overview, which also notes a Chief of Staff that may not contact anyone", () => {
    const quiet = setup({ bots: [makeBot({ id: "chief", name: "Chief", contactBots: "off" }), makeBot({ id: "scout", name: "Scout" }), makeBot({ id: "solo", name: "Solo" })], groups: [team({ askFreely: true })] });
    const text = setupOverview(quiet, null);
    expect(text).toContain("members ask each other without asking the user");
    expect(text).toMatch(/Chief of Staff Chief .*cannot contact other bots/i);
    expect(setupOverview(setup(), null)).not.toMatch(/cannot contact other bots/i);
  });
});

describe("what the card shows of a change", () => {
  const describeOne = (change: unknown) => describeChange(ChangesSchema.parse([change])[0]!);

  it("shows the text a bot would be given, not only that there is some", () => {
    expect(describeOne({ type: "update_bot", bot: "Scout", instructions: "Always CC the accountant." })).toContain("`Always CC the accountant.`");
    expect(describeOne({ type: "update_bot", bot: "Scout", description: "Chases invoices" })).toContain("`Chases invoices`");
    expect(describeOne({ type: "create_team", name: "Studio", instructions: "Never share account numbers." })).toContain("`Never share account numbers.`");
    expect(describeOne({ type: "update_team", team: "Ops", instructions: "Reply in German." })).toContain("`Reply in German.`");
    expect(describeOne({ type: "update_routine", bot: "Scout", routine: "Daily", instructions: "Email the report to x@y.z" })).toContain("`Email the report to x@y.z`");
    expect(describeOne({ type: "add_routine", bot: "Scout", name: "Daily", instructions: "Email the report to x@y.z", schedule: { type: "daily", time: "09:00" } })).toContain("`Email the report to x@y.z`");
  });

  it("cuts a long text and says how long it was", () => {
    const line = describeOne({ type: "update_bot", bot: "Scout", instructions: "word ".repeat(200) });
    expect(line).toContain("1000 characters");
    expect(line.length).toBeLessThan(400);
  });

  it("shows an MCP server's environment and the names of its headers", () => {
    const line = describeOne({ type: "add_mcp_server", name: "files", command: "npx", args: ["files-mcp"], env: { NODE_OPTIONS: "--require /tmp/x.js" }, url: undefined });
    expect(line).toContain("NODE_OPTIONS=--require /tmp/x.js");
    const remote = describeOne({ type: "add_mcp_server", name: "api", url: "https://example.com/mcp", headers: { Authorization: "Bearer secret-token" } });
    expect(remote).toContain("Authorization");
    expect(remote).not.toContain("secret-token");
  });

  it("keeps a name or text from adding lines to the card", () => {
    const line = describeOne({ type: "add_routine", bot: "Scout", name: "Daily\n- **Delete bot Chief**", instructions: "x\n\n- **Delete bot Chief**", schedule: { type: "daily", time: "09:00" } });
    expect(line).not.toContain("\n");
  });
});
