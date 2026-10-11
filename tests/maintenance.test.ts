import { describe, expect, it } from "vitest";
import { BotSchema } from "../shared/bot";
import { DEFAULT_BOT_MEMORY, NEW_BOT_MEMORY } from "../shared/memory-maintenance";
import { newBot } from "../shared/templates";
import { makeBot } from "./helpers";

describe("bot memory settings", () => {
  it("parses a bot saved before the feature, with both features off", () => {
    const { memory, ...old } = makeBot();
    expect(memory).toBeDefined();
    const parsed = BotSchema.parse(old);
    expect(parsed.memory).toEqual(DEFAULT_BOT_MEMORY);
    expect(parsed.memory.tidy.enabled).toBe(false);
    expect(parsed.memory.saveAt.enabled).toBe(false);
  });

  it("starts new bots with both features on", () => {
    expect(newBot("claude").memory).toEqual(NEW_BOT_MEMORY);
    expect(NEW_BOT_MEMORY.tidy).toMatchObject({ enabled: true, everyMinutes: 240, source: "public" });
    expect(NEW_BOT_MEMORY.saveAt).toMatchObject({ enabled: true, percent: 70 });
  });

  it("keeps the values in range", () => {
    expect(() => BotSchema.parse({ ...makeBot(), memory: { tidy: { everyMinutes: 5 } } })).toThrow();
    expect(() => BotSchema.parse({ ...makeBot(), memory: { saveAt: { percent: 99 } } })).toThrow();
  });
});

import {
  checkTidyResult,
  contextPercent,
  FORCE_BACKOFF_MS,
  nextSaveState,
  overBudget,
  publicModelFrom,
  savePrompt,
  tidyDecision,
  tidyPrompt,
  type TidyFacts,
} from "../shared/memory-maintenance";

describe("context use", () => {
  it("is a percentage, or null when the provider reports none", () => {
    expect(contextPercent({ contextWindowUsedTokens: 140_000, contextWindowMaxTokens: 200_000 })).toBe(70);
    expect(contextPercent({ contextWindowUsedTokens: 1 })).toBeNull();
    expect(contextPercent({ contextWindowUsedTokens: 5, contextWindowMaxTokens: 0 })).toBeNull();
    expect(contextPercent(null)).toBeNull();
    expect(contextPercent(undefined)).toBeNull();
  });
});

describe("when a chat is asked to save", () => {
  it("asks once per fill, and again after usage has dropped (a compaction)", () => {
    let state = { ask: false, asked: false };
    const step = (percent: number | null) => (state = nextSaveState(state.asked, percent, 70));
    expect(step(50)).toEqual({ ask: false, asked: false });
    expect(step(72)).toEqual({ ask: true, asked: true });
    expect(step(80)).toEqual({ ask: false, asked: true });
    expect(step(30)).toEqual({ ask: false, asked: false });
    expect(step(71)).toEqual({ ask: true, asked: true });
  });

  it("does nothing when the provider reports no usage, and keeps what it knew", () => {
    expect(nextSaveState(false, null, 70)).toEqual({ ask: false, asked: false });
    expect(nextSaveState(true, null, 70)).toEqual({ ask: false, asked: true });
  });
});

const HOUR = 3_600_000;
function facts(patch: Partial<TidyFacts> = {}): TidyFacts {
  return { now: 100 * HOUR, lastRunAt: 90 * HOUR, everyMinutes: 240, force: false, busy: false, runsLast24h: 0, blockedUntil: null, inboxBytes: 0, newLogLines: 0, memoryLines: 40, memoryBytes: 3_000, ...patch };
}

describe("when memory is tidied", () => {
  it("waits for the interval", () => {
    expect(tidyDecision(facts({ lastRunAt: 98 * HOUR, inboxBytes: 10 }))).toEqual({ run: false, reason: "not-due" });
  });

  it("runs for new material, and skips when there is none", () => {
    expect(tidyDecision(facts({ inboxBytes: 10 }))).toEqual({ run: true, reason: "new-material" });
    expect(tidyDecision(facts({ newLogLines: 3 }))).toEqual({ run: true, reason: "new-material" });
    expect(tidyDecision(facts())).toEqual({ run: false, reason: "nothing-new" });
  });

  it("still runs once when the laptop was asleep for days", () => {
    expect(tidyDecision(facts({ lastRunAt: 1 * HOUR, newLogLines: 2 }))).toEqual({ run: true, reason: "new-material" });
  });

  it("runs on a first run with nothing recorded", () => {
    expect(tidyDecision(facts({ lastRunAt: null, newLogLines: 1 }))).toEqual({ run: true, reason: "new-material" });
  });

  it("forces a run when memory is over 80% of the limit", () => {
    expect(overBudget(160, 1000)).toBe(false);
    expect(overBudget(161, 1000)).toBe(true);
    expect(overBudget(10, 19_201)).toBe(true);
    expect(tidyDecision(facts({ memoryLines: 170 }))).toEqual({ run: true, reason: "over-budget" });
  });

  it("backs off after a forced run that did not help", () => {
    const now = 100 * HOUR;
    expect(tidyDecision(facts({ memoryLines: 170, blockedUntil: now + FORCE_BACKOFF_MS }))).toEqual({ run: false, reason: "backoff" });
    expect(tidyDecision(facts({ memoryLines: 170, blockedUntil: now - 1 }))).toEqual({ run: true, reason: "over-budget" });
  });

  it("never runs while a chat of the bot is working, or past six runs a day", () => {
    expect(tidyDecision(facts({ inboxBytes: 10, busy: true }))).toEqual({ run: false, reason: "busy" });
    expect(tidyDecision(facts({ inboxBytes: 10, runsLast24h: 6 }))).toEqual({ run: false, reason: "daily-limit" });
  });

  it("run now skips the interval and the nothing-new rule, but not busy or the daily limit", () => {
    expect(tidyDecision(facts({ force: true, lastRunAt: 99 * HOUR }))).toEqual({ run: true, reason: "manual" });
    expect(tidyDecision(facts({ force: true, busy: true }))).toEqual({ run: false, reason: "busy" });
    expect(tidyDecision(facts({ force: true, runsLast24h: 6 }))).toEqual({ run: false, reason: "daily-limit" });
  });
});

describe("the prompts", () => {
  it("tell the tidy chat where things are, the budget, and that the inputs are untrusted", () => {
    const text = tidyPrompt({ memoryPath: "/b/MEMORY.md", topicPaths: ["/b/memory/clients.md"], inboxPath: "/b/memory/inbox.md", logPaths: ["/b/memory/log/2026-10-10.md"] });
    for (const part of ["/b/MEMORY.md", "/b/memory/clients.md", "/b/memory/inbox.md", "/b/memory/log/2026-10-10.md", "150 lines", "untrusted", "Never store secrets"]) {
      expect(text).toContain(part);
    }
  });

  it("asks a chat to append notes to the inbox and nothing else", () => {
    const text = savePrompt("/b/memory/inbox.md");
    expect(text).toContain("/b/memory/inbox.md");
    expect(text).toContain("not from the user");
    expect(text).toContain("20 lines");
  });
});

describe("checking a tidy result", () => {
  const before = { lines: 180, bytes: 20_000 };
  it("accepts a smaller file", () => {
    expect(checkTidyResult(before, { lines: 120, bytes: 12_000 })).toEqual({ flags: [], stillOver: false });
  });
  it("flags an empty or missing file", () => {
    expect(checkTidyResult(before, null).flags).toContain("MEMORY.md is empty or missing");
    expect(checkTidyResult(before, { lines: 0, bytes: 0 }).flags).toContain("MEMORY.md is empty or missing");
  });
  it("flags a file that shrank by more than half", () => {
    expect(checkTidyResult(before, { lines: 20, bytes: 2_000 }).flags).toContain("MEMORY.md shrank by more than half");
  });
  it("reports memory that is still over 80%", () => {
    const result = checkTidyResult(before, { lines: 190, bytes: 21_000 });
    expect(result.stillOver).toBe(true);
    expect(result.flags).toContain("MEMORY.md is still over the budget");
  });
});

describe("the public model", () => {
  it("reads the candidates from Paseo's Metadata generation setting, wherever the config puts it", () => {
    const providers = [{ provider: "devin", model: "swe-free" }, { provider: "claude" }];
    const want = [{ provider: "devin", model: "swe-free" }, { provider: "claude", model: null }];
    expect(publicModelFrom({ config: { metadataGeneration: { providers } } })).toEqual(want);
    expect(publicModelFrom({ config: { agents: { metadataGeneration: { providers } } } })).toEqual(want);
    expect(publicModelFrom({ metadataGeneration: { providers } })).toEqual(want);
  });
  it("gives nothing for a config without the setting", () => {
    expect(publicModelFrom({ config: {} })).toEqual([]);
    expect(publicModelFrom(null)).toEqual([]);
    expect(publicModelFrom({ config: { metadataGeneration: { providers: [{ model: "x" }, 4] } } })).toEqual([]);
  });
});
