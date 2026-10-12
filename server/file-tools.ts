import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { Bot } from "../shared/bot";
import { DONE_DIR, FILE_NAME, fileBelongsToTurn, MAX_FILE_BYTES, MAX_FILES_PER_SCAN, parseToolFile, PROPOSALS_DIR, UNCLAIMED_AFTER_MS, writtenStrings, type ToolFileKind } from "../shared/file-tools";
import { PROPOSAL_CARD } from "../shared/rpc";
import { usesFiles } from "../shared/tools-mode";
import { newUuid } from "../shared/uuid";
import { proposalIdInText } from "../shared/proposals";
import { botDataPath } from "./bot-home";
import type { BotsHost } from "./host";
import type { Relay } from "./relay";
import { proposeRoutine } from "./tools/routines";
import { proposeChanges } from "./tools/setup";
import { proposeSkill } from "./tools/skills";
import type { BotTool } from "./tools/mcp";

const TOOLS: Record<ToolFileKind, BotTool> = { changes: proposeChanges, routine: proposeRoutine, skill: proposeSkill };
const KEEP_DONE = 100;

export interface ScanResult {
  name: string;
  kind: ToolFileKind | null;
  ok: boolean;
  /** The tool's reply, or why the file was not accepted. */
  text: string;
  proposalId: string | null;
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

/** Moves the file to done/ and leaves the outcome beside it, where the bot can read it. */
async function settle(dir: string, name: string, text: string): Promise<void> {
  const done = join(dir, DONE_DIR);
  await mkdir(done, { recursive: true });
  await rename(join(dir, name), join(done, name)).catch(() => rm(join(dir, name), { force: true }));
  await writeFile(join(done, `${name}.result.txt`), `${text}\n`, "utf8");
  const files = (await readdir(done)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_DONE))) await rm(join(done, old), { force: true });
}

/**
 * Reads the proposal files a chat wrote in its last turn. `written` is what the turn's tool calls
 * wrote (shared/file-tools.ts `writtenStrings`): only a file those calls name belongs to this chat.
 * Each is run through the tool it stands for, so the checks, the dry run and the card are the ones
 * the MCP tools have. Files no chat accounts for are returned as `unclaimed` once they are old.
 */
export async function scanToolFiles(input: { host: BotsHost; relay: Relay; bot: Bot; agentId: string; written: readonly string[]; now?: number }): Promise<{ done: ScanResult[]; unclaimed: string[] }> {
  const dir = join(botDataPath(input.bot.id), PROPOSALS_DIR);
  const now = input.now ?? Date.now();
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => FILE_NAME.test(name)).sort();
  const done: ScanResult[] = [];
  const unclaimed: string[] = [];
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    if (!fileBelongsToTurn(name, input.written)) {
      if (now - info.mtimeMs > UNCLAIMED_AFTER_MS) unclaimed.push(name);
      continue;
    }
    if (done.length >= MAX_FILES_PER_SCAN) break;
    done.push(await handleFile(input, dir, name, info.size));
  }
  return { done, unclaimed };
}

async function handleFile(input: { host: BotsHost; relay: Relay; bot: Bot; agentId: string }, dir: string, name: string, size: number): Promise<ScanResult> {
  const fail = async (kind: ToolFileKind | null, text: string): Promise<ScanResult> => {
    await settle(dir, name, text).catch(() => {});
    return { name, kind, ok: false, text, proposalId: null };
  };
  if (size > MAX_FILE_BYTES) return fail(null, `The file is too large (over ${MAX_FILE_BYTES / 1024} KB). Write a smaller one.`);
  const parsed = parseToolFile(await readFile(join(dir, name), "utf8").catch(() => ""));
  if ("error" in parsed) return fail(null, parsed.error);
  const tool = TOOLS[parsed.kind];
  const valid = tool.input.safeParse(parsed.args);
  if (!valid.success) return fail(parsed.kind, `Not accepted: ${issues(valid.error)}`);
  try {
    const text = await tool.run(valid.data, { bot: input.bot, agentId: input.agentId, host: input.host, relay: input.relay });
    await settle(dir, name, text).catch(() => {});
    return { name, kind: parsed.kind, ok: true, text, proposalId: proposalIdInText(text) };
  } catch (error) {
    return fail(parsed.kind, `Not accepted: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const MAX_NOTICES_IN_A_ROW = 3;

/** What follows a chat's turn for a bot whose tools are files: read its proposal files, show the cards, report mistakes back. */
export class FileTools {
  /** Files in a row that were not accepted, per chat; after a few the bot stops being told (the result files stay). */
  private readonly failures = new Map<string, number>();
  /** Notices waiting for a chat that was busy. */
  private readonly pending = new Map<string, string[]>();

  constructor(
    private readonly host: BotsHost,
    private readonly relay: Relay,
  ) {}

  async afterTurn(input: { bot: Bot; agentId: string; timeline: readonly unknown[] }): Promise<void> {
    const { bot, agentId } = input;
    if (!usesFiles((await this.host.values())?.toolMode, bot.provider)) return;
    const base = { host: this.host, relay: this.relay, bot, agentId };
    const first = await scanToolFiles({ ...base, written: writtenStrings(input.timeline) });
    let results = first.done;
    if (first.unclaimed.length) {
      // No chat's tool calls account for these and they are old: this chat takes them. A guess, so it is logged.
      console.warn(`paseo-bots: giving ${first.unclaimed.join(", ")} to chat ${agentId}; no turn accounted for them`);
      results = [...results, ...(await scanToolFiles({ ...base, written: first.unclaimed })).done];
    }
    for (const result of results) {
      if (result.ok) {
        this.failures.set(agentId, 0);
        if (result.proposalId) await this.card(agentId, result.proposalId);
      } else {
        const count = (this.failures.get(agentId) ?? 0) + 1;
        this.failures.set(agentId, count);
        if (count <= MAX_NOTICES_IN_A_ROW) this.queue(agentId, `Your proposal file ${result.name} was not accepted: ${result.text.replace(/^Not accepted:\s*/, "")} Fix it and write it again as a new file.`);
      }
    }
    await this.flush(agentId);
  }

  private async card(agentId: string, proposalId: string): Promise<void> {
    await this.host.paseo?.agents
      .ref(agentId)
      .timeline.append({ type: "plugin", id: proposalId, ...PROPOSAL_CARD, data: { proposalId } } as never)
      .catch((error: unknown) => console.error("paseo-bots: couldn't post a proposal card", error));
  }

  private queue(agentId: string, text: string): void {
    this.pending.set(agentId, [...(this.pending.get(agentId) ?? []), text]);
  }

  /** Sends the waiting notices as one message once the chat is idle. */
  private async flush(agentId: string): Promise<void> {
    const waiting = this.pending.get(agentId);
    if (!waiting?.length) return;
    const snapshot = await this.host.paseo?.agents.ref(agentId).refresh().catch(() => null);
    const status = snapshot?.agent.status;
    if (!snapshot || status === "running" || status === "initializing") return;
    this.pending.delete(agentId);
    await this.host.paseo!.agents
      .ref(agentId)
      .send(`[Bots, not from the user] ${waiting.join("\n")}`, { messageId: newUuid() } as never)
      .catch((error: unknown) => console.error("paseo-bots: couldn't tell a chat about a proposal file", error));
  }
}
