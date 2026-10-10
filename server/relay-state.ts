import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pluginDataPath } from "./bot-home";

// The relay's own state: the secret that signs each chat's tool token, and the last port it
// listened on so running chats keep their URL across restarts. Only this process reads the file.

interface State {
  /** Signs each chat's relay token. */
  secret: string;
  /** Last relay port, reused so running chats keep their MCP URL across restarts. */
  port: number | null;
}

function statePath(): string {
  return join(pluginDataPath(), "relay.json");
}

let cached: State | null = null;

export async function readState(): Promise<State> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(statePath(), "utf8")) as State;
  } catch {
    cached = { secret: randomBytes(32).toString("hex"), port: null };
  }
  return cached;
}

export async function writeState(patch: Partial<State>): Promise<State> {
  const next = { ...(await readState()), ...patch };
  cached = next;
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(statePath(), 0o600).catch(() => {});
  return next;
}
