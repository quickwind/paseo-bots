import { describe, expect, it } from "vitest";
import { allPages } from "../shared/pages";

type Page = { entries: number[]; pageInfo?: { hasMore: boolean; nextCursor: string | null } };
const pages = (list: Page[]) => {
  const asked: (string | null)[] = [];
  return { asked, fetch: async (cursor: string | null) => (asked.push(cursor), list[asked.length - 1]!) };
};

describe("reading a list the host hands out in pages", () => {
  it("is the one page when the host says there is no more, or says nothing about pages", async () => {
    const one = pages([{ entries: [1, 2], pageInfo: { hasMore: false, nextCursor: null } }]);
    expect(await allPages(one.fetch)).toEqual([1, 2]);
    expect(one.asked).toEqual([null]);
    expect(await allPages(pages([{ entries: [3] }]).fetch)).toEqual([3]);
  });
  it("follows the cursor through every page and joins them in order", async () => {
    const many = pages([
      { entries: [1, 2], pageInfo: { hasMore: true, nextCursor: "c1" } },
      { entries: [3, 4], pageInfo: { hasMore: true, nextCursor: "c2" } },
      { entries: [5], pageInfo: { hasMore: false, nextCursor: null } },
    ]);
    expect(await allPages(many.fetch)).toEqual([1, 2, 3, 4, 5]);
    expect(many.asked).toEqual([null, "c1", "c2"]);
  });
  it("fails, rather than hand back a part, when there is more but no cursor, or too many pages", async () => {
    await expect(allPages(pages([{ entries: [1], pageInfo: { hasMore: true, nextCursor: null } }]).fetch)).rejects.toThrow(/incomplete/i);
    const endless = async () => ({ entries: [1], pageInfo: { hasMore: true, nextCursor: "again" } });
    await expect(allPages(endless, 3)).rejects.toThrow(/incomplete/i);
  });
});
