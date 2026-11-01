import { z } from "zod";
import { TIDY_LABEL } from "../../shared/memory-maintenance";
import { getApproval, listApprovals } from "../approvals-store";
import { defineTool, type ToolCaller } from "./mcp";

// A bot puts a matter to the user and waits for the answer, which comes into the chat as a message.

/** Not for a memory tidy chat (it reads untrusted text unattended and must not ask the user for decisions). */
async function mayAsk({ agentId, host }: ToolCaller): Promise<boolean> {
  const chat = await host.chatOf(agentId).catch(() => null);
  return !chat?.labels[TIDY_LABEL];
}

export const requestApprovalTool = defineTool({
  name: "request_approval",
  description:
    "Ask the user to approve a matter before you go on (a design, a plan, a decision, a result). The user sees a card in this chat with your text and the file, and decides; you cannot decide for them, and neither can another bot. After asking, stop: do nothing else in this chat until the answer arrives here as a message. If the user rejects it, talk it over with them and ask again.",
  input: z.object({
    title: z.string().min(1).max(200).describe("What is to be approved, in a few words."),
    text: z.string().min(1).max(20_000).describe("What you ask and why, in markdown, so the user can decide without reading this chat."),
    file: z.string().min(1).max(500).optional().describe("A file to show with it, such as the plan: a path in your folder or in this chat's workspace (text, at most 200 KB)."),
  }),
  available: mayAsk,
  async run(args, { bot, agentId, host, relay }) {
    if (!relay?.approvals) throw new Error("Approvals aren't available right now. Try again in a moment.");
    const labels = (await host.chatOf(agentId))?.labels ?? {};
    const result = await relay.approvals.request({ bot, agentId, labels }, args);
    if (!result.ok) throw new Error(result.text);
    return result.text;
  },
});

export const listApprovalsTool = defineTool({
  name: "list_approvals",
  description: "List your own approval requests, newest first: id, state, title, when decided and the user's note. Use it to find an approval's id to cite, or to see what the user answered.",
  input: z.object({ status: z.enum(["pending", "approved", "rejected", "withdrawn"]).optional().describe("Only the ones in this state.") }),
  available: mayAsk,
  async run({ status }, { bot }) {
    const found = await listApprovals({ botId: bot.id, ...(status ? { status } : {}) });
    if (found.length === 0) return status ? `You have no ${status} approvals.` : "You have no approvals.";
    return found
      .slice(0, 30)
      .map((entry) => `- ${entry.id} · ${entry.status} · "${entry.title}" · asked ${entry.createdAt}${entry.decidedAt ? ` · decided ${entry.decidedAt}` : ""}${entry.note ? ` · note: ${JSON.stringify(entry.note)}` : ""}`)
      .join("\n");
  },
});

export const withdrawApprovalTool = defineTool({
  name: "withdraw_approval",
  description: "Withdraw your own approval request while it still waits for the user (you no longer need the decision). It grants nothing.",
  input: z.object({ id: z.string().regex(/^a-[a-f0-9]{10}$/).describe("The approval's id.") }),
  available: mayAsk,
  async run({ id }, { agentId, relay }) {
    if (!relay?.approvals) throw new Error("Approvals aren't available right now. Try again in a moment.");
    const current = await getApproval(id);
    if (!current) throw new Error(`There is no approval ${id}.`);
    await relay.approvals.withdraw(id, "asking-bot", agentId);
    return `Approval ${id} is withdrawn.`;
  },
});
