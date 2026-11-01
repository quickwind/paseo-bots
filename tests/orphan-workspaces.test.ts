import { describe, expect, it } from "vitest";
import { orphanedBotWorkspaces } from "../shared/chat";

const ROOT = "/home/me/.paseo/plugin-data/aydo/shared/Bots";
const entry = (dir: string, root = ROOT) => ({ projectId: "p", projectRootPath: root, workspaceDirectory: dir, title: dir });

describe("orphanedBotWorkspaces", () => {
  it("finds the workspaces of bots that no longer exist", () => {
    const entries = [entry(`${ROOT}/a`), entry(`${ROOT}/gone`), entry(`${ROOT}/b/`)];
    expect(orphanedBotWorkspaces(entries, new Set(["a"])).map((workspace) => workspace.workspaceDirectory)).toEqual([`${ROOT}/gone`, `${ROOT}/b/`]);
  });

  it("leaves the project folder itself, other projects and nested folders alone", () => {
    const entries = [entry(ROOT), entry("/work/app", "/work/app"), entry(`${ROOT}/a/sub`), entry("/work/other/gone", "/work/other")];
    expect(orphanedBotWorkspaces(entries, new Set())).toEqual([]);
  });

  it("reads Windows paths", () => {
    const root = "C:\\Users\\me\\.paseo\\plugin-data\\aydo\\shared\\Bots";
    expect(orphanedBotWorkspaces([entry(`${root}\\gone`, root)], new Set())).toHaveLength(1);
  });
});

describe("botIdOfDirectory", () => {
  it("names the bot a folder belongs to", async () => {
    const { botIdOfDirectory } = await import("../shared/chat");
    expect(botIdOfDirectory(`${ROOT}/abc`)).toBe("abc");
    expect(botIdOfDirectory(`${ROOT}/abc/`)).toBe("abc");
    expect(botIdOfDirectory("C:\\Users\\me\\.paseo\\plugin-data\\aydo\\shared\\Bots\\abc")).toBe("abc");
    expect(botIdOfDirectory(ROOT)).toBeNull();
    expect(botIdOfDirectory(`${ROOT}/abc/sub`)).toBeNull();
    expect(botIdOfDirectory("/work/app")).toBeNull();
    expect(botIdOfDirectory(undefined)).toBeNull();
  });
});

describe("the Aydo folder and the older Bots folder", () => {
  const NEW = "/home/me/.paseo/plugin-data/aydo/shared/Aydo";
  it("knows both as the plugin's project and reads the assistant's id under either", async () => {
    const { botIdOfDirectory, isBotsProjectRoot } = await import("../shared/chat");
    expect(isBotsProjectRoot(NEW)).toBe(true);
    expect(isBotsProjectRoot(ROOT)).toBe(true);
    expect(isBotsProjectRoot("/work/Aydo")).toBe(false);
    expect(botIdOfDirectory(`${NEW}/abc`)).toBe("abc");
    expect(botIdOfDirectory(`${ROOT}/abc`)).toBe("abc");
  });

  it("finds the orphans of both", () => {
    const entries = [entry(`${NEW}/gone`, NEW), entry(`${ROOT}/gone`, ROOT)];
    expect(orphanedBotWorkspaces(entries, new Set())).toHaveLength(2);
  });
});

describe("a workspace made under the older Bots folder is still the assistant's", () => {
  it("is found at the new path, so it gets renamed and no second one is made", async () => {
    const { syncBotWorkspaceTitle } = await import("../shared/chat");
    const titles: string[] = [];
    const api = {
      workspaces: {
        list: async () => ({ entries: [entry("/d/plugin-data/aydo/shared/Bots/b1", "/d/plugin-data/aydo/shared/Bots")] }),
        ref: () => ({ setTitle: async (title: string) => void titles.push(title) }),
      },
    };
    await syncBotWorkspaceTitle(api as never, { id: "b1", name: "Scout" } as never, { path: "/d/plugin-data/aydo/shared/Aydo/b1", projectRoot: "/d/plugin-data/aydo/shared/Aydo" } as never);
    expect(titles).toEqual(["Scout"]);
  });
});
