import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import type { Bot } from "../shared/bot";
import { DONE_DIR, FILE_NAME, fileBelongsToTurn, MAX_FILE_BYTES, MAX_FILES_PER_SCAN, parseToolFile, PROPOSALS_DIR, UNCLAIMED_AFTER_MS, type ToolFileKind } from "../shared/file-tools";
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
