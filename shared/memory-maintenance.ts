import { z } from "zod";

/** What a chat's system prompt carries of MEMORY.md (server/memory.ts reads the same numbers). */
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 24_000;
/** Tidy aims below the limit so the file has room to grow between runs. */
export const TIDY_TARGET_LINES = 150;
export const TIDY_TARGET_BYTES = 18_000;
/** Above this share of the limit, tidy runs even with nothing new. */
export const OVER_BUDGET_FRACTION = 0.8;
export const TIDY_MAX_RUNS_PER_DAY = 6;
/** After a forced tidy that fails or does not shrink memory, wait this long before forcing again. */
export const FORCE_BACKOFF_MS = 24 * 3_600_000;
/** The file chats append unfinished notes to; it lives in memory/ so it is a topic file to the app. */
export const INBOX_FILE = "inbox.md";
/** Label on tidy chats, carrying the bot id. */
export const TIDY_LABEL = "paseo-bots.tidy";
export const SAVE_MAX_LINES = 20;

const TidySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  everyMinutes: z.number().int().min(15).max(10_080).default(240),
  /** "public": the first usable model of Paseo's Metadata generation list. "bot": the bot's own. "model": `model` on the bot's provider. */
  source: z.enum(["public", "bot", "model"]).default("public"),
  model: z.string().nullable().default(null),
});

const SaveSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Context window use at which a chat is asked to save its notes. */
  percent: z.number().int().min(50).max(95).default(70),
});

export const BotMemorySchema = z.object({
  tidy: TidySettingsSchema.default({ enabled: false, everyMinutes: 240, source: "public", model: null }),
  saveAt: SaveSettingsSchema.default({ enabled: false, percent: 70 }),
});
export type BotMemory = z.infer<typeof BotMemorySchema>;

export const DEFAULT_BOT_MEMORY: BotMemory = BotMemorySchema.parse({});
export const NEW_BOT_MEMORY: BotMemory = {
  tidy: { ...DEFAULT_BOT_MEMORY.tidy, enabled: true },
  saveAt: { ...DEFAULT_BOT_MEMORY.saveAt, enabled: true },
};
