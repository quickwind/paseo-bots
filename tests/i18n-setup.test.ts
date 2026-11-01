import { describe, expect, it } from "vitest";
import { DEFAULT_SETUP_PROMPT, DEFAULT_SETUP_PROMPT_FILES, DEFAULT_SETUP_PROMPT_FILES_ZH, DEFAULT_SETUP_PROMPT_ZH, defaultSetupPrompt, setupPromptText } from "../shared/setup";

const EN = "Let's set you up. Interview me, one short question at a time, about what I want from you, how I like to work, and what you should never do. Stop asking once you know enough; eight questions is plenty.\n\nDo not ask about your name while interviewing. Only when the interview is finished, as your very last question, suggest three names for yourself that fit what we discussed, each with a few words of reason, and ask me to pick one or give my own. Wait for my answer, then use the name I choose.\n\nThen call get_setup to see your current settings, and call propose_changes once, as an update to yourself, with the chosen name (the 'name' field), a one-line title, a short description and standing instructions for yourself, plus any library skills that fit. Do not change your provider, model, approval mode or thinking setting; if I want those changed, tell me to use the Model and Permissions settings. I apply the changes from the card you propose. If you do not have get_setup or propose_changes, do not stop there: give me the name, one-line title, description and standing instructions as a short block to paste into the Identity and Soul settings.\n\nWrite a starting MEMORY.md once I confirm, and tell me when everything is in place.";
const EN_FILES = "Let's set you up. Interview me, one short question at a time, about what I want from you, how I like to work, and what you should never do. Stop asking once you know enough; eight questions is plenty.\n\nDo not ask about your name while interviewing. Only when the interview is finished, as your very last question, suggest three names for yourself that fit what we discussed, each with a few words of reason, and ask me to pick one or give my own. Wait for my answer, then use the name I choose.\n\nThen read setup/overview.md and your own file in setup/bots/ (see Bot tools for where they are), and write one proposal file of kind changes, as an update to yourself, with the chosen name (the 'name' field), a one-line title, a short description and standing instructions for yourself, plus any library skills that fit. Do not change your provider, model, approval mode or thinking setting; if I want those changed, tell me to use the Model and Permissions settings. I apply the changes from the card that appears. If you cannot write the file, do not stop there: give me the name, one-line title, description and standing instructions as a short block to paste into the Identity and Soul settings.\n\nWrite a starting MEMORY.md once I confirm, and tell me when everything is in place.";
const custom = { prompt: "  my own prompt  ", autoStart: true };
const blank = { prompt: "   ", autoStart: true };
const ticks = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();

describe("setup interview prompt in two languages", () => {
  it("keeps the English constants byte-identical", () => {
    expect(DEFAULT_SETUP_PROMPT).toBe(EN);
    expect(DEFAULT_SETUP_PROMPT_FILES).toBe(EN_FILES);
  });
  it("uses a saved prompt as written in every locale", () => {
    for (const locale of ["zh-CN", "en", "ja", undefined]) {
      for (const files of [false, true]) expect(setupPromptText(custom, files, locale)).toBe("my own prompt");
    }
  });
  it("picks the default by locale", () => {
    for (const setup of [undefined, blank]) {
      expect(setupPromptText(setup, false, "zh-CN")).toBe(DEFAULT_SETUP_PROMPT_ZH);
      expect(setupPromptText(setup, true, "zh-CN")).toBe(DEFAULT_SETUP_PROMPT_FILES_ZH);
      for (const locale of ["zh-TW", "ja", "en", undefined]) {
        expect(setupPromptText(setup, false, locale)).toBe(DEFAULT_SETUP_PROMPT);
        expect(setupPromptText(setup, true, locale)).toBe(DEFAULT_SETUP_PROMPT_FILES);
      }
    }
    expect(defaultSetupPrompt(false, "zh-CN")).toBe(DEFAULT_SETUP_PROMPT_ZH);
    expect(defaultSetupPrompt(true, "zh-CN")).toBe(DEFAULT_SETUP_PROMPT_FILES_ZH);
    expect(defaultSetupPrompt(true, "zh-TW")).toBe(DEFAULT_SETUP_PROMPT_FILES);
    expect(defaultSetupPrompt(false)).toBe(DEFAULT_SETUP_PROMPT);
  });
  it("the Chinese texts are Chinese, ask for Chinese replies and proposals, and keep every token", () => {
    for (const [zh, en] of [[DEFAULT_SETUP_PROMPT_ZH, DEFAULT_SETUP_PROMPT], [DEFAULT_SETUP_PROMPT_FILES_ZH, DEFAULT_SETUP_PROMPT_FILES]]) {
      expect(zh).toMatch(/[\u4e00-\u9fff]/);
      expect(zh).toContain("用中文");
      expect(zh).toMatch(/名称、标题、描述和指令.*中文|中文.*名称、标题、描述和指令/);
      expect(zh).toContain("MEMORY.md");
      expect(ticks(zh)).toEqual(ticks(en));
      // The English texts carry no backticks, so also check the known tokens one by one.
      for (const token of ["get_setup", "propose_changes", "setup/overview.md", "setup/bots/", "MEMORY.md", "'name'", "kind changes"]) {
        if (en.includes(token)) expect(zh, token).toContain(token);
      }
    }
  });
});

describe("Chinese interview prompts use full-width punctuation", () => {
  it("has no ASCII , ; : ( ) next to a Chinese character outside backticks and quotes", () => {
    for (const prompt of [DEFAULT_SETUP_PROMPT_ZH, DEFAULT_SETUP_PROMPT_FILES_ZH]) {
      const rest = prompt.replace(/`[^`]*`/g, "").replace(/'[^']*'/g, "");
      const bad = [...rest.matchAll(/[\u4e00-\u9fff][,;:()]|[,;:()][\u4e00-\u9fff]|[,;:()] ?[\u4e00-\u9fff]/g)].map((m) => m[0]);
      expect(bad).toEqual([]);
    }
  });
});
