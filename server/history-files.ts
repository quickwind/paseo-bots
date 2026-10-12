import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { redactSecrets } from "../shared/activity";
import type { Bot } from "../shared/bot";
import { TIDY_LABEL } from "../shared/memory-maintenance";
import { usesFiles } from "../shared/tools-mode";
import { botDataPath } from "./bot-home";
import type { BotsHost } from "./host";
import { clearManaged, realDir } from "./managed-files";

export const HISTORY_DIR = "history";
export const MAX_CHATS = 40;
export const MAX_MESSAGES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const MESSAGE_CAP = 4_000;
const PAGE = 400;

const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "chat";

/** Who said a message: a message that starts with the marker the plugin or another bot puts on it is not from the user. */
function speaker(type: string, text: string): string {
  if (type === "assistant_message") return "you";
  if (/^\[(Message from|Reply from)\b/.test(text)) return "another bot";
  if (text.startsWith("[Bots")) return "the plugin";
  return "the user";
}

/**
 * For a bot whose tools are files: keeps a transcript of the chat that just ended (what was said, not
 * the tool calls, secrets removed) in history/, which the bot searches with its own file tools in
 * place of `search_chats`. Only the newest chats are kept, within a size limit.
 */
export async function writeHistory(host: BotsHost, bot: Bot, agentId: string): Promise<void> {
  const dir = join(botDataPath(bot.id), HISTORY_DIR);
  if (!usesFiles((await host.values())?.toolMode, bot.provider)) return clearManaged(dir);
  const ref = host.paseo?.agents.ref(agentId);
  const agent = (await ref?.refresh().catch(() => null))?.agent;
  if (!ref || !agent || agent.labels?.[TIDY_LABEL]) return;
  const page = await ref.timeline.refetch({ direction: "tail", projection: "projected", limit: PAGE }).catch(() => null);
  const messages = (page?.entries ?? [])
    .map((entry) => ({ item: entry.item as { type: string; text?: unknown }, at: entry.timestamp }))
    .filter(({ item }) => (item.type === "user_message" || item.type === "assistant_message") && typeof item.text === "string")
    .slice(-MAX_MESSAGES);
  const title = agent.title?.trim() || "Untitled chat";
  const lines = [`# ${title}`, `Chat ${agentId} of ${bot.name}, started ${agent.createdAt ?? "unknown"}. A transcript of what was said; written by the Bots plugin.`, ""];
  for (const { item, at } of messages) {
    const text = redactSecrets(String(item.text));
    lines.push(`### ${at.slice(0, 16).replace("T", " ")} · ${speaker(item.type, text)}`, text.length > MESSAGE_CAP ? `${text.slice(0, MESSAGE_CAP)}\n[cut at ${MESSAGE_CAP} characters]` : text, "");
  }
  const id = agentId.slice(0, 8);
  const name = `${(agent.createdAt ?? new Date().toISOString()).slice(0, 10)}-${slugOf(title)}-${id}.md`;
  await realDir(dir);
  const temporary = join(dir, `${name}.tmp-${randomBytes(4).toString("hex")}`);
  await writeFile(temporary, `${lines.join("\n")}\n`, "utf8");
  await rename(temporary, join(dir, name));
  // A renamed chat keeps one file.
  for (const other of await readdir(dir)) if (other !== name && other.endsWith(`-${id}.md`)) await rm(join(dir, other), { force: true });
  await prune(dir, name);
}

/** Keeps the newest MAX_CHATS files within MAX_BYTES; the file just written always stays. */
async function prune(dir: string, keep: string): Promise<void> {
  const files = await Promise.all(
    (await readdir(dir))
      .filter((name) => name.endsWith(".md"))
      .map(async (name) => {
        const info = await stat(join(dir, name));
        return { name, at: name === keep ? Infinity : info.mtimeMs, size: info.size };
      }),
  );
  files.sort((a, b) => b.at - a.at);
  let total = 0;
  let count = 0;
  for (const file of files) {
    count += 1;
    total += file.size;
    if (file.name !== keep && (count > MAX_CHATS || total > MAX_BYTES)) await rm(join(dir, file.name), { force: true });
  }
}
