import { describe, expect, it } from "vitest";
import { botSettings } from "../shared/bot";
import { DEFAULT_SETUP_PROMPT, setupPromptText, shouldAutoSetup } from "../shared/setup";

describe("the setup interview prompt", () => {
  it("is the built-in text unless one is configured", () => {
    expect(setupPromptText(undefined)).toBe(DEFAULT_SETUP_PROMPT);
    expect(setupPromptText({ prompt: "", autoStart: true })).toBe(DEFAULT_SETUP_PROMPT);
    expect(setupPromptText({ prompt: "  \n ", autoStart: true })).toBe(DEFAULT_SETUP_PROMPT);
    expect(setupPromptText({ prompt: "  Ask about my team.  ", autoStart: true })).toBe("Ask about my team.");
  });

  it("interviews, then proposes the configuration on one card, and leaves the model and approval mode alone", () => {
    for (const part of ["one short question at a time", "get_setup", "propose_changes", "MEMORY.md", "provider, model, approval mode or thinking", "Model and Permissions settings"]) {
      expect(DEFAULT_SETUP_PROMPT).toContain(part);
    }
  });
});

describe("when a new bot starts its own setup", () => {
  const on = { prompt: "", autoStart: true };
  it("does for a blank bot with a provider, unless it is switched off", () => {
    expect(shouldAutoSetup(undefined, on, "claude")).toBe(true);
    expect(shouldAutoSetup(undefined, undefined, "claude")).toBe(true);
    expect(shouldAutoSetup(undefined, { ...on, autoStart: false }, "claude")).toBe(false);
  });
  it("does not for a role or a preset, which already come with instructions", () => {
    expect(shouldAutoSetup({ template: { id: "researcher" } }, on, "claude")).toBe(false);
    expect(shouldAutoSetup({ preset: { id: "p" } }, on, "claude")).toBe(false);
  });
  it("does not when there is no provider to run the interview", () => {
    expect(shouldAutoSetup(undefined, on, "")).toBe(false);
  });
});

describe("the setup settings", () => {
  it("are optional, so settings saved before them stay valid", () => {
    const parsed = botSettings.schema.parse({ bots: [] });
    expect(parsed.setup).toBeUndefined();
    expect(botSettings.schema.parse({ bots: [], setup: {} }).setup).toEqual({ prompt: "", autoStart: true });
    expect(botSettings.schema.parse({ bots: [], setup: { prompt: "x", autoStart: false } }).setup).toEqual({ prompt: "x", autoStart: false });
  });
});
