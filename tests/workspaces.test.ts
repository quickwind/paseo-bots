import { describe, expect, it } from "vitest";
import type { BotGroup } from "../shared/bot";
import { CreateWorkspaceInput, folderNameFor, grantScope, scopeOf, workspaceInputProblem, workspaceLabel } from "../shared/workspaces";

const NOW = "2026-10-19T00:00:00.000Z";
const group = (patch: Partial<BotGroup> = {}): BotGroup => ({ id: "t1", name: "Eng", logo: null, leadId: "lead", memberIds: ["lead", "b1"], instructions: "", askFreely: false, createdAt: NOW, updatedAt: NOW, ...patch });
const input = (patch: Record<string, unknown> = {}) => CreateWorkspaceInput.parse({ project: "app", title: "Login", ...patch });

describe("folderNameFor", () => {
  it("turns a title into a safe folder name", () => {
    expect(folderNameFor("Login v2: plan")).toBe("login-v2-plan");
    expect(folderNameFor("  ..//x  ")).toBe("x");
    expect(folderNameFor("???")).toBe("");
    expect(folderNameFor("a".repeat(100))).toHaveLength(60);
  });
});

describe("CreateWorkspaceInput", () => {
  it("defaults to a plain folder and trims the title", () => {
    expect(input({ title: "  Login  " })).toMatchObject({ title: "Login", worktree: false });
  });
  it("refuses a title with a control character or over 80 characters, and an empty project", () => {
    expect(CreateWorkspaceInput.safeParse({ project: "app", title: "a\u0000b" }).success).toBe(false);
    expect(CreateWorkspaceInput.safeParse({ project: "app", title: "x".repeat(81) }).success).toBe(false);
    expect(CreateWorkspaceInput.safeParse({ project: "", title: "x" }).success).toBe(false);
  });
});

describe("workspaceInputProblem", () => {
  it("accepts a worktree with a branch and base, and a plain folder", () => {
    expect(workspaceInputProblem(input({ worktree: true, branch: "feature/login", base: "main" }))).toBeNull();
    expect(workspaceInputProblem(input())).toBeNull();
  });
  it("says so when a branch or base is given without a worktree", () => {
    expect(workspaceInputProblem(input({ branch: "x" }))).toMatch(/worktree/);
    expect(workspaceInputProblem(input({ base: "main" }))).toMatch(/worktree/);
  });
  it("refuses branch names git would not take or that look like options or paths", () => {
    for (const branch of ["a..b", "-x", "x.lock", "a b", "/abs", "x/"]) expect(workspaceInputProblem(input({ worktree: true, branch }))).not.toBeNull();
    expect(workspaceInputProblem(input({ worktree: true, base: "a..b" }))).not.toBeNull();
  });
  it("refuses a folder title that leaves no name", () => {
    expect(workspaceInputProblem(input({ title: "???" }))).toMatch(/folder name/);
    expect(workspaceInputProblem(input({ title: "???", worktree: true, branch: "ok" }))).toBeNull();
    expect(workspaceInputProblem(input({ title: "???", worktree: true }))).toMatch(/branch/);
  });
});

describe("grantScope", () => {
  it("is the team for a bot on a team, else the bot", () => {
    expect(grantScope("b1", [group()])).toBe("team:t1");
    expect(grantScope("lead", [group()])).toBe("team:t1");
    expect(grantScope("solo", [group()])).toBe("bot:solo");
    expect(grantScope("b1", [])).toBe("bot:b1");
  });
});

describe("scopeOf", () => {
  it("is the scope a team or a bot names, and refuses anything else", () => {
    expect(scopeOf({ teamId: "t1" })).toBe("team:t1");
    expect(scopeOf({ botId: "b1" })).toBe("bot:b1");
    expect(() => scopeOf({})).toThrow("Name a team or a bot");
    expect(() => scopeOf({ teamId: "t1", botId: "b1" })).toThrow("Name a team or a bot");
  });
  it("agrees with grantScope", () => {
    expect(scopeOf({ teamId: "t1" })).toBe(grantScope("b1", [group()]));
    expect(scopeOf({ botId: "solo" })).toBe(grantScope("solo", [group()]));
  });
});

describe("workspaceLabel", () => {
  it("is the project and the title, so workspaces with one title in two projects can be told apart", () => {
    expect(workspaceLabel({ title: "main", projectName: "proj2" })).toBe("proj2 · main");
  });
  it("is the title alone when the project is not known", () => {
    expect(workspaceLabel({ title: "main" })).toBe("main");
  });
});
