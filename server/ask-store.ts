import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginDataPath } from "./bot-home";
import type { BotsHost } from "./host";

// The questions one bot has asked another, kept in one file so a follow-up from the same chat can go
// into the chat that already has the answer, whether the question came as a file or as the ask_bot tool.

/** Label on the chat that answers, carrying the id of the first question put to it. */
export const ASK_REQUEST_LABEL = "bot-crew.ask-request";
/** A follow-up goes into the same chat for this long after its last question; after that a new chat starts. */
export const REUSE_WITHIN_MS = 60 * 60_000;
const KEEP = 200;

export interface AskRequest {
  id: string;
  fromBot: string;
  fromChat: string;
  toBot: string;
  toName: string;
  toChat: string | null;
  message: string;
  createdAt: string;
  /** "waiting": for the user's approval. "queued": approved, waiting for the other chat to be free. "running": the other bot is working. */
  status: "waiting" | "queued" | "running" | "answered" | "closed";
  /** When the question was sent; the half hour is counted from here. */
  startedAt?: string;
  answeredAt?: string;
  /** "tool": asked with ask_bot, which waits for the answer itself, so nothing is pushed into the asking chat. */
  via?: "tool";
  /** Messages for the asking chat that have not been sent yet (it was busy). */
  unsent: string[];
}

const storePath = () => join(pluginDataPath(), "requests.json");

export async function loadRequests(): Promise<AskRequest[]> {
  try {
    return (JSON.parse(await readFile(storePath(), "utf8")) as { requests?: AskRequest[] }).requests ?? [];
  } catch {
    return [];
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** One read-modify-write at a time. */
export function updateRequests<T>(change: (requests: AskRequest[]) => T): Promise<T> {
  const run = async () => {
    const requests = await loadRequests();
    const result = change(requests);
    await mkdir(pluginDataPath(), { recursive: true });
    await writeFile(storePath(), JSON.stringify({ requests: requests.slice(-KEEP) }, null, 2), "utf8");
    return result;
  };
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

const lastUsed = (request: AskRequest) => Date.parse(request.answeredAt ?? request.startedAt ?? request.createdAt);

/**
 * The chat an earlier question from this chat to this bot started, if a follow-up can go into it:
 * it is still there, and its last question was less than an hour ago. `busy` says the other bot is
 * still working (or other questions already wait for it), so a follow-up has to wait its turn.
 */
export async function reusableChat(host: BotsHost, input: { fromChat: string; toBot: string; exceptId?: string; now: number }): Promise<{ chat: string; busy: boolean } | null> {
  const requests = await loadRequests();
  const earlier = requests
    .filter((entry) => entry.id !== input.exceptId && entry.fromChat === input.fromChat && entry.toBot === input.toBot && entry.toChat && entry.status !== "waiting")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!earlier?.toChat) return null;
  if (input.now - Math.max(lastUsed(earlier), ...requests.filter((entry) => entry.toChat === earlier.toChat).map(lastUsed)) > REUSE_WITHIN_MS) return null;
  const agent = (await host.paseo?.agents.ref(earlier.toChat).refresh().catch(() => null))?.agent;
  if (!agent || (agent as { archivedAt?: string | null }).archivedAt) return null;
  const working = agent.status === "running" || agent.status === "initializing";
  return { chat: earlier.toChat, busy: working || requests.some((entry) => entry.toChat === earlier.toChat && entry.status === "queued" && entry.id !== input.exceptId) };
}
