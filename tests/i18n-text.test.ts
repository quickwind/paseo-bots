import { describe, expect, it } from "vitest";
import zh from "../shared/locales/zh-CN.json";
import { approvalSummary, type ApprovalSummary } from "../shared/approvals";
import { dayName, journalSource, journalSummary } from "../shared/activity";
import { botLimits, botProblems } from "../shared/bot";
import { formatDuration } from "../shared/markdown";
import { relativeTime } from "../shared/time";
import { makeBot } from "./helpers";
import { changeWarnings, ChangesSchema, describeChange } from "../shared/changes";
import { displayTitle } from "../shared/chat";
import { projectFoldersNote } from "../shared/folder-access";
import { describeCron, describeSchedule } from "../shared/routines";
import { afterSetupNotes } from "../shared/setup";
import { BUCKET_LABELS, bucketLabel, type ChatBucket } from "../shared/sidebar";
import { humanizeToolName } from "../shared/tools";
import { BOT_TEMPLATES, botFromPreset, newBot, templateText } from "../shared/templates";
import { englishTranslate, type Translate } from "../shared/translate";
import en from "../shared/locales/en.json";

type Tree = { [k: string]: string | Tree };

/** A Chinese translator built from zh-CN.json the way the client's i18next would (plural form by count, {{name}}). */
const tz: Translate = (key, options) => {
  const find = (path: string): string | undefined => {
    let node: string | Tree | undefined = zh as Tree;
    for (const part of path.split(".")) {
      if (typeof node !== "object") return undefined;
      node = node[part];
    }
    return typeof node === "string" ? node : undefined;
  };
  let text: string | undefined;
  if (typeof options?.count === "number") text = find(`${key}_${new Intl.PluralRules("zh-CN").select(options.count)}`) ?? find(`${key}_other`);
  text ??= find(key);
  if (text === undefined) throw new Error(`missing zh key ${key}`);
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (options?.[name] === undefined ? whole : String(options[name])));
};

const chinese = (text: string) => {
  expect(text).not.toContain("{{");
  expect(text).toMatch(/[一-鿿]/);
};

const changes = ChangesSchema.parse([
  { type: "create_bot", name: "Pixel", title: "Helper", provider: "claude", model: "opus", skills: ["a", "b"] },
  { type: "update_bot", bot: "Scout", mode: "plan", allow_tools: ["x/y"], archived: true, pinned: true, contact_bots: "allow", working_folder: "/tmp/w" },
  { type: "delete_bot", bot: "Chief" },
  { type: "add_routine", bot: "Scout", name: "Daily", schedule: { type: "interval", every_minutes: 30 }, instructions: "Check mail" },
  { type: "update_routine", bot: "Scout", routine: "Daily", name: "Mail", enabled: false },
  { type: "delete_routine", bot: "Scout", routine: "Daily" },
  { type: "create_team", name: "Studio", lead: "Juno", members: ["Juno", "Mika"], ask_freely: true },
  { type: "update_team", team: "Ops", lead: null, add_members: ["A"], ask_freely: false },
  { type: "delete_team", team: "Ops" },
  { type: "set_skill", skill: "s", enabled: true },
  { type: "add_mcp_server", name: "files", command: "npx", args: ["files-mcp"], env: { A: "1" } },
  { type: "add_mcp_server", name: "api", url: "https://example.com/mcp" },
  { type: "set_mcp_server", server: "api", enabled: true },
  { type: "remove_mcp_server", server: "api" },
  { type: "set_defaults", contact_bots: "allow" },
  { type: "save_preset", bot: "Scout" },
  { type: "delete_preset", preset: "P" },
]);

describe("describeChange and changeWarnings", () => {
  it("keeps English output", () => {
    expect(describeChange(changes[2]!)).toBe("**Delete assistant Chief**; its chats stay in Paseo's history");
    expect(describeChange(changes[4]!)).toBe('**Scout**: routine "Daily" renamed to "Mail"; paused');
    expect(describeChange(changes[0]!)).toContain("**New assistant Pixel**: ");
    expect(changeWarnings(changes)).toContain("Deletes the assistant Chief.");
    expect(changeWarnings(changes)).toContain("Scout runs in approval mode \"plan\".");
  });
  it("gives Chinese with nothing left over", () => {
    for (const change of changes) chinese(describeChange(change, tz));
    for (const line of changeWarnings(changes, tz)) chinese(line);
    expect(describeChange(changes[2]!, tz)).toBe("**删除助理 Chief**；其聊天仍保留在 Paseo 的历史记录中");
    expect(changeWarnings(changes, tz)).toContain("删除助理 Chief。");
  });
  it("says the length of a long text with a count", () => {
    const [long] = ChangesSchema.parse([{ type: "create_team", name: "T", instructions: "x".repeat(300) }]);
    expect(describeChange(long!)).toContain("(300 characters)");
    expect(describeChange(long!, tz)).toContain("共 300 个字符");
  });
});

describe("afterSetupNotes", () => {
  const bot = (tidy: Partial<{ enabled: boolean; everyMinutes: number; source: "public" | "bot" | "model"; model: string | null }>) => ({
    provider: "claude",
    model: "opus" as string | null,
    memory: { tidy: { enabled: true, everyMinutes: 240, source: "public" as const, model: null, ...tidy } },
  });
  it("keeps English", () => {
    expect(afterSetupNotes(bot({}))).toEqual([
      "**Model:** opus on claude. Change it in this assistant's settings, under Model.",
      "**Memory tidy:** on, every 4 hours, with a model from Paseo's Metadata generation list. Change it in this assistant's settings, under Memory.",
    ]);
  });
  it("gives Chinese", () => {
    for (const tidy of [{}, { enabled: false }, { everyMinutes: 1440 }, { everyMinutes: 60, source: "bot" as const }, { everyMinutes: 45 }]) for (const line of afterSetupNotes(bot(tidy), tz)) chinese(line);
    expect(afterSetupNotes(bot({ everyMinutes: 1440 }), tz)[1]).toContain("每天");
  });
});

describe("schedules", () => {
  const schedules = [
    { kind: "webhook" as const },
    { kind: "interval" as const, minutes: 120 },
    { kind: "interval" as const, minutes: 30 },
    { kind: "daily" as const, time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    { kind: "daily" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    { kind: "daily" as const, time: "09:00", weekdays: [1, 3] },
    { kind: "cron" as const, expression: "*/5 * * * *" },
    { kind: "once" as const, at: "2030-01-01T10:00:00.000Z" },
  ];
  it("keeps English", () => {
    expect(describeSchedule(schedules[0]!)).toBe("When its webhook is called");
    expect(describeSchedule(schedules[1]!)).toBe("Every 2h");
    expect(describeSchedule(schedules[2]!)).toBe("Every 30 min");
    expect(describeSchedule(schedules[5]!)).toBe("Mon, Wed at 09:00");
    expect(describeCron("0 9 * * 1")).toBe("Mondays at 09:00");
    expect(describeCron("15 */2 * * *")).toBe("Every 2 hours at :15");
  });
  it("gives Chinese", () => {
    for (const schedule of schedules) chinese(describeSchedule(schedule, tz));
    for (const cron of ["* * * * *", "*/5 * * * *", "0 * * * *", "15 * * * *", "0 */2 * * *", "15 */2 * * *", "0 9 * * *", "0 9 * * 1-5", "0 9 * * 0,6", "0 9 * * 1"]) chinese(describeCron(cron, tz)!);
    expect(describeCron("0 9 * * 1", tz)).toBe("每周一 09:00");
    expect(describeCron("0 0 1 1 *", tz)).toBeNull();
  });
});

describe("activity wording", () => {
  const row = { file: "MEMORY.md", actor: "bot" as const, via: "chat" as const, chat: { title: "x" }, kind: "edited" as const, added: 2, removed: 0 };
  it("keeps English with counts 0, 1 and 2", () => {
    expect(journalSummary({ ...row, kind: "created", added: 1 }, "Scout")).toBe("Scout created MEMORY.md with 1 line");
    expect(journalSummary({ ...row, kind: "created", added: 0 }, "Scout")).toBe("Scout created MEMORY.md");
    expect(journalSummary({ ...row, removed: 2, added: 0, file: "a.md" }, "Scout")).toBe("Scout removed 2 lines from the a topic");
  });
  it("gives Chinese", () => {
    for (const added of [0, 1, 2]) for (const kind of ["created", "edited", "deleted"] as const) chinese(journalSummary({ ...row, kind, added }, "Scout", tz));
    chinese(journalSummary({ ...row, actor: "you", added: 1, removed: 1, file: "a.md" }, "Scout", tz));
    expect(journalSummary(row, "Scout", tz)).toBe("Scout向MEMORY.md添加了 2 行");
  });
  it("names days", () => {
    const now = new Date(2026, 8, 27, 12);
    expect(dayName("2026-09-27", now)).toBe("Today");
    expect(dayName("2026-09-26", now)).toBe("Yesterday");
    expect(dayName("2026-09-27", now, { t: tz })).toBe("今天");
    expect(dayName("2026-09-26", now, { t: tz })).toBe("昨天");
    expect(dayName("2026-09-20", now, { t: tz, locale: "zh-CN" })).toBe(new Date(2026, 8, 20).toLocaleDateString("zh-CN", { weekday: "short", month: "short", day: "numeric" }));
    expect(dayName("2026-09-20", now, { locale: "en-US" })).toBe("Sun, Sep 20");
  });
});

describe("approvalSummary", () => {
  const entry = (patch: Partial<ApprovalSummary>) => ({ botName: "Scout", title: "Ship it", status: "pending", note: "", ...patch }) as ApprovalSummary;
  it("keeps English", () => {
    expect(approvalSummary(entry({}))).toBe('Scout · "Ship it" · waiting for you');
    expect(approvalSummary(entry({ status: "rejected", note: " too  risky " }))).toBe('Scout · "Ship it" · rejected: too risky');
    expect(approvalSummary(entry({ status: "withdrawn", note: "x" }))).toBe('Scout · "Ship it" · withdrawn');
  });
  it("gives Chinese", () => {
    for (const status of ["pending", "approved", "rejected", "withdrawn"] as const) chinese(approvalSummary(entry({ status, note: "好" }), tz));
    expect(approvalSummary(entry({ status: "approved", note: "ok" }), tz)).toBe("Scout · “Ship it” · 已批准:ok");
  });
});

describe("small labels", () => {
  it("humanizes tool names", () => {
    expect(humanizeToolName("mcp__paseo__create_agent")).toBe("Create agent");
    expect(humanizeToolName("mcp__bots__search_chats")).toBe("Search chats");
    expect(humanizeToolName("web_search")).toBe("Web search");
    expect(humanizeToolName("mcp__paseo__create_agent", tz)).toBe("创建 Agent");
    expect(humanizeToolName("mcp__paseo__some_unknown_tool", tz)).toBe("Some unknown tool");
    expect(humanizeToolName("web_search", tz)).toBe("Web search");
  });
  it("titles chats", () => {
    expect(displayTitle("[Scout] Plan")).toBe("Plan");
    expect(displayTitle(null)).toBe("New chat");
    expect(displayTitle("", tz)).toBe("新建聊天");
    expect(displayTitle("Plan", tz)).toBe("Plan");
  });
  it("labels buckets", () => {
    expect(bucketLabel("needs_input")).toBe("Needs input");
    for (const bucket of Object.keys(BUCKET_LABELS) as ChatBucket[]) {
      expect(bucketLabel(bucket)).toBe(BUCKET_LABELS[bucket]);
      chinese(bucketLabel(bucket, tz));
    }
  });
  it("notes project folders", () => {
    expect(projectFoldersNote("antigravity")).toBe("It never asks for approval. Its tools are files, since it cannot take the plugin's MCP server.");
    expect(projectFoldersNote("other")).toBe("");
    expect(projectFoldersNote("other", undefined, tz)).toBe("");
    for (const provider of ["claude", "devin", "antigravity"]) chinese(projectFoldersNote(provider, undefined, tz));
  });
});

describe("shared helpers with t", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  it("relative time", () => {
    const cases: [number, string, string][] = [
      [0, "just now", "刚刚"],
      [59, "just now", "刚刚"],
      [60, "1m ago", "1分钟前"],
      [150, "3m ago", "3分钟前"],
      [3600, "1h ago", "1小时前"],
      [3 * 3600, "3h ago", "3小时前"],
      [86400, "1d ago", "1天前"],
      [2 * 86400, "2d ago", "2天前"],
    ];
    for (const [seconds, en, cn] of cases) {
      expect(relativeTime(ago(seconds), now)).toBe(en);
      expect(relativeTime(ago(seconds), now, tz)).toBe(cn);
    }
    expect(relativeTime(ago(40 * 86400), now, tz)).toBe("2026-08-17");
    expect(relativeTime(null, now, tz)).toBe("");
  });
  it("durations", () => {
    const cases: [number, string, string][] = [
      [400, "0s", "0秒"],
      [24_900, "24s", "24秒"],
      [132_000, "2m 12s", "2分12秒"],
      [120_000, "2m", "2分"],
      [3_900_000, "1h 5m", "1小时5分"],
      [3_600_000, "1h", "1小时"],
      [-1, "0s", "0秒"],
    ];
    for (const [ms, en, cn] of cases) {
      expect(formatDuration(ms)).toBe(en);
      expect(formatDuration(ms, tz)).toBe(cn);
    }
  });
  it("bot limits", () => {
    const routine = { id: "r", name: "r", prompt: "p", enabled: true, schedule: { kind: "webhook" as const }, resultsChatId: null, createdAt: "" };
    for (const bot of [makeBot(), makeBot({ contactBots: "off" }), makeBot({ modeId: "bypassPermissions", contactBots: "allow", routines: [routine] })]) {
      for (const local of [true, false]) {
        const lines = botLimits(bot, { local }, tz);
        expect(lines).toHaveLength(botLimits(bot, { local }).length);
        for (const line of lines) chinese(line);
      }
    }
    expect(botLimits(makeBot(), { local: true })).toHaveLength(4);
  });
  it("bot problems", () => {
    const bad = makeBot({ name: " ", provider: "", cwd: "", soul: "x".repeat(25_000) });
    expect(botProblems(bad, false)).toEqual(["Give the assistant a name.", "Pick an agent provider.", "Pick a working folder on the selected host.", "Standing instructions are over 24 KB."]);
    const cn = botProblems(bad, false, tz);
    expect(cn).toHaveLength(4);
    for (const line of cn) chinese(line);
    expect(cn[3]).toContain("24");
  });
  it("journal sources", () => {
    const row = { via: "app", chat: null } as never;
    expect(journalSource({ via: "undo" } as never)).toBe("undo");
    expect(journalSource({ via: "disk" } as never)).toBe("changed outside the app");
    expect(journalSource({ via: "app", chat: { id: "c", title: "Plan" } } as never)).toBe('from chat "Plan"');
    expect(journalSource(row)).toBe("in the assistant's settings");
    for (const r of [{ via: "undo" }, { via: "disk" }, { via: "app", chat: { id: "c", title: "Plan" } }, row]) chinese(journalSource(r as never, tz));
    expect(journalSource({ via: "app", chat: { id: "c", title: "Plan" } } as never, tz)).toContain("Plan");
  });
});

describe("names made at creation", () => {
  const has = (tree: Tree, path: string) => typeof path.split(".").reduce<string | Tree | undefined>((node, part) => (typeof node === "object" ? node[part] : undefined), tree) === "string";
  it("names a blank assistant in the language of the moment", () => {
    expect(newBot("claude").name).toBe("New assistant");
    expect(newBot("claude", undefined, tz).name).toBe("新助理");
    expect(botFromPreset("claude", { ...newBot("claude"), name: "Mine", createdAt: "" } as never, tz).name).toBe("Mine");
  });
  it("gives each template its name, title and description in both languages, and keeps the soul", () => {
    for (const template of BOT_TEMPLATES) {
      expect(templateText(template, englishTranslate)).toEqual({ name: template.name, title: template.title, description: template.description });
      const zhText = templateText(template, tz);
      for (const value of Object.values(zhText)) chinese(value);
      expect(newBot("claude", template, tz).soul).toBe(newBot("claude", template).soul);
      expect(newBot("claude", template, tz).name).toBe(zhText.name);
      expect(newBot("claude", template).name).toBe(template.name);
      for (const key of [template.nameKey, template.titleKey, template.descriptionKey]) {
        expect(has(en as Tree, key)).toBe(true);
        expect(has(zh as Tree, key)).toBe(true);
      }
    }
  });
  it("names a copy in the language of the moment", () => {
    expect(tz("templates.copyName", { name: "Ada" })).toBe("Ada 副本");
  });
});
