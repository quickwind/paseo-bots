import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_APPROVAL_FILE_BYTES } from "../shared/approvals";
import { readApprovalFile } from "../server/approvals-file";

describe("readApprovalFile", () => {
  let root: string;
  let bot: string;
  let work: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aydo-afile-"));
    [bot, work, outside] = [join(root, "bot"), join(root, "work"), join(root, "outside")];
    for (const dir of [bot, work, outside]) await mkdir(dir, { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("reads a markdown file in an allowed folder with its checksum and size", async () => {
    await writeFile(join(work, "plan.md"), "# Plan\nUse Postgres.\n");
    const result = await readApprovalFile({ path: join(work, "plan.md"), allowed: [bot, work] });
    expect(result).toEqual({ ok: true, file: { path: join(work, "plan.md"), text: "# Plan\nUse Postgres.\n", sha256: createHash("sha256").update("# Plan\nUse Postgres.\n").digest("hex"), bytes: 21 } });
  });

  it("resolves a relative path against the first allowed folder", async () => {
    await writeFile(join(bot, "plan.md"), "x");
    const result = await readApprovalFile({ path: "plan.md", allowed: [bot, work] });
    expect(result.ok && result.file.path).toBe(join(bot, "plan.md"));
  });

  it("refuses a path outside every allowed folder", async () => {
    await writeFile(join(outside, "plan.md"), "x");
    const result = await readApprovalFile({ path: join(outside, "plan.md"), allowed: [bot, work] });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toMatch(/outside/);
  });

  it("refuses a path that climbs out with ..", async () => {
    await writeFile(join(outside, "plan.md"), "x");
    const result = await readApprovalFile({ path: join(work, "..", "outside", "plan.md"), allowed: [work] });
    expect(!result.ok && result.reason).toMatch(/outside/);
  });

  it("refuses a link to a file", async () => {
    await writeFile(join(work, "real.md"), "x");
    await symlink(join(work, "real.md"), join(work, "link.md"));
    const result = await readApprovalFile({ path: join(work, "link.md"), allowed: [work] });
    expect(!result.ok && result.reason).toMatch(/link/);
  });

  it("refuses a path through a linked folder", async () => {
    await writeFile(join(outside, "plan.md"), "x");
    await symlink(outside, join(work, "dir"));
    const result = await readApprovalFile({ path: join(work, "dir", "plan.md"), allowed: [work] });
    expect(!result.ok && result.reason).toMatch(/link/);
  });

  it("refuses a file over the size limit and says its size", async () => {
    await writeFile(join(work, "big.md"), "a".repeat(MAX_APPROVAL_FILE_BYTES + 1));
    const result = await readApprovalFile({ path: join(work, "big.md"), allowed: [work] });
    expect(!result.ok && result.reason).toMatch(/200 KB|too big/);
    expect(!result.ok && result.reason).toContain(String(MAX_APPROVAL_FILE_BYTES + 1));
  });

  it("refuses a file with a NUL byte or invalid UTF-8", async () => {
    await writeFile(join(work, "nul.md"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(work, "bad.md"), Buffer.from([0xff, 0xfe, 0x41]));
    for (const name of ["nul.md", "bad.md"]) {
      const result = await readApprovalFile({ path: join(work, name), allowed: [work] });
      expect(!result.ok && result.reason).toMatch(/not text/);
    }
  });

  it("refuses a missing file and a folder", async () => {
    expect((await readApprovalFile({ path: join(work, "nope.md"), allowed: [work] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/not found/) });
    await mkdir(join(work, "d"));
    expect((await readApprovalFile({ path: join(work, "d"), allowed: [work] }))).toMatchObject({ ok: false });
  });
});
