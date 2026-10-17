import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTools, scanToolFiles } from "../server/file-tools";
import { ChangesSchema, changeWarnings, describeChange } from "../shared/changes";
import { fakeHost, makeBot } from "./helpers";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "paseo-bots-leftfiles-"));
  process.env.PASEO_HOME = home;
});
afterEach(async () => {
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

const skillFile = JSON.stringify({ kind: "skill", name: "s", description: "d", instructions: "i" });

async function folders(botId: string) {
  const { botDataPath } = await import("../server/bot-home");
  const proposals = join(botDataPath(botId), "proposals");
  const outbox = join(botDataPath(botId), "outbox");
  await mkdir(proposals, { recursive: true });
  await mkdir(outbox, { recursive: true });
  return { proposals, outbox };
}

describe("a tool file that is a link", () => {
  it("is not read: a link could lead to a file outside the bot's folder", async () => {
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const { proposals } = await folders("scout");
    const outside = join(home, "outside.json");
    await writeFile(outside, skillFile);
    if (!(await symlink(outside, join(proposals, "skill-l1.json")).then(() => true, () => false))) {
      if (process.env.CI) throw new Error("CI could not create a file link");
      return;
    }
    const { done } = await scanToolFiles({ host: fakeHost([scout]), relay: null as never, bot: scout, agentId: "chat-1", written: ["Wrote ./proposals/skill-l1.json"] });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ok: false, proposalId: null });
    expect(done[0]!.text).toContain("not a plain file");
  });
});

describe("an ask file whose question could not be put through", () => {
  it("is reported to the chat and does not stop the other files of the turn", async () => {
    const bot = makeBot({ id: "chief", name: "Chief", provider: "devin", contactBots: "allow" });
    const host = fakeHost([bot]);
    const sent: string[] = [];
    host.attach({ agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", labels: {}, title: "Chat", cwd: "/x" } }), timeline: { append: async () => {} }, send: async (text: string) => void sent.push(text) }) } } as never);
    const { proposals, outbox } = await folders("chief");
    await writeFile(join(outbox, "ask-e1.json"), JSON.stringify({ kind: "ask", to: "Scout", message: "hi" }));
    await writeFile(join(proposals, "skill-e2.json"), skillFile);
    const asks = { request: async () => { throw new Error("disk full"); }, deliver: async () => {} };
    const files = new FileTools(host, null as never, asks as never, null);
    const timeline = ["Wrote ./outbox/ask-e1.json", "Wrote ./proposals/skill-e2.json"].map((filePath) => ({ type: "tool_call", detail: { type: "edit", filePath } }));
    await expect(files.afterTurn({ bot, agentId: "chat-1", timeline })).resolves.toBeUndefined();
    expect(await readFile(join(outbox, "done", "ask-e1.json.result.txt"), "utf8")).toContain("disk full");
    expect(await readdir(join(proposals, "done"))).toContain("skill-e2.json");
    expect(sent.join("\n")).toContain("ask-e1.json");
  });
});

describe("a done/ folder the plugin cannot write to", () => {
  it("is said plainly instead of leaving the file to be tried again every turn", async () => {
    if (process.platform === "win32") return; // folder permissions work differently there
    const scout = makeBot({ id: "scout", name: "Scout", provider: "devin" });
    const { proposals } = await folders("scout");
    await mkdir(join(proposals, "done"));
    await chmod(join(proposals, "done"), 0o500);
    try {
      await writeFile(join(proposals, "skill-p1.json"), skillFile);
      const { done } = await scanToolFiles({ host: fakeHost([scout]), relay: null as never, bot: scout, agentId: "chat-1", written: ["Wrote ./proposals/skill-p1.json"] });
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ ok: false });
    } finally {
      await chmod(join(proposals, "done"), 0o700);
    }
  });
});

describe("what the card says of an MCP server", () => {
  const parse = (value: unknown[]) => ChangesSchema.parse(value);

  it("does not call a remote server off until it is tested: the user turns it on, tested or not", () => {
    const [line] = parse([{ type: "add_mcp_server", name: "api", url: "https://example.com/mcp" }]).map(describeChange);
    expect(line).not.toContain("passes a test");
    expect(line).toContain("off until you turn it on");
  });

  it("warns when one batch adds a remote server and switches it on", () => {
    const changes = parse([{ type: "add_mcp_server", name: "api", url: "https://example.com/mcp" }, { type: "set_mcp_server", server: "api", enabled: true }]);
    expect(changeWarnings(changes).join("\n")).toContain("api");
    expect(changeWarnings(changes).join("\n")).toContain("on straight away");
  });

  it("warns when defaults let new bots contact other bots freely", () => {
    expect(changeWarnings(parse([{ type: "set_defaults", contact_bots: "allow" }])).join("\n")).toContain("New bots");
  });
});
