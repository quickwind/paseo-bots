import { join } from "node:path";
import { z } from "zod";
import type { Bot, BotSettingsValues } from "../shared/bot";
import { botDetails, providerInfo, setupOverview } from "../shared/changes";
import { usesFiles } from "../shared/tools-mode";
import { botDataPath } from "./bot-home";
import { clearManaged, syncManaged } from "./managed-files";
import { proposeRoutine } from "./tools/routines";
import { proposeChanges } from "./tools/setup";
import { proposeSkill } from "./tools/skills";
import type { PaseoApi } from "./paseo";

export const SETUP_DIR = "setup";

const HEADER = "<!-- Written by the Bots plugin. Read only: changes are overwritten. To change the setup, write a proposal file. -->\n\n";

/**
 * What `get_setup` and `list_bots` give a bot with MCP tools, as files in its folder: an overview of
 * the bots and the setup, and one file per bot. Bots whose tools are an MCP server get none.
 */
export async function writeSetupFiles(bot: Bot, values: BotSettingsValues, paseo: PaseoApi | null): Promise<void> {
  const dir = join(botDataPath(bot.id), SETUP_DIR);
  if (!usesFiles(values.toolMode, bot.provider)) return clearManaged(dir);
  const snapshot = await paseo?.providers.snapshot().catch(() => null);
  const providers = snapshot ? providerInfo(snapshot.entries) : null;
  const files = [
    { path: "proposal-format.md", text: proposalFormat() },
    { path: "overview.md", text: `${HEADER}${setupOverview(values, providers)}\n` },
    ...values.bots.filter((entry) => !entry.archived).map((entry) => ({ path: `bots/${entry.id.replace(/[^\w-]/g, "_")}.md`, text: `${HEADER}${botDetails(values, entry.id)}\n` })),
  ];
  await syncManaged(dir, files);
}

/** The fields of the three proposal files, from the schemas the MCP tools use. */
function proposalFormat(): string {
  const schema = (tool: { input: z.ZodType }) => {
    const { $schema: _schema, ...rest } = z.toJSONSchema(tool.input) as Record<string, unknown>;
    return JSON.stringify(rest, null, 1);
  };
  return [
    HEADER,
    "# Proposal files",
    "",
    'Each file is one JSON object with a "kind" field and the fields below. The schema of each kind follows.',
    "",
    '## kind "changes": changes to the bots, teams, skills and defaults',
    "```json",
    schema(proposeChanges),
    "```",
    "",
    '## kind "routine": a routine for you',
    "```json",
    schema(proposeRoutine),
    "```",
    "",
    '## kind "skill": a skill for you to keep',
    "```json",
    schema(proposeSkill),
    "```",
    "",
  ].join("\n");
}
