import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Windows will not replace a file that someone has open (a reader of the store, a virus scanner): rename says EPERM
// for a moment. The write has to wait it out instead of failing.
const failures = { left: 0, code: "EPERM" };
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (failures.left > 0) {
        failures.left--;
        throw Object.assign(new Error(`${failures.code}: operation not permitted, rename`), { code: failures.code });
      }
      return real.rename(from, to);
    },
  };
});

describe("writeAtomic", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "aydo-atomic-"));
  });
  afterEach(async () => {
    failures.left = 0;
    await rm(dir, { recursive: true, force: true });
  });

  it("tries again while the file is held open by someone else", async () => {
    const { writeAtomic } = await import("../server/managed-files");
    failures.left = 4;
    await writeAtomic(join(dir, "store.json"), "{}");
    expect(await readFile(join(dir, "store.json"), "utf8")).toBe("{}");
    expect(await readdir(dir)).toEqual(["store.json"]);
  });

  it("keeps a file private when asked for a mode", async () => {
    const { writeAtomic } = await import("../server/managed-files");
    await writeAtomic(join(dir, "secret.json"), "{}", 0o600);
    // Windows has no such mode bits.
    if (process.platform !== "win32") expect((await stat(join(dir, "secret.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, "secret.json"), "utf8")).toBe("{}");
  });

  it("gives up with the error, and leaves no temporary file, when the file stays held", async () => {
    const { writeAtomic } = await import("../server/managed-files");
    failures.left = 1000;
    await expect(writeAtomic(join(dir, "store.json"), "{}")).rejects.toThrow(/EPERM/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not hide other errors by retrying them", async () => {
    const { writeAtomic } = await import("../server/managed-files");
    failures.left = 1;
    failures.code = "ENOSPC";
    await expect(writeAtomic(join(dir, "store.json"), "{}")).rejects.toThrow(/ENOSPC/);
    failures.code = "EPERM";
  });
});
