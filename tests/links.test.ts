import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY } from "../shared/bot";
import { makeBot } from "./helpers";

// A bot has a shell, so it can replace a folder or file in its own folder with a link to somewhere else.
// The plugin must never write through, delete from, or read out of such a link.

let home: string;
let outside: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "paseo-bots-links-"));
  outside = await mkdtemp(join(tmpdir(), "paseo-bots-outside-"));
  process.env.PASEO_HOME = home;
});
afterEach(async () => {
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** "junction" lets Windows link folders without admin rights; other systems ignore it. */
const linkFolder = (target: string, path: string) => symlink(target, path, "junction");
/** A file link can need a privilege on Windows; where it cannot be made the test is skipped, but never silently on CI. */
async function linkFile(target: string, path: string): Promise<boolean> {
  const made = await symlink(target, path).then(() => true, () => false);
  if (!made && process.env.CI) throw new Error("CI could not create a file link, so this test would prove nothing");
  return made;
}
const isLink = async (path: string) => (await lstat(path)).isSymbolicLink();

async function botFolder(botId: string): Promise<string> {
  const { ensureBotHome } = await import("../server/bot-home");
  return (await ensureBotHome({ botId })).path;
}

describe("folders the plugin writes in a bot's folder", () => {
  it("syncManaged does not write through a link at a subfolder", async () => {
    const { syncManaged } = await import("../server/managed-files");
    const dir = join(await botFolder("scout"), "setup");
    await mkdir(dir, { recursive: true });
    await linkFolder(outside, join(dir, "bots"));
    await syncManaged(dir, [{ path: "bots/scout.md", text: "hello" }]);
    expect(await readdir(outside)).toEqual([]);
    expect(await isLink(join(dir, "bots"))).toBe(false);
    expect(await readFile(join(dir, "bots", "scout.md"), "utf8")).toBe("hello");
  });

  it("the identity is not written through a linked .devin folder", async () => {
    const { writeIdentity } = await import("../server/identity");
    const folder = await botFolder("scout");
    await linkFolder(outside, join(folder, ".devin"));
    await writeIdentity(makeBot({ id: "scout" }), EMPTY_LIBRARY, { paseo: null, settings: null });
    expect(await readdir(outside)).toEqual([]);
    expect(await isLink(join(folder, ".devin"))).toBe(false);
    expect(await readdir(join(folder, ".devin", "rules"))).toContain("bot-identity.md");
  });

  it("the daily log is not appended through a linked memory/log folder", async () => {
    const { appendDailyLog } = await import("../server/memory");
    const folder = await botFolder("scout");
    await mkdir(join(folder, "memory"), { recursive: true });
    await linkFolder(outside, join(folder, "memory", "log"));
    await appendDailyLog("scout", "- 09:00 · a line");
    expect(await readdir(outside)).toEqual([]);
    expect((await readdir(join(folder, "memory", "log"))).length).toBe(1);
  });

  it("an edit made in the app is not written through a linked memory folder", async () => {
    const { MemoryJournal } = await import("../server/journal");
    const folder = await botFolder("scout");
    await linkFolder(outside, join(folder, "memory"));
    await new MemoryJournal().write("scout", "notes.md", "text");
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(join(folder, "memory", "notes.md"), "utf8")).toBe("text");
  });

  it("linking skills does not delete links from a folder the skills folder points at", async () => {
    const { linkBotSkills } = await import("../server/library");
    const folder = await botFolder("scout");
    await mkdir(join(outside, "keep-me"));
    await linkFolder(join(outside, "keep-me"), join(outside, "other"));
    await linkFolder(outside, join(folder, "skills"));
    await linkBotSkills("scout", []);
    expect(await isLink(join(outside, "other"))).toBe(true);
  });

  it("an upload is not saved through a linked uploads folder", async () => {
    const { saveUpload } = await import("../server/uploads");
    const folder = await botFolder("scout");
    await linkFolder(outside, join(folder, "uploads"));
    await saveUpload({ botId: "scout", fileName: "a.txt", dataBase64: Buffer.from("hi").toString("base64") });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("files behind a link", () => {
  it("an export leaves out a memory file that is a link", async () => {
    const { exportBot } = await import("../server/share");
    const folder = await botFolder("scout");
    await writeFile(join(outside, "secret.txt"), "TOP SECRET");
    await mkdir(join(folder, "memory"), { recursive: true });
    await writeFile(join(folder, "memory", "real.md"), "real notes");
    if (!(await linkFile(join(outside, "secret.txt"), join(folder, "memory", "notes.md")))) return;
    const { json } = await exportBot({ bot: makeBot({ id: "scout" }), includeMemory: true }, EMPTY_LIBRARY);
    expect(json).toContain("real notes");
    expect(json).not.toContain("TOP SECRET");
  });

  it("the project icon is replaced, not written through", async () => {
    const { ensureBotsHome, botsHomePath } = await import("../server/bot-home");
    await ensureBotsHome();
    const icon = join(botsHomePath(), "icon.svg");
    await writeFile(join(outside, "target.txt"), "mine");
    await rm(icon);
    if (!(await linkFile(join(outside, "target.txt"), icon))) return;
    await ensureBotsHome();
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("mine");
  });
});
