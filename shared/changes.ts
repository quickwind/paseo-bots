import { z } from "zod";
import { randomSeed } from "./avatar";
import { projectFoldersNote } from "./folder-access";
import type { HostCaps } from "./host-caps";
import {
  DEFAULT_BOT_DEFAULTS,
  EMPTY_LIBRARY,
  MCP_NAME,
  newGroupId,
  newPlaybookId,
  newRoutineId,
  presetFromBot,
  pushHistory,
  RESERVED_MCP_NAMES,
  type Bot,
  type BotAvatar,
  type BotDefaults,
  type BotGroup,
  type BotSettingsValues,
  type Library,
  type McpServerConfig,
  type TeamLogo,
} from "./bot";
import { saveTeam, teamLogoOf, withoutBot } from "./groups";
import { addMcpServers, forgetItem, mcpServerCanEnable, setBotUses } from "./library";
import { PALETTE_COUNT } from "./pixel";
import { describeSchedule, ScheduleInput, scheduleFrom } from "./routines";
import { BOT_TEMPLATES, newBot } from "./templates";
import { withToolModeFor } from "./tools-mode";
import { englishTranslate, type Translate } from "./translate";

// Changes a bot proposes to the setup (bots, teams, the library, defaults and
// presets) with propose_changes. They wait on a card in its chat, and the app
// applies them all at once when the user presses Apply. Nothing here writes
// anything: `applyChanges` returns the new settings, and throws a message the
// bot can act on when a change doesn't fit the setup.

// ---------------------------------------------------------------- input

const Ref = (what: string) => z.string().min(1).max(100).describe(`${what}: its name or id.`);
const Ids = (what: string) => z.array(z.string().min(1).max(100)).max(100).describe(what);
const IMAGE_URL = /^data:image\/\S+$/i;
const TOOL_GRANT = /^[A-Za-z0-9_-]{1,64}\/\S{1,200}$/;

const Colour = z.number().int().min(0).max(PALETTE_COUNT - 1).nullable().optional();
const ImageUrl = z.string().max(2000).nullable().optional().describe("A data:image picture shown instead of the pixel art; null removes it. Web addresses are not accepted.");

const AvatarInput = z.object({
  new_face: z.boolean().optional().describe("Draw a different pixel-art face."),
  colour: Colour.describe(`Colour of the face, 0 to ${PALETTE_COUNT - 1}; null lets the face pick one.`),
  shape: z.enum(["circle", "rounded", "square"]).optional(),
  image_url: ImageUrl,
});

const LogoInput = z.object({
  new_logo: z.boolean().optional().describe("Draw a different pixel-art logo."),
  colour: Colour.describe(`Colour of the logo, 0 to ${PALETTE_COUNT - 1}; null lets the logo pick one.`),
  image_url: ImageUrl,
});

const PlaybookInput = z.object({
  name: z.string().min(1).max(80),
  triggers: z.array(z.string().min(1).max(60)).min(1).max(20).describe("Words or phrases that bring the playbook into a chat when its first message has one."),
  instructions: z.string().min(1).max(20_000),
});

const BotFields = {
  title: z.string().max(200).optional().describe("One line: what the bot does."),
  description: z.string().max(4000).optional().describe("Who the bot is; shown in the bot list and given to its agent."),
  instructions: z.string().max(24_000).optional().describe("Standing instructions (its Soul). Replaces the current ones."),
  provider: z.string().min(1).max(60).optional().describe("Agent provider id from get_setup, like claude or codex."),
  model: z.string().max(200).nullable().optional().describe("Model id from get_setup; null for the provider's default."),
  mode: z.string().max(100).nullable().optional().describe("Approval mode id from get_setup; null for the provider's default."),
  thinking: z.string().max(100).nullable().optional().describe("Thinking option id from get_setup; null for the default."),
  contact_bots: z.enum(["ask", "allow", "off"]).optional().describe("Asking other bots for help: after the user approves each request (ask), freely (allow) or never (off)."),
  avatar: AvatarInput.optional(),
  working_folder: z.string().max(1000).nullable().optional().describe("Absolute path of its working folder; null for its own folder in the Bots project."),
  pinned: z.boolean().optional(),
};

const ROLE_IDS = BOT_TEMPLATES.map((template) => template.id) as [string, ...string[]];

const CreateBot = z.strictObject({
  type: z.literal("create_bot"),
  name: z.string().min(1).max(100),
  role: z.enum(ROLE_IDS).optional().describe(`Start from a role (${BOT_TEMPLATES.map((template) => `${template.id}: ${template.title}`).join(", ")}); the other fields override it.`),
  ...BotFields,
  skills: Ids("Library skill ids to turn on.").optional(),
  mcp_servers: Ids("Library MCP servers to turn on, by name.").optional(),
  playbooks: z.array(PlaybookInput).max(20).optional(),
});

const UpdateBot = z.strictObject({
  type: z.literal("update_bot"),
  bot: Ref("The bot"),
  name: z.string().min(1).max(100).optional(),
  ...BotFields,
  archived: z.boolean().optional(),
  add_skills: Ids("Library skill ids to turn on.").optional(),
  remove_skills: Ids("Skill ids to turn off.").optional(),
  add_mcp_servers: Ids("Library MCP servers to turn on, by name.").optional(),
  remove_mcp_servers: Ids("MCP servers to turn off, by name.").optional(),
  allow_tools: Ids('MCP tools it may use without asking, as "server/tool".').optional(),
  disallow_tools: Ids('Tools to take off that list, as "server/tool".').optional(),
  add_playbooks: z.array(PlaybookInput).max(20).optional().describe("Playbooks to add; one with the name of an existing playbook replaces it."),
  remove_playbooks: Ids("Playbooks to remove, by name.").optional(),
});

const DeleteBot = z.strictObject({ type: z.literal("delete_bot"), bot: Ref("The bot") });

const AddRoutine = z.strictObject({
  type: z.literal("add_routine"),
  bot: Ref("The bot that runs it"),
  name: z.string().min(1).max(80),
  instructions: z.string().min(1).max(20_000).describe("What to do on each run, written so it works without this chat."),
  schedule: ScheduleInput,
});

const UpdateRoutine = z.strictObject({
  type: z.literal("update_routine"),
  bot: Ref("The bot"),
  routine: Ref("The routine"),
  name: z.string().min(1).max(80).optional(),
  instructions: z.string().min(1).max(20_000).optional(),
  schedule: ScheduleInput.optional(),
  enabled: z.boolean().optional().describe("false pauses it."),
});

const DeleteRoutine = z.strictObject({ type: z.literal("delete_routine"), bot: Ref("The bot"), routine: Ref("The routine") });

const CreateTeam = z.strictObject({
  type: z.literal("create_team"),
  name: z.string().min(1).max(60),
  lead: Ref("Its Chief of Staff, the user's main contact who hands work to the others").optional(),
  members: z.array(Ref("A member")).max(50).optional().describe("The team's bots. A bot is on one team at a time; adding it moves it here."),
  instructions: z.string().max(20_000).optional().describe("Shared instructions added to every member's prompt."),
  ask_freely: z.boolean().optional().describe("true: members may ask each other without the user approving each question (a bot set to never contact others still may not). Default false."),
  logo: LogoInput.optional(),
});

const UpdateTeam = z.strictObject({
  type: z.literal("update_team"),
  team: Ref("The team"),
  name: z.string().min(1).max(60).optional(),
  lead: Ref("Its new Chief of Staff").nullable().optional().describe("Its Chief of Staff; null for none."),
  add_members: z.array(Ref("A bot")).max(50).optional(),
  remove_members: z.array(Ref("A bot")).max(50).optional(),
  instructions: z.string().max(20_000).optional().describe("Shared instructions; replaces the current ones."),
  ask_freely: z.boolean().optional().describe("true: members may ask each other without the user approving each question (a bot set to never contact others still may not). Default false."),
  logo: LogoInput.optional(),
});

const DeleteTeam = z.strictObject({ type: z.literal("delete_team"), team: Ref("The team") });

const SetSkill = z.strictObject({
  type: z.literal("set_skill"),
  skill: Ref("The library skill"),
  enabled: z.boolean().describe("Off keeps it in the library but out of every bot's prompt."),
});

const AddMcpServer = z.strictObject({
  type: z.literal("add_mcp_server"),
  name: z.string().regex(MCP_NAME).describe("Letters, digits, - and _; what bots see before its tools."),
  description: z.string().max(300).optional(),
  command: z.string().min(1).max(1000).optional().describe("For a local server: the program to run."),
  args: z.array(z.string().max(1000)).max(50).optional(),
  env: z.record(z.string(), z.string().max(4000)).optional(),
  url: z.string().url().max(2000).optional().describe("For a remote server: its URL."),
  transport: z.enum(["http", "sse"]).optional().describe("For a remote server; http when left out."),
  headers: z.record(z.string(), z.string().max(4000)).optional(),
});

const SetMcpServer = z.strictObject({ type: z.literal("set_mcp_server"), server: Ref("The library MCP server"), enabled: z.boolean() });
const RemoveMcpServer = z.strictObject({ type: z.literal("remove_mcp_server"), server: Ref("The library MCP server") });

const SetDefaults = z.strictObject({
  type: z.literal("set_defaults"),
  provider: z.string().max(60).optional().describe("Provider for new bots; empty picks one that's ready."),
  model: BotFields.model,
  mode: BotFields.mode,
  thinking: BotFields.thinking,
  contact_bots: BotFields.contact_bots,
});

const SavePreset = z.strictObject({ type: z.literal("save_preset"), bot: Ref("The bot to save as a preset") });
const DeletePreset = z.strictObject({ type: z.literal("delete_preset"), preset: Ref("The preset") });

export const ChangeSchema = z.discriminatedUnion("type", [
  CreateBot,
  UpdateBot,
  DeleteBot,
  AddRoutine,
  UpdateRoutine,
  DeleteRoutine,
  CreateTeam,
  UpdateTeam,
  DeleteTeam,
  SetSkill,
  AddMcpServer,
  SetMcpServer,
  RemoveMcpServer,
  SetDefaults,
  SavePreset,
  DeletePreset,
]);
export type Change = z.infer<typeof ChangeSchema>;
export const ChangesSchema = z.array(ChangeSchema).min(1).max(50);

type BotFieldValues = { [Key in keyof typeof BotFields]?: z.infer<(typeof BotFields)[Key]> };

// ---------------------------------------------------------------- lookups

/** A provider as get_setup lists it: its models (with their thinking options) and approval modes. */
export interface ProviderInfo {
  id: string;
  models: { id: string; label: string; isDefault: boolean; thinking: string[] }[];
  modes: { id: string; label: string }[];
  defaultModeId: string | null;
}

/** Paseo's provider snapshot entry, as far as changes need it. */
interface ProviderEntry {
  provider: string;
  enabled: boolean;
  status: string;
  models?: readonly { id: string; label: string; isDefault?: boolean; isSelectable?: boolean; thinkingOptions?: readonly { id: string }[] }[];
  modes?: readonly { id: string; label: string }[];
  defaultModeId?: string | null;
}

/** The enabled providers from Paseo's provider snapshot. */
export function providerInfo(entries: readonly ProviderEntry[]): ProviderInfo[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.provider,
      models: (entry.models ?? []).filter((model) => model.isSelectable !== false).map((model) => ({ id: model.id, label: model.label, isDefault: !!model.isDefault, thinking: (model.thinkingOptions ?? []).map((option) => option.id) })),
      modes: (entry.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
      defaultModeId: entry.defaultModeId ?? null,
    }));
}

/** The provider a new bot gets when nothing names one: Claude when it's ready, else the first ready one. */
export function readyProvider(entries: readonly ProviderEntry[]): string {
  const ready = entries.filter((entry) => entry.enabled && entry.status === "ready");
  return (ready.find((entry) => entry.provider === "claude") ?? ready[0])?.provider ?? "";
}

export interface ApplyContext {
  now: string;
  /** Provider for new bots when neither the change nor the defaults name one. */
  provider: string;
  /** Checks provider, model, mode and thinking ids when known. */
  providers?: readonly ProviderInfo[] | null;
}

function byRef<T>(items: readonly T[], ref: string, id: (item: T) => string, name: (item: T) => string, what: string): T {
  const wanted = ref.trim();
  const exact = items.find((item) => id(item) === wanted);
  if (exact) return exact;
  const key = wanted.toLowerCase();
  const named = items.filter((item) => name(item).trim().toLowerCase() === key);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`${named.length} ${what}s are called "${wanted}". Use the id.`);
  const known = items.map(name).filter(Boolean);
  throw new Error(`There's no ${what} called "${wanted}".${known.length ? ` There are: ${known.slice(0, 30).join(", ")}.` : ""}`);
}

const findBot = (values: BotSettingsValues, ref: string) => byRef(values.bots, ref, (bot) => bot.id, (bot) => bot.name, "bot");
const findTeam = (values: BotSettingsValues, ref: string) => byRef(values.groups ?? [], ref, (group) => group.id, (group) => group.name, "team");
const findSkill = (library: Library, ref: string) => byRef(library.skills, ref, (skill) => skill.id, (skill) => skill.id, "skill");
const findServer = (library: Library, ref: string) => byRef(library.mcpServers, ref, (server) => server.id, (server) => server.name, "MCP server");

function checkAgent(context: ApplyContext, fields: { provider: string; model: string | null; modeId: string | null; thinkingOptionId: string | null }): void {
  const providers = context.providers;
  if (!providers || !fields.provider) return;
  const provider = providers.find((entry) => entry.id === fields.provider);
  if (!provider) throw new Error(`There's no provider "${fields.provider}". Use one of: ${providers.map((entry) => entry.id).join(", ")}.`);
  const model = fields.model ? provider.models.find((entry) => entry.id === fields.model) : null;
  if (fields.model && !model) throw new Error(`${provider.id} has no model "${fields.model}". Use one of: ${provider.models.map((entry) => entry.id).join(", ")}.`);
  if (fields.modeId && !provider.modes.some((mode) => mode.id === fields.modeId)) {
    throw new Error(`${provider.id} has no mode "${fields.modeId}". Use one of: ${provider.modes.map((mode) => mode.id).join(", ") || "none"}.`);
  }
  const thinking = (model ?? provider.models.find((entry) => entry.isDefault))?.thinking ?? [];
  if (fields.thinkingOptionId && !thinking.includes(fields.thinkingOptionId)) {
    throw new Error(`That model has no thinking option "${fields.thinkingOptionId}". Use one of: ${thinking.join(", ") || "none"}.`);
  }
}

function imageUrl(value: string | null): string | null {
  if (value !== null && !IMAGE_URL.test(value.trim())) throw new Error("A picture needs a data:image URL; web addresses are not accepted.");
  return value?.trim() ?? null;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

// ---------------------------------------------------------------- bots

function withAvatar(avatar: BotAvatar, input: z.infer<typeof AvatarInput> | undefined): BotAvatar {
  if (!input) return avatar;
  return {
    seed: input.new_face ? randomSeed() : avatar.seed,
    palette: input.colour !== undefined ? input.colour : avatar.palette,
    shape: input.shape ?? avatar.shape,
    imageUrl: input.image_url !== undefined ? imageUrl(input.image_url) : input.new_face ? null : avatar.imageUrl,
  };
}

function withAgent(bot: Bot, fields: BotFieldValues, context: ApplyContext): Bot {
  const provider = fields.provider ?? bot.provider;
  const switched = provider !== bot.provider;
  // A model, mode or thinking level belongs to the provider it was picked for.
  const defaultMode = context.providers?.find((entry) => entry.id === provider)?.defaultModeId ?? null;
  const next = {
    ...bot,
    provider,
    model: fields.model !== undefined ? fields.model : switched ? null : bot.model,
    modeId: fields.mode !== undefined ? fields.mode : switched ? defaultMode : bot.modeId,
    thinkingOptionId: fields.thinking !== undefined ? fields.thinking : switched ? null : bot.thinkingOptionId,
  };
  if (fields.provider !== undefined || fields.model !== undefined || fields.mode !== undefined || fields.thinking !== undefined) checkAgent(context, next);
  return withToolModeFor(next);
}

function withFields(bot: Bot, fields: BotFieldValues, context: ApplyContext): Bot {
  const next: Bot = withAgent({ ...bot, avatar: withAvatar(bot.avatar, fields.avatar) }, fields, context);
  if (fields.title !== undefined) next.title = oneLine(fields.title);
  if (fields.description !== undefined) next.description = fields.description.trim();
  if (fields.instructions !== undefined) next.soul = fields.instructions.trim();
  if (fields.contact_bots !== undefined) next.contactBots = fields.contact_bots;
  if (fields.working_folder !== undefined) {
    const folder = fields.working_folder?.trim() || null;
    if (folder && !folder.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(folder)) throw new Error("A working folder needs an absolute path.");
    next.cwd = folder;
  }
  if (fields.pinned !== undefined) next.pinned = fields.pinned;
  return next;
}

function withLibraryItems(bot: Bot, library: Library, kind: "skill" | "mcp", add: readonly string[] = [], remove: readonly string[] = []): Bot {
  let next = bot;
  const id = (ref: string) => (kind === "skill" ? findSkill(library, ref).id : findServer(library, ref).id);
  for (const ref of add) next = setBotUses(next, kind, id(ref), true);
  for (const ref of remove) next = setBotUses(next, kind, id(ref), false);
  return next;
}

function withGrants(bot: Bot, allow: readonly string[] = [], disallow: readonly string[] = []): Bot {
  const grants = new Set(bot.alwaysAllow);
  for (const grant of allow) {
    if (!TOOL_GRANT.test(grant.trim())) throw new Error(`"${grant}" isn't a tool as "server/tool".`);
    grants.add(grant.trim());
  }
  for (const grant of disallow) grants.delete(grant.trim());
  return { ...bot, alwaysAllow: [...grants] };
}

function withPlaybooks(bot: Bot, add: readonly z.infer<typeof PlaybookInput>[] = [], remove: readonly string[] = []): Bot {
  let playbooks = [...bot.playbooks];
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const ref of remove) {
    if (!playbooks.some((playbook) => same(playbook.name, ref))) throw new Error(`${bot.name} has no playbook called "${ref}".`);
    playbooks = playbooks.filter((playbook) => !same(playbook.name, ref));
  }
  for (const input of add) {
    const existing = playbooks.find((playbook) => same(playbook.name, input.name));
    const playbook = { id: existing?.id ?? newPlaybookId(), name: input.name.trim(), triggers: [...new Set(input.triggers.map((trigger) => trigger.trim()).filter(Boolean))], instructions: input.instructions.trim() };
    playbooks = existing ? playbooks.map((entry) => (entry === existing ? playbook : entry)) : [...playbooks, playbook];
  }
  return { ...bot, playbooks };
}

function withBot(values: BotSettingsValues, bot: Bot, context: ApplyContext): BotSettingsValues {
  const previous = values.bots.find((entry) => entry.id === bot.id);
  const updated = { ...bot, updatedAt: context.now };
  return {
    ...values,
    bots: previous ? values.bots.map((entry) => (entry.id === bot.id ? updated : entry)) : [...values.bots, updated],
    // Edits can be undone from the bot's History, as the user's own edits can.
    history: previous ? pushHistory(values.history, previous, new Date(context.now)) : values.history,
  };
}

function uniqueBotName(values: BotSettingsValues, name: string, except?: string): string {
  const trimmed = oneLine(name);
  if (values.bots.some((bot) => bot.id !== except && bot.name.trim().toLowerCase() === trimmed.toLowerCase())) throw new Error(`There's already a bot called "${trimmed}".`);
  return trimmed;
}

// ---------------------------------------------------------------- teams

function withLogo(logo: TeamLogo, input: z.infer<typeof LogoInput> | undefined): TeamLogo {
  if (!input) return logo;
  return {
    seed: input.new_logo ? randomSeed() : logo.seed,
    palette: input.colour !== undefined ? input.colour : logo.palette,
    imageUrl: input.image_url !== undefined ? imageUrl(input.image_url) : input.new_logo ? null : logo.imageUrl,
  };
}

function teamMembers(group: BotGroup | null): string[] {
  return group ? [...new Set([...(group.leadId ? [group.leadId] : []), ...group.memberIds])] : [];
}

// ---------------------------------------------------------------- apply

function applyChange(values: BotSettingsValues, change: Change, context: ApplyContext): BotSettingsValues {
  const library = values.library ?? EMPTY_LIBRARY;
  const groups = values.groups ?? [];
  switch (change.type) {
    case "create_bot": {
      const defaults = values.defaults ?? DEFAULT_BOT_DEFAULTS;
      const template = BOT_TEMPLATES.find((entry) => entry.id === change.role);
      const base = newBot(defaults.provider || context.provider, template);
      let bot: Bot = {
        ...base,
        name: uniqueBotName(values, change.name),
        model: defaults.provider ? defaults.model : null,
        modeId: defaults.provider ? defaults.modeId : null,
        thinkingOptionId: defaults.provider ? defaults.thinkingOptionId : null,
        contactBots: defaults.contactBots,
        createdAt: context.now,
      };
      bot = withFields(bot, change, context);
      bot = withLibraryItems(bot, library, "skill", change.skills);
      bot = withLibraryItems(bot, library, "mcp", change.mcp_servers);
      bot = withPlaybooks(bot, change.playbooks);
      return withBot(values, bot, context);
    }
    case "update_bot": {
      let bot = findBot(values, change.bot);
      if (change.name !== undefined) bot = { ...bot, name: uniqueBotName(values, change.name, bot.id) };
      bot = withFields(bot, change, context);
      if (change.archived !== undefined) bot = { ...bot, archived: change.archived };
      bot = withLibraryItems(bot, library, "skill", change.add_skills, change.remove_skills);
      bot = withLibraryItems(bot, library, "mcp", change.add_mcp_servers, change.remove_mcp_servers);
      bot = withGrants(bot, change.allow_tools, change.disallow_tools);
      bot = withPlaybooks(bot, change.add_playbooks, change.remove_playbooks);
      return withBot(values, bot, context);
    }
    case "delete_bot": {
      const bot = findBot(values, change.bot);
      const ui = values.ui;
      const { [bot.id]: _order, ...chatOrder } = ui?.chatOrder ?? {};
      return {
        ...values,
        bots: values.bots.filter((entry) => entry.id !== bot.id),
        history: values.history.filter((entry) => entry.botId !== bot.id),
        groups: withoutBot(groups, bot.id, context.now),
        ui: ui && { ...ui, collapsed: ui.collapsed.filter((id) => id !== bot.id), pinnedChats: ui.pinnedChats.filter((pin) => pin.botId !== bot.id), chatOrder },
      };
    }
    case "add_routine": {
      const bot = findBot(values, change.bot);
      const routine = { id: newRoutineId(), name: change.name.trim(), prompt: change.instructions.trim(), enabled: true, schedule: scheduleFrom(change.schedule, new Date(context.now)), resultsChatId: null, createdAt: context.now };
      return withBot(values, { ...bot, routines: [...bot.routines, routine] }, context);
    }
    case "update_routine": {
      const bot = findBot(values, change.bot);
      const routine = byRef(bot.routines, change.routine, (entry) => entry.id, (entry) => entry.name, "routine");
      const updated = {
        ...routine,
        name: change.name?.trim() ?? routine.name,
        prompt: change.instructions?.trim() ?? routine.prompt,
        schedule: change.schedule ? scheduleFrom(change.schedule, new Date(context.now)) : routine.schedule,
        enabled: change.enabled ?? routine.enabled,
      };
      return withBot(values, { ...bot, routines: bot.routines.map((entry) => (entry.id === routine.id ? updated : entry)) }, context);
    }
    case "delete_routine": {
      const bot = findBot(values, change.bot);
      const routine = byRef(bot.routines, change.routine, (entry) => entry.id, (entry) => entry.name, "routine");
      return withBot(values, { ...bot, routines: bot.routines.filter((entry) => entry.id !== routine.id) }, context);
    }
    case "create_team": {
      const lead = change.lead ? findBot(values, change.lead) : null;
      const members = [...new Set([...(lead ? [lead.id] : []), ...(change.members ?? []).map((ref) => findBot(values, ref).id)])];
      const logo = withLogo({ seed: randomSeed(), palette: null, imageUrl: null }, change.logo);
      const draft = { name: oneLine(change.name), logo, leadId: lead?.id ?? null, memberIds: members, instructions: change.instructions?.trim() ?? "", askFreely: change.ask_freely ?? false };
      return { ...values, groups: saveTeam(groups, null, draft, newGroupId(), context.now) };
    }
    case "update_team": {
      const group = findTeam(values, change.team);
      const removed = new Set((change.remove_members ?? []).map((ref) => findBot(values, ref).id));
      const lead = change.lead === undefined ? group.leadId : change.lead === null ? null : findBot(values, change.lead).id;
      const members = [...new Set([...teamMembers(group), ...(change.add_members ?? []).map((ref) => findBot(values, ref).id), ...(lead ? [lead] : [])])].filter((id) => !removed.has(id) || id === lead);
      const draft = {
        name: change.name !== undefined ? oneLine(change.name) : group.name,
        logo: withLogo(teamLogoOf(group), change.logo),
        leadId: lead && members.includes(lead) ? lead : null,
        memberIds: members,
        instructions: change.instructions?.trim() ?? group.instructions,
        askFreely: change.ask_freely ?? group.askFreely,
      };
      return { ...values, groups: saveTeam(groups, group.id, draft, group.id, context.now) };
    }
    case "delete_team": {
      const group = findTeam(values, change.team);
      return { ...values, groups: groups.filter((entry) => entry.id !== group.id) };
    }
    case "set_skill": {
      const skill = findSkill(library, change.skill);
      if (change.enabled && skill.reviewedSha === null) throw new Error(`${skill.id} needs a review before it can be on. The user reviews it in Skills & Tools.`);
      return { ...values, library: { ...library, skills: library.skills.map((entry) => (entry.id === skill.id ? { ...entry, enabled: change.enabled, updatedAt: context.now } : entry)) } };
    }
    case "add_mcp_server": {
      const name = change.name.trim();
      if (RESERVED_MCP_NAMES.includes(name)) throw new Error(`"${name}" is taken by Paseo or this plugin. Pick another name.`);
      if (library.mcpServers.some((server) => server.name === name)) throw new Error(`There's already an MCP server called "${name}".`);
      if (!change.command === !change.url) throw new Error("Give either a command (a local server) or a URL (a remote one).");
      const config: McpServerConfig = change.command
        ? { type: "stdio", command: change.command.trim(), args: change.args ?? [], env: change.env ?? {} }
        : { type: change.transport ?? "http", url: change.url!.trim(), headers: change.headers ?? {} };
      const added = addMcpServers(library, [{ name, enabled: true, config }], { now: context.now });
      const id = added.ids[0]!;
      return { ...values, library: { ...added.library, mcpServers: added.library.mcpServers.map((server) => (server.id === id ? { ...server, description: change.description?.trim() ?? "" } : server)) } };
    }
    case "set_mcp_server": {
      const server = findServer(library, change.server);
      if (change.enabled && !mcpServerCanEnable(server)) throw new Error(`${server.name} hasn't passed a connection test. The user tests it in Skills & Tools, which turns it on.`);
      return { ...values, library: { ...library, mcpServers: library.mcpServers.map((entry) => (entry.id === server.id ? { ...entry, enabled: change.enabled, updatedAt: context.now } : entry)) } };
    }
    case "remove_mcp_server": {
      const server = findServer(library, change.server);
      return { ...values, library: { ...library, mcpServers: library.mcpServers.filter((entry) => entry.id !== server.id) }, bots: forgetItem(values.bots, "mcp", server.id) };
    }
    case "set_defaults": {
      const current = values.defaults ?? DEFAULT_BOT_DEFAULTS;
      const provider = change.provider !== undefined ? change.provider.trim() : current.provider;
      const switched = provider !== current.provider;
      const defaults: BotDefaults = {
        provider,
        model: change.model !== undefined ? change.model : switched ? null : current.model,
        modeId: change.mode !== undefined ? change.mode : switched ? null : current.modeId,
        thinkingOptionId: change.thinking !== undefined ? change.thinking : switched ? null : current.thinkingOptionId,
        contactBots: change.contact_bots ?? current.contactBots,
      };
      checkAgent(context, { provider: defaults.provider, model: defaults.model, modeId: defaults.modeId, thinkingOptionId: defaults.thinkingOptionId });
      return { ...values, defaults };
    }
    case "save_preset": {
      const bot = findBot(values, change.bot);
      return { ...values, presets: [...(values.presets ?? []), presetFromBot(bot, context.now)] };
    }
    case "delete_preset": {
      const presets = values.presets ?? [];
      const preset = byRef(presets, change.preset, (entry) => entry.id, (entry) => entry.name, "preset");
      return { ...values, presets: presets.filter((entry) => entry.id !== preset.id) };
    }
  }
}

/** The settings with every change applied in order; throws naming the first change that doesn't fit. */
export function applyChanges(values: BotSettingsValues, changes: readonly Change[], context: ApplyContext): BotSettingsValues {
  return changes.reduce((current, change, index) => {
    try {
      return applyChange(current, change, context);
    } catch (error) {
      throw new Error(`Change ${index + 1} (${change.type}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }, values);
}

// ---------------------------------------------------------------- card

const list = (items: readonly string[]) => items.join(", ");

const PREVIEW_CHARS = 200;

/** A text for the card, on one line and in a code span so its own Markdown does nothing; a long one is cut and its length said. */
function preview(text: string, t: Translate): string {
  const line = oneLine(text).replace(/`/g, "'");
  return line.length > PREVIEW_CHARS ? t("text.change.previewCut", { text: line.slice(0, PREVIEW_CHARS), count: text.length }) : `\`${line}\``;
}

/** Longest stretch of standing instructions the card shows in full. */
const INSTRUCTIONS_SHOWN = 1500;

/**
 * The bot's name and written fields as their own lines for the card (each a bullet, the instructions quoted below),
 * so a long setup is readable instead of one run-on line. Empty when the change sets none of them.
 */
function textBlock(name: string | undefined, fields: BotFieldValues, t: Translate): string {
  const none = t("text.change.none");
  const bullets = [
    ...(name !== undefined ? [t("text.change.nameBullet", { value: oneLine(name) })] : []),
    ...(fields.title !== undefined ? [t("text.change.titleBullet", { value: oneLine(fields.title) || none })] : []),
    ...(fields.description !== undefined ? [t("text.change.descriptionBullet", { value: oneLine(fields.description) || none })] : []),
    ...(fields.instructions !== undefined ? [fields.instructions.trim() ? t("text.change.instructionsBullet") : t("text.change.instructionsNoneBullet")] : []),
  ];
  const instructions = fields.instructions?.trim();
  const quoted = instructions
    ? [
        (instructions.length > INSTRUCTIONS_SHOWN ? `${instructions.slice(0, INSTRUCTIONS_SHOWN).trimEnd()}…` : instructions).split("\n").map((line) => `> ${line}`.trimEnd()).join("\n"),
        ...(instructions.length > INSTRUCTIONS_SHOWN ? [t("text.change.instructionsLong", { count: instructions.length })] : []),
      ]
    : [];
  return bullets.length ? ["", bullets.join("\n"), ...(quoted.length ? ["", ...quoted] : [])].join("\n") : "";
}

function fieldsWithoutText(fields: BotFieldValues): BotFieldValues {
  const { title: _title, description: _description, instructions: _instructions, ...rest } = fields;
  return rest;
}

function agentText(fields: BotFieldValues, t: Translate): string[] {
  const parts: string[] = [];
  if (fields.provider !== undefined) parts.push(t("text.change.provider", { value: fields.provider }));
  if (fields.model !== undefined) parts.push(fields.model ? t("text.change.model", { value: fields.model }) : t("text.change.modelDefault"));
  if (fields.mode !== undefined) parts.push(fields.mode ? t("text.change.mode", { value: fields.mode }) : t("text.change.modeDefault"));
  if (fields.thinking !== undefined) parts.push(fields.thinking ? t("text.change.thinking", { value: fields.thinking }) : t("text.change.thinkingDefault"));
  return parts;
}

function fieldsText(fields: BotFieldValues, t: Translate): string[] {
  const parts: string[] = [];
  if (fields.title !== undefined) parts.push(t("text.change.title", { value: oneLine(fields.title) }));
  if (fields.description !== undefined) parts.push(t("text.change.blurb", { value: preview(fields.description, t) }));
  if (fields.instructions !== undefined) parts.push(t("text.change.instructions", { value: preview(fields.instructions, t) }));
  parts.push(...agentText(fields, t));
  if (fields.contact_bots !== undefined) parts.push({ ask: t("text.change.contactAsk"), allow: t("text.change.contactAllow"), off: t("text.change.contactOff") }[fields.contact_bots]);
  if (fields.avatar) parts.push(fields.avatar.image_url ? t("text.change.avatarPicture") : fields.avatar.image_url === null ? t("text.change.avatarPixel") : t("text.change.avatarOther"));
  if (fields.working_folder !== undefined) parts.push(fields.working_folder ? t("text.change.workingFolder", { value: fields.working_folder }) : t("text.change.ownFolder"));
  if (fields.pinned !== undefined) parts.push(fields.pinned ? t("text.change.pinned") : t("text.change.unpinned"));
  return parts;
}

function scheduleText(input: z.infer<typeof ScheduleInput>, t: Translate): string {
  try {
    return describeSchedule(scheduleFrom(input, new Date()), t);
  } catch {
    return input.type;
  }
}

/** The environment a new MCP server gets (variables can change how a program runs), and the names of the headers it sends. */
function mcpExtras(change: Extract<Change, { type: "add_mcp_server" }>, t: Translate): string {
  const env = Object.entries(change.env ?? {});
  const headers = Object.keys(change.headers ?? {});
  return [
    env.length ? t("text.change.mcpWithEnv", { value: preview(env.map(([name, value]) => `${name}=${value}`).join(" "), t) }) : "",
    headers.length ? t("text.change.mcpSendsHeaders", { value: preview(headers.join(", "), t) }) : "",
  ].join("");
}

/**
 * One Markdown line for the card, as the user reads the change. The translator may arrive as the second argument of
 * `changes.map(describeChange)`, which passes the index there; anything but a function means English.
 */
export function describeChange(change: Change, translate: Translate | number = englishTranslate): string {
  const t = typeof translate === "function" ? translate : englishTranslate;
  const items = (names: readonly string[]) => names.join(t("text.change.listSep"));
  const parts = (head: string, texts: readonly string[]) => t("text.change.headParts", { head, parts: texts.join(t("text.change.partSep")) });
  const state = (on: boolean) => t(on ? "text.change.on" : "text.change.off");
  switch (change.type) {
    case "create_bot": {
      const texts = [
        ...(change.role ? [t("text.change.startsAs", { role: BOT_TEMPLATES.find((template) => template.id === change.role)?.title ?? change.role })] : []),
        ...fieldsText(fieldsWithoutText(change), t),
        ...(change.skills?.length ? [t("text.change.skills", { list: items(change.skills) })] : []),
        ...(change.mcp_servers?.length ? [t("text.change.mcpServers", { list: items(change.mcp_servers) })] : []),
        ...(change.playbooks?.length ? [t("text.change.playbooks", { list: items(change.playbooks.map((playbook) => playbook.name)) })] : []),
      ];
      const head = t("text.change.newBot", { name: oneLine(change.name) });
      return `${texts.length ? parts(head, texts) : head}${textBlock(undefined, change, t)}`;
    }
    case "update_bot": {
      const texts = [
        ...fieldsText(fieldsWithoutText(change), t),
        ...(change.archived !== undefined ? [t(change.archived ? "text.change.archived" : "text.change.unarchived")] : []),
        ...(change.add_skills?.length ? [t("text.change.turnsOnSkills", { list: items(change.add_skills) })] : []),
        ...(change.remove_skills?.length ? [t("text.change.turnsOffSkills", { list: items(change.remove_skills) })] : []),
        ...(change.add_mcp_servers?.length ? [t("text.change.turnsOnMcp", { list: items(change.add_mcp_servers) })] : []),
        ...(change.remove_mcp_servers?.length ? [t("text.change.turnsOffMcp", { list: items(change.remove_mcp_servers) })] : []),
        ...(change.allow_tools?.length ? [t("text.change.usesWithoutAsking", { list: items(change.allow_tools) })] : []),
        ...(change.disallow_tools?.length ? [t("text.change.asksAgainBefore", { list: items(change.disallow_tools) })] : []),
        ...(change.add_playbooks?.length ? [t("text.change.playbooks", { list: items(change.add_playbooks.map((playbook) => playbook.name)) })] : []),
        ...(change.remove_playbooks?.length ? [t("text.change.removesPlaybooks", { list: items(change.remove_playbooks) })] : []),
      ];
      const block = textBlock(change.name, change, t);
      const head = `**${change.bot}**`;
      return `${texts.length || !block ? parts(head, texts.length ? texts : [t("text.change.noChanges")]) : head}${block}`;
    }
    case "delete_bot":
      return t("text.change.deleteBot", { bot: change.bot });
    case "add_routine":
      return t("text.change.addRoutine", {
        bot: change.bot,
        name: oneLine(change.name),
        schedule: scheduleText(change.schedule, t),
        rest: change.instructions?.trim() ? t("text.change.colonText", { text: preview(change.instructions, t) }) : "",
      });
    case "update_routine": {
      const texts = [
        ...(change.name !== undefined ? [t("text.change.renamedToQuoted", { name: oneLine(change.name) })] : []),
        ...(change.instructions !== undefined ? [t("text.change.instructions", { value: preview(change.instructions, t) })] : []),
        ...(change.schedule ? [scheduleText(change.schedule, t)] : []),
        ...(change.enabled !== undefined ? [t(change.enabled ? "text.change.resumed" : "text.change.paused")] : []),
      ];
      return t("text.change.updateRoutine", { bot: change.bot, routine: change.routine, parts: texts.join(t("text.change.partSep")) || t("text.change.unchanged") });
    }
    case "delete_routine":
      return t("text.change.deleteRoutine", { bot: change.bot, routine: change.routine });
    case "create_team": {
      const members = (change.members ?? []).filter((member) => member !== change.lead);
      const texts = [
        ...(change.lead ? [t("text.change.ledBy", { lead: change.lead })] : []),
        ...(members.length ? [t("text.change.withMembers", { list: items(members) })] : []),
        ...(change.instructions?.trim() ? [t("text.change.sharedInstructions", { value: preview(change.instructions, t) })] : []),
        ...(change.ask_freely ? [t("text.change.membersAskFreely")] : []),
      ];
      const head = t("text.change.newTeam", { name: oneLine(change.name) });
      return texts.length ? parts(head, texts) : head;
    }
    case "update_team": {
      const texts = [
        ...(change.name !== undefined ? [t("text.change.renamedTo", { name: oneLine(change.name) })] : []),
        ...(change.lead !== undefined ? [change.lead ? t("text.change.ledBy", { lead: change.lead }) : t("text.change.noChief")] : []),
        ...(change.add_members?.length ? [t("text.change.adds", { list: items(change.add_members) })] : []),
        ...(change.remove_members?.length ? [t("text.change.removes", { list: items(change.remove_members) })] : []),
        ...(change.instructions !== undefined ? [t("text.change.newSharedInstructions", { value: preview(change.instructions, t) })] : []),
        ...(change.ask_freely !== undefined ? [t(change.ask_freely ? "text.change.membersAskFreely" : "text.change.membersAskYouFirst")] : []),
        ...(change.logo ? [t("text.change.newLogo")] : []),
      ];
      return t("text.change.teamHead", { team: change.team, parts: texts.join(t("text.change.partSep")) || t("text.change.noChanges") });
    }
    case "delete_team":
      return t("text.change.deleteTeam", { team: change.team });
    case "set_skill":
      return t("text.change.skill", { skill: change.skill, state: state(change.enabled) });
    case "add_mcp_server":
      return t("text.change.addMcp", {
        name: change.name,
        what: change.command ? t("text.change.mcpRuns", { value: preview([change.command, ...(change.args ?? [])].join(" "), t) }) : t("text.change.mcpConnects", { url: change.url }),
        extras: mcpExtras(change, t),
        after: change.command ? t("text.change.mcpOffAfterTest") : t("text.change.mcpOffUntilOn"),
      });
    case "set_mcp_server":
      return t("text.change.setMcp", { server: change.server, state: state(change.enabled) });
    case "remove_mcp_server":
      return t("text.change.removeMcp", { server: change.server });
    case "set_defaults": {
      const texts = [...agentText(change, t), ...(change.contact_bots ? [t("text.change.defaultsContact", { value: change.contact_bots })] : [])];
      return t("text.change.setDefaults", { parts: texts.join(t("text.change.partSep")) || t("text.change.defaultsSame") });
    }
    case "save_preset":
      return t("text.change.savePreset", { bot: change.bot });
    case "delete_preset":
      return t("text.change.deletePreset", { preset: change.preset });
  }
}

/** What deserves a second look before applying: more access, and anything deleted. */
export function changeWarnings(changes: readonly Change[], t: Translate = englishTranslate): string[] {
  const warnings: string[] = [];
  const items = (names: readonly string[]) => names.join(t("text.change.listSep"));
  for (const change of changes) {
    const who = change.type === "create_bot" ? change.name : "bot" in change ? change.bot : "";
    if ((change.type === "create_bot" || change.type === "update_bot") && change.mode) warnings.push(t("text.warning.mode", { who, mode: change.mode }));
    if ((change.type === "create_bot" || change.type === "update_bot") && change.contact_bots === "allow") warnings.push(t("text.warning.contact", { who }));
    if (change.type === "update_bot" && change.allow_tools?.length) warnings.push(t("text.warning.allowTools", { who, list: items(change.allow_tools) }));
    if ((change.type === "create_bot" || change.type === "update_bot") && change.working_folder) warnings.push(t("text.warning.worksIn", { who, folder: change.working_folder }));
    if (change.type === "add_mcp_server" && change.command) warnings.push(t("text.warning.mcpRuns", { name: change.name }));
    if (change.type === "set_mcp_server" && change.enabled) {
      const added = changes.find((other): other is Extract<Change, { type: "add_mcp_server" }> => other.type === "add_mcp_server" && other.url !== undefined && other.name.toLowerCase() === change.server.trim().toLowerCase());
      if (added) warnings.push(t("text.warning.mcpConnects", { name: added.name, url: added.url }));
    }
    if (change.type === "set_defaults" && change.contact_bots === "allow") warnings.push(t("text.warning.defaultsContact"));
    if (change.type === "delete_bot") warnings.push(t("text.warning.deleteBot", { bot: change.bot }));
    if ((change.type === "create_team" || change.type === "update_team") && change.ask_freely) warnings.push(t("text.warning.teamAsk", { team: change.type === "create_team" ? oneLine(change.name) : change.team }));
    if (change.type === "delete_team") warnings.push(t("text.warning.deleteTeam", { team: change.team }));
    if (change.type === "remove_mcp_server") warnings.push(t("text.warning.removeMcp", { server: change.server }));
  }
  return warnings;
}

// ---------------------------------------------------------------- setup text

function botLine(bot: Bot, values: BotSettingsValues): string {
  const library = values.library ?? EMPTY_LIBRARY;
  const team = (values.groups ?? []).find((group) => group.leadId === bot.id || group.memberIds.includes(bot.id));
  const name = (ids: readonly string[], items: readonly { id: string; name?: string }[]) => ids.map((id) => items.find((item) => item.id === id)?.name ?? id);
  const parts = [
    [bot.provider || "no provider", bot.model ?? "default model", bot.modeId ? `mode ${bot.modeId}` : null].filter(Boolean).join(" · "),
    team ? `team ${team.name}${team.leadId === bot.id ? " (Chief of Staff)" : ""}` : null,
    bot.skillIds.length ? `skills ${list(bot.skillIds)}` : null,
    bot.mcpServerIds.length ? `MCP servers ${list(name(bot.mcpServerIds, library.mcpServers))}` : null,
    bot.routines.length ? `${bot.routines.length} routine${bot.routines.length === 1 ? "" : "s"}` : null,
    `contact other bots: ${bot.contactBots}`,
    bot.archived ? "archived" : null,
  ].filter(Boolean);
  return `- ${bot.name} (id ${bot.id})${bot.title ? `: ${bot.title}` : ""}. ${parts.join("; ")}.`;
}

/** get_setup's overview: bots, teams, the library, defaults, presets and providers. */
export function setupOverview(values: BotSettingsValues, providers: readonly ProviderInfo[] | null): string {
  const library = values.library ?? EMPTY_LIBRARY;
  const groups = values.groups ?? [];
  const defaults = values.defaults ?? DEFAULT_BOT_DEFAULTS;
  const byId = new Map(values.bots.map((bot) => [bot.id, bot.name]));
  const sections = [
    `Bots (${values.bots.length}):\n${values.bots.map((bot) => botLine(bot, values)).join("\n") || "- none"}`,
    `Teams (${groups.length}):\n${
      groups
        .map((group) => {
          const members = teamMembers(group).filter((id) => id !== group.leadId).map((id) => byId.get(id) ?? id);
          const lead = group.leadId ? values.bots.find((bot) => bot.id === group.leadId) : null;
          return `- ${group.name} (id ${group.id}): Chief of Staff ${lead ? lead.name : group.leadId ? (byId.get(group.leadId) ?? group.leadId) : "none"}${lead?.contactBots === "off" ? " (cannot contact other bots: its setting is Off, so it cannot hand work to the team)" : ""}; members ${list(members) || "none"}${group.instructions.trim() ? "; has shared instructions" : ""}${group.askFreely ? "; members ask each other without asking the user" : ""}.`;
        })
        .join("\n") || "- none"
    }`,
    `Library skills (${library.skills.length}):\n${library.skills.map((skill) => `- ${skill.id}: ${skill.description || "no description"} [${skill.reviewedSha === null ? "needs review" : skill.enabled ? "on" : "off"}]`).join("\n") || "- none"}`,
    `Library MCP servers (${library.mcpServers.length}):\n${library.mcpServers.map((server) => `- ${server.name}${server.description ? `: ${server.description}` : ""} [${server.enabled ? "on" : mcpServerCanEnable(server) ? "off" : "off, untested"}]`).join("\n") || "- none"}`,
    `New bots start with: provider ${defaults.provider || "any ready one"}, ${defaults.model ?? "default model"}, contact other bots: ${defaults.contactBots}.`,
    `Presets: ${list((values.presets ?? []).map((preset) => preset.name)) || "none"}.`,
    providers
      ? `Providers:\n${providers
          .map(
            (provider) =>
              `- ${provider.id}: models ${list(provider.models.map((model) => `${model.id}${model.isDefault ? " (default)" : ""}${model.thinking.length ? ` [thinking: ${list(model.thinking)}]` : ""}`)) || "none"}; modes ${list(provider.modes.map((mode) => `${mode.id}${mode.id === provider.defaultModeId ? " (default)" : ""}`)) || "none"}`,
          )
          .join("\n")}`
      : "Providers: unknown right now.",
    `Roles for new bots: ${list(BOT_TEMPLATES.map((template) => `${template.id} (${template.title})`))}.`,
  ];
  return sections.join("\n\n");
}

/** get_setup for one bot: everything the settings panel shows. */
export function botDetails(values: BotSettingsValues, ref: string, caps?: HostCaps): string {
  const bot = findBot(values, ref);
  const library = values.library ?? EMPTY_LIBRARY;
  const block = (title: string, text: string) => `${title}:\n${text.trim() || "(none)"}`;
  return [
    botLine(bot, values),
    block("Blurb", bot.description),
    block("Instructions (Soul)", bot.soul),
    block("Playbooks", bot.playbooks.map((playbook) => `- ${playbook.name} (triggers: ${list(playbook.triggers)}):\n${playbook.instructions}`).join("\n\n")),
    block("Routines", bot.routines.map((routine) => `- ${routine.name} (id ${routine.id}, ${routine.enabled ? describeSchedule(routine.schedule) : "paused"}):\n${routine.prompt}`).join("\n\n")),
    block("MCP servers", bot.mcpServerIds.map((id) => library.mcpServers.find((server) => server.id === id)?.name ?? id).join(", ")),
    block("Tools allowed without asking", bot.alwaysAllow.join(", ")),
    block("Working folder", bot.cwd ?? "its own folder in the Bots project"),
    block("Project folders", projectFoldersNote(bot.provider, caps)),
  ].join("\n\n");
}
