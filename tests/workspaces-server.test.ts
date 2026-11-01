import { mkdir, mkdtemp, lstat, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotGroup } from "../shared/bot";
import { proposalIdInText } from "../shared/proposals";
import { CreateWorkspaceInput } from "../shared/workspaces";
import { fakeHost, makeBot } from "./helpers";

const NOW = "2026-10-19T00:00:00.000Z";
const team: BotGroup = { id: "t1", name: "Eng", logo: null, leadId: "lead", memberIds: ["lead", "dev"], instructions: "", askFreely: false, createdAt: NOW, updatedAt: NOW };
const input = (patch: Record<string, unknown> = {}) => CreateWorkspaceInput.parse({ project: "app", title: "Login", ...patch });

const projects = [
  { projectId: "proj-1", projectDisplayName: "app", projectRootPath: "/work/app", projectKind: "git" },
  { projectId: "proj-2", projectDisplayName: "Notes", projectRootPath: "/work/notes", projectKind: "directory" },
  { projectId: "proj-3", projectDisplayName: "notes", projectRootPath: "/other/notes", projectKind: "directory" },
];
const entries = [
  { id: "wks_b", projectId: "proj-1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-b", name: "b", title: "Beta", archivingAt: null },
  { id: "wks_a", projectId: "proj-1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-a", name: "a", title: null, archivingAt: null },
  { id: "wks_old", projectId: "proj-1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-old", name: "old", title: "Old", archivingAt: "2026-10-18T00:00:00.000Z" },
  { id: "wks_n", projectId: "proj-2", projectDisplayName: "Notes", projectRootPath: "/work/notes", workspaceDirectory: "/work/notes", name: "n", title: "Notes", archivingAt: null },
];

function fakePaseo(options: { createThrows?: string; folderRoot?: string; extraEntries?: unknown[]; labels?: Record<string, string>; botsProject?: boolean; chatWorkspaces?: Record<string, string> } = {}) {
  const created: { title: string; source: Record<string, unknown> }[] = [];
  const sent: { id: string; text: string }[] = [];
  const botsProject = { projectId: "proj-bots", projectDisplayName: "Bots", projectRootPath: "/data/plugin-data/aydo/shared/Bots", projectKind: "non_git" };
  const allProjects = [...projects, ...(options.folderRoot ? [{ projectId: "proj-4", projectDisplayName: "docs", projectRootPath: options.folderRoot, projectKind: "non_git" }] : []), ...(options.botsProject ? [botsProject] : [])];
  const paseo = {
    projects: { list: async () => ({ projects: allProjects }) },
    workspaces: {
      list: async () => ({ entries: [...entries, ...(options.extraEntries ?? []), ...(options.botsProject ? [{ id: "wks_bot", projectId: "proj-bots", projectDisplayName: "Bots", projectRootPath: botsProject.projectRootPath, workspaceDirectory: `${botsProject.projectRootPath}/dev`, name: "dev", title: "Dev", archivingAt: null }] : [])] }),
      create: async (request: { title: string; source: Record<string, unknown> }) => {
        if (options.createThrows) throw new Error(options.createThrows);
        created.push(request);
        const directory = request.source.kind === "worktree" ? `/work/app-wt/${String(request.source.branchName)}` : String(request.source.path);
        return { id: "wks_new", directory };
      },
    },
    agents: { ref: (id: string) => ({ send: async (text: string) => void sent.push({ id, text }), ...(options.labels || options.chatWorkspaces ? { refresh: async () => ({ agent: { labels: options.labels ?? {}, title: "t", cwd: "/x", workspaceId: options.chatWorkspaces?.[id] } }) } : {}) }) },
  };
  return { paseo: paseo as never, created, sent };
}

describe("workspaces of the user's projects", () => {
  let home: string;
  let docs: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aydo-ws-"));
    process.env.PASEO_HOME = home;
    docs = join(home, "docs-project");
    await mkdir(docs);
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });
  const service = () => import("../server/workspaces");
  const grants = () => import("../server/project-grants");
  const hostFor = (fake: ReturnType<typeof fakePaseo>, bots = [makeBot({ id: "lead", name: "Lead" }), makeBot({ id: "dev", name: "Dev" }), makeBot({ id: "solo", name: "Solo" })]) => {
    const host = fakeHost(bots, undefined, [team]);
    host.attach(fake.paseo);
    return host;
  };

  it("lists active workspaces by project name, then title", async () => {
    const { listWorkspaces } = await service();
    const list = await listWorkspaces(fakePaseo().paseo);
    expect(list.map((entry) => entry.id)).toEqual(["wks_a", "wks_b", "wks_n"]);
    expect(list[0]).toEqual({ id: "wks_a", title: "a", directory: "/work/app-a", projectId: "proj-1", projectName: "app" });
  });

  it("finds a project by id, by root folder or by name in any case, and says why when it cannot", async () => {
    const { resolveProject } = await service();
    const paseo = fakePaseo().paseo;
    expect(await resolveProject(paseo, "proj-1")).toEqual({ id: "proj-1", name: "app", root: "/work/app" });
    expect(await resolveProject(paseo, "/work/app")).toMatchObject({ id: "proj-1" });
    expect(await resolveProject(paseo, "APP")).toMatchObject({ id: "proj-1" });
    const twice = await resolveProject(paseo, "notes");
    expect(twice).toHaveProperty("problem");
    expect((twice as { problem: string }).problem).toContain("/work/notes");
    expect((twice as { problem: string }).problem).toContain("/other/notes");
    const none = await resolveProject(paseo, "nope");
    expect((none as { problem: string }).problem).toMatch(/app.*Notes/s);
  });

  it("does not let a memory tidy chat create a workspace, even in a project the team remembered", async () => {
    const { requestWorkspace } = await service();
    const { allowProject } = await grants();
    await allowProject("team:t1", { id: "proj-1", name: "app" });
    const fake = fakePaseo({ labels: { "aydo.bot": "dev", "aydo.tidy": "1" } });
    await expect(requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-tidy", host: hostFor(fake) }, input())).rejects.toThrow(/memory tidy/);
    expect(fake.created).toEqual([]);
  });

  it("lets a chat another bot started create a workspace, as the designer's will", async () => {
    const { requestWorkspace } = await service();
    const { allowProject } = await grants();
    await allowProject("team:t1", { id: "proj-1", name: "app" });
    const fake = fakePaseo({ labels: { "aydo.bot": "dev", "aydo.asked-by": "lead" } });
    await requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-asked", host: hostFor(fake) }, input({ worktree: true }));
    expect(fake.created).toHaveLength(1);
  });

  it("keeps the plugin's own Bots project out of the lists and out of reach", async () => {
    const { listWorkspaces, resolveProject, requestWorkspace } = await service();
    const fake = fakePaseo({ botsProject: true });
    expect((await listWorkspaces(fake.paseo)).map((entry) => entry.projectName)).not.toContain("Bots");
    const byName = await resolveProject(fake.paseo, "Bots");
    expect(byName).toHaveProperty("problem");
    expect((byName as { problem: string }).problem).not.toMatch(/Projects:.*Bots/);
    expect(await resolveProject(fake.paseo, "/data/plugin-data/aydo/shared/Bots")).toHaveProperty("problem");
    expect(await resolveProject(fake.paseo, "proj-bots")).toHaveProperty("problem");
    await expect(requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "c", host: hostFor(fake) }, input({ project: "Bots", title: "scratch" }))).rejects.toThrow(/no project/);
    expect(fake.created).toEqual([]);
  });

  it("asks the user the first time: a pending card, nothing created", async () => {
    const { requestWorkspace } = await service();
    const { getProposal } = await import("../server/proposals");
    const fake = fakePaseo();
    const reply = await requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-1", host: hostFor(fake) }, input({ worktree: true, branch: "feature/login", base: "main" }));
    expect(fake.created).toEqual([]);
    const proposal = await getProposal(proposalIdInText(reply)!);
    expect(proposal).toMatchObject({ kind: "workspace", status: "pending", botId: "dev", agentId: "chat-1", data: { scope: "team:t1", project: { id: "proj-1", name: "app", root: "/work/app" } } });
  });

  it("creates at once in a project the team remembered, a worktree from the given branch", async () => {
    const { requestWorkspace } = await service();
    const { allowProject } = await grants();
    await allowProject("team:t1", { id: "proj-1", name: "app" });
    const fake = fakePaseo();
    const reply = await requestWorkspace({ bot: makeBot({ id: "lead", name: "Lead" }), agentId: "chat-1", host: hostFor(fake) }, input({ worktree: true, branch: "feature/login", base: "main" }));
    expect(fake.created).toEqual([{ title: "Login", source: { kind: "worktree", projectId: "proj-1", baseBranch: "main", branchName: "feature/login" } }]);
    expect(reply).toBe('Workspace "Login" created: id wks_new, folder /work/app-wt/feature/login. Paseo adds a number to the branch name when it was taken; run git branch in the folder to see the real one.');
  });

  it("defaults the branch to the title as a folder-style name", async () => {
    const { requestWorkspace } = await service();
    const { allowProject } = await grants();
    await allowProject("team:t1", { id: "proj-1", name: "app" });
    const fake = fakePaseo();
    await requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-1", host: hostFor(fake) }, input({ title: "Login v2: plan", worktree: true }));
    expect(fake.created[0]!.source).toMatchObject({ kind: "worktree", branchName: "login-v2-plan" });
  });

  describe("a plain folder in a project", () => {
    const request = async (fake: ReturnType<typeof fakePaseo>, patch: Record<string, unknown> = {}) => {
      const { requestWorkspace } = await service();
      const { allowProject } = await grants();
      await allowProject("team:t1", { id: "proj-4", name: "docs" });
      return requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-1", host: hostFor(fake) }, input({ project: "docs", title: "Login v2: plan", ...patch }));
    };

    it("makes the folder under the project root and creates the workspace in it", async () => {
      const fake = fakePaseo({ folderRoot: docs });
      const reply = await request(fake);
      const path = join(docs, "login-v2-plan");
      expect(fake.created).toEqual([{ title: "Login v2: plan", source: { kind: "directory", path, projectId: "proj-4" } }]);
      expect((await lstat(path)).isDirectory()).toBe(true);
      expect(reply).toBe(`Workspace "Login v2: plan" created: id wks_new, folder ${path}.`);
    });

    it("reuses a workspace that already has that folder, and creates nothing", async () => {
      const path = join(docs, "login-v2-plan");
      await mkdir(path);
      const fake = fakePaseo({ folderRoot: docs, extraEntries: [{ id: "wks_have", projectId: "proj-4", projectDisplayName: "docs", projectRootPath: docs, workspaceDirectory: path, name: "x", title: "Login v2: plan", archivingAt: null }] });
      const reply = await request(fake);
      expect(fake.created).toEqual([]);
      expect(reply).toBe(`Workspace "Login v2: plan" already exists: id wks_have, folder ${path}.`);
    });

    it("refuses a link or a file where the folder would go, and leaves it alone", async () => {
      const elsewhere = join(home, "elsewhere");
      await mkdir(elsewhere);
      await symlink(elsewhere, join(docs, "login-v2-plan"));
      const linked = fakePaseo({ folderRoot: docs });
      await expect(request(linked)).rejects.toThrow(/link/);
      expect((await lstat(join(docs, "login-v2-plan"))).isSymbolicLink()).toBe(true);
      await writeFile(join(docs, "notes-file"), "x");
      const file = fakePaseo({ folderRoot: docs });
      await expect(request(file, { title: "notes file" })).rejects.toThrow(/not a folder/);
      expect(linked.created).toEqual([]);
      expect(file.created).toEqual([]);
    });
  });

  it("remembers by bot for a bot with no team, so a teammate's grant does not apply", async () => {
    const { requestWorkspace } = await service();
    const { allowProject } = await grants();
    await allowProject("team:t1", { id: "proj-1", name: "app" });
    const fake = fakePaseo();
    const reply = await requestWorkspace({ bot: makeBot({ id: "solo", name: "Solo" }), agentId: "chat-9", host: hostFor(fake) }, input());
    expect(fake.created).toEqual([]);
    expect(proposalIdInText(reply)).not.toBeNull();
  });

  it("refuses an invalid request and an unknown project without creating anything", async () => {
    const { requestWorkspace } = await service();
    const fake = fakePaseo();
    const caller = { bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-1", host: hostFor(fake) };
    await expect(requestWorkspace(caller, input({ branch: "x" }))).rejects.toThrow(/worktree/);
    await expect(requestWorkspace(caller, input({ project: "nope" }))).rejects.toThrow(/app/);
    await expect(requestWorkspace(caller, input({ project: "notes" }))).rejects.toThrow(/\/other\/notes/);
    expect(fake.created).toEqual([]);
  });

  it("creates when the user approves, remembers the project for the scope, and tells the chat", async () => {
    const { requestWorkspace, workspaceApproved } = await service();
    const { getProposal } = await import("../server/proposals");
    const { projectAllowed } = await grants();
    const fake = fakePaseo();
    const host = hostFor(fake);
    const reply = await requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-1", host }, input({ worktree: true, branch: "feature/login" }));
    const proposal = (await getProposal(proposalIdInText(reply)!))!;
    await workspaceApproved(proposal as never, host);
    expect(fake.created).toHaveLength(1);
    expect(await projectAllowed("team:t1", "proj-1")).toBe(true);
    expect(fake.sent).toEqual([{ id: "chat-1", text: '[Aydo] Workspace "Login" created: id wks_new, folder /work/app-wt/feature/login. Paseo adds a number to the branch name when it was taken; run git branch in the folder to see the real one.' }]);
  });

  it("reports Paseo's reason and does not remember the project when creating fails", async () => {
    const { requestWorkspace, workspaceApproved } = await service();
    const { getProposal } = await import("../server/proposals");
    const { projectAllowed } = await grants();
    const fake = fakePaseo({ createThrows: "branch feature/login already exists" });
    const host = hostFor(fake);
    const reply = await requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-1", host }, input({ worktree: true, branch: "feature/login" }));
    await workspaceApproved((await getProposal(proposalIdInText(reply)!))! as never, host);
    expect(await projectAllowed("team:t1", "proj-1")).toBe(false);
    expect(fake.sent[0]!.text).toBe("[Aydo] The workspace could not be created: branch feature/login already exists");
  });

  it("holds the notice for a chat that waits for an approval", async () => {
    const { requestWorkspace, workspaceRefused } = await service();
    const { getProposal } = await import("../server/proposals");
    const { createApproval, takeHeld } = await import("../server/approvals-store");
    const fake = fakePaseo();
    const host = hostFor(fake);
    const reply = await requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-1", host }, input());
    await createApproval({ botId: "dev", botName: "Dev", agentId: "chat-1", chatTitle: "t", teamId: null, project: null, workspace: null, title: "T", text: "x", file: null });
    await workspaceRefused((await getProposal(proposalIdInText(reply)!))! as never, host);
    expect(fake.sent).toEqual([]);
    expect((await takeHeld("chat-1"))[0]).toContain("did not allow a workspace");
  });

  it("a request that cites an approval needs it approved, and makes nothing otherwise", async () => {
    const { requestWorkspace } = await service();
    const { createApproval, resolveApproval } = await import("../server/approvals-store");
    const fake = fakePaseo();
    const host = hostFor(fake);
    const bot = makeBot({ id: "dev", name: "Dev" });
    const made = await createApproval({ botId: "dev", botName: "Dev", agentId: "other", chatTitle: "t", teamId: null, project: null, workspace: null, title: "T", text: "x", file: null });
    await expect(requestWorkspace({ bot, agentId: "chat-1", host }, input({ approval: made.id }))).rejects.toThrow(/pending/);
    await expect(requestWorkspace({ bot, agentId: "chat-1", host }, input({ approval: "a-ffffffffff" }))).rejects.toThrow(/no approval/i);
    expect(fake.created).toEqual([]);
    await resolveApproval(made.id, { status: "approved", note: "", decidedBy: "user" });
    const reply = await requestWorkspace({ bot, agentId: "chat-1", host }, input({ approval: made.id }));
    expect(reply).toContain("Proposal");
  });

  it("tells the chat when the user says no, and remembers nothing", async () => {
    const { requestWorkspace, workspaceRefused } = await service();
    const { getProposal } = await import("../server/proposals");
    const { projectAllowed } = await grants();
    const fake = fakePaseo();
    const host = hostFor(fake);
    const reply = await requestWorkspace({ bot: makeBot({ id: "dev", name: "Dev" }), agentId: "chat-1", host }, input());
    await workspaceRefused((await getProposal(proposalIdInText(reply)!))! as never, host);
    expect(fake.sent[0]!.text).toBe("[Aydo] The user did not allow a workspace in app. Don't ask again unless the user tells you to.");
    expect(await projectAllowed("team:t1", "proj-1")).toBe(false);
    expect(fake.created).toEqual([]);
  });
});

describe("finding a workspace by name", () => {
  const service = () => import("../server/workspaces");

  it("finds one by id, by title in any case, or by its label", async () => {
    const { resolveWorkspace } = await service();
    const paseo = fakePaseo().paseo;
    expect(await resolveWorkspace(paseo, "wks_b")).toMatchObject({ id: "wks_b", title: "Beta" });
    expect(await resolveWorkspace(paseo, "beta")).toMatchObject({ id: "wks_b" });
    expect(await resolveWorkspace(paseo, "app · Beta")).toMatchObject({ id: "wks_b" });
    expect(await resolveWorkspace(paseo, "  Notes ")).toMatchObject({ id: "wks_n" });
  });

  it("says which ones when a title is shared, and which exist when there is no such workspace", async () => {
    const { resolveWorkspace } = await service();
    const twice = fakePaseo({ extraEntries: [{ id: "wks_b2", projectId: "proj-1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-b2", name: "b2", title: "Beta", archivingAt: null }] }).paseo;
    const ambiguous = await resolveWorkspace(twice, "Beta");
    expect((ambiguous as { problem: string }).problem).toContain("/work/app-b");
    expect((ambiguous as { problem: string }).problem).toContain("/work/app-b2");
    const none = await resolveWorkspace(fakePaseo().paseo, "Gamma");
    expect((none as { problem: string }).problem).toMatch(/no workspace.*Gamma/i);
    expect((none as { problem: string }).problem).toContain("app · Beta");
  });

  it("does not offer a workspace being archived or one in the plugin's own Bots project", async () => {
    const { resolveWorkspace } = await service();
    const paseo = fakePaseo({ botsProject: true }).paseo;
    expect(await resolveWorkspace(paseo, "Old")).toHaveProperty("problem");
    expect(await resolveWorkspace(paseo, "Dev")).toHaveProperty("problem");
    expect(await resolveWorkspace(paseo, "wks_bot")).toHaveProperty("problem");
  });

  it("names the project workspace a chat runs in, and nothing for a chat in a bot's own folder or an unknown chat", async () => {
    const { workspaceOfChat } = await service();
    const paseo = fakePaseo({ botsProject: true, chatWorkspaces: { "chat-1": "wks_b", "chat-bot": "wks_bot" } }).paseo;
    expect(await workspaceOfChat(paseo, "chat-1")).toMatchObject({ id: "wks_b", title: "Beta" });
    expect(await workspaceOfChat(paseo, "chat-bot")).toBeNull();
    expect(await workspaceOfChat(paseo, "chat-unknown")).toBeNull();
  });
});

describe("a host that hands the workspaces out in pages", () => {
  it("lists every page, so a workspace past the first page is found", async () => {
    const { listWorkspaces, resolveWorkspace } = await import("../server/workspaces");
    const entry = (n: number) => ({ id: `wks_${n}`, projectId: "p1", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: `/work/app-${n}`, name: `w${n}`, title: `W${n}`, archivingAt: null });
    const asked: unknown[] = [];
    const paseo = {
      workspaces: {
        list: async (options?: { page?: { limit: number; cursor?: string } }) => {
          asked.push(options?.page?.cursor ?? null);
          return options?.page?.cursor === "c1" ? { entries: [entry(3)], pageInfo: { hasMore: false, nextCursor: null } } : { entries: [entry(1), entry(2)], pageInfo: { hasMore: true, nextCursor: "c1" } };
        },
      },
    } as never;
    expect((await listWorkspaces(paseo)).map((listing) => listing.id)).toEqual(["wks_1", "wks_2", "wks_3"]);
    expect(await resolveWorkspace(paseo, "W3")).toMatchObject({ id: "wks_3" });
    expect(asked.slice(0, 2)).toEqual([null, "c1"]);
  });
});
