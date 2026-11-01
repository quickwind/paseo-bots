import { describe, expect, it } from "vitest";
import { nextFollow } from "../client/chat/follow";

const base = { follow: true, distance: 0, offset: 1000, previousOffset: 1000, content: 2000, previousContent: 2000, programmatic: false, threshold: 64 };

describe("whether the chat keeps following new messages", () => {
  it("keeps following when the content grows and the view has not moved", () => {
    expect(nextFollow({ ...base, distance: 300, content: 2300 })).toBe(true);
  });

  it("keeps following when the content grows by more than the near-bottom margin between two scroll events", () => {
    expect(nextFollow({ ...base, distance: 120, content: 2120, offset: 1000, previousOffset: 1000 })).toBe(true);
  });

  it("stops following when the reader scrolls up", () => {
    expect(nextFollow({ ...base, distance: 400, offset: 700, previousOffset: 1000 })).toBe(false);
  });

  it("starts following again when the reader comes back to the bottom", () => {
    expect(nextFollow({ ...base, follow: false, distance: 20, offset: 1900, previousOffset: 1500 })).toBe(true);
  });

  it("does not take the app's own scroll to the end for the reader scrolling up", () => {
    expect(nextFollow({ ...base, distance: 200, offset: 800, previousOffset: 1000, programmatic: true })).toBe(true);
  });

  it("does not take a shrinking list (the view is pushed up by the browser) for the reader scrolling up", () => {
    expect(nextFollow({ ...base, distance: 90, offset: 900, previousOffset: 1000, content: 1800, previousContent: 2000 })).toBe(true);
  });

  it("stays stopped while the reader reads above", () => {
    expect(nextFollow({ ...base, follow: false, distance: 600, offset: 700, previousOffset: 700, content: 2600, previousContent: 2000 })).toBe(false);
  });
});
