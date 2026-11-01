import { appendFile, lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { localDay } from "../shared/activity";
import type { Bot } from "../shared/bot";
import { teamOf } from "../shared/groups";
import { projectSlug, reportIndexLine, statusLines, type ReportRecord } from "../shared/reports";
import { pluginDataPath, teamReportsPath } from "./bot-home";
import type { BotsHost } from "./host";
import { listWorkspaces } from "./workspaces";
import { dropLink, realDirUnder, writeAtomic } from "./managed-files";

// A team's reports: one line for each finished turn of a team member in a project workspace, written by the
// plugin (never by a bot's tool) into <plugin data>/shared/Teams/<team id>/reports/<project>/<day>.md.

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const PROJECT_FILE = "project.json";

interface ProjectRef {
  id: string;
  name: string;
}

interface ProjectFile extends ProjectRef {
  /** When the sweep first saw the project with no active workspace; the thirty days of grace count from here. */
  inactiveSince?: string;
}

async function readProject(dir: string): Promise<ProjectFile | null> {
  try {
    const value = JSON.parse((await readPlain(join(dir, PROJECT_FILE))) || "null") as Partial<ProjectFile>;
    if (typeof value.id !== "string" || typeof value.name !== "string") return null;
    return { id: value.id, name: value.name, ...(typeof value.inactiveSince === "string" ? { inactiveSince: value.inactiveSince } : {}) };
  } catch {
    return null;
  }
}

/** The project's folder name: its slug, or the slug and the end of its id when another project already has the slug. */
async function folderFor(root: string, project: ProjectRef): Promise<string> {
  const slug = projectSlug(project.name);
  const there = await readProject(join(root, slug));
  if (!there || there.id === project.id) return slug;
  return `${slug}-${project.id.replace(/[^A-Za-z0-9]/g, "").slice(-4).toLowerCase() || "x"}`;
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** The text of a regular file; "" for a link, a folder or a missing file: a lead could have planted a link to another team's files. */
async function readPlain(path: string): Promise<string> {
  const info = await lstat(path).catch(() => null);
  return info?.isFile() ? readFile(path, "utf8").catch(() => "") : "";
}

// ---------------------------------------------------------------- v2: whole records, per team and project

const INDEX_HEADER = "<!-- Written by the Bots plugin. One line per finished turn; the whole question and answer are in the .jsonl of the same day: search its chat id and time. -->";
const LATEST_HEADER = "<!-- Written by the Bots plugin. One line for each chat of the team: its latest turn (chats that need attention first). The whole question and answer of a turn are in <project>/<day>.jsonl: search the chat id and time. -->";

/** Writes for one team happen one after another, so a day's header and the latest.md are never made twice or half-way. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(key, next.catch(() => {}));
  return next;
}

/** A project's name for the lead's eyes: one short line, else the folder's name (project.json could have been edited). */
async function projectLabel(dir: string, folder: string): Promise<string> {
  const named = (await readProject(dir))?.name;
  return named && /^[^\r\n]{1,60}$/.test(named) ? named : folder;
}

/** The newest `max` per-chat lines of a team over the last three days, as `statusLines` shows them. */
export async function teamStatusLines(teamId: string, max: number, now = new Date()): Promise<string[]> {
  const root = teamReportsPath(teamId);
  const days = [0, 1, 2].map((back) => localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)));
  const entries: { project: string; day: string; line: string }[] = [];
  for (const folder of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, folder);
    if (!(await lstat(dir).then((info) => info.isDirectory(), () => false))) continue;
    const project = await projectLabel(dir, folder);
    for (const day of days) {
      const text = await readPlain(join(dir, `${day}.md`));
      for (const line of text.split("\n")) if (line.startsWith("- ")) entries.push({ project, day, line });
    }
  }
  return statusLines(entries, max);
}

/**
 * Keeps a finished turn of a team member (the lead too) in the team's reports: the whole record in the day's .jsonl, a
 * line in its .md, and a fresh latest.md. Returns false (and writes nothing) for a bot on no team.
 */
export async function recordReport(host: BotsHost, input: { bot: Bot; record: ReportRecord }): Promise<boolean> {
  const team = teamOf(input.bot.id, (await host.values())?.groups ?? []);
  if (!team) return false;
  const root = teamReportsPath(team.id);
  return serial(team.id, async () => {
    await realDirUnder(root);
    const { project } = input.record;
    const dir = await realDirUnder(root, await folderFor(root, project));
    if (!(await readProject(dir))) await writeAtomic(join(dir, PROJECT_FILE), `${JSON.stringify({ id: project.id, name: project.name }, null, 2)}\n`);
    const day = localDay(new Date(input.record.at));
    const index = join(dir, `${day}.md`);
    const records = join(dir, `${day}.jsonl`);
    const header = (await exists(index)) ? "" : `${INDEX_HEADER}\n`;
    // A bot with the folder attached (the lead) could have replaced a day file with a link; it is not followed.
    await dropLink(index);
    await dropLink(records);
    await appendFile(records, `${JSON.stringify(input.record)}\n`, { encoding: "utf8", mode: 0o600 });
    await appendFile(index, `${header}${reportIndexLine(input.record)}\n`, { encoding: "utf8", mode: 0o600 });
    const lines = await teamStatusLines(team.id, 40, new Date(input.record.at));
    await writeAtomic(join(root, "latest.md"), `${LATEST_HEADER}\n\n${lines.length > 0 ? lines.join("\n") : "Nothing has been reported yet."}\n`);
    return true;
  });
}

/** A team's report folder, made if it is not there yet (a session can only have a folder attached that exists). */
export async function ensureTeamReports(teamId: string): Promise<string> {
  const root = teamReportsPath(teamId);
  await realDirUnder(root);
  return root;
}

// ---------------------------------------------------------------- retention

const DAY_MS = 86_400_000;
/** A project's records go this long after its last workspace was archived, and a deleted team's folder this long after the team was gone. */
export const REPORT_GRACE_DAYS = 30;
/** The most whole records one project keeps (.jsonl); beyond it the oldest days go. The index (.md) is small and stays. */
export const REPORT_SIZE_CAP = 200 * 1024 * 1024;

const isDirectory = (path: string) => lstat(path).then((info) => info.isDirectory(), () => false);

/**
 * Once in a while (the app runs it at start and every few hours): a project's whole records are kept while it has an active
 * workspace; thirty days after its last workspace is archived they are deleted (the index stays); a project over the size cap
 * loses its oldest days; a deleted team's folder goes thirty days after the team was first noticed gone. Nothing is deleted
 * when the workspaces or the settings cannot be read.
 */
export async function sweepReports(host: BotsHost, now = new Date(), options: { sizeCap?: number } = {}): Promise<{ removedRecords: number; removedTeams: number }> {
  const result = { removedRecords: 0, removedTeams: 0 };
  const paseo = host.paseo;
  const settings = await host.values();
  if (!paseo || !settings) return result;
  const workspaces = await listWorkspaces(paseo).catch(() => null);
  if (!workspaces) return result;
  const active = new Set(workspaces.map((entry) => entry.projectId));
  const teams = new Set((settings.groups ?? []).map((group) => group.id));
  const reports = join(pluginDataPath(), "shared", "Reports");
  const grace = REPORT_GRACE_DAYS * DAY_MS;
  for (const teamId of await readdir(reports).catch(() => [] as string[])) {
    if (!/^[A-Za-z0-9_-]+$/.test(teamId)) continue;
    const teamDir = join(reports, teamId);
    if (!(await isDirectory(teamDir))) continue;
    // Inside the team's write queue: a record being written is not deleted under the writer.
    await serial(teamId, async () => {
      if (!teams.has(teamId)) {
        const marker = join(teamDir, ".gone");
        const since = Date.parse(await readFile(marker, "utf8").catch(() => ""));
        if (Number.isNaN(since)) await writeAtomic(marker, now.toISOString());
        else if (now.getTime() - since > grace) {
          await rm(teamDir, { recursive: true, force: true });
          result.removedTeams++;
        }
        return;
      }
      // A team that exists has no gone-marker (a stale one would cut the thirty days short if it is deleted later).
      await rm(join(teamDir, ".gone"), { force: true });
      for (const folder of await readdir(teamDir).catch(() => [] as string[])) {
        const dir = join(teamDir, folder);
        if (!(await isDirectory(dir))) continue;
        const project = await readProject(dir);
        if (!project) continue;
        const save = (inactiveSince?: string) => writeAtomic(join(dir, PROJECT_FILE), `${JSON.stringify({ id: project.id, name: project.name, ...(inactiveSince ? { inactiveSince } : {}) }, null, 2)}\n`);
        let records = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
        if (active.has(project.id)) {
          if (project.inactiveSince) await save();
        } else if (!project.inactiveSince || Number.isNaN(Date.parse(project.inactiveSince))) {
          await save(now.toISOString());
        } else if (now.getTime() - Date.parse(project.inactiveSince) > grace) {
          for (const name of records) await rm(join(dir, name), { force: true });
          result.removedRecords += records.length;
          records = [];
        }
        // Over the size cap: the oldest days of whole records go first.
        const sizes = await Promise.all(records.map(async (name) => ({ name, size: (await stat(join(dir, name)).catch(() => null))?.size ?? 0 })));
        let total = sizes.reduce((sum, entry) => sum + entry.size, 0);
        for (const entry of sizes) {
          if (total <= (options.sizeCap ?? REPORT_SIZE_CAP)) break;
          await rm(join(dir, entry.name), { force: true });
          total -= entry.size;
          result.removedRecords++;
        }
      }
    });
  }
  return result;
}
