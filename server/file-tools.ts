import { lstat, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Bot } from "../shared/bot";
import { DONE_DIR, FILE_NAME, fileBelongsToTurn, MAX_FILE_BYTES, MAX_FILES_PER_SCAN, OUTBOX_DIR, parseToolFile, PROPOSALS_DIR, UNCLAIMED_AFTER_MS, writtenStrings, type ToolFileKind } from "../shared/file-tools";
import { PROPOSAL_CARD } from "../shared/rpc";
import { usesFiles } from "../shared/tools-mode";
import { newUuid } from "../shared/uuid";
import { proposalIdInText } from "../shared/proposals";
import { botDataPath } from "./bot-home";
import type { BotsHost } from "./host";
import { realDir, writeAtomic } from "./managed-files";
import type { ChatActivity } from "./maintenance";
import { writeHistory } from "./history-files";
import type { Asks } from "./asks";
import type { Relay } from "./relay";
import { proposeRoutine } from "./tools/routines";
import { proposeChanges } from "./tools/setup";
import { proposeSkill } from "./tools/skills";
import type { BotTool } from "./tools/mcp";

const TOOLS: Partial<Record<ToolFileKind, BotTool>> = { changes: proposeChanges, routine: proposeRoutine, skill: proposeSkill };
const AskFile = z.object({ to: z.string().min(1).max(100), message: z.string().min(1).max(20_000) });
const KEEP_DONE = 100;
const BAD_NAME = "Not accepted: the file name may only have letters, digits, _, . and -, and must end in .json.";

export interface ScanInput {
  host: BotsHost;
  relay: Relay;
  bot: Bot;
  agentId: string;
  written: readonly string[];
  now?: number;
  /** proposals (the default) or the outbox, where a bot asks another bot. */
  folder?: typeof PROPOSALS_DIR | typeof OUTBOX_DIR;
  /** The asks service and the chat's labels, for the outbox. */
  asks?: Pick<Asks, "request"> | null;
  labels?: Record<string, string>;
}

export interface ScanResult {
  name: string;
  kind: ToolFileKind | null;
  ok: boolean;
  /** The tool's reply, or why the file was not accepted. */
  text: string;
  proposalId: string | null;
  /** Not worth telling the chat: it did not write the file. */
  quiet?: boolean;
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

const CLAIM_STALE_MS = 60_000;

/**
 * Exclusive creation of a marker file: of two scans only one gets it. (Two renames of one file are
 * not enough: on Windows both can succeed.) A marker a crashed scan left behind is taken over.
 */
async function lockFile(marker: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await (await open(marker, "wx")).close();
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM, EBUSY and EACCES: Windows says so while the other scan is deleting its marker.
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
      const age = await stat(marker).then((info) => Date.now() - info.mtimeMs, () => null);
      if (age === null || age <= CLAIM_STALE_MS) return false;
      await rm(marker, { force: true });
    }
  }
  return false;
}

/**
 * Takes the file for this scan by moving it into done/, holding a marker beside it meanwhile so
 * that when two scans race for a file only one gets it. Returns where it is now, or null when
 * someone else got it first (or done/ cannot be used, in which case the file is removed so it is
 * not taken over and over).
 */
async function claim(dir: string, name: string): Promise<{ path: string } | { removed: true } | null> {
  const done = join(dir, DONE_DIR);
  let held = false;
  const marker = join(done, `${name}.claim`);
  try {
    try {
      await realDir(done);
    } catch {
      // Two scans making the folder at once can make one of them fail (on Windows); that is fine when the folder is there.
      if (!(await lstat(done).then((info) => info.isDirectory(), () => false))) throw new Error("done/ cannot be used");
    }
    held = await lockFile(marker);
    if (!held) return null;
  } catch {
    await rm(join(dir, name), { force: true });
    return { removed: true };
  }
  try {
    await rename(join(dir, name), join(done, name));
  } catch {
    return null;
  } finally {
    if (held) await rm(marker, { force: true });
  }
  return { path: join(done, name) };
}

/** Leaves the outcome beside the file, where the bot can read it; keeps done/ to the newest files. */
async function conclude(dir: string, name: string, text: string): Promise<void> {
  const done = join(dir, DONE_DIR);
  await writeAtomic(join(done, `${name}.result.txt`), `${text}\n`).catch(() => {});
  const files = await Promise.all(
    (await readdir(done, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({ name: entry.name, at: (await stat(join(done, entry.name)).catch(() => null))?.mtimeMs ?? 0 })),
  );
  files.sort((a, b) => a.at - b.at);
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_DONE))) await rm(join(done, old.name), { force: true });
}

/**
 * Reads the proposal files a chat wrote in its last turn. `written` is what the turn's tool calls
 * wrote (shared/file-tools.ts `writtenStrings`): only a file those calls name belongs to this chat.
 * Each is run through the tool it stands for, so the checks, the dry run and the card are the ones
 * the MCP tools have. Files no chat accounts for are returned as `unclaimed` once they are old.
 */
export async function scanToolFiles(input: ScanInput): Promise<{ done: ScanResult[]; unclaimed: string[] }> {
  const dir = join(botDataPath(input.bot.id), input.folder ?? PROPOSALS_DIR);
  const now = input.now ?? Date.now();
  // A link in place of the folder is removed, never followed.
  await realDir(dir).catch(() => {});
  const all = (await readdir(dir).catch(() => [] as string[])).sort();
  const names = all.filter((name) => FILE_NAME.test(name));
  const done: ScanResult[] = [];
  const unclaimed: string[] = [];
  for (const name of names) {
    const info = await lstat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    if (!fileBelongsToTurn(name, input.written)) {
      if (now - info.mtimeMs > UNCLAIMED_AFTER_MS) unclaimed.push(name);
      continue;
    }
    if (done.length >= MAX_FILES_PER_SCAN) break;
    const result = await handleFile(input, dir, name, info.size);
    if (result) done.push(result);
  }
  // A file this turn wrote under a name the plugin does not read would otherwise sit there unnoticed, and the bot would think it was sent.
  for (const name of all.filter((entry) => !FILE_NAME.test(entry) && entry !== DONE_DIR)) {
    if (done.length >= MAX_FILES_PER_SCAN) break;
    if (!fileBelongsToTurn(name, input.written) || !(await lstat(join(dir, name)).catch(() => null))?.isFile()) continue;
    const claimed = await claim(dir, name);
    if (!claimed) continue;
    if ("path" in claimed) await conclude(dir, name, BAD_NAME);
    done.push({ name, kind: null, ok: false, text: BAD_NAME, proposalId: null });
  }
  return { done, unclaimed };
}

/** Settles files nobody accounts for without running them: the bot is told, in the result file, to write them again. */
export async function discardFiles(input: Pick<ScanInput, "bot" | "folder">, names: readonly string[], text: string): Promise<ScanResult[]> {
  const dir = join(botDataPath(input.bot.id), input.folder ?? PROPOSALS_DIR);
  const out: ScanResult[] = [];
  for (const name of names) {
    const claimed = await claim(dir, name);
    if (!claimed || "removed" in claimed) continue;
    await conclude(dir, name, text);
    out.push({ name, kind: null, ok: false, text, proposalId: null, quiet: true });
  }
  return out;
}

async function handleFile(input: ScanInput, dir: string, name: string, size: number): Promise<ScanResult | null> {
  const claimed = await claim(dir, name);
  if (!claimed) return null;
  const fail = async (kind: ToolFileKind | null, text: string): Promise<ScanResult> => {
    if ("path" in claimed) await conclude(dir, name, text);
    return { name, kind, ok: false, text, proposalId: null };
  };
  if ("removed" in claimed) return fail(null, "The file was removed: the done/ folder next to it could not be used. Write it again.");
  if (size > MAX_FILE_BYTES) return fail(null, `The file is too large (over ${MAX_FILE_BYTES / 1024} KB). Write a smaller one.`);
  const outbox = input.folder === OUTBOX_DIR;
  const parsed = parseToolFile(await readFile(claimed.path, "utf8").catch(() => ""), outbox ? ["ask"] : undefined);
  if ("error" in parsed) return fail(null, parsed.error);
  if (parsed.kind === "ask") {
    const question = AskFile.safeParse(parsed.args);
    if (!question.success) return fail("ask", `Not accepted: ${issues(question.error)}`);
    if (!input.asks) return fail("ask", "Not accepted: asking other bots is not available here.");
    const result = await input.asks.request({ bot: input.bot, agentId: input.agentId, labels: input.labels ?? {} }, question.data);
    if (!result.ok) return fail("ask", result.text);
    await conclude(dir, name, result.text);
    return { name, kind: "ask", ok: true, text: result.text, proposalId: result.proposalId };
  }
  const tool = TOOLS[parsed.kind]!;
  const valid = tool.input.safeParse(parsed.args);
  if (!valid.success) return fail(parsed.kind, `Not accepted: ${issues(valid.error)}`);
  try {
    const text = await tool.run(valid.data, { bot: input.bot, agentId: input.agentId, host: input.host, relay: input.relay });
    await conclude(dir, name, text);
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
    private readonly asks: Pick<Asks, "request" | "deliver"> | null = null,
    private readonly activity: Pick<ChatActivity, "busy"> | null = null,
  ) {}

  async afterTurn(input: { bot: Bot; agentId: string; timeline: readonly unknown[]; labels?: Record<string, string> }): Promise<void> {
    const { bot, agentId } = input;
    if (!usesFiles((await this.host.values())?.toolMode, bot.provider)) {
      // Back on an MCP server: the history folder is cleared (writeHistory does that for a bot without file tools).
      await writeHistory(this.host, bot, agentId).catch(() => {});
      return;
    }
    const written = writtenStrings(input.timeline);
    let results: ScanResult[] = [];
    for (const folder of this.asks ? ([PROPOSALS_DIR, OUTBOX_DIR] as const) : ([PROPOSALS_DIR] as const)) {
      const base = { host: this.host, relay: this.relay, bot, agentId, folder, asks: this.asks, labels: input.labels ?? {} };
      const first = await scanToolFiles({ ...base, written });
      results = [...results, ...first.done];
      if (!first.unclaimed.length) continue;
      if (folder === OUTBOX_DIR) {
        // A question must come from the chat that asked it, so a guess could send it for the wrong one.
        results = [...results, ...(await discardFiles({ bot, folder }, first.unclaimed, "Not accepted: the plugin could not tell which chat wrote this file, so the question was not sent. Write it again as the last step of your turn."))];
      } else if (!this.activity?.busy(bot.id)) {
        // No chat's tool calls account for these and they are old, and no other chat of the bot is working: this chat takes them. A guess, so it is logged.
        console.warn(`bot-crew: giving ${first.unclaimed.join(", ")} to chat ${agentId}; no turn accounted for them`);
        results = [...results, ...(await scanToolFiles({ ...base, written: first.unclaimed })).done];
      }
    }
    for (const result of results) {
      if (result.ok) {
        this.failures.set(agentId, 0);
        if (result.proposalId) await this.card(agentId, result.proposalId);
      } else if (!result.quiet) {
        const count = (this.failures.get(agentId) ?? 0) + 1;
        this.failures.set(agentId, count);
        if (count <= MAX_NOTICES_IN_A_ROW) this.queue(agentId, `Your file ${result.name} was not accepted: ${result.text.replace(/^Not accepted:\s*/, "")} Fix it and write it again as a new file.`);
      }
    }
    await this.flush(agentId);
    await this.asks?.deliver(agentId).catch((error: unknown) => console.error("bot-crew: couldn't deliver a bot's answer", error));
    await writeHistory(this.host, bot, agentId).catch((error: unknown) => console.error("bot-crew: couldn't write the chat history", error));
  }

  private async card(agentId: string, proposalId: string): Promise<void> {
    await this.host.paseo?.agents
      .ref(agentId)
      .timeline.append({ type: "plugin", id: proposalId, ...PROPOSAL_CARD, data: { proposalId } } as never)
      .catch((error: unknown) => console.error("bot-crew: couldn't post a proposal card", error));
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
      .catch((error: unknown) => console.error("bot-crew: couldn't tell a chat about a proposal file", error));
  }
}
