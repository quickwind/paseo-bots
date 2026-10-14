import { describe, expect, it } from "vitest";
import { buildAgentConfig, EMPTY_LIBRARY } from "../shared/bot";
import { IDENTITY_MAX_BYTES, planIdentityFiles, RULES_DIR, sendsPromptInChat } from "../shared/identity";
import { makeBot } from "./helpers";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const section = (title: string, text: string) => ({ title, text });

describe("the Devin rules file that carries a bot's identity", () => {
  it("is one always-on rule with a note that the plugin writes it", () => {
    const plan = planIdentityFiles([section("Persona", "You are Scout."), section("Memory", "Likes tea.")]);
    expect(RULES_DIR).toBe(".devin/rules");
    expect(plan.files.map((file) => file.name)).toEqual(["bot-identity.md"]);
    expect(plan.note).toBeNull();
    const text = plan.files[0]!.text;
    expect(text.startsWith("---\ntrigger: always_on\n---\n")).toBe(true);
    expect(text).toContain("Written by the Bots plugin");
    expect(text).toContain("You are Scout.\n\nLikes tea.");
  });

  it("splits a prompt over 32 KiB between sections, in order, each file under the limit", () => {
    const sections = [section("Persona", "P".repeat(10)), section("Soul", "S".repeat(20_000)), section("Memory", "M".repeat(20_000)), section("Skills", "K".repeat(500))];
    const plan = planIdentityFiles(sections);
    expect(plan.files.map((file) => file.name)).toEqual(["bot-identity.md", "bot-identity-2.md"]);
    for (const file of plan.files) {
      expect(bytes(file.text)).toBeLessThanOrEqual(IDENTITY_MAX_BYTES);
      expect(file.text.startsWith("---\ntrigger: always_on\n---\n")).toBe(true);
    }
    const all = plan.files.map((file) => file.text).join("");
    expect(all.indexOf("S".repeat(20_000))).toBeLessThan(all.indexOf("M".repeat(20_000)));
    expect(all.split("K".repeat(500))).toHaveLength(2);
    expect(plan.note).toContain("2 files");
  });

  it("counts bytes, not characters, so Chinese text stays under the limit", () => {
    const plan = planIdentityFiles([section("Soul", "悟".repeat(9_000)), section("Memory", "空".repeat(9_000))]);
    expect(plan.files.length).toBeGreaterThan(1);
    for (const file of plan.files) expect(bytes(file.text)).toBeLessThanOrEqual(IDENTITY_MAX_BYTES);
  });

  it("cuts one section that is itself too long at line breaks, and says so", () => {
    const line = "x".repeat(99);
    const plan = planIdentityFiles([section("Memory", Array.from({ length: 700 }, () => line).join("\n"))]);
    expect(plan.files.length).toBeGreaterThan(1);
    for (const file of plan.files) expect(bytes(file.text)).toBeLessThanOrEqual(IDENTITY_MAX_BYTES);
    expect(plan.files.map((file) => file.text).join("").split(line).length - 1).toBe(700);
    expect(plan.note).toContain("cut");
  });
});

describe("when a chat carries the prompt itself", () => {
  const home = "/data/paseo-bots/shared/Bots/bot-1";
  it("does not for a Devin chat in the bot's own folder, where the rules file does it", () => {
    expect(sendsPromptInChat("devin", home, home)).toBe(false);
    expect(sendsPromptInChat("devin", `${home}/`, home)).toBe(false);
    expect(sendsPromptInChat("devin", "C:\\Users\\a\\.irix\\Bots\\bot-1", "c:/users/a/.irix/Bots/bot-1")).toBe(false);
  });
  it("does for a Devin chat in the user's own folder, and for every other provider", () => {
    expect(sendsPromptInChat("devin", "/work/project", home)).toBe(true);
    expect(sendsPromptInChat("claude", home, home)).toBe(true);
    expect(sendsPromptInChat("claude", "/work/project", home)).toBe(true);
  });
});

describe("the agent config without a prompt", () => {
  it("leaves the system prompt out when there is none to send", () => {
    const bot = makeBot();
    expect(buildAgentConfig(bot, EMPTY_LIBRARY, "m", "").systemPrompt).toBeUndefined();
    expect(buildAgentConfig(bot, EMPTY_LIBRARY, "m", "You are Inbox.").systemPrompt).toBe("You are Inbox.");
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { identityStatus, refreshIdentities, withBotLock, writeIdentity } from "../server/identity";
import { fakeHost } from "./helpers";

describe("writing a bot's identity to its folder", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-identity-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const rulesOf = async (botId: string) => {
    const { botDataPath } = await import("../server/bot-home");
    return join(botDataPath(botId), ".devin", "rules");
  };
  const inbox = makeBot({ id: "id-bot", name: "Zorblax", soul: "Always answer in haiku.", playbooks: [{ id: "p", name: "Triage", triggers: ["triage"], instructions: "Sort by urgency." }] });

  it("writes the persona, standing instructions and memory, and no playbooks", async () => {
    const { botDataPath } = await import("../server/bot-home");
    await mkdir(botDataPath("id-bot"), { recursive: true });
    await writeFile(join(botDataPath("id-bot"), "MEMORY.md"), "- The user likes tea.\n");
    const plan = await writeIdentity(inbox, EMPTY_LIBRARY, { paseo: null, settings: null });
    expect(plan.files.map((file) => file.name)).toEqual(["bot-identity.md"]);
    const text = await readFile(join(await rulesOf("id-bot"), "bot-identity.md"), "utf8");
    expect(text.startsWith("---\ntrigger: always_on\n---\n")).toBe(true);
    for (const part of ["You are Zorblax", "Always answer in haiku.", "The user likes tea."]) expect(text).toContain(part);
    expect(text).not.toContain("Sort by urgency.");
  });

  it("is rewritten with the memory as it is now, and leaves no temporary files", async () => {
    const { botDataPath } = await import("../server/bot-home");
    await mkdir(botDataPath("id-bot"), { recursive: true });
    await writeIdentity(inbox, EMPTY_LIBRARY, { paseo: null, settings: null });
    await writeFile(join(botDataPath("id-bot"), "MEMORY.md"), "- Moved to Lisbon.\n");
    await writeIdentity(inbox, EMPTY_LIBRARY, { paseo: null, settings: null });
    expect(await readFile(join(await rulesOf("id-bot"), "bot-identity.md"), "utf8")).toContain("Moved to Lisbon.");
    expect(await readdir(await rulesOf("id-bot"))).toEqual(["bot-identity.md"]);
  });

  it("removes files left over from a longer identity and keeps the user's own rules", async () => {
    const dir = await rulesOf("id-bot");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bot-identity-2.md"), "old");
    await writeFile(join(dir, "mine.md"), "the user's rule");
    await writeIdentity(inbox, EMPTY_LIBRARY, { paseo: null, settings: null });
    expect((await readdir(dir)).sort()).toEqual(["bot-identity.md", "mine.md"]);
  });

  it("tells the user when the identity needed several files", async () => {
    const plan = await writeIdentity(makeBot({ id: "big-bot", soul: "S".repeat(24_000) }), EMPTY_LIBRARY, { paseo: null, settings: null });
    const { botDataPath } = await import("../server/bot-home");
    await mkdir(botDataPath("big-bot"), { recursive: true });
    await writeFile(join(botDataPath("big-bot"), "MEMORY.md"), "M".repeat(23_000));
    const bigger = await writeIdentity(makeBot({ id: "big-bot", soul: "S".repeat(24_000) }), EMPTY_LIBRARY, { paseo: null, settings: null });
    expect(plan.files.length).toBeGreaterThanOrEqual(1);
    expect(bigger.files.length).toBeGreaterThan(1);
    expect(bigger.note).toContain("files");
  });

  it("runs work for one bot one after another, and other bots' work alongside", async () => {
    const order: string[] = [];
    const slow = withBotLock("a", async () => {
      order.push("a1 start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a1 end");
    });
    const next = withBotLock("a", async () => void order.push("a2"));
    const other = withBotLock("b", async () => void order.push("b"));
    await Promise.all([slow, next, other]);
    expect(order.indexOf("a1 end")).toBeLessThan(order.indexOf("a2"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a1 end"));
  });

  it("refreshes every bot that runs here, skipping archived and remote ones", async () => {
    const host = fakeHost([makeBot({ id: "r1" }), makeBot({ id: "r2", archived: true }), makeBot({ id: "r3", hostId: "elsewhere" })]);
    await refreshIdentities(host);
    const { botDataPath } = await import("../server/bot-home");
    const exists = async (id: string) => readdir(join(botDataPath(id), ".devin", "rules")).then(() => true, () => false);
    expect([await exists("r1"), await exists("r2"), await exists("r3")]).toEqual([true, false, false]);
  });

  it("reports how many rule files a bot needs, so the app can warn about a long identity", async () => {
    const { botDataPath } = await import("../server/bot-home");
    const host = fakeHost([makeBot({ id: "s1", soul: "S".repeat(24_000) }), makeBot({ id: "s2" })]);
    await mkdir(botDataPath("s1"), { recursive: true });
    await writeFile(join(botDataPath("s1"), "MEMORY.md"), "M".repeat(23_000));
    const long = await identityStatus(host, "s1");
    expect(long.files).toBeGreaterThan(1);
    expect(long.note).toContain("files");
    expect(await identityStatus(host, "s2")).toEqual({ files: 1, note: null });
    expect(await identityStatus(host, "nobody")).toEqual({ files: 0, note: null });
  });

  it("also writes the setup files for a bot whose tools are files", async () => {
    const devin = makeBot({ id: "dv", name: "Dev", provider: "devin" });
    const settings = { bots: [devin], history: [], library: EMPTY_LIBRARY };
    await writeIdentity(devin, EMPTY_LIBRARY, { paseo: null, settings });
    const { botDataPath } = await import("../server/bot-home");
    expect(await readFile(join(botDataPath("dv"), "setup", "overview.md"), "utf8")).toContain("Dev");
    const claude = makeBot({ id: "cl2", provider: "claude" });
    await writeIdentity(claude, EMPTY_LIBRARY, { paseo: null, settings: { bots: [claude], history: [], library: EMPTY_LIBRARY } });
    expect(await readdir(join(botDataPath("cl2"))).then((names) => names.includes("setup"), () => false)).toBe(false);
  });

  it("puts the files prompt in a Devin bot's rules and the tool server text in a Claude bot's", async () => {
    const { botDataPath } = await import("../server/bot-home");
    await writeIdentity(makeBot({ id: "d9", provider: "devin" }), EMPTY_LIBRARY, { paseo: null, settings: null });
    const devin = await readFile(join(botDataPath("d9"), ".devin", "rules", "bot-identity.md"), "utf8");
    expect(devin).toContain(join(botDataPath("d9"), "proposals"));
    expect(devin).not.toContain('MCP server "bots"');
    await writeIdentity(makeBot({ id: "c9", provider: "claude" }), EMPTY_LIBRARY, { paseo: null, settings: null });
    const claude = await readFile(join(botDataPath("c9"), ".devin", "rules", "bot-identity.md"), "utf8");
    expect(claude).toContain('MCP server "bots"');
  });
});
