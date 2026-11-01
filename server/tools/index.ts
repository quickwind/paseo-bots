import { listApprovalsTool, requestApprovalTool, withdrawApprovalTool } from "./approvals";
import { askBot, assignBot, checkChat, listBots } from "./bots";
import { searchChats } from "./chats";
import type { BotTool } from "./mcp";
import { proposeRoutine } from "./routines";
import { getSetup, proposeChanges } from "./setup";
import { proposeSkill } from "./skills";
import { createWorkspaceTool, listWorkspacesTool } from "./workspaces";

/** Every tool the "bots" MCP server offers, in the order agents see them. */
export const BOT_TOOLS: readonly BotTool[] = [listBots, askBot, assignBot, checkChat, searchChats, getSetup, proposeSkill, proposeRoutine, proposeChanges, listWorkspacesTool, createWorkspaceTool, requestApprovalTool, listApprovalsTool, withdrawApprovalTool];
