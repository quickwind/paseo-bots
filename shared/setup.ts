import { z } from "zod";
import { englishTranslate, isChineseLocale, type Translate } from "./translate";

/** "Set up with the bot": the interview a bot opens with, and whether a new blank bot starts it by itself. */
export const SetupSettingsSchema = z.object({
  /** Empty uses the built-in prompt. */
  prompt: z.string().max(8000).default(""),
  autoStart: z.boolean().default(true),
});
export type SetupSettings = z.infer<typeof SetupSettingsSchema>;

export const DEFAULT_SETUP_PROMPT =
  "Let's set you up. Interview me, one short question at a time, about what I want from you, how I like to work, and what you should never do. " +
  "Stop asking once you know enough; eight questions is plenty.\n\n" +
  "Do not ask about your name while interviewing. Only when the interview is finished, as your very last question, suggest three names for yourself that fit what we discussed, each with a few words of reason, and ask me to pick one or give my own. Wait for my answer, then use the name I choose.\n\n" +
  "Then call get_setup to see your current settings, and call propose_changes once, as an update to yourself, with the chosen name (the 'name' field), a one-line title, a short description and standing instructions for yourself, " +
  "plus any library skills that fit. Do not change your provider, model, approval mode or thinking setting; if I want those changed, tell me to use the Model and Permissions settings. " +
  "I apply the changes from the card you propose. If you do not have get_setup or propose_changes, do not stop there: give me the name, one-line title, description and standing instructions as a short block to paste into the Identity and Soul settings.\n\n" +
  "Write a starting MEMORY.md once I confirm, and tell me when everything is in place.";

/** The same interview for a bot whose tools are files in its folder: it writes a proposal file instead of calling a tool. */
export const DEFAULT_SETUP_PROMPT_FILES =
  "Let's set you up. Interview me, one short question at a time, about what I want from you, how I like to work, and what you should never do. " +
  "Stop asking once you know enough; eight questions is plenty.\n\n" +
  "Do not ask about your name while interviewing. Only when the interview is finished, as your very last question, suggest three names for yourself that fit what we discussed, each with a few words of reason, and ask me to pick one or give my own. Wait for my answer, then use the name I choose.\n\n" +
  "Then read setup/overview.md and your own file in setup/bots/ (see Bot tools for where they are), and write one proposal file of kind changes, as an update to yourself, with the chosen name (the 'name' field), a one-line title, a short description and standing instructions for yourself, " +
  "plus any library skills that fit. Do not change your provider, model, approval mode or thinking setting; if I want those changed, tell me to use the Model and Permissions settings. " +
  "I apply the changes from the card that appears. If you cannot write the file, do not stop there: give me the name, one-line title, description and standing instructions as a short block to paste into the Identity and Soul settings.\n\n" +
  "Write a starting MEMORY.md once I confirm, and tell me when everything is in place.";

/** The interview in Chinese: the same steps, and the assistant talks and writes its proposal in Chinese. */
export const DEFAULT_SETUP_PROMPT_ZH =
  "我们来设置你。请用中文和我交流，一次只问一个简短的问题，了解我希望你做什么、我喜欢怎样工作，以及你绝对不能做什么。" +
  "一旦了解得足够了就不要再问；八个问题已经足够。\n\n" +
  "访谈期间不要问你的名字。只有在访谈结束时，作为你的最后一个问题，根据我们谈到的内容为你自己建议三个名字，每个附上几句理由，请我选一个或给出我自己的名字。等我回答，然后使用我选定的名字。\n\n" +
  "然后调用 get_setup 查看你当前的设置，并调用 propose_changes 一次，作为对你自己的更新，包含选定的名字（'name' 字段）、一行标题、简短的描述和你自己的长期指令，" +
  "以及合适的资源库中的技能。你提议的名称、标题、描述和指令都用中文书写。不要更改你的提供方、模型、批准模式或思考设置；如果我想更改这些，请告诉我去使用模型和权限设置。" +
  "我会通过你提出的卡片应用这些更改。如果你没有 get_setup 或 propose_changes，不要就此停下：请把名字、一行标题、描述和长期指令整理成一小段文字给我，我粘贴到身份和灵魂设置中。\n\n" +
  "我确认之后，写一份起始的 MEMORY.md，并在一切就绪时告诉我。";

/** The Chinese interview for an assistant whose tools are files in its folder. */
export const DEFAULT_SETUP_PROMPT_FILES_ZH =
  "我们来设置你。请用中文和我交流，一次只问一个简短的问题，了解我希望你做什么、我喜欢怎样工作，以及你绝对不能做什么。" +
  "一旦了解得足够了就不要再问；八个问题已经足够。\n\n" +
  "访谈期间不要问你的名字。只有在访谈结束时，作为你的最后一个问题，根据我们谈到的内容为你自己建议三个名字，每个附上几句理由，请我选一个或给出我自己的名字。等我回答，然后使用我选定的名字。\n\n" +
  "然后阅读 setup/overview.md 和 setup/bots/ 中你自己的文件（文件位置见 Bot tools），并写一个 kind changes 的提案文件，作为对你自己的更新，包含选定的名字（'name' 字段）、一行标题、简短的描述和你自己的长期指令，" +
  "以及合适的资源库中的技能。你提议的名称、标题、描述和指令都用中文书写。不要更改你的提供方、模型、批准模式或思考设置；如果我想更改这些，请告诉我去使用模型和权限设置。" +
  "我会通过出现的卡片应用这些更改。如果你无法写入文件，不要就此停下：请把名字、一行标题、描述和长期指令整理成一小段文字给我，我粘贴到身份和灵魂设置中。\n\n" +
  "我确认之后，写一份起始的 MEMORY.md，并在一切就绪时告诉我。";

/** The built-in interview for a language (the files version for an assistant whose tools are files). */
export function defaultSetupPrompt(files: boolean, locale?: string): string {
  if (isChineseLocale(locale)) return files ? DEFAULT_SETUP_PROMPT_FILES_ZH : DEFAULT_SETUP_PROMPT_ZH;
  return files ? DEFAULT_SETUP_PROMPT_FILES : DEFAULT_SETUP_PROMPT;
}

/** The prompt a setup chat opens with: the configured one (as written, in every language), or the built-in for the language. */
export function setupPromptText(setup: SetupSettings | undefined, files = false, locale?: string): string {
  return setup?.prompt.trim() || defaultSetupPrompt(files, locale);
}

/**
 * Whether a bot just created from the New bot dialog starts its setup interview: only a blank bot
 * (a role or preset already brings instructions), only when it has a provider to run on, and
 * unless the plugin setting turns it off.
 */
export function shouldAutoSetup(start: { template?: unknown; preset?: unknown } | undefined, setup: Pick<SetupSettings, "autoStart"> | undefined, provider: string): boolean {
  return !start?.template && !start?.preset && Boolean(provider) && (setup?.autoStart ?? true);
}

function every(minutes: number, t: Translate): string {
  if (minutes === 1440) return t("text.setup.everyDay");
  if (minutes % 60 === 0) return minutes === 60 ? t("text.setup.everyHour") : t("text.setup.everyHours", { n: minutes / 60 });
  return t("text.setup.everyMinutes", { n: minutes });
}

/**
 * After a bot's setup is applied: the two settings the interview never touches, as they stand now,
 * and where to change them. The model and the memory tidy cost the user something (quota, time), so they should know.
 */
export function afterSetupNotes(bot: { provider: string; model: string | null; memory: { tidy: { enabled: boolean; everyMinutes: number; source: "public" | "bot" | "model"; model: string | null } } }, t: Translate = englishTranslate): string[] {
  const { tidy } = bot.memory;
  const model = tidy.source === "bot" ? t("text.setup.tidyModelBot") : tidy.source === "model" && tidy.model ? tidy.model : t("text.setup.tidyModelDefault");
  const used = bot.model ? t("text.setup.modelOn", { model: bot.model, provider: bot.provider }) : t("text.setup.modelDefault", { provider: bot.provider });
  return [
    t("text.setup.modelLine", { model: used }),
    tidy.enabled ? t("text.setup.tidyOn", { every: every(tidy.everyMinutes, t), model }) : t("text.setup.tidyOff", { model }),
  ];
}
