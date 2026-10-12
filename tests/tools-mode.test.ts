import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { botSettings, EMPTY_LIBRARY, promptSections, type PromptContext } from "../shared/bot";
import { botFilesPrompt } from "../shared/bot-tools";
import { usesFiles } from "../shared/tools-mode";
import { makeBot } from "./helpers";

describe("when a bot's tools are files instead of an MCP server", () => {
  it("is Devin in automatic mode, and whatever the setting says otherwise", () => {
    expect(usesFiles(undefined, "devin")).toBe(true);
    expect(usesFiles("auto", "devin")).toBe(true);
    expect(usesFiles("auto", "claude")).toBe(false);
    expect(usesFiles("files", "claude")).toBe(true);
    expect(usesFiles("mcp", "devin")).toBe(false);
  });

  it("is an optional setting, so settings saved before it stay valid", () => {
    expect(botSettings.schema.parse({ bots: [] }).toolMode).toBeUndefined();
    expect(botSettings.schema.parse({ bots: [], toolMode: "files" }).toolMode).toBe("files");
    expect(() => botSettings.schema.parse({ bots: [], toolMode: "both" })).toThrow();
  });
});

function context(patch: Partial<PromptContext> = {}): PromptContext {
  return { memory: "", memoryPath: null, recentWork: [], playbooks: [], skills: [], paseoTools: false, botTools: false, ...patch };
}
const botToolsText = (ctx: PromptContext) => promptSections(makeBot(), ctx).find((section) => section.title === "Bot tools")?.text;

describe("the Bot tools part of the prompt", () => {
  it("talks about the MCP server when the bot has it", () => {
    expect(botToolsText(context({ botTools: true }))).toContain('MCP server "bots"');
  });
  it("talks about files, and not the MCP server, when the tools are files", () => {
    const text = botToolsText(context({ botFiles: { home: "/data/bot-1" } }))!;
    expect(text).toContain("/data/bot-1");
    expect(text).not.toContain("MCP");
  });
  it("has no part at all for a bot with neither", () => {
    expect(botToolsText(context())).toBeUndefined();
  });
});

describe("the prompt context of a bot", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-mode-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("marks a Devin bot's tools as files, and a Claude bot's as the MCP server", async () => {
    const { promptContext } = await import("../server/prompt");
    const devin = await promptContext(makeBot({ id: "d1", provider: "devin" }), true, EMPTY_LIBRARY, false, {});
    expect(devin.botTools).toBe(false);
    expect(devin.botFiles?.home).toContain("d1");
    const claude = await promptContext(makeBot({ id: "c1", provider: "claude" }), true, EMPTY_LIBRARY, false, {});
    expect(claude.botTools).toBe(true);
    expect(claude.botFiles ?? null).toBeNull();
    const forced = await promptContext(makeBot({ id: "c2", provider: "claude" }), true, EMPTY_LIBRARY, false, { toolMode: "files" });
    expect(forced.botTools).toBe(false);
    expect(forced.botFiles?.home).toContain("c2");
  });
});

describe("the files prompt", () => {
  const text = botFilesPrompt({ contactBots: "ask" }, "/data/bots/scout");
  it("names the folders with their full paths", () => {
    for (const part of ["/data/bots/scout/setup/overview.md", "/data/bots/scout/setup/proposal-format.md", "/data/bots/scout/proposals/", "/data/bots/scout/history/"]) expect(text).toContain(part);
  });
  it("shows the three proposal shapes", () => {
    for (const kind of ['"kind":"changes"', '"kind":"routine"', '"kind":"skill"']) expect(text).toContain(kind);
  });
  it("asks for a unique file name and for the file to be written last, and says not to apply anything", () => {
    expect(text).toMatch(/unique/i);
    expect(text).toContain("last step");
    expect(text).toContain("done/");
    expect(text).toMatch(/do not apply/i);
  });
  it("does not mention an MCP server or tool calls", () => {
    expect(text).not.toMatch(/MCP|tool server|tool call/i);
  });

  it("tells a bot that may contact others how to ask one, and leaves it out for one that may not", () => {
    const asks = botFilesPrompt({ contactBots: "ask" }, "/data/bots/scout");
    expect(asks).toContain("/data/bots/scout/outbox/");
    expect(asks).toContain('"kind":"ask"');
    expect(asks).toContain("end your turn");
    expect(asks).toMatch(/user (is asked|decides)/i);
    const allowed = botFilesPrompt({ contactBots: "allow" }, "/data/bots/scout");
    expect(allowed).toContain("/data/bots/scout/outbox/");
    expect(allowed).not.toMatch(/user (is asked|decides)/i);
    const off = botFilesPrompt({ contactBots: "off" }, "/data/bots/scout");
    expect(off).not.toContain("outbox");
  });
});
