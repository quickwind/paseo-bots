import { describe, expect, it } from "vitest";
import { chatWhere, friendlyStartError, workspaceChoices, workspaceLabels } from "../client/workspace-choice";

const BOTS = "/data/plugin-data/aydo/shared/Bots";
const entry = (patch: Record<string, unknown>) => ({ id: "w", projectId: "p", projectDisplayName: "app", projectRootPath: "/work/app", workspaceDirectory: "/work/app-x", name: "x", title: null, archivingAt: null, ...patch });

describe("the workspaces a new chat can be started in", () => {
  it("labels each with its project and title, and sorts by that label", () => {
    const list = workspaceChoices([
      entry({ id: "w2", title: "Settings page" }),
      entry({ id: "w1", title: "Login" }),
      entry({ id: "w3", projectDisplayName: "Notes", projectRootPath: "/work/notes", workspaceDirectory: "/work/notes/one", title: null, name: "one" }),
    ]);
    expect(list.map((choice) => choice.label)).toEqual(["app · Login", "app · Settings page", "Notes · one"]);
    expect(list[0]).toEqual({ id: "w1", label: "app · Login", directory: "/work/app-x" });
  });

  it("prefers the project's custom name, and falls back to the project root when a workspace has no folder", () => {
    const [choice] = workspaceChoices([entry({ projectCustomName: "Shop", workspaceDirectory: undefined, title: "Main" })]);
    expect(choice).toEqual({ id: "w", label: "Shop · Main", directory: "/work/app" });
  });

  it("leaves out workspaces being archived and everything in the plugin's own Bots project", () => {
    const list = workspaceChoices([
      entry({ id: "keep", title: "Keep" }),
      entry({ id: "gone", title: "Gone", archivingAt: "2026-10-20T00:00:00.000Z" }),
      entry({ id: "bot", projectDisplayName: "Bots", projectRootPath: BOTS, workspaceDirectory: `${BOTS}/bot-1`, name: "scout" }),
      entry({ id: "root", projectDisplayName: "Bots", projectRootPath: BOTS, workspaceDirectory: undefined }),
    ]);
    expect(list.map((choice) => choice.id)).toEqual(["keep"]);
  });

  it("gives nothing for no workspaces", () => {
    expect(workspaceChoices([])).toEqual([]);
  });
});

describe("telling worktrees apart", () => {
  it("adds the worktree's folder name when it differs from the title", () => {
    const [choice] = workspaceChoices([entry({ title: "Checkout page", workspaceKind: "worktree", worktreeSlug: "feature-checkout" })]);
    expect(choice!.label).toBe("app · Checkout page (feature-checkout)");
  });
  it("adds nothing when the title is the folder name, or for a plain folder", () => {
    expect(workspaceChoices([entry({ title: "feature-x", workspaceKind: "worktree", worktreeSlug: "feature-x" })])[0]!.label).toBe("app · feature-x");
    expect(workspaceChoices([entry({ title: "Notes", workspaceKind: "directory" })])[0]!.label).toBe("app · Notes");
  });
});

describe("where a chat runs", () => {
  const labels = workspaceLabels(workspaceChoices([entry({ id: "w1", title: "Login" })]));
  it("names the project workspace a chat is in", () => {
    expect(chatWhere({ workspaceId: "w1" }, labels)).toBe("app · Login");
  });
  it("says nothing for a chat in the bot's own folder or one with no workspace", () => {
    expect(chatWhere({ workspaceId: "assistants-own" }, labels)).toBeNull();
    expect(chatWhere({ workspaceId: null }, labels)).toBeNull();
    expect(chatWhere(null, labels)).toBeNull();
    expect(chatWhere(undefined, labels)).toBeNull();
  });
});

describe("friendlyStartError", () => {
  it("says a workspace is gone when the host says it has no folder or was not found", () => {
    const gone = "That workspace is gone. Pick another one, or the assistant's own folder.";
    expect(friendlyStartError("Workspace wks_1234 has no available directory")).toBe(gone);
    expect(friendlyStartError("Workspace not found: wks_1234")).toBe(gone);
  });
  it("leaves other errors as they are", () => {
    expect(friendlyStartError("Network down")).toBe("Network down");
  });
});
