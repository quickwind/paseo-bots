import { describe, expect, it } from "vitest";
import { mergeDraft } from "../client/draft";
import { makeBot } from "./helpers";

// The panel keeps a whole copy of the bot while it is being edited and saves the copy a moment later. Saving the
// whole copy would undo anything saved meanwhile, such as a routine accepted from a card in the chat.

describe("saving a bot that was edited in the panel", () => {
  const base = makeBot({ id: "scout", title: "Researcher", soul: "old" });

  it("applies only the fields the person changed", () => {
    const draft = { ...base, soul: "new instructions", updatedAt: "2026-10-18T10:00:00.000Z" };
    const savedMeanwhile = { ...base, routines: [{ id: "rt-1" } as never] };
    const merged = mergeDraft(savedMeanwhile, draft, base);
    expect(merged.soul).toBe("new instructions");
    expect(merged.updatedAt).toBe("2026-10-18T10:00:00.000Z");
    expect(merged.routines).toEqual(savedMeanwhile.routines);
    expect(merged.title).toBe("Researcher");
  });

  it("takes the whole draft when there is nothing to compare it with", () => {
    const draft = { ...base, soul: "new" };
    expect(mergeDraft(base, draft, undefined)).toBe(draft);
  });
});
