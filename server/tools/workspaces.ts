import { z } from "zod";
import { CreateWorkspaceInput } from "../../shared/workspaces";
import { listWorkspaces, requestWorkspace } from "../workspaces";
import { defineTool } from "./mcp";

// Where the work is: the workspaces of the user's projects, and a new one for a piece of work. A project the bot's
// team has not used asks the user on a card first; after that it is remembered for the team.

export const listWorkspacesTool = defineTool({
  name: "list_workspaces",
  description: "List the workspaces of the user's projects: title, id, project and folder. Use it to find where a piece of work lives before creating a new workspace.",
  input: z.object({}),
  async run(_args, { host }) {
    const list = await listWorkspaces(host.requirePaseo());
    if (list.length === 0) return "There are no workspaces.";
    return list.map((entry) => `- ${entry.title} (id ${entry.id}) in ${entry.projectName}: ${entry.directory}`).join("\n");
  },
});

export const createWorkspaceTool = defineTool({
  name: "create_workspace",
  description:
    "Create a workspace for a piece of work in one of the user's projects: a git worktree on its own branch (worktree true, in a git project), or a plain folder inside the project. The first time your team uses a project the user is asked on a card in this chat, and the workspace is created when they allow it; after that it is created at once. The reply says where it is.",
  input: CreateWorkspaceInput,
  run: (input, { bot, agentId, host }) => requestWorkspace({ bot, agentId, host }, input),
});
