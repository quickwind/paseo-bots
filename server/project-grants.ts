import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginDataPath } from "./bot-home";
import { writeAtomic } from "./managed-files";

// Projects a team (or a bot with no team) may create workspaces in without asking again, saved from the
// first workspace card. They live on this host apart from the bots' settings, so a shared team file
// can never grant one.

const MAX_PER_SCOPE = 200;

export interface ProjectGrant {
  projectId: string;
  projectName: string;
  grantedAt: string;
}

type StoredGrant = ProjectGrant & { scope: string };

const storePath = () => join(pluginDataPath(), "project-grants.json");

async function load(): Promise<StoredGrant[]> {
  try {
    const saved = JSON.parse(await readFile(storePath(), "utf8")) as { grants?: StoredGrant[] };
    return Array.isArray(saved.grants) ? saved.grants : [];
  } catch {
    return [];
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** One read-modify-write at a time. */
function change<T>(edit: (grants: StoredGrant[]) => { grants: StoredGrant[]; result: T }): Promise<T> {
  const run = async () => {
    const { grants, result } = edit(await load());
    await writeAtomic(storePath(), JSON.stringify({ version: 1, grants }, null, 2));
    return result;
  };
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

export async function listGrants(scope: string): Promise<ProjectGrant[]> {
  return (await load()).filter((grant) => grant.scope === scope).map(({ scope: _scope, ...grant }) => grant);
}

export async function projectAllowed(scope: string, projectId: string): Promise<boolean> {
  return (await load()).some((grant) => grant.scope === scope && grant.projectId === projectId);
}

/** Remembers a project for a scope; a project already remembered keeps its date and takes the new name. */
export function allowProject(scope: string, project: { id: string; name: string }): Promise<void> {
  return change((grants) => {
    const mine = grants.filter((grant) => grant.scope === scope);
    const same = mine.find((grant) => grant.projectId === project.id);
    if (same) return { grants: grants.map((grant) => (grant === same ? { ...grant, projectName: project.name } : grant)), result: undefined };
    if (mine.length >= MAX_PER_SCOPE) throw new Error(`A team can remember at most ${MAX_PER_SCOPE} projects.`);
    return { grants: [...grants, { scope, projectId: project.id, projectName: project.name, grantedAt: new Date().toISOString() }], result: undefined };
  });
}

export function revokeProject(scope: string, projectId: string): Promise<boolean> {
  return change((grants) => {
    const next = grants.filter((grant) => grant.scope !== scope || grant.projectId !== projectId);
    return { grants: next, result: next.length !== grants.length };
  });
}
