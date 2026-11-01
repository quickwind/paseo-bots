import { describe, expect, it } from "vitest";
import { chatEngineLabel } from "../client/chat-engine";

const providers = [
  { provider: "claude", label: "Claude Code", models: [{ id: "sonnet", label: "Sonnet 5.5", isDefault: true }, { id: "haiku", label: "Haiku 5.5" }] },
  { provider: "devin", label: "Devin", models: [{ id: "swe-1-6-slow", label: "SWE 1.6" }] },
];

describe("the provider and model a chat runs on, for its header", () => {
  it("names the provider and the model of an open chat", () => {
    expect(chatEngineLabel({ provider: "claude", model: "haiku" }, providers)).toBe("Claude Code · Haiku 5.5");
  });

  it("uses the provider's default model when the chat has none recorded", () => {
    expect(chatEngineLabel({ provider: "claude", model: null }, providers)).toBe("Claude Code · Sonnet 5.5");
  });

  it("falls back to the raw ids while the provider list is not loaded or does not know them", () => {
    expect(chatEngineLabel({ provider: "claude", model: "haiku" }, undefined)).toBe("claude · haiku");
    expect(chatEngineLabel({ provider: "other", model: "m1" }, providers)).toBe("other · m1");
  });

  it("shows only the provider when no model is known, and nothing without a provider", () => {
    expect(chatEngineLabel({ provider: "devin", model: null }, [{ provider: "devin", label: "Devin", models: [] }])).toBe("Devin");
    expect(chatEngineLabel({ provider: "", model: null }, providers)).toBeNull();
  });
});
