import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import en from "../shared/locales/en.json";
import zhCN from "../shared/locales/zh-CN.json";
import { englishTranslate, isChineseLocale } from "../shared/translate";

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[path] = v;
    else Object.assign(out, flatten(v, path));
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
const pluralBase = (key: string) => key.replace(/_(one|other)$/, "");
const enFlat = flatten(en as Tree);
const zhFlat = flatten(zhCN as Tree);

function hasKey(key: string): boolean {
  return key in enFlat || `${key}_other` in enFlat || `${key}_one` in enFlat;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("i18n resources", () => {
  it("zh-CN keys are a subset of en keys with the same placeholders", () => {
    for (const [key, value] of Object.entries(zhFlat)) {
      const enKey = key in enFlat ? key : `${pluralBase(key)}_other`;
      expect(enFlat[enKey], `zh-CN key ${key} has no English key`).toBeDefined();
      expect(placeholders(value), key).toEqual(placeholders(enFlat[enKey]));
    }
  });

  it("locale tags are canonical and no segment contains a dot", () => {
    for (const tag of ["en", "zh-CN"]) expect(Intl.getCanonicalLocales(tag)[0]).toBe(tag);
    const segmentsOk = (tree: Tree): boolean =>
      Object.entries(tree).every(([k, v]) => !k.includes(".") && (typeof v === "string" || segmentsOk(v)));
    expect(segmentsOk(en as Tree)).toBe(true);
    expect(segmentsOk(zhCN as Tree)).toBe(true);
  });

  it("client/i18n/messages loads without throwing", async () => {
    await expect(import("../client/i18n/messages")).resolves.toBeDefined();
  });
});

describe("englishTranslate", () => {
  it("picks plural forms and interpolates", () => {
    expect(englishTranslate("text.journal.lines", { count: 1 })).toBe("1 line");
    expect(englishTranslate("text.journal.lines", { count: 0 })).toBe("0 lines");
    expect(englishTranslate("text.journal.lines", { count: 2 })).toBe("2 lines");
    expect(englishTranslate("common.settingsUnreadable")).toBe("Settings can't be read.");
  });
  it("throws for an unknown key", () => {
    expect(() => englishTranslate("no.such.key")).toThrow("Unknown translation key: no.such.key");
  });
});

describe("isChineseLocale", () => {
  it("accepts simplified Chinese tags only", () => {
    for (const l of ["zh-CN", "zh", "zh-Hans-CN"]) expect(isChineseLocale(l), l).toBe(true);
    for (const l of ["zh-TW", "zh-HK", "ja", "fr", "", undefined]) expect(isChineseLocale(l), String(l)).toBe(false);
  });
});

describe("translation key usage", () => {
  it("every literal key used under client/ exists in en.json", () => {
    const files = [...walk("client"), "index.client.tsx"];
    const re = /(?:\bt|messages\.message)\(\s*["']([A-Za-z0-9_.]+)["']/g;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(re)) expect(hasKey(m[1]), `${f}: ${m[1]}`).toBe(true);
    }
  });
});

describe("translation consistency", () => {
  // Groups of keys that share an English value on purpose.
  const DUPLICATE_ALLOWED: string[][] = [
    // Separators: the Chinese list separators are not the same punctuation as the English ones may become.
    ["text.change.listSep", "text.schedule.daySep"],
    // A default assistant name (a noun phrase) versus the "New assistant" action.
    ["host.newBot", "templates.newBotName"],
    // Same English words, different things opened (an assistant versus a file).
    ["teams.openBot", "attachment.openFile"],
    // The same words as a tab name and as a settings section title.
    ["teams.otherBots", "panel.otherBots"],
    // A status word (the Done bucket) and a button label (the avatar editor): Chinese reads 已完成 and 完成.
    ["text.bucket.done", "panel.done"],
    // The same words in the settings screen and in the assistant's own page.
    ["settings.setup.title", "panel.setUp"],
    ["settings.defaults.contact", "panel.contactBots"],
    // A group heading and the default name of a role: both are the plain noun.
    ["panel.group.bot", "templates.assistant.name"],
  ];

  it("no two keys share an English value (plural forms and the allowlist aside)", () => {
    const byValue = new Map<string, string[]>();
    for (const [key, value] of Object.entries(enFlat)) byValue.set(value, [...(byValue.get(value) ?? []), key]);
    const problems: string[] = [];
    for (const [value, keys] of byValue) {
      if (keys.length < 2) continue;
      if (new Set(keys.map(pluralBase)).size === 1) continue;
      const allowed = DUPLICATE_ALLOWED.some((group) => keys.every((k) => group.includes(k)));
      if (!allowed) problems.push(`${JSON.stringify(value)}: ${keys.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("zh-CN uses full-width punctuation next to Chinese text", () => {
    const strip = (v: string) => v.replace(/\{\{\w+\}\}/g, "").replace(/`[^`]*`/g, "").replace(/\w+:\/\/\S*/g, "").replace(/\w:[\w\\]/g, "").replace(/\{"\w+": \{[^}]*\}\}/g, "");
    const problems: string[] = [];
    for (const [key, value] of Object.entries(zhFlat)) {
      if (!/[\u4e00-\u9fff]/.test(value)) continue;
      const rest = strip(value);
      if (/[,:?!()]/.test(rest) || rest.includes("...")) problems.push(`${key}: ${value}`);
    }
    expect(problems).toEqual([]);
  });

  it("zh-CN has no 智能体 (Agent stays Agent) and no 技能与工具 (it is 技能和工具)", () => {
    const problems = Object.entries(zhFlat).filter(([, v]) => v.includes("智能体") || v.includes("技能与工具")).map(([k, v]) => `${k}: ${v}`);
    expect(problems).toEqual([]);
  });

  it("one English common word has one Chinese word", () => {
    const words = ["Delete", "Cancel", "Save", "Add", "Remove", "Edit", "Done", "On", "Off", "Approve", "Approval", "Skill", "Skills"];
    for (const word of words) {
      const keys = Object.keys(enFlat).filter((k) => enFlat[k].toLowerCase() === word.toLowerCase() && k in zhFlat && k !== "panel.done"); // panel.done is a button (完成), the status is 已完成
      if (keys.length === 0) continue;
      const chinese = new Set(keys.map((k) => zhFlat[k]));
      expect([...chinese], `${word}: ${keys.join(", ")}`).toHaveLength(1);
    }
  });
});

// ---- Gates ----

const KEY_SHAPE = /["'`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)["'`]/g;

// Keys read from a variable. Each entry is a key PREFIX and says where the dynamic read is.
const DYNAMIC_PREFIXES: Array<[string, string]> = [
  ["text.schedule.dayShort.", "shared/routines.ts: t(`text.schedule.dayShort.${day}`) for each weekday number"],
  ["text.schedule.dayPlural.", "shared/routines.ts: t(`text.schedule.dayPlural.${dayOfWeek}`)"],
  ["text.approval.status.", "shared/approvals.ts: t(`text.approval.status.${approval.status}`)"],
  ["text.bucket.", "shared/sidebar.ts: t(`text.bucket.${bucket}`)"],
  ["text.tool.", "shared/tools.ts: key built as `text.tool.${leaf}` from the tool name"],
];

function sourceFiles(): { client: string[]; other: string[] } {
  const shared = readdirSync("shared").filter((n) => n.endsWith(".ts")).map((n) => join("shared", n));
  return { client: [...walk("client"), "index.client.tsx"], other: [...shared, ...walk("server")] };
}

function usedKeys(): Set<string> {
  const used = new Set<string>();
  const { client, other } = sourceFiles();
  const call = /(?:\bt|messages\.message)\(\s*["']([A-Za-z0-9_.]+)["']/g;
  for (const f of client) for (const m of readFileSync(f, "utf8").matchAll(call)) used.add(m[1]);
  for (const f of [...client, ...other]) for (const m of readFileSync(f, "utf8").matchAll(KEY_SHAPE)) used.add(m[1]);
  return used;
}

function unusedKeys(used: Set<string>, keys: string[], prefixes: string[]): string[] {
  return keys.filter((k) => {
    const base = pluralBase(k);
    return !used.has(k) && !used.has(base) && !prefixes.some((p) => k.startsWith(p));
  });
}

describe("gate: every English key is used", () => {
  it("finds an unused key (scanner check)", () => {
    expect(unusedKeys(new Set(["a.b"]), ["a.b", "a.c_one", "a.c_other", "x.y.z"], ["x.y."])).toEqual(["a.c_one", "a.c_other"]);
  });
  it("no key of en.json is unused", () => {
    const unused = unusedKeys(usedKeys(), Object.keys(enFlat), DYNAMIC_PREFIXES.map(([p]) => p));
    expect(unused, `Unused keys (delete them, or add a prefix with a reason to DYNAMIC_PREFIXES):\n${unused.join("\n")}`).toEqual([]);
  });
});

/**
 * Finds calls of `t(` or `useT(` that run when the module loads (outside every function body).
 * A simple scan: comments and strings are skipped, braces, parens and brackets are tracked, a `{`
 * after `)` or `=>` opens a function body, and a `=>` marks the rest of its statement as inside a function.
 */
export function moduleLevelTranslateCalls(src: string): Array<{ line: number; name: string }> {
  type Frame = { fn: boolean; arrow: boolean };
  const stack: Frame[] = [{ fn: false, arrow: false }];
  const found: Array<{ line: number; name: string }> = [];
  let line = 1;
  let lastWord = "";
  let prevSig = ""; // last significant (non-space) text, enough to see `)`, `=>`
  const inFn = () => stack.some((f) => f.fn || f.arrow);
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === "\n") { line++; i++; continue; }
    if (two === "//") { while (i < n && src[i] !== "\n") i++; continue; }
    if (two === "/*") { const end = src.indexOf("*/", i + 2); const stop = end < 0 ? n : end + 2; line += (src.slice(i, stop).match(/\n/g) ?? []).length; i = stop; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") i++; i++; }
      if (src[i] === c) i++;
      prevSig = "str";
      continue;
    }
    if (c === "`") {
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "\n") line++;
        if (depth === 0 && src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
        if (depth > 0 && src[i] === "{") depth++;
        if (depth > 0 && src[i] === "}") depth--;
        i++;
      }
      i++;
      prevSig = "str";
      continue;
    }
    if (c === "/" && (["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "=>", ""].includes(prevSig) || (prevSig === "id" && lastWord === "return"))) {
      // a regular expression literal: skip it (a `[...]` class may hold a `/`)
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      prevSig = "str";
      continue;
    }
    if (two === "=>") { stack[stack.length - 1].arrow = true; prevSig = "=>"; i += 2; continue; }
    if (c === "{") {
      stack.push({ fn: prevSig === ")" || prevSig === "=>" || /\)\s*:\s*(?:[\w.<>\[\] |&,]|\{[^{}]*\})+\s*$/.test(src.slice(Math.max(0, i - 200), i)), arrow: false });
      prevSig = "{"; i++; continue;
    }
    if (c === "(" || c === "[") { stack.push({ fn: false, arrow: false }); prevSig = c; i++; continue; }
    if (c === "}" || c === ")" || c === "]") { if (stack.length > 1) stack.pop(); prevSig = c; i++; continue; }
    if (c === ";" || c === ",") { stack[stack.length - 1].arrow = false; prevSig = c; i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!;
      const word = m[0];
      const before = src[i - 1];
      const after = src.slice(i + word.length).match(/^\s*\(/);
      const declared = /\bfunction\s+$/.test(src.slice(Math.max(0, i - 12), i));
      if ((word === "t" || word === "useT") && after && before !== "." && !declared && !inFn()) found.push({ line, name: word });
      i += word.length;
      prevSig = "id";
      lastWord = word;
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return found;
}

describe("gate: no translation call at module level", () => {
  it("the scanner finds a violation (scanner check)", () => {
    const bad = [
      "import { useT } from './x';",
      "// t('in a comment') and 'don\\'t'",
      "const OK = (t: Translate = englishTranslate) => t('a');",
      "const LABEL = t('module level');",
      "const OBJ = { title: t('in an object') };",
      "const HOOK = useT();",
      "function ok() { return t('b'); }",
      "export function Comp(): JSX.Element { const t = useT(); return <A label={t('c')} />; }",
      "const F = () =>\n  t('d');",
      "const G = foo(t('arg'));",
    ].join("\n");
    expect(moduleLevelTranslateCalls(bad)).toEqual([
      { line: 4, name: "t" },
      { line: 5, name: "t" },
      { line: 6, name: "useT" },
      { line: 11, name: "t" },
    ]);
  });

  it("no client/ or shared/ module calls t or useT while loading", () => {
    const shared = readdirSync("shared").filter((f) => f.endsWith(".ts")).map((f) => join("shared", f));
    const files = [...walk("client"), "index.client.tsx", ...shared];
    const problems: string[] = [];
    for (const f of files) for (const hit of moduleLevelTranslateCalls(readFileSync(f, "utf8"))) problems.push(`${f}:${hit.line} ${hit.name}(`);
    expect(problems).toEqual([]);
  });
});

// Best effort: literal English in a visible-text prop. Files here may keep such text on purpose.
const ENGLISH_LITERAL_ALLOWLIST: Array<[string, string]> = [
  ["client/chat/Composer.tsx", "the deny message of an interrupted permission request goes to the agent, not to the user"],
  ["client/chat/Permission.tsx", "the deny message of a refused permission goes to the agent"],
  ["client/chat/stream/QuestionForm.tsx", "the deny message of a dismissed question goes to the agent"],
  ["client/library/SkillSheets.tsx", "an example path a user types (placeholder), not a sentence"],
];

const TEXT_PROPS = "title|label|hint|info|placeholder|description|actionLabel|confirmLabel|cancelLabel|accessibilityLabel|text|message";

/** String literals that look like visible English in a JSX attribute or object property with a text-like name. */
export function englishLiterals(src: string): string[] {
  const re = new RegExp(`\\b(?:${TEXT_PROPS})\\s*(?:=\\s*\\{?|:)\\s*(["'])([A-Z][^"'\\n]*?)\\1`, "g");
  return [...src.matchAll(re)].map((m) => m[2]).filter((text) => text.includes(" ") && (text.match(/[A-Za-z]/g) ?? []).length >= 3);
}

// One-word capitalised literals (Resize, Copied, Confirm) that the sentence rule above cannot see.
// These words stay as they are: names of products, protocols and formats, not UI words.
const WORD_ALLOWLIST = new Set([
  "Aydo", // the product name
  "JSON", // a file format (the MCP server import text)
  "SSE", // the MCP transport name (Server-Sent Events)
  "MCP", // the protocol name
  "URL", // a technical term
  "HTTP", // a protocol name
]);

/**
 * One-word capitalised literals in a visible-text prop (`label="Resize"`), a property (`label: "Done"`)
 * or an assignment (`const label = x ?? "Confirm"`), including each branch of a ternary inside the value.
 * The value runs to the next `,`, `;`, `}` or line end, so a literal in a later JSX attribute is not taken.
 */
export function oneWordLiterals(src: string): string[] {
  const found: string[] = [];
  for (const m of src.matchAll(new RegExp(`\\b(?:${TEXT_PROPS})\\s*(?:=|:)\\s*`, "g"))) {
    const rest = src.slice(m.index! + m[0].length).replace(/^\{\s*/, "");
    const direct = /^(["'`])([A-Z][A-Za-z-]*)\1/.exec(rest);
    const end = rest.search(/[,;}\n]/);
    const value = direct ? direct[0] : end < 0 ? rest : rest.slice(0, end);
    for (const word of value.matchAll(/(["'`])([A-Z][A-Za-z-]*)\1/g)) if (!WORD_ALLOWLIST.has(word[2])) found.push(word[2]);
  }
  return found;
}

describe("gate: no one-word English in visible props", () => {
  it("the scanner finds one-word literals (scanner check)", () => {
    const src = `<View accessibilityLabel="Resize" icon="Plus" />\nconst o = { label: "SSE", text: copied ? "Copied" : "Copy code", title: "Aydo" };\nconst cancelLabel = input.cancelLabel ?? "Cancel";`;
    expect(oneWordLiterals(src)).toEqual(["Resize", "Copied", "Cancel"]);
  });

  it("visible props hold no one-word English under client/", () => {
    const problems: string[] = [];
    for (const f of [...walk("client"), "index.client.tsx"]) {
      const hits = oneWordLiterals(readFileSync(f, "utf8"));
      if (hits.length > 0) problems.push(`${f}: ${hits.map((h) => JSON.stringify(h)).join(", ")}`);
    }
    expect(problems, `One-word English in a visible prop (use t("key"), or add the word to WORD_ALLOWLIST with a reason):\n${problems.join("\n")}`).toEqual([]);
  });
});

describe("gate: no hard-coded English in visible props", () => {
  it("the scanner finds English literals (scanner check)", () => {
    const src = `<Button label="Save changes" title={"Open the file"} hint='Pick one' text="OK" placeholder={t("a.b")} />\nconst o = { description: "Plain text here", id: "Not a prop" };`;
    expect(englishLiterals(src)).toEqual(["Save changes", "Open the file", "Pick one", "Plain text here"]);
  });

  it("only allowlisted client files hold such literals", () => {
    const allowed = new Set(ENGLISH_LITERAL_ALLOWLIST.map(([f]) => f));
    const problems: string[] = [];
    for (const f of [...walk("client"), "index.client.tsx"]) {
      const normalized = f.replaceAll("\\", "/");
      if (allowed.has(normalized)) continue;
      const hits = englishLiterals(readFileSync(f, "utf8"));
      if (hits.length > 0) problems.push(`${normalized}: ${hits.map((h) => JSON.stringify(h)).join(", ")}`);
    }
    expect(problems, `Visible English that was not converted (use t("key"), or add the file to ENGLISH_LITERAL_ALLOWLIST with a reason):\n${problems.join("\n")}`).toEqual([]);
  });
});

// English texts that reach the user through a toast or an error, by their text (not by file).
// Each one is sent to the agent or is kept English on purpose.
const TOAST_LITERAL_ALLOWLIST: Array<[string, string]> = [
  ["Interrupted by the user.", "the deny message of an interrupted permission request goes to the agent"],
  ["Denied by user", "the deny message of a refused permission goes to the agent"],
  ["Dismissed by user", "the deny message of a dismissed question goes to the agent"],
  ["See the attached files.", "text sent to the agent with attachments"],
  ["Pasted text (N words)", "attachment title, kept English on purpose"],
];

/**
 * English sentences (two or more words, starting with a capital) in a `toast.error(`, `toast.show(` or
 * `new Error(` line. A `${...}` placeholder counts as "N". Best effort: a text built across lines is not seen.
 */
export function englishErrorLiterals(src: string): string[] {
  const found: string[] = [];
  for (const line of src.split("\n")) {
    if (!/\b(?:toast\.(?:error|show)|new Error)\(/.test(line)) continue;
    for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      const text = m[2].replace(/\$\{[^}]*\}/g, "N");
      if (!/^[A-Z]/.test(text)) continue;
      if ((text.match(/[A-Za-z']+/g) ?? []).length < 2) continue;
      found.push(text);
    }
  }
  return found;
}

describe("gate: no English sentence in a toast or an error", () => {
  it("the scanner finds such literals (scanner check)", () => {
    const src = [
      'toast.error("Couldn\'t open the link.");',
      "toast.show(`Path copied`, { variant: \"success\" });",
      'throw new Error(t("a.b"));',
      "reject(new Error(`Couldn't read ${file.name}.`));",
      'toast.error(t("x.y"));',
      'onRespond({ behavior: "deny", message: "Dismissed by user" });',
    ].join("\n");
    expect(englishErrorLiterals(src)).toEqual(["Couldn't open the link.", "Path copied", "Couldn't read N."]);
  });

  it("toast and error texts under client/ are translated or allowlisted", () => {
    const allowed = new Set(TOAST_LITERAL_ALLOWLIST.map(([text]) => text));
    const problems: string[] = [];
    for (const f of [...walk("client"), "index.client.tsx"]) {
      const hits = englishErrorLiterals(readFileSync(f, "utf8")).filter((h) => !allowed.has(h));
      if (hits.length > 0) problems.push(`${f}: ${hits.map((h) => JSON.stringify(h)).join(", ")}`);
    }
    expect(problems, `English in a toast or error (use t("key"), or add the text to TOAST_LITERAL_ALLOWLIST with a reason):\n${problems.join("\n")}`).toEqual([]);
  });
});
