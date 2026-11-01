import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("the remembered projects", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-grants-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });
  const grants = () => import("../server/project-grants");
  const app = { id: "proj-1", name: "app" };

  it("allows a project for one scope only", async () => {
    const { allowProject, projectAllowed } = await grants();
    await allowProject("team:t1", app);
    expect(await projectAllowed("team:t1", "proj-1")).toBe(true);
    expect(await projectAllowed("team:t2", "proj-1")).toBe(false);
    expect(await projectAllowed("bot:b1", "proj-1")).toBe(false);
    expect(await projectAllowed("team:t1", "proj-2")).toBe(false);
  });

  it("keeps one grant when a project is allowed twice, and lists it with its name", async () => {
    const { allowProject, listGrants } = await grants();
    await allowProject("team:t1", app);
    await allowProject("team:t1", { id: "proj-1", name: "app renamed" });
    const list = await listGrants("team:t1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ projectId: "proj-1", projectName: "app renamed" });
    expect(typeof list[0]!.grantedAt).toBe("string");
  });

  it("revokes once", async () => {
    const { allowProject, revokeProject, projectAllowed } = await grants();
    await allowProject("team:t1", app);
    expect(await revokeProject("team:t1", "proj-1")).toBe(true);
    expect(await revokeProject("team:t1", "proj-1")).toBe(false);
    expect(await projectAllowed("team:t1", "proj-1")).toBe(false);
  });

  it("reads a corrupt file as no grants and recovers on the next write", async () => {
    const { allowProject, listGrants, projectAllowed } = await grants();
    await allowProject("team:t1", app);
    const file = join(home, "plugin-data", "aydo", "project-grants.json");
    await writeFile(file, "{not json");
    expect(await listGrants("team:t1")).toEqual([]);
    expect(await projectAllowed("team:t1", "proj-1")).toBe(false);
    await allowProject("team:t1", app);
    expect(JSON.parse(await readFile(file, "utf8")).grants).toHaveLength(1);
  });

  it("refuses the 201st project of a scope", async () => {
    const { allowProject } = await grants();
    for (let i = 0; i < 200; i++) await allowProject("team:t1", { id: `p${i}`, name: `p${i}` });
    await expect(allowProject("team:t1", { id: "p200", name: "p200" })).rejects.toThrow("at most 200 projects");
    await allowProject("team:t2", { id: "p200", name: "p200" });
  });
});
