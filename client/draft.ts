import type { Bot } from "../shared/bot";

/**
 * The bot to save from a draft the panel kept while it was edited. `base` is the bot as it was when editing began:
 * only the fields the draft changed are applied to `current`, so what was saved meanwhile (a routine or skill
 * accepted from a card in the chat) is not undone. Without a base the draft is taken whole.
 */
export function mergeDraft(current: Bot, draft: Bot, base: Bot | undefined): Bot {
  if (!base) return draft;
  const merged: Bot = { ...current };
  for (const key of Object.keys(draft) as (keyof Bot)[]) {
    // The panel changes fields with `{ ...bot, ...patch }`, so a field it left alone is the very same value as in the base.
    if (draft[key] !== base[key]) (merged as unknown as Record<string, unknown>)[key] = draft[key];
  }
  return merged;
}
