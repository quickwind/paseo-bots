import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAgentConfig, EMPTY_LIBRARY } from "../shared/bot";
import { botToolName, supportsToolGrants } from "../shared/bot-tools";
import { withPluginCommands } from "../client/chat/composer/logic";
import { proposalIdOf } from "../shared/proposals";
import { expandLearn, sanitizeSkillName } from "../shared/skills";
import { newUuid } from "../shared/uuid";
import { fakeHost, makeBot } from "./helpers";

describe("tool names and grants", () => {
  it("recognises the plugin's tools whatever the provider calls them", () => {
    expect(botToolName("mcp__bots__ask_bot")).toBe("ask_bot");
    expect(botToolName("bots.propose_skill")).toBe("propose_skill");
    expect(botToolName("bots_list_bots")).toBe("list_bots");
    expect(botToolName("mcp__other__ask_bot")).toBeNull();
    expect(botToolName("bots.unknown")).toBeNull();
    expect(botToolName("mcp__bots__create_workspace")).toBe("create_workspace");
    expect(botToolName("bots_list_workspaces")).toBe("list_workspaces");
    expect(botToolName("mcp__bots__assign_bot")).toBe("assign_bot");
  });

  it("only sends grants to providers that take exact grants", () => {
    expect(supportsToolGrants("claude")).toBe(true);
    expect(supportsToolGrants("opencode")).toBe(true);
    expect(supportsToolGrants("gemini")).toBe(false);
    const tools = { type: "http" as const, url: "http://127.0.0.1:1/bots/b/a", headers: {} };
    const claude = buildAgentConfig(makeBot({ alwaysAllow: ["bots/ask_bot"] }), EMPTY_LIBRARY, "m", "", { tools });
    expect(claude.mcpServers).toEqual({ bots: tools });
    expect(claude.toolPolicy?.preapproved.map((grant) => grant.tool)).toEqual(["list_bots", "check_chat", "search_chats", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app", "list_workspaces", "create_workspace", "assign_bot", "request_approval", "list_approvals", "withdraw_approval", "ask_bot"]);
    // Paseo refuses a chat whose provider can't take grants, so none are sent.
    expect(buildAgentConfig(makeBot({ provider: "gemini", alwaysAllow: ["bots/ask_bot"] }), EMPTY_LIBRARY, "m", "", { tools })).not.toHaveProperty("toolPolicy");
  });

  it("expands /learn and lists it before provider commands", () => {
    expect(expandLearn("/learn")).toContain("propose_skill");
    expect(expandLearn("  /learn the invoice part ")).toContain("Focus on: the invoice part.");
    expect(expandLearn("/learner")).toBeNull();
    expect(expandLearn("please /learn")).toBeNull();
    const learn = { name: "learn", description: "ours", argumentHint: "" };
    const provider = [{ name: "learn", description: "theirs", argumentHint: "" }, { name: "compact", description: "", argumentHint: "" }];
    expect(withPluginCommands([learn], provider).map((command) => command.description)).toEqual(["ours", ""]);
  });

  it("finds the proposal behind a finished propose_skill call", () => {
    const output = [{ type: "text", text: "Proposal p-0123456789: the user sees..." }];
    expect(proposalIdOf({ name: "mcp__bots__propose_skill", status: "completed", detail: { type: "unknown", input: {}, output } })).toBe("p-0123456789");
    expect(proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { type: "unknown", input: {}, output: "Proposal p-abcdefabcd: x" } })).toBe("p-abcdefabcd");
    expect(proposalIdOf({ name: "mcp__bots__propose_skill", status: "running", detail: { type: "unknown", input: {}, output: null } })).toBeNull();
    expect(proposalIdOf({ name: "mcp__bots__list_bots", status: "completed", detail: { type: "unknown", input: {}, output } })).toBeNull();
  });

  it("finds the proposal behind a finished create_workspace call", () => {
    const output = [{ type: "text", text: "Proposal p-0123456789: the user sees a new workspace..." }];
    expect(proposalIdOf({ name: "mcp__bots__create_workspace", status: "completed", detail: { type: "unknown", input: {}, output } })).toBe("p-0123456789");
    expect(proposalIdOf({ name: "mcp__bots__list_workspaces", status: "completed", detail: { type: "unknown", input: {}, output } })).toBeNull();
  });

  it("finds the proposal behind a finished assign_bot call that asked the user", () => {
    const output = [{ type: "text", text: "Proposal p-0123456789: Assignment r-ab12cd34: the user sees your assignment..." }];
    expect(proposalIdOf({ name: "mcp__bots__assign_bot", status: "completed", detail: { type: "unknown", input: {}, output } })).toBe("p-0123456789");
  });

  it("keeps skill folder names inside the library", () => {
    expect(sanitizeSkillName("..")).toBe("skill");
    expect(sanitizeSkillName(".hidden.")).toBe("hidden");
    expect(sanitizeSkillName("v1.2 notes")).toBe("v1.2-notes");
  });

  it("makes v4 UUIDs for agent ids", () => {
    expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("the bots MCP server", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-tools-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("serves the MCP handshake, lists its tools and runs them for one chat", async () => {
    const { Relay } = await import("../server/relay");
    const { BOT_TOOLS } = await import("../server/tools");
    const host = fakeHost([makeBot({ id: "bot-a", name: "Scout", title: "Researcher" }), makeBot({ id: "bot-b", name: "Inbox", description: "Email triage" }), makeBot({ id: "bot-c", archived: true })]);
    const relay = new Relay(host, BOT_TOOLS);
    try {
      const agentId = newUuid();
      const mount = (await relay.mountTools("bot-a", agentId)) as { url: string; headers: Record<string, string> };
      expect(mount.url).toContain(`/bots/bot-a/${agentId}`);
      const post = (body: unknown, token = mount.headers.Authorization!, url = mount.url) =>
        fetch(url, { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify(body) });

      const init = (await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("aydo");
      expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

      const list = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
      expect(list.result.tools.map((tool) => tool.name)).toContain("list_bots");
      expect(list.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["list_workspaces", "create_workspace", "assign_bot"]));
      expect(list.result.tools[0]!.inputSchema.type).toBe("object");

      const call = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } })).json()) as { result: { content: { text: string }[] } };
      expect(call.result.content[0]!.text).toBe("- Inbox (id: bot-b): Email triage");

      // A token for another chat, or another bot's URL, is refused.
      expect((await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "Bearer nope")).status).toBe(401);
      expect((await post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, mount.headers.Authorization!, mount.url.replace(agentId, newUuid()))).status).toBe(401);
      const unknown = (await (await post({ jsonrpc: "2.0", id: 6, method: "nope" })).json()) as { error: { code: number } };
      expect(unknown.error.code).toBe(-32601);
    } finally {
      relay.stop();
    }
  });

  it("proposes a skill that the user saves or dismisses once", async () => {
    const { proposeSkill } = await import("../server/tools/skills");
    const { acceptProposal, dismissProposal, getProposal } = await import("../server/proposals");
    const { librarySkillPath } = await import("../server/library");
    const host = fakeHost([makeBot({ id: "bot-a" })]);
    const caller = { bot: makeBot({ id: "bot-a" }), agentId: newUuid(), host, relay: null as never };
    const reply = await proposeSkill.run({ name: "Weekly Report!", description: "Use for the\nweekly report", instructions: "1. Collect PRs." }, caller);
    const id = proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { output: reply } })!;
    expect(id).toMatch(/^p-[a-z0-9]{10}$/);

    const proposal = await getProposal(id);
    expect(proposal).toMatchObject({ botId: "bot-a", agentId: caller.agentId, kind: "skill", status: "pending", data: { name: "weekly-report", description: "Use for the weekly report" } });
    expect(proposal!.kind === "skill" && proposal!.data.text).toBe("---\nname: weekly-report\ndescription: Use for the weekly report\n---\n\n1. Collect PRs.\n");

    const accepted = await acceptProposal(id);
    expect(accepted.proposal.status).toBe("accepted");
    expect(accepted.skill).toMatchObject({ id: "weekly-report", description: "Use for the weekly report" });
    expect(await readFile(join(librarySkillPath("weekly-report"), "SKILL.md"), "utf8")).toBe(proposal!.kind === "skill" ? proposal!.data.text : "");
    await expect(acceptProposal(id)).rejects.toThrow("already saved");
    await expect(dismissProposal(id)).rejects.toThrow("already saved");

    const other = proposalIdOf({ name: "bots.propose_skill", status: "completed", detail: { output: await proposeSkill.run({ name: "x", description: "y", instructions: "z" }, caller) } })!;
    expect((await dismissProposal(other)).status).toBe("dismissed");
    await expect(acceptProposal(other)).rejects.toThrow("dismissed");
    await expect(acceptProposal("p-0000000000")).rejects.toThrow("no longer available");
  });

  it("hands an assignment to the asks service, shows the card's proposal, and says why when it is refused", async () => {
    const { assignBot } = await import("../server/tools/bots");
    const host = fakeHost([makeBot({ id: "bot-a" })]);
    const calls: { from: { agentId: string }; args: unknown }[] = [];
    let reply: { ok: boolean; proposalId: string | null; text: string } = { ok: true, proposalId: null, text: 'Assignment r-1: Scout is starting work in "Login".' };
    const relay = { asks: { request: async (from: { agentId: string }, args: unknown) => (calls.push({ from, args }), reply) } };
    const caller = { bot: makeBot({ id: "bot-a" }), agentId: "chat-1", host, relay: relay as never };
    expect(await assignBot.run({ bot: "Scout", task: "Write notes.md", workspace: "Login" }, caller)).toBe('Assignment r-1: Scout is starting work in "Login".');
    expect(calls[0]!.args).toEqual({ to: "Scout", message: "Write notes.md", workspace: "Login", assign: true });
    await assignBot.run({ bot: "Scout", task: "Write notes.md" }, caller);
    expect(calls[1]!.args).toEqual({ to: "Scout", message: "Write notes.md", assign: true });
    reply = { ok: true, proposalId: "p-0123456789", text: "Assignment r-2: the user sees your assignment." };
    expect(await assignBot.run({ bot: "Scout", task: "x" }, caller)).toBe("Proposal p-0123456789: Assignment r-2: the user sees your assignment.");
    reply = { ok: false, proposalId: null, text: "You are not working in a project workspace. Name the workspace to assign in, or use ask_bot." };
    await expect(assignBot.run({ bot: "Scout", task: "x" }, caller)).rejects.toThrow("not working in a project workspace");
    await expect(assignBot.run({ bot: "Scout", task: "x" }, caller)).rejects.toThrow("Ask the user which workspace they mean; do not pick one yourself.");
    reply = { ok: false, proposalId: null, text: "This chat has asked too many times in the last hour (5). Wait for the user before asking again." };
    await expect(assignBot.run({ bot: "Scout", task: "x" }, caller)).rejects.not.toThrow("do not pick one yourself");
    await expect(assignBot.run({ bot: "Scout", task: "x" }, { ...caller, relay: { asks: null } as never })).rejects.toThrow("isn't available");
  });

  it("offers assign_bot only to a bot that may contact others", async () => {
    const { assignBot } = await import("../server/tools/bots");
    const host = fakeHost([makeBot({ id: "bot-a" })]);
    const caller = (contactBots: "ask" | "allow" | "off") => ({ bot: makeBot({ id: "bot-a", contactBots }), agentId: "chat-1", host, relay: null as never });
    expect(await assignBot.available!(caller("ask"))).toBe(true);
    expect(await assignBot.available!(caller("allow"))).toBe(true);
    expect(await assignBot.available!(caller("off"))).toBe(false);
  });

  it("lists workspaces and refuses a bad create_workspace request in words the bot can act on", async () => {
    const { listWorkspacesTool, createWorkspaceTool } = await import("../server/tools/workspaces");
    const host = fakeHost([makeBot({ id: "bot-a" })]);
    const entries = [{ id: "wks_1", projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-x", name: "x", title: "Login", archivingAt: null }];
    host.attach({ projects: { list: async () => ({ projects: [] }) }, workspaces: { list: async () => ({ entries }) } } as never);
    const caller = { bot: makeBot({ id: "bot-a" }), agentId: newUuid(), host, relay: null as never };
    expect(await listWorkspacesTool.run({}, caller)).toBe("- Login (id wks_1) in app: /work/app-x");
    host.attach({ projects: { list: async () => ({ projects: [] }) }, workspaces: { list: async () => ({ entries: [] }) } } as never);
    expect(await listWorkspacesTool.run({}, caller)).toBe("There are no workspaces.");
    await expect(createWorkspaceTool.run({ project: "app", title: "Login", worktree: false, branch: "x" }, caller)).rejects.toThrow(/worktree/);
  });
});
