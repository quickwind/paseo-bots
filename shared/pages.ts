/**
 * All of a list the host hands out in pages (the daemon returns 200 workspaces unless asked for more). It fails rather than
 * return a part: a caller that decides things from "what is not in the list" (the reports sweep) must not act on a partial one.
 */
export async function allPages<T>(
  fetchPage: (cursor: string | null) => Promise<{ entries: T[]; pageInfo?: { hasMore: boolean; nextCursor: string | null } }>,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor);
    out.push(...result.entries);
    if (!result.pageInfo?.hasMore) return out;
    if (!result.pageInfo.nextCursor) throw new Error("The host's list is incomplete: more pages, but no cursor for them.");
    cursor = result.pageInfo.nextCursor;
  }
  throw new Error("The host's list is incomplete: too many pages.");
}
