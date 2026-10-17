import { describe, expect, it } from "vitest";
import { EMPTY_LIBRARY } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import { ASK_PREAPPROVED_LABEL } from "../shared/groups";
import { makeBot } from "./helpers";

// Chats the person starts in the app and chats the server starts (routines, other bots) both go through startBotChat.

function fakeApi() {
  const created: { labels: Record<string, string> }[] = [];
  const workspace = { projectId: "p", projectRootPath: "/bots/scout", workspaceDirectory: "/bots/scout", title: "Scout" };
  const handle = { agents: { create: async (options: { labels: Record<string, string> }) => (created.push(options), { id: "chat-1" }) } };
  const api = { workspaces: { list: async () => ({ entries: [workspace] }), ref: () => handle } } as never;
  return { api, created };
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
