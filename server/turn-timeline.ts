import type { PaseoApi } from "./paseo";

/** The parts of a timeline item the turn readers look at. */
export interface TurnItem {
  type: string;
  text?: unknown;
  name?: unknown;
}

// Paseo 0.13 and later send `agent.turn_ended` with an empty `timeline` (deprecated in the SDK: "Always empty"); the
// history is fetched on demand. What the plugin reads from a finished turn (the reply, the tools, which files a turn
// wrote, who drove it) comes from here.

const PAGE = 100;
/** A turn with a tool call per item is longer than a page; this many pages is a thousand items. */
const MAX_PAGES = 10;
/** The turn's own user message and the one before it: the second tells "the only message" (a routine's first turn) from a later one. */
const USER_MESSAGES = 2;

/** Whether the item is the user's message, the mark where a turn starts. */
const isUser = (item: TurnItem) => item.type === "user_message";

/**
 * The items of a chat that just finished a turn, oldest first. What the event carried is used when it carried
 * something (older hosts); otherwise the tail of the chat is read, going back page by page until two messages of
 * the user are in or the start is reached. Empty when the chat cannot be read: a turn is then recorded without its
 * text rather than not at all.
 */
export async function turnTimeline(paseo: PaseoApi | null, agentId: string, given: readonly TurnItem[], pageSize = PAGE): Promise<readonly TurnItem[]> {
  if (given.length > 0 || !paseo) return given;
  try {
    const handle = paseo.agents.ref(agentId);
    let page = await handle.timeline.refetch({ direction: "tail", projection: "projected", limit: pageSize });
    if (page.error) throw new Error(page.error);
    let items: TurnItem[] = page.entries.map((entry) => entry.item as TurnItem);
    for (let pages = 1; pages < MAX_PAGES && page.hasOlder && page.startCursor && items.filter(isUser).length < USER_MESSAGES; pages++) {
      page = await handle.timeline.refetch({ direction: "before", cursor: page.startCursor, projection: "projected", limit: pageSize });
      if (page.error) throw new Error(page.error);
      if (page.entries.length === 0) break;
      items = [...page.entries.map((entry) => entry.item as TurnItem), ...items];
    }
    return items;
  } catch (error) {
    console.error("aydo: couldn't read the chat's timeline after a turn", error);
    return [];
  }
}
