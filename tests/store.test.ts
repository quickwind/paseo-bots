import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The question and proposal stores are read while they are written. A reader that catches a file half
// written would take it for an empty store: the hourly count would restart and an answer would find no request.

describe("the stores of questions and proposals", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-store-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  /** Reads over and over while `work` runs; the biggest drop in what was read tells of a half-written file. */
  async function biggestDrop(read: () => Promise<number>, work: () => Promise<void>): Promise<number> {
    let running = true;
    let seen = 0;
    let drop = 0;
    const reader = (async () => {
      while (running) {
        const count = await read();
        drop = Math.max(drop, seen - count);
        seen = Math.max(seen, count);
      }
    })();
    await work();
    running = false;
    await reader;
    return drop;
  }

  it("never shows a question store that has lost entries while it is being written", async () => {
    const { loadRequests, updateRequests } = await import("../server/ask-store");
    const request = (n: number) => ({ id: `r-${n}`, fromBot: "a", fromChat: "c", toBot: "b", toName: "B", toChat: null, message: "x".repeat(2_000), createdAt: new Date().toISOString(), status: "waiting" as const, unsent: [] });
    const drop = await biggestDrop(
      async () => (await loadRequests()).length,
      async () => {
        for (let n = 0; n < 150; n++) await updateRequests((requests) => void requests.push(request(n)));
      },
    );
    expect(drop).toBe(0);
    expect((await loadRequests()).length).toBe(150);
    expect((await readdir(join(home, "plugin-data", "bot-crew"))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("never shows a proposal store that has lost entries while it is being written", async () => {
    const { createProposal, getProposal } = await import("../server/proposals");
    const ids: string[] = [];
    const drop = await biggestDrop(
      async () => {
        const first = ids[0];
        // Always waits on the store, so the reading loop lets the writer run.
        const found = await getProposal(first ?? "none");
        return first && found ? 1 : 0;
      },
      async () => {
        for (let n = 0; n < 150; n++) ids.push((await createProposal({ botId: "b", agentId: "c", kind: "ask", data: { requestId: `r-${n}`, toBotId: "x", toName: "X", message: "y".repeat(2_000) } } as never)).id);
      },
    );
    expect(drop).toBe(0);
  });
});
