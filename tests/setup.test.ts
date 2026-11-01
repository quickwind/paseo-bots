import { describe, expect, it } from "vitest";
import { botSettings } from "../shared/bot";
import { afterSetupNotes, DEFAULT_SETUP_PROMPT, DEFAULT_SETUP_PROMPT_FILES, setupPromptText, shouldAutoSetup } from "../shared/setup";

describe("the setup interview prompt", () => {
  it("is the built-in text unless one is configured", () => {
    expect(setupPromptText(undefined)).toBe(DEFAULT_SETUP_PROMPT);
    expect(setupPromptText({ prompt: "", autoStart: true })).toBe(DEFAULT_SETUP_PROMPT);
    expect(setupPromptText({ prompt: "  \n ", autoStart: true })).toBe(DEFAULT_SETUP_PROMPT);
    expect(setupPromptText({ prompt: "  Ask about my team.  ", autoStart: true })).toBe("Ask about my team.");
  });

  it("interviews, then proposes the configuration on one card, and leaves the model and approval mode alone", () => {
    for (const part of ["one short question at a time", "get_setup", "propose_changes", "MEMORY.md", "provider, model, approval mode or thinking", "Model and Permissions settings", "If you do not have get_setup or propose_changes", "Identity and Soul"]) {
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

describe("the setup interview for a bot whose tools are files", () => {
  it("writes a proposal file instead of calling a tool, and leaves the model and mode alone", () => {
    expect(setupPromptText(undefined, true)).toBe(DEFAULT_SETUP_PROMPT_FILES);
    for (const part of ["one short question at a time", "setup/overview.md", "proposal file", "MEMORY.md", "provider, model, approval mode or thinking"]) expect(DEFAULT_SETUP_PROMPT_FILES).toContain(part);
    expect(DEFAULT_SETUP_PROMPT_FILES).not.toContain("propose_changes");
    expect(DEFAULT_SETUP_PROMPT_FILES).not.toContain("get_setup");
  });
  it("uses a configured prompt as it is, whatever the tools", () => {
    expect(setupPromptText({ prompt: "Ask about my team.", autoStart: true }, true)).toBe("Ask about my team.");
  });
  it("keeps the tool version for a bot with tools", () => {
    expect(setupPromptText(undefined, false)).toBe(DEFAULT_SETUP_PROMPT);
  });
});

describe("afterSetupNotes", () => {
  const memory = (patch = {}) => ({ tidy: { enabled: true, everyMinutes: 240, source: "public" as const, model: null, ...patch } });

  it("names the model and the tidy settings and where to change them", () => {
    const [model, tidy] = afterSetupNotes({ provider: "claude", model: "opus", memory: memory() });
    expect(model).toBe("**Model:** opus on claude. Change it in this assistant's settings, under Model.");
    expect(tidy).toBe("**Memory tidy:** on, every 4 hours, with a model from Paseo's Metadata generation list. Change it in this assistant's settings, under Memory.");
  });

  it("says when the provider's default model is used and when tidy is off", () => {
    const [model, tidy] = afterSetupNotes({ provider: "devin", model: null, memory: memory({ enabled: false }) });
    expect(model).toContain("devin's default model");
    expect(tidy).toContain("**Memory tidy:** off");
    expect(tidy).toContain("under Memory");
  });
});
