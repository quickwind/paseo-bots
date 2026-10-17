import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Bot, BotSettingsValues, Library } from "../shared/bot";
import { IDENTITY_FILE, planIdentityFiles, RULES_DIR, type IdentityPlan } from "../shared/identity";
import { botDataPath } from "./bot-home";
import type { BotsHost } from "./host";
import type { PaseoApi } from "./paseo";
import { realDir } from "./managed-files";
import { identitySections } from "./prompt";
import { writeSetupFiles } from "./setup-files";

const locks = new Map<string, Promise<unknown>>();

/**
 * Runs work for one bot after the work already queued for it. Writing the identity file and
 * creating a chat that reads it (Devin reads the rules when the session is created) go through
 * here, so two chats started together do not overwrite each other's file in between.
 */
export function withBotLock<T>(botId: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(botId) ?? Promise.resolve()).then(work, work);
  locks.set(
    botId,
    next.catch(() => {}),
  );
  return next;
}

const OWN_FILE = new RegExp(`^${IDENTITY_FILE}(-\\d+)?\\.md(\\.tmp-.*)?$`);

/** Writes the bot's identity to `<bot folder>/.devin/rules`, atomically, and removes files an earlier, longer one left. */
export async function writeIdentity(bot: Bot, library: Library, context: { paseo: PaseoApi | null; settings: BotSettingsValues | null }): Promise<IdentityPlan> {
  const plan = planIdentityFiles(await identitySections(bot, library, context.paseo, context.settings));
  const dir = join(botDataPath(bot.id), RULES_DIR);
  await realDir(dir);
  for (const file of plan.files) {
    const temporary = join(dir, `${file.name}.tmp-${randomBytes(4).toString("hex")}`);
    await writeFile(temporary, file.text, "utf8");
    await rename(temporary, join(dir, file.name));
  }
  const keep = new Set(plan.files.map((file) => file.name));
  for (const name of await readdir(dir)) if (OWN_FILE.test(name) && !keep.has(name)) await rm(join(dir, name), { force: true });
  // A bot with file tools reads the setup from files kept beside its identity.
  if (context.settings) await writeSetupFiles(bot, context.settings, context.paseo);
  return plan;
}

/** Rewrites one bot's identity (its memory changed); does nothing for a bot that is gone, archived or on another host. */
export async function refreshIdentity(host: BotsHost, botId: string): Promise<void> {
  const [bot, library, settings] = await Promise.all([host.bot(botId), host.library(), host.values()]);
  if (!bot || bot.archived || bot.hostId) return;
  await withBotLock(bot.id, () => writeIdentity(bot, library, { paseo: host.paseo, settings })).catch((error: unknown) => console.error(`bot-crew: couldn't write ${bot.name}'s identity`, error));
}

/** Rewrites the identity of every bot that runs on this host. */
export async function refreshIdentities(host: BotsHost): Promise<void> {
  const [bots, library, settings] = await Promise.all([host.bots(), host.library(), host.values()]);
  for (const bot of bots) {
    if (bot.archived || bot.hostId) continue;
    await withBotLock(bot.id, () => writeIdentity(bot, library, { paseo: host.paseo, settings })).catch((error: unknown) => console.error(`bot-crew: couldn't write ${bot.name}'s identity`, error));
  }
}

/** How many rule files a bot's identity takes, and anything the user should know about it (nothing is written). */
export async function identityStatus(host: BotsHost, botId: string): Promise<{ files: number; note: string | null }> {
  const bot = await host.bot(botId);
  if (!bot) return { files: 0, note: null };
  const plan = planIdentityFiles(await identitySections(bot, await host.library(), host.paseo, await host.values()));
  return { files: plan.files.length, note: plan.note };
}
