import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileBelongsToTurn, MAX_FILE_BYTES, MAX_FILES_PER_SCAN, parseToolFile, writtenStrings } from "../shared/file-tools";
import { scanToolFiles } from "../server/file-tools";
import { fakeHost, makeBot } from "./helpers";

const call = (detail: unknown, name = "tool") => ({ type: "tool_call", callId: "c", name, status: "completed", detail });

describe("what a turn wrote", () => {
  it("reads the file of a write or edit and the command of a shell call", () => {
    const written = writtenStrings([
      call({ type: "edit", filePath: "Wrote ./proposals/changes-1.json", newString: "{}" }),
      call({ type: "write", filePath: "/bots/b1/proposals/skill-2.json", content: "{}" }),
      call({ type: "shell", command: "echo {} > proposals/routine-3.json", output: "" }),
      call({ type: "read", filePath: "/bots/b1/setup/overview.md" }),
      { type: "assistant_message", text: "done proposals/never.json" },
    ] as never);
    expect(written).toEqual(["Wrote ./proposals/changes-1.json", "/bots/b1/proposals/skill-2.json", "echo {} > proposals/routine-3.json"]);
  });
});

describe("what the last turn wrote", () => {
  it("leaves out earlier turns, so a name an earlier turn used is not claimed again", () => {
    const written = writtenStrings([
      call({ type: "edit", filePath: "Wrote ./proposals/skill-old.json" }),
      { type: "assistant_message", text: "ok" },
      { type: "user_message", text: "next" },
      call({ type: "edit", filePath: "Wrote ./proposals/skill-new.json" }),
    ] as never);
    expect(written).toEqual(["Wrote ./proposals/skill-new.json"]);
  });
});

describe("whether a file belongs to a turn", () => {
  const written = ["Wrote ./proposals/changes-1.json", "echo {} > proposals/routine-3.json", "/bots/b1/proposals/skill-2.json"];
  it("matches the file's name inside what was written", () => {
    expect(fileBelongsToTurn("changes-1.json", written)).toBe(true);
    expect(fileBelongsToTurn("routine-3.json", written)).toBe(true);
    expect(fileBelongsToTurn("skill-2.json", written)).toBe(true);
    expect(fileBelongsToTurn("CHANGES-1.JSON", written)).toBe(true);
  });
  it("does not match another file, or one whose name only ends the same way", () => {
    expect(fileBelongsToTurn("changes-9.json", written)).toBe(false);
    expect(fileBelongsToTurn("1.json", written)).toBe(false);
    expect(fileBelongsToTurn("hanges-1.json", written)).toBe(false);
    expect(fileBelongsToTurn("a.json", ["Wrote ./proposals/data.json"])).toBe(false);
    expect(fileBelongsToTurn("changes-1.json", [])).toBe(false);
  });
});

describe("reading an ask file", () => {
  it("returns the question when ask is allowed, and refuses other kinds there", () => {
    expect(parseToolFile('{"kind":"ask","to":"Scout","message":"hi"}', ["ask"])).toEqual({ kind: "ask", args: { to: "Scout", message: "hi" } });
    expect(parseToolFile('{"kind":"skill"}', ["ask"])).toEqual({ error: expect.stringContaining("must be ask") });
    expect(parseToolFile('{"kind":"ask","to":"Scout","message":"hi"}')).toEqual({ error: expect.stringContaining("changes, routine or skill") });
  });
});

describe("reading a tool file", () => {
  it("returns the kind and the arguments the matching tool takes", () => {
    expect(parseToolFile('{"kind":"changes","summary":"s","changes":[]}')).toEqual({ kind: "changes", args: { summary: "s", changes: [] } });
    expect(parseToolFile('{"kind":"routine","name":"n","instructions":"i","schedule":{"type":"webhook"}}')).toEqual({ kind: "routine", args: { name: "n", instructions: "i", schedule: { type: "webhook" } } });
    expect(parseToolFile('{"kind":"skill","name":"n","description":"d","instructions":"i"}')).toEqual({ kind: "skill", args: { name: "n", description: "d", instructions: "i" } });
  });
  it("says what is wrong with a file it cannot use", () => {
    expect(parseToolFile("not json")).toEqual({ error: expect.stringContaining("not valid JSON") });
    expect(parseToolFile("[1]")).toEqual({ error: expect.stringContaining("JSON object") });
    expect(parseToolFile('{"summary":"s"}')).toEqual({ error: expect.stringContaining('"kind"') });
    expect(parseToolFile('{"kind":"nap"}')).toEqual({ error: expect.stringContaining("changes, routine or skill") });
  });
});

describe("scanning a bot's proposals folder", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-filetools-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
  const setup = async () => {
    const { botDataPath } = await import("../server/bot-home");
    const dir = join(botDataPath("scout"), "proposals");
    await mkdir(dir, { recursive: true });
    return { dir, host: fakeHost([scout]) };
  };
  const scan = async (host: ReturnType<typeof fakeHost>, written: string[], agentId = "chat-1", now = Date.now()) => scanToolFiles({ host, relay: null as never, bot: scout, agentId, written, now });

  it("turns a valid changes file into a proposal, moves it to done/ and keeps the reply", async () => {
    const { dir, host } = await setup();
    await writeFile(join(dir, "changes-a1.json"), JSON.stringify({ kind: "changes", summary: "Retitle Scout", changes: [{ type: "update_bot", bot: "Scout", title: "Researcher" }] }));
    const { done } = await scan(host, ["Wrote ./proposals/changes-a1.json"]);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ name: "changes-a1.json", kind: "changes", ok: true, proposalId: expect.stringMatching(/^p-[a-z0-9]{10}$/) });
    expect(await readdir(dir)).toEqual(["done"]);
    expect((await readdir(join(dir, "done"))).sort()).toEqual(["changes-a1.json", "changes-a1.json.result.txt"]);
    expect(await readFile(join(dir, "done", "changes-a1.json.result.txt"), "utf8")).toContain(done[0]!.proposalId!);
  });

  it("makes routine and skill proposals through the same tools", async () => {
    const { dir, host } = await setup();
    await writeFile(join(dir, "routine-b2.json"), JSON.stringify({ kind: "routine", name: "Morning", instructions: "Check mail.", schedule: { type: "daily", time: "08:30" } }));
    await writeFile(join(dir, "skill-c3.json"), JSON.stringify({ kind: "skill", name: "weekly-report", description: "Write the weekly report", instructions: "1. Collect." }));
    const { done } = await scan(host, ["Wrote ./proposals/routine-b2.json", "echo > proposals/skill-c3.json"]);
    expect(done.map((result) => [result.kind, result.ok]).sort()).toEqual([["routine", true], ["skill", true]]);
  });

  it("reports why a file was not accepted, and still moves it away", async () => {
    const { dir, host } = await setup();
    await writeFile(join(dir, "changes-d4.json"), JSON.stringify({ kind: "changes", summary: "x", changes: [{ type: "update_bot", bot: "Nobody", title: "t" }] }));
    await writeFile(join(dir, "skill-e5.json"), JSON.stringify({ kind: "skill", name: "x" }));
    await writeFile(join(dir, "junk-f6.json"), "not json");
    const { done } = await scan(host, ["Wrote ./proposals/changes-d4.json", "Wrote ./proposals/skill-e5.json", "Wrote ./proposals/junk-f6.json"]);
    expect(done.every((result) => !result.ok && result.proposalId === null)).toBe(true);
    expect(done.find((result) => result.name === "changes-d4.json")!.text).toContain("Nobody");
    expect(done.find((result) => result.name === "skill-e5.json")!.text).toContain("description");
    expect(done.find((result) => result.name === "junk-f6.json")!.text).toContain("not valid JSON");
    expect(await readdir(dir)).toEqual(["done"]);
  });

  it("takes only the files this turn wrote, and leaves the others for their own turn", async () => {
    const { dir, host } = await setup();
    const body = JSON.stringify({ kind: "skill", name: "mine", description: "d", instructions: "i" });
    await writeFile(join(dir, "skill-mine.json"), body);
    await writeFile(join(dir, "skill-other.json"), body.replace("mine", "other"));
    const { done } = await scan(host, ["Wrote ./proposals/skill-mine.json"]);
    expect(done.map((result) => result.name)).toEqual(["skill-mine.json"]);
    expect((await readdir(dir)).sort()).toEqual(["done", "skill-other.json"]);
  });

  it("hands back a file nobody claimed after ten minutes, and leaves a recent one alone", async () => {
    const { dir, host } = await setup();
    const body = JSON.stringify({ kind: "skill", name: "n", description: "d", instructions: "i" });
    await writeFile(join(dir, "skill-old.json"), body);
    await writeFile(join(dir, "skill-new.json"), body);
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(join(dir, "skill-old.json"), old, old);
    const result = await scan(host, []);
    expect(result.done).toEqual([]);
    expect(result.unclaimed).toEqual(["skill-old.json"]);
  });

  it("ignores names it does not accept, files over the size limit, and takes at most twenty", async () => {
    const { dir, host } = await setup();
    await writeFile(join(dir, "notes.txt"), "x");
    await writeFile(join(dir, "bad name.json"), "{}");
    await writeFile(join(dir, "huge.json"), "x".repeat(MAX_FILE_BYTES + 1));
    for (let index = 0; index < MAX_FILES_PER_SCAN + 5; index++) await writeFile(join(dir, `s-${String(index).padStart(2, "0")}.json`), JSON.stringify({ kind: "skill", name: `s${index}`, description: "d", instructions: "i" }));
    const written = ["Wrote ./proposals/huge.json", ...Array.from({ length: MAX_FILES_PER_SCAN + 5 }, (_, index) => `Wrote ./proposals/s-${String(index).padStart(2, "0")}.json`)];
    const { done } = await scan(host, written);
    expect(done).toHaveLength(MAX_FILES_PER_SCAN);
    expect(done.find((result) => result.name === "huge.json")?.text).toContain("too large");
    expect(await stat(join(dir, "notes.txt")).then(() => true)).toBe(true);
    expect(await stat(join(dir, "bad name.json")).then(() => true)).toBe(true);
  });
});

import { FileTools } from "../server/file-tools";

describe("after a turn ends, for a bot whose tools are files", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-afterturn-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const skillFile = (name: string) => JSON.stringify({ kind: "skill", name, description: "d", instructions: "i" });
  async function setup(botPatch: Partial<ReturnType<typeof makeBot>> = {}, status = "idle") {
    const bot = makeBot({ id: "scout", name: "Scout", provider: "devin", ...botPatch });
    const host = fakeHost([bot]);
    const appended: { agentId: string; item: Record<string, unknown> }[] = [];
    const sent: { agentId: string; text: string }[] = [];
    const state = { status };
    host.attach({
      agents: {
        ref: (agentId: string) => ({
          refresh: async () => ({ agent: { status: state.status, labels: {}, title: "Chat", cwd: "/x" } }),
          timeline: { append: async (item: Record<string, unknown>) => void appended.push({ agentId, item }) },
          send: async (text: string) => void sent.push({ agentId, text }),
        }),
      },
    } as never);
    const { botDataPath } = await import("../server/bot-home");
    const dir = join(botDataPath("scout"), "proposals");
    await mkdir(dir, { recursive: true });
    const files = new FileTools(host, null as never);
    const turn = (agentId: string, written: string[]) => files.afterTurn({ bot, agentId, timeline: written.map((filePath) => ({ type: "tool_call", detail: { type: "edit", filePath } })) });
    return { bot, host, dir, files, appended, sent, state, turn };
  }

  it("posts a card for each proposal the turn wrote, and says nothing", async () => {
    const { dir, appended, sent, turn } = await setup();
    await writeFile(join(dir, "skill-a1.json"), skillFile("a"));
    await turn("chat-1", ["Wrote ./proposals/skill-a1.json"]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ agentId: "chat-1", item: { type: "plugin", kind: "proposal", version: 1, data: { proposalId: expect.stringMatching(/^p-/) } } });
    expect(appended[0]!.item.id).toBe((appended[0]!.item.data as { proposalId: string }).proposalId);
    expect(sent).toEqual([]);
  });

  it("tells the chat when a file was not accepted, naming the file and the reason", async () => {
    const { dir, appended, sent, turn } = await setup();
    await writeFile(join(dir, "skill-b2.json"), JSON.stringify({ kind: "skill", name: "b" }));
    await turn("chat-1", ["Wrote ./proposals/skill-b2.json"]);
    expect(appended).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("skill-b2.json");
    expect(sent[0]!.text).toContain("description");
    expect(sent[0]!.text).toContain("not accepted");
  });

  it("waits to tell a chat that is already working again, and tells it after its next turn", async () => {
    const { dir, sent, state, turn } = await setup({}, "running");
    await writeFile(join(dir, "skill-c3.json"), "nope");
    await turn("chat-1", ["Wrote ./proposals/skill-c3.json"]);
    expect(sent).toEqual([]);
    state.status = "idle";
    await turn("chat-1", []);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("skill-c3.json");
  });

  it("stops sending notices after three failures in a row, and starts again after a success", async () => {
    const { dir, sent, turn } = await setup();
    for (let index = 0; index < 4; index++) {
      await writeFile(join(dir, `bad-${index}.json`), "nope");
      await turn("chat-1", [`Wrote ./proposals/bad-${index}.json`]);
    }
    expect(sent).toHaveLength(3);
    await writeFile(join(dir, "skill-ok.json"), skillFile("ok"));
    await turn("chat-1", ["Wrote ./proposals/skill-ok.json"]);
    await writeFile(join(dir, "bad-9.json"), "nope");
    await turn("chat-1", ["Wrote ./proposals/bad-9.json"]);
    expect(sent).toHaveLength(4);
  });

  it("leaves a bot whose tools are an MCP server alone", async () => {
    const { dir, appended, turn } = await setup({ provider: "claude" });
    await writeFile(join(dir, "skill-d4.json"), skillFile("d"));
    await turn("chat-1", ["Wrote ./proposals/skill-d4.json"]);
    expect(appended).toEqual([]);
    expect(await readdir(dir)).toEqual(["skill-d4.json"]);
  });

  it("gives a file nobody claimed to the chat whose turn ends, after ten minutes", async () => {
    const { dir, appended, turn } = await setup();
    await writeFile(join(dir, "skill-e5.json"), skillFile("e"));
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(join(dir, "skill-e5.json"), old, old);
    await turn("chat-2", []);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.agentId).toBe("chat-2");
  });
});

import { turnEnded } from "../server/activity";
import { MemoryJournal } from "../server/journal";
import { ChatActivity, SaveTracker } from "../server/maintenance";

describe("a chat in a bot's own folder", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-folderchat-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function hostWith(cwd: string, labels: Record<string, string> = {}) {
    const bot = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const host = fakeHost([bot]);
    const appended: unknown[] = [];
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels, title: "New chat", cwd } }), timeline: { append: async (item: unknown) => void appended.push(item) }, send: async () => {} }) } } as never);
    return { bot, host, appended };
  }

  it("is the bot's chat even without the label the plugin gives its own chats", async () => {
    const { botDataPath } = await import("../server/bot-home");
    const { host } = await hostWith(botDataPath("scout"));
    expect(await host.chatOf("plain")).toMatchObject({ botId: "scout" });
    expect(await host.botIdOf("plain")).toBe("scout");
  });

  it("is nobody's chat when it runs somewhere else", async () => {
    const { host } = await hostWith("/work/project");
    expect(await host.chatOf("elsewhere")).toBeNull();
  });

  it("gets its proposal cards after a turn, like the bot's other chats", async () => {
    const { botDataPath } = await import("../server/bot-home");
    const { bot, host, appended } = await hostWith(botDataPath("scout"));
    const dir = join(botDataPath("scout"), "proposals");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skill-f6.json"), JSON.stringify({ kind: "skill", name: "f", description: "d", instructions: "i" }));
    const files = new FileTools(host, null as never);
    const event = { agent: { id: "plain", workspaceId: null, parentAgentId: null, provider: "devin", cwd: botDataPath("scout"), title: "New chat" }, turnId: "t", outcome: { kind: "completed" }, timeline: [{ type: "tool_call", detail: { type: "edit", filePath: "Wrote ./proposals/skill-f6.json" } }] };
    await turnEnded(host, new MemoryJournal(), { finished: async () => {} }, event as never, { activity: new ChatActivity(), saves: new SaveTracker(), tidy: null, fileTools: files });
    expect(appended).toHaveLength(1);
    expect(bot.id).toBe("scout");
  });
});

describe("the outbox, for a bot whose tools are files", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-outbox-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(result = { ok: true, text: "Request r-1: sent to Scout.", proposalId: null as string | null }) {
    const bot = makeBot({ id: "chief", name: "Chief", provider: "devin", contactBots: "allow" });
    const host = fakeHost([bot]);
    const appended: unknown[] = [];
    const sent: string[] = [];
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, title: "Chat", cwd: "/x" } }), timeline: { append: async (item: unknown) => void appended.push(item) }, send: async (text: string) => void sent.push(text) }) } } as never);
    const calls: { from: { agentId: string; labels: Record<string, string> }; args: { to: string; message: string } }[] = [];
    const asks = { request: async (from: never, args: never) => (calls.push({ from, args } as never), result), deliver: async () => {} };
    const { botDataPath } = await import("../server/bot-home");
    const outbox = join(botDataPath("chief"), "outbox");
    const proposals = join(botDataPath("chief"), "proposals");
    await mkdir(outbox, { recursive: true });
    await mkdir(proposals, { recursive: true });
    const files = new FileTools(host, null as never, asks as never);
    const turn = (written: string[], labels: Record<string, string> = {}) => files.afterTurn({ bot, agentId: "chat-1", labels, timeline: written.map((filePath) => ({ type: "tool_call", detail: { type: "edit", filePath } })) });
    return { outbox, proposals, calls, appended, sent, turn };
  }

  it("sends an ask file's question to the asks service, from the chat that wrote it", async () => {
    const { outbox, calls, turn } = await setup();
    await writeFile(join(outbox, "ask-a1.json"), JSON.stringify({ kind: "ask", to: "Scout", message: "How many unread?" }));
    await turn(["Wrote ./outbox/ask-a1.json"], { x: "y" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ to: "Scout", message: "How many unread?" });
    expect(calls[0]!.from).toMatchObject({ agentId: "chat-1", labels: { x: "y" } });
    expect(await readdir(outbox)).toEqual(["done"]);
    expect(await readFile(join(outbox, "done", "ask-a1.json.result.txt"), "utf8")).toContain("sent to Scout");
  });

  it("posts the approval card when the question waits for the user", async () => {
    const { outbox, appended, turn } = await setup({ ok: true, text: "Request r-2: waiting.", proposalId: "p-abcdef1234" });
    await writeFile(join(outbox, "ask-b2.json"), JSON.stringify({ kind: "ask", to: "Scout", message: "hi" }));
    await turn(["echo > outbox/ask-b2.json"]);
    expect(appended).toMatchObject([{ type: "plugin", kind: "proposal", data: { proposalId: "p-abcdef1234" } }]);
  });

  it("tells the chat when the question was refused, and rejects files of the wrong kind or shape", async () => {
    const { outbox, proposals, calls, sent, turn } = await setup({ ok: false, text: "Asking other bots is not allowed for you.", proposalId: null });
    await writeFile(join(outbox, "ask-c3.json"), JSON.stringify({ kind: "ask", to: "Scout", message: "hi" }));
    await writeFile(join(outbox, "skill-c4.json"), JSON.stringify({ kind: "skill", name: "x" }));
    await writeFile(join(outbox, "ask-c5.json"), JSON.stringify({ kind: "ask", to: "Scout" }));
    await turn(["Wrote ./outbox/ask-c3.json", "Wrote ./outbox/skill-c4.json", "Wrote ./outbox/ask-c5.json"]);
    expect(calls).toHaveLength(1);
    const text = sent.join("\n");
    for (const part of ["ask-c3.json", "not allowed", "skill-c4.json", "must be ask", "ask-c5.json", "message"]) expect(text).toContain(part);
    expect(proposals).toBeTruthy();
  });

  it("does not take an ask file from the proposals folder", async () => {
    const { proposals, calls, sent, turn } = await setup();
    await writeFile(join(proposals, "ask-c6.json"), JSON.stringify({ kind: "ask", to: "Scout", message: "hi" }));
    await turn(["Wrote ./proposals/ask-c6.json"]);
    expect(calls).toEqual([]);
    expect(sent.join("\n")).toContain("changes, routine or skill");
  });
});

import { symlink } from "node:fs/promises";

describe("scanning safely", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-safe-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
  const skillBody = JSON.stringify({ kind: "skill", name: "n", description: "d", instructions: "i" });
  async function prepare() {
    const { botDataPath } = await import("../server/bot-home");
    const bot = join(botDataPath("scout"));
    await mkdir(join(bot, "proposals"), { recursive: true });
    return { bot, dir: join(bot, "proposals"), host: fakeHost([scout]) };
  }
  const scanOf = (host: ReturnType<typeof fakeHost>, written: string[]) => scanToolFiles({ host, relay: null as never, bot: scout, agentId: "chat-1", written });

  it("lets only one of two scans that race for a file process it", async () => {
    const { dir, host } = await prepare();
    await writeFile(join(dir, "skill-race.json"), skillBody);
    const [first, second] = await Promise.all([scanOf(host, ["Wrote ./proposals/skill-race.json"]), scanOf(host, ["Wrote ./proposals/skill-race.json"])]);
    expect(first.done.length + second.done.length).toBe(1);
    const { pluginDataPath } = await import("../server/bot-home");
    expect(JSON.parse(await readFile(join(pluginDataPath(), "proposals.json"), "utf8")).proposals).toHaveLength(1);
  });

  it("never follows a proposals folder that is a link to somewhere else", async () => {
    const { bot, host } = await prepare();
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "mine.json"), skillBody);
    await rm(join(bot, "proposals"), { recursive: true, force: true });
    await symlink(elsewhere, join(bot, "proposals"));
    const result = await scanOf(host, ["Wrote ./proposals/mine.json"]);
    expect(result.done).toEqual([]);
    expect(await readdir(elsewhere)).toEqual(["mine.json"]);
  });

  it("does not write through a done folder that is a link, nor delete what it points at", async () => {
    const { dir, host } = await prepare();
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    for (let index = 0; index < 120; index++) await writeFile(join(elsewhere, `keep-${index}.txt`), "x");
    await symlink(elsewhere, join(dir, "done"));
    await writeFile(join(dir, "skill-link.json"), skillBody);
    await scanOf(host, ["Wrote ./proposals/skill-link.json"]);
    expect(await readdir(elsewhere)).toHaveLength(120);
  });

  it("does not overwrite a file that a link in done/ points to", async () => {
    const { dir, host } = await prepare();
    const target = join(home, "precious.txt");
    await writeFile(target, "precious");
    await mkdir(join(dir, "done"), { recursive: true });
    await symlink(target, join(dir, "done", "skill-over.json.result.txt"));
    await writeFile(join(dir, "skill-over.json"), skillBody);
    await scanOf(host, ["Wrote ./proposals/skill-over.json"]);
    expect(await readFile(target, "utf8")).toBe("precious");
  });

  it("prunes done/ by age and survives a folder inside it", async () => {
    const { dir, host } = await prepare();
    const done = join(dir, "done");
    await mkdir(join(done, "sub"), { recursive: true });
    for (let index = 0; index < 110; index++) {
      const name = `z-${String(index).padStart(3, "0")}.txt`;
      await writeFile(join(done, name), "x");
      const at = new Date(Date.now() - (200 - index) * 60_000);
      await utimes(join(done, name), at, at);
    }
    await writeFile(join(dir, "skill-new.json"), skillBody);
    await scanOf(host, ["Wrote ./proposals/skill-new.json"]);
    const names = await readdir(done);
    expect(names).toContain("skill-new.json.result.txt");
    expect(names).toContain("sub");
    expect(names.some((name) => name === "z-000.txt")).toBe(false);
    expect(names.some((name) => name === "z-109.txt")).toBe(true);
  });

  it("removes a file it could not move, so it is not processed again", async () => {
    const { dir, host } = await prepare();
    await writeFile(join(dir, "done"), "a file where the folder should be");
    await writeFile(join(dir, "skill-stuck.json"), skillBody);
    const first = await scanOf(host, ["Wrote ./proposals/skill-stuck.json"]);
    const second = await scanOf(host, ["Wrote ./proposals/skill-stuck.json"]);
    expect(first.done.length + second.done.length).toBeLessThanOrEqual(1);
    expect(await readdir(dir)).not.toContain("skill-stuck.json");
  });
});

describe("guessing which chat a file belongs to", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-guess-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  async function setup(busy: boolean) {
    const bot = makeBot({ id: "chief", name: "Chief", provider: "devin", contactBots: "allow" });
    const host = fakeHost([bot]);
    const appended: unknown[] = [];
    const sent: string[] = [];
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, title: "Chat", cwd: "/x" } }), timeline: { append: async (item: unknown) => void appended.push(item) }, send: async (text: string) => void sent.push(text) }) } } as never);
    const calls: unknown[] = [];
    const asks = { request: async (...args: unknown[]) => (calls.push(args), { ok: true, text: "sent", proposalId: null }), deliver: async () => {} };
    const activity = new ChatActivity();
    if (busy) activity.started("chief", "other-chat");
    const { botDataPath } = await import("../server/bot-home");
    const proposals = join(botDataPath("chief"), "proposals");
    const outbox = join(botDataPath("chief"), "outbox");
    await mkdir(proposals, { recursive: true });
    await mkdir(outbox, { recursive: true });
    const old = new Date(Date.now() - 11 * 60_000);
    const files = new FileTools(host, null as never, asks as never, activity);
    return { bot, proposals, outbox, old, calls, appended, sent, turn: () => files.afterTurn({ bot, agentId: "chat-9", timeline: [] }) };
  }

  it("does not guess while another chat of the bot is working", async () => {
    const { proposals, old, appended, turn } = await setup(true);
    await writeFile(join(proposals, "skill-w1.json"), JSON.stringify({ kind: "skill", name: "w", description: "d", instructions: "i" }));
    await utimes(join(proposals, "skill-w1.json"), old, old);
    await turn();
    expect(appended).toEqual([]);
    expect(await readdir(proposals)).toContain("skill-w1.json");
  });

  it("never guesses an ask, which would send a question for a chat that was not the one that wrote it", async () => {
    const { outbox, old, calls, turn } = await setup(false);
    await writeFile(join(outbox, "ask-g2.json"), JSON.stringify({ kind: "ask", to: "Scout", message: "hi" }));
    await utimes(join(outbox, "ask-g2.json"), old, old);
    await turn();
    expect(calls).toEqual([]);
    expect(await readFile(join(outbox, "done", "ask-g2.json.result.txt"), "utf8")).toContain("which chat wrote");
  });
});
