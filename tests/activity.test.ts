import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { journalSummary, lastTurn, logLine, matchesAll, parseLog, parseSince, recentWork, redactSecrets, searchWords, snippet } from "../shared/activity";
import { lineDiff } from "../shared/diff";
import { newUuid } from "../shared/uuid";
import { fakeHost, makeBot } from "./helpers";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);

describe("daily log lines", () => {
  it("takes the last reply and the tools of the latest turn", () => {
    const turn = lastTurn([
      { type: "user_message", text: "old" },
      { type: "assistant_message", text: "old answer" },
      { type: "user_message", text: "Check my inbox" },
      { type: "tool_call", name: "mcp__apps__COMPOSIO_SEARCH_TOOLS" },
      { type: "assistant_message", text: "Looking." },
      { type: "tool_call", name: "Read" },
      { type: "tool_call", name: "Read" },
      { type: "assistant_message", text: "Three new mails." },
    ]);
    expect(turn).toEqual({ reply: "Three new mails.", tools: ["apps/COMPOSIO_SEARCH_TOOLS", "Read"] });
  });

  it("writes one folded, redacted line per turn", () => {
    expect(logLine({ at: at(27, 9, 5), chat: 'Inbox "daily"', reply: "Sent it.\nKey sk-abcdefghijklmnopqrstuv is set.", tools: ["Read"] })).toBe(
      '- 09:05 · from chat "Inbox \'daily\'" · Sent it. Key [redacted] is set. [tools: Read]',
    );
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "  ", tools: [] })).toBeNull();
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "", tools: [], failure: "rate limited" })).toBe('- 09:05 · from chat "x" · (turn failed: rate limited)');
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "a".repeat(400), tools: [] })!.length).toBeLessThan(300);
    expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz")).toBe("Bearer [redacted] and [redacted]");
  });

  it("carries where, who drove the turn and how it ended in a bracket, and logs a stopped turn without a reply", () => {
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "Sent it.", tools: [], meta: "app · Login · by the user · done" })).toBe('- 09:05 · from chat "x" · [app · Login · by the user · done] Sent it.');
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "", tools: [], meta: "app · Login · by the user · stopped", stopped: true })).toBe('- 09:05 · from chat "x" · [app · Login · by the user · stopped]');
    expect(logLine({ at: at(27, 9, 5), chat: "x", reply: "  ", tools: [], meta: "m" })).toBeNull();
    const [entry] = parseLog("2026-09-27", '- 09:05 · from chat "x" · [app · Login · by the user · done] Sent it.');
    expect(entry!.text).toBe("[app · Login · by the user · done] Sent it.");
  });

  it("shows the bracket as its own part of the brief, and skips failed and stopped turns in it", () => {
    const now = new Date(2026, 8, 27, 12, 0);
    const entries = parseLog(
      "2026-09-27",
      ['- 08:00 · from chat "Old" · Plain old line.', '- 09:30 · from chat "Build" · [app · Login · assigned by Mate · done] Wrote notes.md. [tools: edit]', '- 10:00 · from chat "Broken" · [app · Login · by the user · failed] (turn failed: boom)', '- 11:00 · from chat "Stopped" · [app · Login · by the user · stopped]'].join("\n"),
    );
    const brief = recentWork(entries, now);
    expect(brief).toContain('- today 09:30 · "Build" · [app · Login · assigned by Mate · done] · you said: "Wrote notes.md."');
    expect(brief).toContain('- today 08:00 · "Old" · you said: "Plain old line."');
    expect(brief.join("\n")).not.toContain("Broken");
    expect(brief.join("\n")).not.toContain("Stopped");
  });

  it("redacts the credential formats that a team's records would otherwise carry", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(redactSecrets(`token is ${jwt} ok`)).toBe("token is [redacted] ok");
    expect(redactSecrets("password=hunter2hunter2 and Password: hunter2hunter2")).toBe("password=[redacted] and Password: [redacted]");
    expect(redactSecrets("api_key = abcdefghijkl, secret:abcdefgh")).toBe("api_key = [redacted], secret:[redacted]");
    expect(redactSecrets("key AIzaSyA1234567890abcdefghijklmnopqrstuv end")).toBe("key [redacted] end");
    expect(redactSecrets("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\nmore\n-----END RSA PRIVATE KEY-----\nb")).toBe("a\n[redacted]\nb");
    expect(redactSecrets("The password policy is in the wiki, and a token of thanks.")).toBe("The password policy is in the wiki, and a token of thanks.");
  });

  it("briefs the newest line from each chat of the last two days", () => {
    const today = parseLog(
      "2026-09-27",
      ['- 08:00 · from chat "Inbox" · First. [tools: Read]', '- 09:30 · from chat "Inbox" · Sent the three invoices.', '- 10:00 · from chat "Report" · (turn failed: boom)', "a note the bot wrote"].join("\n"),
    );
    const earlier = parseLog("2026-09-26", '- 17:40 · from chat "Report" · Drafted the report.\n');
    const old = parseLog("2026-09-24", '- 12:00 · from chat "Old" · Too old.\n');
    expect(today).toHaveLength(3);
    expect(recentWork([...old, ...earlier, ...today], at(27, 12))).toEqual(['- today 09:30 · "Inbox" · you said: "Sent the three invoices."', '- yesterday 17:40 · "Report" · you said: "Drafted the report."']);
  });
});

describe("the journal's diff", () => {
  it("shows changed lines with two lines of context", () => {
    const before = ["# Memory", "a", "b", "c", "d", "e", "f"].join("\n") + "\n";
    const after = ["# Memory", "a", "b", "C", "d", "e", "f", "g"].join("\n") + "\n";
    const { diff, added, removed } = lineDiff(before, after);
    expect({ added, removed }).toEqual({ added: 2, removed: 1 });
    expect(diff).toBe(["@@ -2,6 +2,7 @@", " a", " b", "-c", "+C", " d", " e", " f", "+g"].join("\n"));
    expect(lineDiff("", "one\ntwo\n")).toMatchObject({ diff: "@@ -0,0 +1,2 @@\n+one\n+two", added: 2, removed: 0 });
    expect(lineDiff("same\n", "same\n")).toEqual({ diff: "", added: 0, removed: 0 });
  });
});

describe("search helpers", () => {
  it("matches every content word and marks them", () => {
    expect(searchWords("What did we decide about the Q3 invoices?")).toEqual(["decide", "q3", "invoices"]);
    expect(matchesAll("Invoices for Q3 are late", ["q3", "invoices"])).toBe(true);
    expect(matchesAll("Invoices are late", ["q3", "invoices"])).toBe(false);
    expect(snippet("The Q3 invoices went out.", ["q3", "invoices"])).toBe("The [Q3] [invoices] went out.");
  });

  it("reads time ranges", () => {
    const now = at(27, 12);
    expect(parseSince("24h", now)).toEqual(at(26, 12));
    expect(parseSince("today", now)).toEqual(at(27, 0));
    expect(parseSince("yesterday", now)).toEqual(at(26, 0));
    expect(parseSince("2w", now)).toEqual(at(13, 12));
    expect(parseSince("2026-09-01", now)).toEqual(at(1, 0));
    expect(() => parseSince("last tuesday", now)).toThrow("Couldn't read");
  });

  it("words journal rows the way the person reads them", () => {
    const row = { file: "MEMORY.md", actor: "bot" as const, via: "chat" as const, chat: { title: "x" }, kind: "edited" as const, added: 2, removed: 0 };
    expect(journalSummary(row, "Scout")).toBe("Scout added 2 lines to MEMORY.md");
    expect(journalSummary({ ...row, actor: "you", file: "clients.md", kind: "deleted" }, "Scout")).toBe("You deleted the clients topic");
    expect(journalSummary({ ...row, added: 3, removed: 1 }, "Scout")).toBe("Scout rewrote 3 lines in MEMORY.md");
  });
});

describe("memory journal, daily log and search_chats", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-activity-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("does not blame the person for what another chat of the bot is editing when a second turn starts", async () => {
    const { MemoryJournal } = await import("../server/journal");
    const { memoryFilePath } = await import("../server/memory");
    const journal = new MemoryJournal();
    const main = memoryFilePath("bot-two", "MEMORY.md");
    await mkdir(join(main, ".."), { recursive: true });
    await writeFile(main, "# Memory\n");
    await journal.begin("bot-two"); // chat A starts
    await writeFile(main, "# Memory\n- written by chat A\n");
    await journal.begin("bot-two"); // chat B starts while A is still working
    await journal.end("bot-two", { id: "chat-a", title: "A" });
    await journal.end("bot-two", { id: "chat-b", title: "B" });
    const entries = await journal.list("bot-two");
    expect(entries.map((entry) => [entry.actor, entry.via, entry.chat?.id ?? null])).toEqual([["bot", "chat", "chat-a"]]);
  });

  it("journals the bot's edits during a turn, the person's edits, and undoes them", async () => {
    const { MemoryJournal } = await import("../server/journal");
    const { memoryFilePath } = await import("../server/memory");
    const journal = new MemoryJournal();
    const main = memoryFilePath("bot-j", "MEMORY.md");
    await mkdir(join(main, ".."), { recursive: true });
    await writeFile(main, "# Memory\n- likes tea\n");

    await journal.begin("bot-j");
    await writeFile(main, "# Memory\n- likes tea\n- works Mon-Fri\n");
    await mkdir(join(main, "..", "memory"), { recursive: true });
    await writeFile(memoryFilePath("bot-j", "clients.md"), "# Clients\n");
    await journal.end("bot-j", { id: "chat-1", title: "Setup" });

    let entries = await journal.list("bot-j");
    expect(entries.map((entry) => [entry.file, entry.actor, entry.kind, entry.added, entry.removed])).toEqual([
      ["clients.md", "bot", "created", 1, 0],
      ["MEMORY.md", "bot", "edited", 1, 0],
    ]);
    expect(entries[1]!.chat).toEqual({ id: "chat-1", title: "Setup" });

    // Changed outside the app between turns.
    await writeFile(main, "# Memory\n");
    await journal.begin("bot-j");
    entries = await journal.list("bot-j");
    expect(entries[0]).toMatchObject({ file: "MEMORY.md", actor: "you", via: "disk", removed: 2 });

    await journal.undo("bot-j", entries[0]!.id);
    expect(await readFile(main, "utf8")).toBe("# Memory\n- likes tea\n- works Mon-Fri\n");
    const created = (await journal.list("bot-j")).find((entry) => entry.kind === "created")!;
    await journal.undo("bot-j", created.id);
    await expect(readFile(memoryFilePath("bot-j", "clients.md"), "utf8")).rejects.toThrow();

    await journal.write("bot-j", "MEMORY.md", "# Memory\n- edited in the app\n");
    const latest = (await journal.list("bot-j"))[0]!;
    expect(latest).toMatchObject({ actor: "you", via: "app", kind: "edited" });
    expect((await journal.list("bot-j")).filter((entry) => entry.via === "undo")).toHaveLength(2);
  });

  it("logs finished turns of bot chats and searches chats and memory", async () => {
    const { turnEnded } = await import("../server/activity");
    const { MemoryJournal } = await import("../server/journal");
    const { listLogDays, recentLogEntries } = await import("../server/memory");
    const { searchChats } = await import("../server/tools/chats");
    const host = fakeHost([makeBot({ id: "bot-s", name: "Scout" })]);
    host.chatOf = async (agentId: string) => (agentId === "other-agent" ? null : { botId: "bot-s", title: "Invoices", routineId: null, labels: {} });
    const scheduler = { finished: async () => {} };
    const journal = new MemoryJournal();
    const agent = { id: newUuid(), workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/", title: null };

    const timeline = [
      { type: "user_message", text: "Send the Q3 invoices" },
      { type: "tool_call", name: "mcp__apps__GMAIL_SEND", callId: "1", status: "completed", detail: { type: "unknown", input: null, output: null }, error: null },
      { type: "assistant_message", text: "Sent the three Q3 invoices to Acme." },
    ] as never;
    await turnEnded(host, journal, scheduler, { agent, turnId: "t1", outcome: { kind: "completed" }, timeline });
    await turnEnded(host, journal, scheduler, { agent: { ...agent, id: "other-agent" }, turnId: "t2", outcome: { kind: "completed" }, timeline });
    await turnEnded(host, journal, scheduler, { agent, turnId: "t3", outcome: { kind: "canceled", reason: "stopped" }, timeline });
    // The finished turn and the stopped one are logged; the other agent's is not a bot chat.
    expect((await listLogDays("bot-s")).days).toEqual([{ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), lines: 2 }]);
    const [entry, stopped] = await recentLogEntries("bot-s", 1);
    expect(entry).toMatchObject({ chat: "Invoices", text: "[by the user · done] Sent the three Q3 invoices to Acme. [tools: apps/GMAIL_SEND]" });
    // What the bot had said before it was stopped stays in the line.
    expect(stopped).toMatchObject({ chat: "Invoices", text: "[by the user · stopped] Sent the three Q3 invoices to Acme. [tools: apps/GMAIL_SEND]" });

    const current = newUuid();
    const past = { id: newUuid(), title: "Invoices", updatedAt: new Date().toISOString() };
    const entries = [
      { item: { type: "user_message", text: "Send the Q3 invoices" }, timestamp: new Date(Date.now() - 60_000).toISOString() },
      { item: { type: "assistant_message", text: "Sent the three Q3 invoices to Acme." }, timestamp: new Date().toISOString() },
    ];
    const listed: unknown[] = [];
    host.attach({
      agents: {
        list: async (options: unknown) => {
          listed.push(options);
          return { entries: [{ agent: { id: current, title: "Now", updatedAt: new Date().toISOString() } }, { agent: past }] };
        },
        ref: (id: string) => ({ timeline: { refetch: async () => ({ entries: id === past.id ? entries : [{ item: { type: "user_message", text: "q3 invoices again" }, timestamp: new Date().toISOString() }] }) } }),
      },
    } as never);
    const caller = { bot: makeBot({ id: "bot-s" }), agentId: current, host, relay: null as never };
    const found = await searchChats.run({ query: "q3 invoices" }, caller);
    expect(listed[0]).toMatchObject({ filter: { labels: { "aydo.bot": "bot-s" }, includeArchived: true } });
    expect(found).toContain("Memory:\n- [memory/log/");
    expect(found).toContain(`chat "Invoices" (id: ${past.id}) · you] Sent the three [Q3] [invoices] to Acme.`);
    expect(found).toContain("· the user] Send the [Q3] [invoices]");
    expect(found).not.toContain("again");
    expect(await searchChats.run({ query: "unicorns" }, caller)).toBe("Nothing matched.");
    await expect(searchChats.run({}, caller)).rejects.toThrow("Give a few words");
  });
});

describe("team reports from finished turns", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-turnreports-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const NOWISO = "2026-10-20T00:00:00.000Z";
  const team = { id: "t1", name: "Crew", logo: null, leadId: "lead", memberIds: ["lead", "dev"], instructions: "", askFreely: false, createdAt: NOWISO, updatedAt: NOWISO };
  const entries = [
    { id: "wks_1", projectId: "prj_1111aaaa", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-login", name: "login", title: "Login", archivingAt: null },
  ];
  const assignment = "[Assignment from Chief, another bot on this Paseo, not from your user.]\n\nWrite notes.md";

  async function finish(botId: string, chatWorkspace: string | null, timeline: unknown[], outcome: { kind: "completed" } | { kind: "canceled"; reason: string } = { kind: "completed" }, chatId = "a1b2c3d4-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
    const { turnEnded } = await import("../server/activity");
    const { MemoryJournal } = await import("../server/journal");
    const host = fakeHost([makeBot({ id: "lead", name: "Chief" }), makeBot({ id: "dev", name: "Dev" }), makeBot({ id: "solo", name: "Solo" })], undefined, [team]);
    host.chatOf = async () => ({ botId, title: "Chief → Write notes.md", routineId: null, labels: {} });
    host.attach({ workspaces: { list: async () => ({ entries }) }, agents: { ref: () => ({ refresh: async () => ({ agent: { workspaceId: chatWorkspace } }) }) } } as never);
    const agent = { id: chatId, workspaceId: chatWorkspace, parentAgentId: null, provider: "claude", cwd: "/", title: null };
    await turnEnded(host, new MemoryJournal(), { finished: async () => {} }, { agent, turnId: "t", outcome: outcome as never, timeline: timeline as never });
  }
  const dayFile = async (ext: "md" | "jsonl") => {
    const { teamReportsPath } = await import("../server/bot-home");
    const { localDay } = await import("../shared/activity");
    return readFile(join(teamReportsPath("t1"), "app", `${localDay(new Date())}.${ext}`), "utf8").catch(() => "");
  };
  const records = async () => (await dayFile("jsonl")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

  it("keeps the whole question (without the framing) and the whole last answer of a member's turn in a project workspace", async () => {
    const long = `Conclusion at the end. ${"middle ".repeat(100)} THE CODE IS 4417`;
    await finish("dev", "wks_1", [{ type: "user_message", text: assignment }, { type: "tool_call", name: "Read", detail: {} }, { type: "assistant_message", text: "Let me look first." }, { type: "assistant_message", text: long }]);
    const [record] = await records();
    expect(record).toMatchObject({ bot: { id: "dev", name: "Dev" }, chat: { id: "a1b2c3d4-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Chief → Write notes.md" }, project: { id: "prj_1111aaaa", name: "app" }, workspace: "app · Login", driver: { kind: "bot", name: "Chief", via: "assignment" }, status: "done", question: "Write notes.md", answer: long });
    expect(JSON.stringify(record)).not.toContain("Let me look first");
    expect(JSON.stringify(record)).not.toContain('"Read"');
    expect(await dayFile("md")).toContain('· Dev · "Chief → Write notes.md" · [app · Login · assigned by Chief · done] · Q: Write notes.md · A: Conclusion at the end.');
    expect(await dayFile("md")).toContain("THE CODE IS 4417 · chat a1b2c3d4");
  });

  it("records a turn the user typed in the assigned chat as the user's, and a stopped one as stopped", async () => {
    await finish("dev", "wks_1", [{ type: "user_message", text: assignment }, { type: "assistant_message", text: "Which folder?" }, { type: "user_message", text: "Now also notes9.md" }, { type: "assistant_message", text: "Both written." }], { kind: "completed" }, "bbbbbbbb-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await finish("dev", "wks_1", [{ type: "user_message", text: "Long task" }, { type: "assistant_message", text: "Starting." }], { kind: "canceled", reason: "stopped" }, "cccccccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const all = await records();
    expect(all.find((record) => record.chat.id.startsWith("bbbbbbbb"))).toMatchObject({ driver: { kind: "user" }, question: "Now also notes9.md", answer: "Both written." });
    expect(all.find((record) => record.chat.id.startsWith("cccccccc"))).toMatchObject({ status: "stopped", answer: "Starting." });
  });

  it("records the lead's own turn in a project workspace too", async () => {
    await finish("lead", "wks_1", [{ type: "user_message", text: "Draft the plan" }, { type: "assistant_message", text: "Plan drafted." }], { kind: "completed" }, "dddddddd-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect((await records()).find((record) => record.chat.id.startsWith("dddddddd"))).toMatchObject({ bot: { id: "lead", name: "Chief" }, answer: "Plan drafted." });
  });

  it("records nothing for a turn in the bot's own folder or for a bot on no team", async () => {
    const before = await records();
    await finish("dev", null, [{ type: "user_message", text: "hi" }, { type: "assistant_message", text: "own folder" }], { kind: "completed" }, "eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await finish("solo", "wks_1", [{ type: "user_message", text: "hi" }, { type: "assistant_message", text: "no team" }], { kind: "completed" }, "ffffffff-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(await records()).toEqual(before);
  });

  it("redacts secrets in the record and in the index", async () => {
    await finish("dev", "wks_1", [{ type: "user_message", text: "use password=hunter2hunter2 please" }, { type: "assistant_message", text: "ok, key sk-abcdefghijklmnopqrstuv" }], { kind: "completed" }, "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const record = (await records()).find((entry) => entry.chat.id.startsWith("99999999"));
    expect(record.question).toBe("use password=[redacted] please");
    expect(record.answer).toBe("ok, key [redacted]");
    expect(await dayFile("md")).not.toContain("hunter2");
  });
});
