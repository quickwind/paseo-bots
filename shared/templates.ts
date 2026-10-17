import { randomSeed } from "./avatar";
import { newMemory } from "./memory-maintenance";
import { newBotId, type Bot, type Preset } from "./bot";

// Starting points for a new bot, from OpenMausBot's New bot roles
// (src/lib/bot-roles.ts): a name, a job and standing instructions.

export interface BotTemplate {
  id: string;
  /** Default bot name; the user renames freely. */
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  /** Standing instructions. */
  soul: string;
}

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "assistant",
    name: "Assistant",
    title: "General assistant",
    description: "Answers questions, drafts text, and takes on whatever you hand it.",
    avatarSeed: "assistant-7",
    soul: "You are a capable, plain-spoken assistant. Ask one clarifying question when a request is ambiguous; otherwise do the work and show the result. Keep replies short and concrete.",
  },
  {
    id: "research",
    name: "Scout",
    title: "Researcher",
    description: "Digs through the web and your files, and comes back with a sourced brief.",
    avatarSeed: "research-5",
    soul: "You research questions and return a brief: the answer first, then the evidence with links, then what you could not verify. Prefer primary sources. Say clearly when sources disagree. Never present a guess as a finding.",
  },
];

/** A new bot on `provider`: blank, or from a template (a role). */
export function newBot(provider: string, template?: BotTemplate): Bot {
  const now = new Date().toISOString();
  return {
    id: newBotId(),
    name: template?.name ?? "New bot",
    title: template?.title ?? "",
    description: template?.description ?? "",
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
  };
}

/** A new bot from a preset: its identity, instructions, playbooks and skills. */
export function botFromPreset(provider: string, preset: Preset): Bot {
  const { id: _id, createdAt: _createdAt, ...fields } = preset;
  return { ...newBot(provider), ...fields };
}
