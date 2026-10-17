import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_CHATS, MAX_MESSAGES, writeHistory } from "../server/history-files";
import { fakeHost, makeBot } from "./helpers";

type Msg = { type: "user_message" | "assistant_message" | "tool_call"; text?: string };

describe("the history files a bot with file tools can search", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-history-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
  const dirOf = async () => join((await import("../server/bot-home")).botDataPath("scout"), "history");

  function hostWith(chats: Record<string, { title: string; labels?: Record<string, string>; messages: Msg[]; createdAt?: string }>, bot = scout) {
    const host = fakeHost([bot]);
    host.attach({
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({ agent: { id, title: chats[id]!.title, labels: chats[id]!.labels ?? {}, createdAt: chats[id]!.createdAt ?? "2026-10-13T09:12:00.000Z", cwd: "/x" } }),
          timeline: { refetch: async () => ({ entries: chats[id]!.messages.map((item, index) => ({ item, timestamp: new Date(Date.UTC(2026, 9, 13, 9, index)).toISOString() })) }) },
        }),
      },
    } as never);
    return host;
  }
  const say = (user: string, assistant: string): Msg[] => [{ type: "user_message", text: user }, { type: "tool_call" }, { type: "assistant_message", text: assistant }];

  it("writes a chat as a transcript of what was said, secrets removed, named by date, title and id", async () => {
    const host = hostWith({ "abcdef12-0000": { title: "Weekly report plan", messages: say("Use key sk-abcdefghijklmnopqrstuv for it", "Done: the report is planned.") } });
    await writeHistory(host, scout, "abcdef12-0000");
    const names = await readdir(await dirOf());
    expect(names).toEqual(["2026-10-13-weekly-report-plan-abcdef12.md"]);
    const text = await readFile(join(await dirOf(), names[0]!), "utf8");
    expect(text).toContain("Weekly report plan");
    expect(text).toContain("Done: the report is planned.");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuv");
    expect(text).not.toContain("tool_call");
  });

  it("still writes and prunes when the folder holds a folder named like a transcript or a broken link", async () => {
    const dir = await dirOf();
    await mkdir(join(dir, "folder.md"), { recursive: true });
    await symlink(join(dir, "nowhere"), join(dir, "broken.md")).catch(() => {});
    const host = hostWith({ "abcdef12-0000": { title: "Plan", messages: say("hi", "hello") } });
    await writeHistory(host, scout, "abcdef12-0000");
    expect(await readdir(dir)).toContain("2026-10-13-plan-abcdef12.md");
  });

  it("keeps one file per chat when the chat is renamed and grows", async () => {
    const chats = { "abcdef12-0000": { title: "New chat", messages: say("hi", "hello") } };
    await writeHistory(hostWith(chats), scout, "abcdef12-0000");
    chats["abcdef12-0000"] = { title: "Lunch plans", messages: [...say("hi", "hello"), ...say("lunch?", "noodles")] };
    await writeHistory(hostWith(chats), scout, "abcdef12-0000");
    const names = await readdir(await dirOf());
    expect(names).toEqual(["2026-10-13-lunch-plans-abcdef12.md"]);
    expect(await readFile(join(await dirOf(), names[0]!), "utf8")).toContain("noodles");
  });

  it("keeps the newest messages when a chat is longer than the limit", async () => {
    const messages: Msg[] = Array.from({ length: MAX_MESSAGES + 30 }, (_, index) => ({ type: "user_message", text: `message number ${index}` }));
    await writeHistory(hostWith({ "c1-aaaaaaaa": { title: "Long", messages } }), scout, "c1-aaaaaaaa");
    const text = await readFile(join(await dirOf(), (await readdir(await dirOf()))[0]!), "utf8");
    expect(text).toContain(`message number ${MAX_MESSAGES + 29}`);
    expect(text).toContain("message number 30\n");
    expect(text).not.toContain("message number 29\n");
  });

  it("keeps only the newest chats", async () => {
    const dir = await dirOf();
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < MAX_CHATS + 3; index++) {
      const name = `2026-09-${String(index + 1).padStart(2, "0")}-old-${String(index).padStart(8, "0")}.md`;
      await writeFile(join(dir, name), "x");
      const at = new Date(Date.UTC(2026, 8, 1 + index));
      await utimes(join(dir, name), at, at);
    }
    await writeHistory(hostWith({ "newest-0000": { title: "Newest", messages: say("a", "b") } }), scout, "newest-0000");
    const names = await readdir(dir);
    expect(names).toHaveLength(MAX_CHATS);
    expect(names.some((name) => name.includes("newest-0"))).toBe(true);
    expect(names.some((name) => name.endsWith("00000000.md"))).toBe(false);
  });

  it("skips a memory tidy chat, and does nothing for a bot whose tools are an MCP server", async () => {
    const tidy = hostWith({ "t1-bbbbbbbb": { title: "Memory tidy", labels: { "bot-crew.tidy": "scout" }, messages: say("tidy", "ok") } });
    await writeHistory(tidy, scout, "t1-bbbbbbbb");
    expect(await readdir(await dirOf()).catch(() => [])).toEqual([]);
    const claude = makeBot({ id: "scout", provider: "claude" });
    await mkdir(await dirOf(), { recursive: true });
    await writeFile(join(await dirOf(), "2026-01-01-old-aaaaaaaa.md"), "x");
    await writeHistory(hostWith({ "c2-cccccccc": { title: "Chat", messages: say("a", "b") } }, claude), claude, "c2-cccccccc");
    expect(await readdir(await dirOf()).catch(() => [])).toEqual([]);
  });

  it("does not call a message from the plugin or another bot a message from the user", async () => {
    const host = hostWith({
      "d1-dddddddd": {
        title: "Asked",
        messages: [
          { type: "user_message", text: "[Message from Chief, another bot on this Paseo, not from your user.]\n\nHow many?" },
          { type: "assistant_message", text: "Three." },
          { type: "user_message", text: "[Reply from Scout to your request r-1. It comes from another bot, not from the user]\n\nTANGERINE" },
          { type: "user_message", text: "[Bots, not from the user] Your proposal file x.json was not accepted" },
          { type: "user_message", text: "a real question" },
        ],
      },
    });
    await writeHistory(host, scout, "d1-dddddddd");
    const text = await readFile(join(await dirOf(), (await readdir(await dirOf()))[0]!), "utf8");
    expect(text).toContain("another bot\n[Message from Chief");
    expect(text).toContain("another bot\n[Reply from Scout");
    expect(text).toContain("the plugin\n[Bots, not from the user]");
    expect(text).toContain("the user\na real question");
  });

  it("does not follow a history folder that is a link to somewhere else", async () => {
    const { symlink } = await import("node:fs/promises");
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    for (let index = 0; index < 60; index++) await writeFile(join(elsewhere, `keep-${index}.md`), "x");
    const dir = await dirOf();
    await mkdir(join(dir, ".."), { recursive: true });
    await symlink(elsewhere, dir);
    await writeHistory(hostWith({ "e1-eeeeeeee": { title: "Chat", messages: say("a", "b") } }), scout, "e1-eeeeeeee");
    expect(await readdir(elsewhere)).toHaveLength(60);
  });
});
