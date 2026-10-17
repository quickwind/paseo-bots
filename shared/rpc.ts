import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BotGroupSchema, BotMcpServerSchema, BotSchema, McpServerConfigSchema, McpToolSchema, TeamFileTeamSchema } from "./bot";
import { ProposalSchema } from "./proposals";

const BotId = z.string().regex(/^[a-z0-9-]+$/);
/** "MEMORY.md" or a topic file such as "projects.md" (stored under memory/). */
const MemoryFileName = z.string().regex(/^[A-Za-z0-9 ._-]+\.md$/);
const SkillName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/);

/**
 * Creates (if needed) the Bots project folder and this bot's folder inside it.
 * `root` backs the Bots project, `path` the bot's workspace.
 */
export const ensureBotHomeRpc = defineRpc({
  name: "bots.ensure-home",
  input: z.object({ botId: BotId }),
  output: z.object({ root: z.string(), path: z.string() }),
});

/** Sent by the app on start so the daemon side can run routines. */
export const helloRpc = defineRpc({
  name: "bots.hello",
  input: z.object({}),
  output: z.object({ scheduler: z.boolean() }),
});

const PromptSectionSchema = z.object({ title: z.string(), text: z.string() });

/** The bot's system prompt as it would be sent now, with its memory and skills; `message` (a new chat's first) picks its playbooks. */
export const systemPromptRpc = defineRpc({
  name: "bots.system-prompt",
  input: z.object({ bot: BotSchema, local: z.boolean(), message: z.string().max(100_000).optional() }),
  output: z.object({ systemPrompt: z.string(), sections: z.array(PromptSectionSchema) }),
});

const MemoryFileSchema = z.object({ name: MemoryFileName, bytes: z.number(), lines: z.number(), topic: z.boolean() });

export const memoryListRpc = defineRpc({
  name: "bots.memory.list",
  input: z.object({ botId: BotId }),
  output: z.object({ folder: z.string(), files: z.array(MemoryFileSchema), injectedLines: z.number(), injectedBytes: z.number() }),
});

const TidyStatusSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  /** The tidy chat is stopped at a permission prompt. */
  waiting: z.boolean(),
  lastRunAt: z.string().nullable(),
  last: z.object({ at: z.string(), status: z.enum(["running", "succeeded", "failed"]), reason: z.string(), note: z.string().nullable(), flags: z.array(z.string()) }).nullable(),
  nextDueAt: z.string().nullable(),
  blockedUntil: z.string().nullable(),
  runsToday: z.number(),
});
export type TidyStatus = z.infer<typeof TidyStatusSchema>;

export const tidyStatusRpc = defineRpc({
  name: "bots.tidy.status",
  input: z.object({ botId: BotId }),
  output: TidyStatusSchema,
});

export const tidyRunRpc = defineRpc({
  name: "bots.tidy.run",
  input: z.object({ botId: BotId }),
  output: TidyStatusSchema,
});

export const identityStatusRpc = defineRpc({
  name: "bots.identity.status",
  input: z.object({ botId: BotId }),
  output: z.object({ files: z.number(), note: z.string().nullable() }),
});

export const memoryReadRpc = defineRpc({
  name: "bots.memory.read",
  input: z.object({ botId: BotId, name: MemoryFileName }),
  output: z.object({ text: z.string() }),
});

export const memoryWriteRpc = defineRpc({
  name: "bots.memory.write",
  input: z.object({ botId: BotId, name: MemoryFileName, text: z.string().max(200_000) }),
  output: z.object({ ok: z.boolean() }),
});

export const memoryDeleteRpc = defineRpc({
  name: "bots.memory.delete",
  input: z.object({ botId: BotId, name: MemoryFileName }),
  output: z.object({ ok: z.boolean() }),
});

const LogDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The daily log: its days, and one day's text when `day` is given. */
export const memoryLogRpc = defineRpc({
  name: "bots.memory.log",
  input: z.object({ botId: BotId, day: LogDay.optional() }),
  output: z.object({ days: z.array(z.object({ day: z.string(), lines: z.number() })), text: z.string().nullable() }),
});

export const memoryLogDeleteRpc = defineRpc({
  name: "bots.memory.log-delete",
  input: z.object({ botId: BotId, day: LogDay }),
  output: z.object({ ok: z.boolean() }),
});

const JournalEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  file: z.string(),
  actor: z.enum(["bot", "you"]),
  via: z.enum(["chat", "app", "disk", "undo"]),
  chat: z.object({ id: z.string(), title: z.string() }).nullable(),
  kind: z.enum(["created", "edited", "deleted"]),
  diff: z.string(),
  added: z.number(),
  removed: z.number(),
  canUndo: z.boolean(),
});
export type JournalRow = z.infer<typeof JournalEntrySchema>;

/** Recent changes to a bot's memory files, newest first. */
export const memoryJournalRpc = defineRpc({
  name: "bots.memory.journal",
  input: z.object({ botId: BotId }),
  output: z.object({ entries: z.array(JournalEntrySchema) }),
});

/** Puts a memory file back the way it was before a change. */
export const memoryUndoRpc = defineRpc({
  name: "bots.memory.undo",
  input: z.object({ botId: BotId, id: z.string().regex(/^j-[a-z0-9]+$/) }),
  output: z.object({ ok: z.boolean() }),
});

const ImportedSkillSchema = z.object({ id: SkillName, description: z.string(), source: z.string() });

/** Copies the skills in a folder on this computer (its full path) into the library. */
export const skillImportRpc = defineRpc({
  name: "bots.library.import-skills",
  input: z.object({ source: z.string().min(1).max(500) }),
  output: z.object({ skills: z.array(ImportedSkillSchema) }),
});

export const skillReadRpc = defineRpc({
  name: "bots.library.read-skill",
  input: z.object({ id: SkillName }),
  output: z.object({ text: z.string(), sha: z.string().nullable(), missing: z.boolean(), path: z.string(), files: z.array(z.string()) }),
});

/** Creates or replaces a library skill's SKILL.md; returns its frontmatter description and hash. */
export const skillWriteRpc = defineRpc({
  name: "bots.library.write-skill",
  input: z.object({ id: SkillName, text: z.string().max(256_000) }),
  output: z.object({ description: z.string(), sha: z.string() }),
});

export const skillDeleteRpc = defineRpc({
  name: "bots.library.delete-skill",
  input: z.object({ id: SkillName }),
  output: z.object({ ok: z.boolean() }),
});

/** Starts or connects to an MCP server, lists its tools and disconnects. */
export const mcpProbeRpc = defineRpc({
  name: "bots.library.test-mcp",
  input: z.object({ config: McpServerConfigSchema }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), tools: z.array(McpToolSchema) }), z.object({ ok: z.literal(false), error: z.string() })]),
});

/** MCP servers other apps on this computer have (Claude Code, Claude Desktop, Cursor), to import. */
export const mcpSourcesRpc = defineRpc({
  name: "bots.library.mcp-sources",
  input: z.object({}),
  output: z.object({ sources: z.array(z.object({ label: z.string(), count: z.number(), json: z.string() })) }),
});

/** One run of a routine, like Paseo's ScheduleRun. */
const RoutineRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(["schedule", "manual", "webhook"]),
  /** When the run was due; for manual and webhook runs, when it was asked for. */
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "skipped-busy", "skipped-missed"]),
  agentId: z.string().nullable(),
  /** The start of the bot's reply once the run finished. */
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

/** A run's card in the routine's results chat: a plugin timeline item that's replaced (same id) when the run finishes. */
export const RoutineRunCardSchema = RoutineRunSchema.pick({ trigger: true, scheduledFor: true, status: true, agentId: true, output: true, error: true }).extend({ routineName: z.string() });
export type RoutineRunCard = z.infer<typeof RoutineRunCardSchema>;
export const ROUTINE_RUN_CARD = { kind: "routine-run", version: 1 } as const;

/** The card for a proposal: a tool call that made one, or (providers without the MCP tools) a plugin item the plugin posts after reading the bot's proposal file. */
export const PROPOSAL_CARD = { kind: "proposal", version: 1 } as const;
export const ProposalCardSchema = z.object({ proposalId: z.string() });

const RoutineRecordSchema = z.object({
  /** The last time the schedule fired (runs, skips and misses), which the next due time counts from. */
  lastRunAt: z.string().nullable(),
  /** The latest runs, oldest first. */
  runs: z.array(RoutineRunSchema),
});
export type RoutineRecord = z.infer<typeof RoutineRecordSchema>;

export const routineStatusRpc = defineRpc({
  name: "bots.routines.status",
  input: z.object({}),
  output: z.object({ scheduler: z.boolean(), routines: z.record(z.string(), RoutineRecordSchema) }),
});

export const routineRunNowRpc = defineRpc({
  name: "bots.routines.run-now",
  input: z.object({ botId: BotId, routineId: z.string() }),
  output: z.object({ run: RoutineRunSchema }),
});

/** The routine's webhook URL on this host; `rotate` replaces its secret so the old URL stops working. */
export const routineWebhookRpc = defineRpc({
  name: "bots.routines.webhook",
  input: z.object({ routineId: z.string().regex(/^[a-z0-9-]+$/), rotate: z.boolean().optional() }),
  output: z.object({ url: z.string() }),
});

/** A shareable bot file: identity, soul, its skills and MCP servers, routines (paused) and optionally memory. Secrets are redacted. */
export const exportBotRpc = defineRpc({
  name: "bots.export",
  input: z.object({ bot: BotSchema, includeMemory: z.boolean() }),
  output: z.object({ json: z.string() }),
});

/** Writes an exported bot's files for `botId`; returns the bot fields to save and what to add to the library. */
export const importBotRpc = defineRpc({
  name: "bots.import",
  input: z.object({ botId: BotId, json: z.string().max(5_000_000) }),
  output: z.object({ bot: BotSchema, skills: z.array(ImportedSkillSchema), mcpServers: z.array(BotMcpServerSchema) }),
});

const ImportedBotSchema = z.object({ bot: BotSchema, skills: z.array(ImportedSkillSchema), mcpServers: z.array(BotMcpServerSchema) });

/** Several bots in one team file, with the teams they're on; secrets are redacted as in single exports. */
export const exportTeamRpc = defineRpc({
  name: "bots.export-team",
  input: z.object({ bots: z.array(BotSchema).min(1).max(50), groups: z.array(BotGroupSchema).max(50).default([]), includeMemory: z.boolean() }),
  output: z.object({ json: z.string() }),
});

/** Imports a team file, or a single bot file, as new bots and teams. */
export const importTeamRpc = defineRpc({
  name: "bots.import-team",
  input: z.object({ json: z.string().max(20_000_000) }),
  output: z.object({ bots: z.array(ImportedBotSchema), teams: z.array(TeamFileTeamSchema) }),
});

/** Stores a picked file on this host so it can be sent as an `uploaded_file` attachment. */
export const uploadRpc = defineRpc({
  name: "bots.upload",
  input: z.object({ botId: BotId, fileName: z.string().min(1).max(255), dataBase64: z.string().max(36_000_000) }),
  output: z.object({ path: z.string(), size: z.number() }),
});

/**
 * The plugin's MCP servers for a new chat of a local bot: its tools. `agentId`
 * is the chat's id, picked before the chat is created.
 */
export const mountRpc = defineRpc({
  name: "bots.mount",
  input: z.object({ botId: BotId, agentId: z.uuid() }),
  output: z.object({ tools: McpServerConfigSchema }),
});

// ---------------------------------------------------------------- proposals

const ProposalId = z.string().regex(/^p-[a-z0-9]+$/);

/** A proposal a bot made in a chat; null once it's gone. */
export const proposalGetRpc = defineRpc({
  name: "bots.proposals.get",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema.nullable() }),
});

/** Accepts a proposal. A skill is written to the library here; the app then records it (and routines) in the bots' settings. */
export const proposalAcceptRpc = defineRpc({
  name: "bots.proposals.accept",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema, skill: z.object({ id: SkillName, description: z.string(), sha: z.string() }).optional() }),
});

export const proposalDismissRpc = defineRpc({
  name: "bots.proposals.dismiss",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema }),
});

// ---------------------------------------------------------------- allowed commands

const CommandRuleSchema = z.object({ id: z.string(), command: z.string(), cwd: z.string() });

/** Commands a bot runs without asking: exact command, exact folder. */
export const commandListRpc = defineRpc({
  name: "bots.commands.list",
  input: z.object({ botId: BotId }),
  output: z.object({ rules: z.array(CommandRuleSchema) }),
});

export const commandAllowRpc = defineRpc({
  name: "bots.commands.allow",
  input: z.object({ botId: BotId, command: z.string().min(1).max(16_384), cwd: z.string().min(1).max(4_096) }),
  output: z.object({ rule: CommandRuleSchema }),
});

export const commandRemoveRpc = defineRpc({
  name: "bots.commands.remove",
  input: z.object({ botId: BotId, id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
