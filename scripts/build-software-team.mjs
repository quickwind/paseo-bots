// Builds docs/blueprints/software-team/software-team.team.json from the markdown beside it. Run: node scripts/build-software-team.mjs
// The file is a team file (format "aydo-team"): import it in the Bots screen ("Import"), then pick each bot's model.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "blueprints", "software-team");
const text = (name) => readFileSync(join(dir, name), "utf8").trim();

// No provider and no model: the file works wherever it is imported (the import gives each bot the default provider, and you pick
// models and providers in each bot's settings).
const bot = (name, title, description, soulFile) => ({
  format: "aydo",
  version: 2,
  bot: { name, title, description, avatar: { seed: name }, soul: text(soulFile), provider: "", model: null, modeId: null, thinkingOptionId: null, routines: [], playbooks: [] },
  skills: [],
  mcpServers: [],
  files: {},
});

const team = {
  format: "aydo-team",
  version: 1,
  bots: [
    bot("Admin", "Chief of Staff", "Takes requests in, opens the feature's workspace, keeps the status.", "admin.md"),
    bot("Architect", "Architect", "Decides the architecture and judges the size of a feature.", "architect.md"),
    bot("Designer", "Designer", "Designs, splits into lanes, reviews and merges, asks for acceptance.", "designer.md"),
    bot("Developer", "Developer", "Builds one lane in its own workspace.", "developer.md"),
  ],
  teams: [{ name: "Software team", logo: null, lead: 0, members: [0, 1, 2, 3], instructions: text("team.md") }],
};

writeFileSync(join(dir, "software-team.team.json"), `${JSON.stringify(team, null, 2)}\n`);
console.log("wrote software-team.team.json");
