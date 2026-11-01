import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("the shared folder is named Aydo", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-home-"));
    process.env.PASEO_HOME = home;
    vi.resetModules();
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("starts a new install in shared/Aydo", async () => {
    const { ensureBotsHome, botsHomePath } = await import("../server/bot-home");
    await ensureBotsHome();
    expect(botsHomePath()).toBe(join(home, "plugin-data", "aydo", "shared", "Aydo"));
    expect((await lstat(botsHomePath())).isDirectory()).toBe(true);
    expect(await lstat(join(home, "plugin-data", "aydo", "shared", "Bots")).catch(() => null)).toBeNull();
  });

  it("moves an older Bots folder, keeps what is in it, and leaves a link under the old name", async () => {
    const old = join(home, "plugin-data", "aydo", "shared", "Bots");
    await mkdir(join(old, "bot-1"), { recursive: true });
    await writeFile(join(old, "bot-1", "MEMORY.md"), "remember");
    const { ensureBotsHome, botsHomePath } = await import("../server/bot-home");
    await ensureBotsHome();
    expect(await readFile(join(botsHomePath(), "bot-1", "MEMORY.md"), "utf8")).toBe("remember");
    expect((await lstat(old)).isSymbolicLink()).toBe(true);
    expect(await readlink(old)).toBe(botsHomePath());
    expect(await readFile(join(old, "bot-1", "MEMORY.md"), "utf8")).toBe("remember");
  });
});
