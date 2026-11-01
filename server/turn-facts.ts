import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import { questionText, turnDriver, turnMeta, turnStatus, type TurnDriver, type TurnStatus } from "../shared/reports";
import { workspaceLabel } from "../shared/workspaces";
import { pendingFor } from "./approvals-store";
import type { BotsHost } from "./host";
import type { PaseoApi } from "./paseo";
import { listWorkspaces, workspaceOfChat, type WorkspaceListing } from "./workspaces";

export interface TurnFacts {
  driver: TurnDriver;
  status: TurnStatus;
  /** The project workspace the chat runs in; null for a chat in a bot's own folder, or when it can't be told. */
  workspace: WorkspaceListing | null;
  /** The bracket for the daily log and the team's reports. */
  meta: string;
  /** The text of the last user message, without the framing of another bot's message. */
  question: string;
}

const LISTING_TTL_MS = 5_000;
const listings = new WeakMap<object, { at: number; list: Promise<WorkspaceListing[]> }>();

/** The host's workspaces, asked for again only after a few seconds: every turn of every bot needs them. */
function cachedListing(paseo: PaseoApi): Promise<WorkspaceListing[]> {
  const known = listings.get(paseo);
  if (known && Date.now() - known.at < LISTING_TTL_MS) return known.list;
  const list = listWorkspaces(paseo);
  listings.set(paseo, { at: Date.now(), list });
  // A failed call is not kept, so the next turn asks again.
  list.catch(() => listings.delete(paseo));
  return list;
}

/** What a finished turn was: where it ran, who drove it, how it ended. */
export async function turnFacts(
  host: BotsHost,
  input: { agentId: string; chat: { routineId: string | null; labels: Record<string, string> }; timeline: readonly unknown[]; outcome: PluginTurnOutcome; reply: string },
): Promise<TurnFacts> {
  const userMessages = input.timeline.filter((item) => (item as { type?: string }).type === "user_message") as { text?: unknown }[];
  const last = userMessages.at(-1)?.text;
  const driver = turnDriver({ lastUserMessage: typeof last === "string" ? last : null, userMessages: userMessages.length, routine: Boolean(input.chat.routineId) });
  // A chat whose approval waits for the user stopped to wait (or was stopped by the plugin to wait): that is not "done".
  const waiting = input.outcome.kind !== "failed" && (await pendingFor(input.agentId).catch(() => null)) !== null;
  const status: TurnStatus = waiting ? "waiting" : turnStatus(input.outcome.kind, input.reply);
  const paseo = host.paseo;
  const workspace = paseo ? await cachedListing(paseo).then((list) => workspaceOfChat(paseo, input.agentId, list)).catch(() => null) : null;
  return { driver, status, workspace, meta: turnMeta({ workspace: workspace ? workspaceLabel(workspace) : null, driver, status }), question: typeof last === "string" ? questionText(last) : "" };
}
