import { describe, expect, it } from "vitest";
import { applyDefaults, botSettings, BotSchema, type BotSettingsValues } from "../shared/bot";
import { applyChanges, ChangesSchema, type ApplyContext } from "../shared/changes";
import { withDefaultProvider } from "../shared/library";
import { botFromPreset, newBot } from "../shared/templates";
import { usesFiles } from "../shared/tools-mode";
import { makeBot, NOW } from "./helpers";

const base = { provider: "", model: null, modeId: null, thinkingOptionId: null, contactBots: "ask" };
const defaults = base as never;

describe("a bot's own tool mode overrides the global default", () => {
  it("wins over the global setting, in both directions", () => {
    expect(usesFiles("mcp", "claude", "files")).toBe(true);
    expect(usesFiles("files", "claude", "mcp")).toBe(false);
    expect(usesFiles("mcp", "devin", "files")).toBe(true);
    expect(usesFiles("files", "devin", "mcp")).toBe(false);
  });

  it("falls back to the global setting when the bot has none", () => {
    expect(usesFiles("mcp", "claude", undefined)).toBe(false);
    expect(usesFiles("files", "claude", undefined)).toBe(true);
    expect(usesFiles("mcp", "devin", undefined)).toBe(false);
  });

  it("keeps the old behaviour for a global value that was never chosen (automatic or unset)", () => {
    expect(usesFiles(undefined, "devin", undefined)).toBe(true);
    expect(usesFiles("auto", "antigravity", undefined)).toBe(true);
    expect(usesFiles("auto", "claude", undefined)).toBe(false);
    expect(usesFiles(undefined, "claude", "files")).toBe(true);
  });

  it("is an optional field of a bot, files or mcp only", () => {
    const bot = makeBot();
    expect(BotSchema.parse(bot).toolMode).toBeUndefined();
    expect(BotSchema.parse({ ...bot, toolMode: "files" }).toolMode).toBe("files");
    expect(() => BotSchema.parse({ ...bot, toolMode: "auto" })).toThrow();
  });
});

describe("settings saved with the automatic choice", () => {
  const migrate = (values: unknown, from = 3) => botSettings.migrate!(values as never, from) as BotSettingsValues;

  it("become MCP for everyone, with the files override written on the Devin and Antigravity bots", () => {
    const next = migrate({ bots: [makeBot({ id: "c" }), makeBot({ id: "d", provider: "devin" }), makeBot({ id: "a", provider: "antigravity" }), makeBot({ id: "dw", provider: "devin-work" })], history: [], toolMode: "auto" });
    expect(next.toolMode).toBe("mcp");
    expect(next.bots.map((bot) => bot.toolMode)).toEqual([undefined, "files", "files", "files"]);
  });

  it("treat an unset choice the same way", () => {
    const next = migrate({ bots: [makeBot({ id: "d", provider: "devin" })], history: [] });
    expect(next.toolMode).toBe("mcp");
    expect(next.bots[0]!.toolMode).toBe("files");
  });

  it("leave a choice somebody made alone, and a bot's own override", () => {
    const forced = migrate({ bots: [makeBot({ id: "d", provider: "devin" })], history: [], toolMode: "files" });
    expect(forced.toolMode).toBe("files");
    expect(forced.bots[0]!.toolMode).toBeUndefined();
    const mcp = migrate({ bots: [makeBot({ id: "d", provider: "devin" })], history: [], toolMode: "mcp" });
    expect(mcp.toolMode).toBe("mcp");
    expect(mcp.bots[0]!.toolMode).toBeUndefined();
    const own = migrate({ bots: [makeBot({ id: "d", provider: "devin", toolMode: "mcp" })], history: [] });
    expect(own.bots[0]!.toolMode).toBe("mcp");
  });

  it("do not change a document that is already current", () => {
    const next = migrate({ bots: [makeBot({ id: "d", provider: "devin" })], history: [], toolMode: "mcp" }, 4);
    expect(next.bots[0]!.toolMode).toBeUndefined();
  });
});

describe("a bot that is set up for a provider that cannot use MCP starts with the files override", () => {
  it("when it is created, from a role or from a preset", () => {
    expect(newBot("devin").toolMode).toBe("files");
    expect(newBot("antigravity").toolMode).toBe("files");
    expect(newBot("claude").toolMode).toBeUndefined();
    const preset = { id: "p", name: "P", title: "", description: "", soul: "", playbooks: [], skillIds: [], createdAt: NOW } as never;
    expect(botFromPreset("devin", preset).toolMode).toBe("files");
  });

  it("when the settings' default provider is the one", () => {
    expect(applyDefaults(newBot("claude"), { ...base, provider: "devin" } as never, "claude").toolMode).toBe("files");
    expect(applyDefaults(newBot("claude"), defaults, "devin").toolMode).toBe("files");
    expect(applyDefaults(newBot("claude"), defaults, "claude").toolMode).toBeUndefined();
  });

  it("when an imported bot with no provider gets the default one", () => {
    const [entry] = withDefaultProvider([{ bot: { provider: "" } as { provider: string; toolMode?: "files" | "mcp" } }], "devin");
    expect(entry!.bot.toolMode).toBe("files");
  });

  it("but never over a choice the bot already has", () => {
    expect(applyDefaults({ ...newBot("claude"), toolMode: "mcp" }, defaults, "devin").toolMode).toBe("mcp");
  });
});

describe("a change that names a provider", () => {
  const context: ApplyContext = { now: NOW, provider: "claude", providers: null };
  const values = (): BotSettingsValues => ({ bots: [makeBot({ id: "solo", name: "Solo" })], history: [], toolMode: "mcp" } as never);
  const apply = (changes: unknown[], start = values()) => applyChanges(start, ChangesSchema.parse(changes), context);

  it("seeds the files override when a bot is switched to such a provider", () => {
    expect(apply([{ type: "update_bot", bot: "Solo", provider: "devin" }]).bots[0]!.toolMode).toBe("files");
  });

  it("leaves an override the bot has", () => {
    const start = values();
    start.bots[0] = makeBot({ id: "solo", name: "Solo", toolMode: "mcp" });
    expect(apply([{ type: "update_bot", bot: "Solo", provider: "devin" }], start).bots[0]!.toolMode).toBe("mcp");
  });

  it("seeds it on a new bot created on such a provider", () => {
    const next = apply([{ type: "create_bot", name: "Dev", provider: "devin" }]);
    expect(next.bots.find((bot) => bot.name === "Dev")!.toolMode).toBe("files");
  });

  it("does not seed a bot on another provider", () => {
    expect(apply([{ type: "update_bot", bot: "Solo", provider: "codex" }]).bots[0]!.toolMode).toBeUndefined();
  });
});
