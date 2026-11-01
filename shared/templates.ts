import { randomSeed } from "./avatar";
import { newMemory } from "./memory-maintenance";
import { withToolModeFor } from "./tools-mode";
import { englishTranslate, type Translate } from "./translate";
import { newBotId, type Bot, type Preset } from "./bot";

// Starting points for a new bot: a name, a job and standing instructions. The idea of ready-made roles follows OpenMausBot's
// (src/lib/ready-bots.ts); the texts here were rewritten for Aydo (see NOTICE).

export interface BotTemplate {
  id: string;
  /** Default bot name; the user renames freely. */
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  /** Standing instructions. */
  soul: string;
  /** Resource keys of the name, title and description in the app language. */
  nameKey: string;
  titleKey: string;
  descriptionKey: string;
}

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "assistant",
    name: "Assistant",
    title: "Everyday helper",
    description: "Handles questions, writing and small jobs you pass along.",
    nameKey: "templates.assistant.name",
    titleKey: "templates.assistant.title",
    descriptionKey: "templates.assistant.description",
    avatarSeed: "assistant-7",
    soul: "You are a practical assistant who speaks plainly. If a request could mean two different things, check with the user first; if it is clear, just do it and report what you did. Be brief and specific.",
  },
  {
    id: "research",
    name: "Scout",
    title: "Research assistant",
    description: "Searches the web and your files and returns a short, sourced summary.",
    nameKey: "templates.research.name",
    titleKey: "templates.research.title",
    descriptionKey: "templates.research.description",
    avatarSeed: "research-5",
    soul: "You investigate questions and write up what you find. Lead with the conclusion, then the supporting evidence with links, then anything still uncertain. Favor original sources, point out where they conflict, and never state a guess as a fact.",
  },
];

/** A template's name, title and description in the language of the moment (the soul is a prompt and stays English). */
export function templateText(template: BotTemplate, t: Translate): { name: string; title: string; description: string } {
  return { name: t(template.nameKey), title: t(template.titleKey), description: t(template.descriptionKey) };
}

/** A new bot on `provider`: blank, or from a template (a role). The texts are stored as plain values. */
export function newBot(provider: string, template?: BotTemplate, t: Translate = englishTranslate): Bot {
  const now = new Date().toISOString();
  const text = template ? templateText(template, t) : undefined;
  return withToolModeFor({
    id: newBotId(),
    name: text?.name ?? t("templates.newBotName"),
    title: text?.title ?? "",
    description: text?.description ?? "",
    avatar: { seed: template?.avatarSeed ?? randomSeed(), palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider,
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: template?.soul ?? "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    voice: { name: null, readReplies: false },
    contactBots: "ask",
    memory: newMemory(provider),
    routines: [],
    playbooks: [],
    cwd: null,
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
  });
}

/** A new bot from a preset: its identity, instructions, playbooks and skills. */
export function botFromPreset(provider: string, preset: Preset, t: Translate = englishTranslate): Bot {
  const { id: _id, createdAt: _createdAt, ...fields } = preset;
  return { ...newBot(provider, undefined, t), ...fields };
}
