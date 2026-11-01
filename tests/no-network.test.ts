import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotSchema, buildAgentConfig, isLoopbackUrl, isRemoteMcp, parseMcpJson, type Library, type LibraryMcpServer } from "../shared/bot";
import { mcpServerCanEnable } from "../shared/library";
import { isLocalFolder, parseSkillFolder } from "../shared/skills";
import { makeBot } from "./helpers";

// This build makes no network connections of its own. These tests hold it to that.

const savedHome = process.env.PASEO_HOME;

beforeEach(async () => {
  process.env.PASEO_HOME = await mkdtemp(join(tmpdir(), "bots-nonet-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = savedHome;
});

describe("skills come from a folder on this computer", () => {
  it("accepts a full path and refuses a GitHub name or a web address", () => {
    for (const ok of ["/home/me/skills", "~/skills", "~", "C:\\skills", "D:/skills", "\\\\server\\share\\skills"]) {
      expect(isLocalFolder(ok)).toBe(true);
      expect(parseSkillFolder(`  ${ok}  `)).toBe(ok);
    }
    for (const bad of ["anthropics/skills", "owner/repo/path", "https://github.com/o/r", "https://example.com/SKILL.md", "skills", "./skills"]) {
      expect(isLocalFolder(bad)).toBe(false);
      expect(() => parseSkillFolder(bad)).toThrow("full path of a folder on this computer");
    }
  });

  it("copies every skill under a folder into the library, without touching the network", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const root = await mkdtemp(join(tmpdir(), "skills-src-"));
    await mkdir(join(root, "pdf", "refs"), { recursive: true });
    await writeFile(join(root, "pdf", "SKILL.md"), "---\nname: PDF Tools\ndescription: Work with PDFs\n---\nSteps");
    await writeFile(join(root, "pdf", "refs", "notes.txt"), "reference text");
    await writeFile(join(root, "pdf", "blob.bin"), "a\0b");
    await symlink("/etc/hosts", join(root, "pdf", "link.txt")).catch(() => {});
    await mkdir(join(root, "nested", "inner"), { recursive: true });
    await writeFile(join(root, "nested", "SKILL.md"), "---\nname: nested\ndescription: Outer\n---");
    await writeFile(join(root, "nested", "inner", "SKILL.md"), "---\nname: inner\ndescription: Inner\n---");
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "SKILL.md"), "---\nname: dep\n---");

    const { importSkills, librarySkillPath } = await import("../server/library");
    const { skills } = await importSkills({ source: root });

    expect(skills.map((skill) => skill.id).sort()).toEqual(["inner", "nested", "pdf-tools"]);
    expect(skills.find((skill) => skill.id === "pdf-tools")).toMatchObject({ description: "Work with PDFs", source: join(root, "pdf") });
    const copied = await readdir(librarySkillPath("pdf-tools"), { recursive: true });
    expect([...copied].sort()).toEqual(["SKILL.md", "refs", "refs/notes.txt".replaceAll("/", copied.some((name) => name.includes("\\")) ? "\\" : "/")].sort());
    expect(await readFile(join(librarySkillPath("pdf-tools"), "refs", "notes.txt"), "utf8")).toBe("reference text");
    // The nested skill is its own skill, not part of its parent.
    expect(await readdir(librarySkillPath("nested"))).toEqual(["SKILL.md"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains a path that is not a folder, or holds no skill", async () => {
    const { importSkills } = await import("../server/library");
    const empty = await mkdtemp(join(tmpdir(), "skills-empty-"));
    await expect(importSkills({ source: join(empty, "missing") })).rejects.toThrow("isn't a folder on this computer");
    await expect(importSkills({ source: empty })).rejects.toThrow("No SKILL.md found");
  });
});

describe("MCP servers are the agent's to connect to, never the plugin's", () => {
  const server = (id: string, config: LibraryMcpServer["config"], patch: Partial<LibraryMcpServer> = {}): LibraryMcpServer => ({
    id,
    name: id,
    description: "",
    enabled: true,
    config,
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: "",
    updatedAt: "",
    ...patch,
  });

  it("knows which addresses are this computer", () => {
    for (const local of ["http://localhost:3000/mcp", "https://LOCALHOST/mcp", "http://127.0.0.1:9/x", "http://127.9.8.7/x", "http://[::1]:8080/mcp", "http://tools.localhost/mcp"]) {
      expect(isLoopbackUrl(local)).toBe(true);
    }
    for (const remote of ["https://mcp.example.com/mcp", "http://10.0.0.5/mcp", "http://192.168.1.2/mcp", "http://127.0.0.1.evil.com/mcp", "http://localhost.evil.com/mcp", "ftp://localhost/x", "not a url", ""]) {
      expect(isLoopbackUrl(remote)).toBe(false);
    }
  });

  it("calls a server remote when it is not a program here or an address here", () => {
    expect(isRemoteMcp({ type: "stdio", command: "npx", args: [], env: {} })).toBe(false);
    expect(isRemoteMcp({ type: "http", url: "http://localhost:1/mcp", headers: {} })).toBe(false);
    expect(isRemoteMcp({ type: "http", url: "https://mcp.intranet.example/mcp", headers: {} })).toBe(true);
    expect(isRemoteMcp({ type: "sse", url: "http://10.1.2.3/sse", headers: {} })).toBe(true);
  });

  it("imports every server in a config file, remote ones included", () => {
    const json = JSON.stringify({
      mcpServers: {
        files: { command: "npx", args: ["files-mcp"] },
        local: { type: "http", url: "http://localhost:8123/mcp" },
        hosted: { type: "http", url: "https://mcp.intranet.example/mcp", headers: { Authorization: "Bearer x" } },
      },
    });
    expect(parseMcpJson(json).map((entry) => entry.name)).toEqual(["files", "local", "hosted"]);
  });

  it("hands a bot's agent every enabled server, remote ones too, since the agent connects to them", () => {
    const library: Library = {
      skills: [],
      mcpServers: [
        server("files", { type: "stdio", command: "npx", args: ["files-mcp"], env: {} }),
        server("hosted", { type: "http", url: "https://mcp.intranet.example/mcp", headers: { Authorization: "Bearer x" } }),
      ],
    };
    const config = buildAgentConfig(makeBot({ mcpServerIds: ["files", "hosted"] }), library, "m", "");
    expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["files", "hosted"]);
  });

  it("lets a remote server be turned on without a test, since the plugin cannot make one", () => {
    const remote = server("hosted", { type: "http", url: "https://mcp.intranet.example/mcp", headers: {} });
    const program = server("files", { type: "stdio", command: "npx", args: [], env: {} });
    expect(mcpServerCanEnable(remote)).toBe(true);
    expect(mcpServerCanEnable(program)).toBe(false);
    expect(mcpServerCanEnable({ ...program, tools: [], checkError: null })).toBe(true);
    expect(mcpServerCanEnable({ ...program, tools: [], checkError: "boom" })).toBe(false);
  });

  it("never connects to a remote server to test it", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { probeMcpServer } = await import("../server/mcp-probe");
    for (const type of ["http", "sse"] as const) {
      const result = await probeMcpServer({ config: { type, url: "https://mcp.intranet.example/mcp", headers: {} } });
      expect(result).toEqual({ ok: false, error: expect.stringContaining("The agent connects to it; this plugin does not") });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("pictures never come from an address", () => {
  it("keeps an uploaded data: image and drops a web address", () => {
    const base = makeBot();
    const parse = (imageUrl: string | null) => BotSchema.parse({ ...base, avatar: { ...base.avatar, imageUrl } }).avatar.imageUrl;
    expect(parse("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(parse("https://example.com/me.png")).toBeNull();
    expect(parse("http://127.0.0.1/me.png")).toBeNull();
    expect(parse(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- the whole source

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["client", "server", "shared"];

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [join(ROOT, "index.client.tsx"), join(ROOT, "index.server.ts")];
  for (const dir of SOURCE_DIRS) {
    for (const name of await readdir(join(ROOT, dir), { recursive: true })) {
      if (/\.(ts|tsx)$/.test(name)) files.push(join(ROOT, dir, name));
    }
  }
  return files;
}

/** Drops comments, so a link in a comment doesn't count. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

describe("the source holds no outbound network code", () => {
  const forbidden: [string, RegExp][] = [
    ["a fetch call", /\bfetch\s*\(/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["WebSocket", /\bWebSocket\b/],
    ["EventSource", /\bEventSource\b/],
    ["a beacon", /\bsendBeacon\b/],
    ["node:https", /node:https/],
    ["node:net or node:tls", /node:(net|tls|dgram)\b/],
    ["an http client call", /\bhttps?\.(request|get)\s*\(/],
    ["a window.open", /\bwindow\.open\b/],
    ["a dynamic import of a URL", /import\s*\(\s*["'`]https?:/],
  ];

  it("has none of the network primitives, outside the one guarded probe", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const name = relative(ROOT, file).replaceAll("\\", "/");
      // The probe talks to MCP servers on this computer and refuses everything else (tested above).
      if (name === "server/mcp-probe.ts") continue;
      const text = code(await readFile(file, "utf8"));
      for (const [label, pattern] of forbidden) if (pattern.test(text)) offenders.push(`${name}: ${label}`);
    }
    expect(offenders).toEqual([]);
  });

  it("names no remote host in code", async () => {
    // Identifiers and templates, not connections: the SVG namespace, this computer's own relay and
    // webhook addresses, and Markdown turning "www.example.com" in a reply into a link a user may press.
    const allowed: ((name: string, url: string) => boolean)[] = [
      (_name, url) => /^http:\/\/www\.w3\.org\//.test(url),
      (_name, url) => /^http:\/\/127\.0\.0\.1:\$\{/.test(url),
      (name, url) => name === "client/library/McpSheets.tsx" && url === "https://mcp.example.com/mcp", // input placeholder
      (name, url) => name === "shared/markdown.ts" && url.startsWith("http://${url"),
    ];
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const name = relative(ROOT, file).replaceAll("\\", "/");
      for (const match of code(await readFile(file, "utf8")).matchAll(/https?:\/\/[^\s"'`)}<>]+/g)) {
        const url = match[0];
        if (isLoopbackUrl(url) || allowed.some((rule) => rule(name, url))) continue;
        offenders.push(`${name}: ${url}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("opens no address on its own: only the Markdown link a user presses", async () => {
    const users: string[] = [];
    for (const file of await sourceFiles()) {
      if (/\bopenExternalUrl\b/.test(code(await readFile(file, "utf8")))) users.push(relative(ROOT, file).replaceAll("\\", "/"));
    }
    expect(users).toEqual(["client/Markdown.tsx"]);
  });
});

// ---------------------------------------------------------------- a stricter reading of the source

/** Modules that open connections of their own. `http` is allowed to serve on this computer, never to call out. */
const NETWORK_MODULES = ["https", "http2", "net", "tls", "dgram", "dns", "quic", "undici", "axios", "node-fetch", "got", "ws"];
const HTTP_SERVER_NAMES = new Set(["createServer", "Server", "IncomingMessage", "ServerResponse", "type"]);

/** What in `text` (a file's source, comments left in) could open a connection to somewhere else. */
export function networkProblems(text: string): string[] {
  const source = code(text);
  const problems: string[] = [];
  for (const match of source.matchAll(/(?:from|import|require\s*\()\s*["'`]([^"'`]+)["'`]/g)) {
    const spec = match[1]!.replace(/^node:/, "");
    if (NETWORK_MODULES.includes(spec.split("/")[0]!)) problems.push(`imports ${match[1]}`);
  }
  for (const match of source.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+["'](?:node:)?http["']/g)) {
    const clause = match[1]!;
    const names = clause.startsWith("{") ? clause.replace(/[{}]/g, "").split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!).filter(Boolean) : [clause];
    if (!names.every((name) => HTTP_SERVER_NAMES.has(name))) problems.push(`imports ${names.filter((name) => !HTTP_SERVER_NAMES.has(name)).join(", ")} from http`);
  }
  if (/\brequire\s*\(\s*["'](?:node:)?http["']\s*\)/.test(source)) problems.push("requires http");
  if (/\b(?:import|require)\s*\(\s*[^"'`\s)]/.test(source)) problems.push("loads a module chosen at run time");
  if (/child_process/.test(source) && /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i.test(source)) problems.push("runs a download tool");
  return problems;
}

describe("the network reading of the source", () => {
  it("flags the ways a connection could be opened that a plain fetch( search misses", () => {
    expect(networkProblems('import { request } from "node:http";\nrequest(url);')).toEqual(["imports request from http"]);
    expect(networkProblems('import http from "http";')).toEqual(["imports http from http"]);
    expect(networkProblems('import * as http from "node:http";')).toEqual(["imports * as http from http"]);
    expect(networkProblems('import { get } from "https";')).toEqual(["imports https"]);
    expect(networkProblems('const net = require("net");')).toEqual(["imports net"]);
    expect(networkProblems('import { lookup } from "node:dns/promises";')).toEqual(["imports node:dns/promises"]);
    expect(networkProblems('import { connect } from "node:http2";')).toEqual(["imports node:http2"]);
    expect(networkProblems('import axios from "axios";')).toEqual(["imports axios"]);
    expect(networkProblems("const mod = await import(name);")).toEqual(["loads a module chosen at run time"]);
    expect(networkProblems('import { spawn } from "node:child_process";\nspawn("curl", [url]);')).toEqual(["runs a download tool"]);
  });

  it("lets a server listen on this computer, and ignores a mention in a comment", () => {
    expect(networkProblems('import { createServer, type IncomingMessage, type ServerResponse } from "node:http";')).toEqual([]);
    expect(networkProblems('import type { IncomingMessage, ServerResponse } from "node:http";')).toEqual([]);
    expect(networkProblems('// we never use axios or import("x") or curl\nconst a = 1;')).toEqual([]);
  });

  it("finds none in the plugin", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const name = relative(ROOT, file).replaceAll("\\", "/");
      // The probe is the one place that starts programs, and it refuses every remote address (tested above).
      if (name === "server/mcp-probe.ts") continue;
      for (const problem of networkProblems(await readFile(file, "utf8"))) offenders.push(`${name}: ${problem}`);
    }
    expect(offenders).toEqual([]);
  });

  it("ships no runtime dependencies, which would be code nobody here reviewed", async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
