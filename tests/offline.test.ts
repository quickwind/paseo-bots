import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotSchema, buildAgentConfig, isLoopbackUrl, mcpServerAllowed, parseMcpJson, type Library, type LibraryMcpServer } from "../shared/bot";
import { isLocalFolder, parseSkillFolder } from "../shared/skills";
import { makeBot } from "./helpers";

// This build makes no network connections of its own. These tests hold it to that.

const savedHome = process.env.PASEO_HOME;

beforeEach(async () => {
  process.env.PASEO_HOME = await mkdtemp(join(tmpdir(), "bots-offline-"));
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

describe("MCP servers stay on this computer", () => {
  it("knows which addresses are this computer", () => {
    for (const local of ["http://localhost:3000/mcp", "https://LOCALHOST/mcp", "http://127.0.0.1:9/x", "http://127.9.8.7/x", "http://[::1]:8080/mcp", "http://tools.localhost/mcp"]) {
      expect(isLoopbackUrl(local)).toBe(true);
    }
    for (const remote of ["https://mcp.example.com/mcp", "http://10.0.0.5/mcp", "http://192.168.1.2/mcp", "http://127.0.0.1.evil.com/mcp", "http://localhost.evil.com/mcp", "ftp://localhost/x", "not a url", ""]) {
      expect(isLoopbackUrl(remote)).toBe(false);
    }
  });

  it("allows a program to start and a localhost address, and nothing remote", () => {
    expect(mcpServerAllowed({ type: "stdio", command: "npx", args: [], env: {} })).toBe(true);
    expect(mcpServerAllowed({ type: "http", url: "http://localhost:1/mcp", headers: {} })).toBe(true);
    expect(mcpServerAllowed({ type: "sse", url: "https://mcp.example.com/sse", headers: {} })).toBe(false);
  });

  it("imports the local servers from a config file and skips remote ones", () => {
    const json = JSON.stringify({
      mcpServers: {
        files: { command: "npx", args: ["files-mcp"] },
        local: { type: "http", url: "http://localhost:8123/mcp" },
        hosted: { type: "http", url: "https://mcp.example.com/mcp" },
        legacy: { type: "sse", url: "https://example.com/sse" },
      },
    });
    expect(parseMcpJson(json).map((server) => server.name)).toEqual(["files", "local"]);
    expect(() => parseMcpJson(JSON.stringify({ hosted: { url: "https://mcp.example.com/mcp" } }))).toThrow("hosted is a remote server; only servers that run on this computer are supported.");
  });

  it("never gives a bot's agent a remote server, even one already saved", () => {
    const server = (id: string, config: LibraryMcpServer["config"]): LibraryMcpServer => ({
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
    });
    const library: Library = {
      skills: [],
      mcpServers: [
        server("files", { type: "stdio", command: "npx", args: ["files-mcp"], env: {} }),
        server("local", { type: "http", url: "http://127.0.0.1:9000/mcp", headers: {} }),
        server("hosted", { type: "http", url: "https://mcp.example.com/mcp", headers: {} }),
      ],
    };
    const config = buildAgentConfig(makeBot({ mcpServerIds: ["files", "local", "hosted"] }), library, "m", "");
    expect(Object.keys(config.mcpServers ?? {}).sort()).toEqual(["files", "local"]);
  });

  it("refuses to probe a remote server and sends nothing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { probeMcpServer } = await import("../server/mcp-probe");
    for (const type of ["http", "sse"] as const) {
      const result = await probeMcpServer({ config: { type, url: "https://mcp.example.com/mcp", headers: {} } });
      expect(result).toEqual({ ok: false, error: expect.stringContaining("run on this computer") });
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
