import { describe, expect, it } from "vitest";
import { EMPTY_LIBRARY } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import { ASK_PREAPPROVED_LABEL } from "../shared/groups";
import { makeBot } from "./helpers";

// Chats the person starts in the app and chats the server starts (routines, other bots) both go through startBotChat.

type Created = { labels: Record<string, string>; config: { options?: unknown }; title?: string };

function fakeApi(options: { listThrows?: boolean; refThrows?: boolean; directory?: string } = {}) {
  const created: Created[] = [];
  const refs: unknown[] = [];
  const directory = options.directory ?? "/bots/scout";
  const workspace = { projectId: "p", projectRootPath: directory, workspaceDirectory: directory, title: "Scout" };
  const handle = { agents: { create: async (input: Created) => (created.push(input), { id: "chat-1" }) } };
  const list = async () => {
    if (options.listThrows) throw new Error("list must not be called");
    return { entries: [workspace] };
  };
  const ref = (target: unknown) => {
    if (options.refThrows) throw new Error("no such workspace");
    refs.push(target);
    return handle;
  };
  const api = { workspaces: { list, ref } } as never;
  return { api, created, refs };
}

const tools = { type: "http" as const, url: "http://127.0.0.1:1/bots/b/a", headers: {} };
const start = (bot: ReturnType<typeof makeBot>, plugin: Parameters<typeof startBotChat>[1]["plugin"]) => {
  const { api, created } = fakeApi();
  return startBotChat(api, { bot, library: EMPTY_LIBRARY, plugin, placement: { path: "/bots/scout", projectRoot: null }, prompt: "hi", systemPrompt: "" }).then(() => created[0]!.labels);
};

describe("the label a chat gets when ask_bot runs without a prompt in it", () => {
  it("says why: the bot is set to Allow, or its team lets members ask freely", async () => {
    expect((await start(makeBot({ name: "Scout", model: "m", contactBots: "allow" }), { tools }))[ASK_PREAPPROVED_LABEL]).toBe("all");
    expect((await start(makeBot({ name: "Scout", model: "m", contactBots: "ask" }), { tools, askFreely: true }))[ASK_PREAPPROVED_LABEL]).toBe("team");
  });

  it("is left off when ask_bot still asks the user, or the bot has no plugin tools", async () => {
    expect(await start(makeBot({ name: "Scout", model: "m", contactBots: "ask" }), { tools })).not.toHaveProperty(ASK_PREAPPROVED_LABEL);
    expect(await start(makeBot({ name: "Scout", model: "m", contactBots: "off" }), { tools, askFreely: true })).not.toHaveProperty(ASK_PREAPPROVED_LABEL);
    expect(await start(makeBot({ name: "Scout", model: "m", contactBots: "allow" }), {})).not.toHaveProperty(ASK_PREAPPROVED_LABEL);
  });
});

describe("attaching the bot's own folder", () => {
  const home = "/bots/scout";
  const run = (patch: Partial<Parameters<typeof startBotChat>[1]> & { provider?: string; fake?: ReturnType<typeof fakeApi> }) => {
    const fake = patch.fake ?? fakeApi();
    const { provider, fake: _fake, ...input } = patch;
    return startBotChat(fake.api, { bot: makeBot({ name: "Scout", model: "m", provider: provider ?? "claude" }), library: EMPTY_LIBRARY, placement: { path: home, projectRoot: null }, prompt: "hi", systemPrompt: "", ...input }).then(() => fake);
  };

  it("adds nothing when the chat runs in the bot's own folder", async () => {
    expect((await run({ home })).created[0]!.config.options).toBeUndefined();
  });

  it("attaches it when the bot has a working folder of its own", async () => {
    const fake = await run({ home, placement: { path: "/work/app", projectRoot: null }, fake: fakeApi({ directory: "/work/app" }) });
    expect(fake.created[0]!.config.options).toEqual({ additionalDirectories: [home] });
  });

  it("starts in the given workspace without listing or creating workspaces, and attaches the folder", async () => {
    const fake = await run({ home, workspace: { id: "wks_1", path: "/work/app-login" }, fake: fakeApi({ listThrows: true }) });
    expect(fake.refs).toEqual(["wks_1"]);
    expect(fake.created[0]!.config.options).toEqual({ additionalDirectories: [home] });
    expect(fake.created[0]!.labels).toHaveProperty("aydo.bot");
  });

  it("treats the same folder as the same whatever the slashes and case", async () => {
    const fake = await run({ home: "C:\\Bots\\Scout", workspace: { id: "wks_1", path: "c:/bots/scout" } });
    expect(fake.created[0]!.config.options).toBeUndefined();
  });

  it("attaches nothing for Antigravity, and for Devin unless the host honours it", async () => {
    const workspace = { id: "wks_1", path: "/work/app" };
    expect((await run({ home, workspace, provider: "antigravity" })).created[0]!.config.options).toBeUndefined();
    expect((await run({ home, workspace, provider: "devin" })).created[0]!.config.options).toBeUndefined();
    expect((await run({ home, workspace, provider: "devin", hostCaps: { devinAdditionalDirectories: true } })).created[0]!.config.options).toEqual({ additionalDirectories: [home] });
  });

  it("attaches the team's report folder too, in a project workspace and in the bot's own folder", async () => {
    const reports = "/data/shared/Teams/t1/reports";
    const inWorkspace = await run({ home, extraFolders: [reports], workspace: { id: "wks_1", path: "/work/app-login" } });
    expect(inWorkspace.created[0]!.config.options).toEqual({ additionalDirectories: [home, reports] });
    const inOwnFolder = await run({ home, extraFolders: [reports] });
    expect(inOwnFolder.created[0]!.config.options).toEqual({ additionalDirectories: [reports] });
  });

  it("does not attach an extra folder that is the chat's own folder, and attaches none for Antigravity or Devin without the host's help", async () => {
    const reports = "/data/shared/Teams/t1/reports";
    expect((await run({ home, extraFolders: [home] })).created[0]!.config.options).toBeUndefined();
    const workspace = { id: "wks_1", path: "/work/app" };
    expect((await run({ home, extraFolders: [reports], workspace, provider: "antigravity" })).created[0]!.config.options).toBeUndefined();
    expect((await run({ home, extraFolders: [reports], workspace, provider: "devin" })).created[0]!.config.options).toBeUndefined();
    expect((await run({ home, extraFolders: [reports], workspace, provider: "devin", hostCaps: { devinAdditionalDirectories: true } })).created[0]!.config.options).toEqual({ additionalDirectories: [home, reports] });
  });

  it("creates no chat when the workspace is unknown, and the error reaches the caller", async () => {
    const fake = fakeApi({ refThrows: true });
    await expect(run({ home, workspace: { id: "gone", path: "/work/app" }, fake })).rejects.toThrow("no such workspace");
    expect(fake.created).toEqual([]);
  });
});

describe("the title of a chat started in a project's workspace", () => {
  const run = (patch: Partial<Parameters<typeof startBotChat>[1]>) => {
    const fake = fakeApi();
    return startBotChat(fake.api, { bot: makeBot({ name: "Scout", model: "m" }), library: EMPTY_LIBRARY, placement: { path: "/bots/scout", projectRoot: null }, prompt: "hi", systemPrompt: "", ...patch }).then(() => fake.created[0]!);
  };
  const workspace = { id: "wks_1", path: "/work/app" };

  it("starts with the assistant's name in brackets, so the host's workspace list shows whose chat it is", async () => {
    expect((await run({ workspace, prompt: "Fix the login bug" })).title).toBe("[Scout] Fix the login bug");
  });

  it("folds a long or multi-line first message into one short line", async () => {
    const title = (await run({ workspace, prompt: `Fix the login bug\n\n${"details ".repeat(40)}` })).title!;
    expect(title.startsWith("[Scout] Fix the login bug details")).toBe(true);
    expect(title).not.toContain("\n");
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("is only the brackets when the first message has no text (an image alone)", async () => {
    expect((await run({ workspace, prompt: "  " })).title).toBe("[Scout]");
  });

  it("is left to the host in the assistant's own folder, where the workspace is named after it", async () => {
    expect((await run({})).title).toBeUndefined();
  });

  it("never replaces a title the caller chose (a routine's name, an assignment's)", async () => {
    expect((await run({ workspace, title: "Nightly review" })).title).toBe("Nightly review");
  });
});
