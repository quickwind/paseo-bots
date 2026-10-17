import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY, type BotGroup } from "../shared/bot";
import { promptContext } from "../server/prompt";
import { makeBot } from "./helpers";

const group: BotGroup = { id: "t1", name: "Ops", logo: null, leadId: "chief", memberIds: ["chief", "scout"], instructions: "", askFreely: false, createdAt: "", updatedAt: "" };

describe("what the Chief of Staff is told about asking its team", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "bot-crew-teamprompt-"));
    process.env.PASEO_HOME = home;
  });
  afterEach(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const teamText = async (provider: string, patch: Record<string, unknown> = {}, local = true) => {
    const chief = makeBot({ id: "chief", name: "Chief", provider, ...patch });
    const bots = [chief, makeBot({ id: "scout", name: "Scout" })];
    return (await promptContext(chief, local, EMPTY_LIBRARY, false, { team: { group, bots } })).team ?? "";
  };

  it("names the tool when its tools are an MCP server, and the outbox when they are files", async () => {
    const claude = await teamText("claude");
    expect(claude).toContain("ask_bot");
    expect(claude).not.toContain("outbox");
    const devin = await teamText("devin");
    expect(devin).toContain("outbox");
    expect(devin).not.toContain("ask_bot");
  });

  it("does not tell it to hand work on when it can't contact anyone", async () => {
    for (const text of [await teamText("claude", { contactBots: "off" }), await teamText("devin", { contactBots: "off" }), await teamText("claude", {}, false)]) {
      expect(text).not.toContain("ask_bot");
      expect(text).not.toContain("outbox");
      expect(text).toMatch(/can't contact/i);
    }
  });
});
