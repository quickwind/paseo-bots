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
