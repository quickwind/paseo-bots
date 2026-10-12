<p align="center">
  <img src="docs/bots.svg" width="512" alt="Six pixel-art bots">
</p>

# paseo-bots, offline edition

Personal bots for [Paseo](https://paseo.sh) and Wukong: give each bot instructions, a model, memory, skills and tools, then chat with it in its own workspace or let it run routines.

This is a fork of [oliexe/paseo-bots](https://github.com/oliexe/paseo-bots) 0.2.0 (MIT, by Ondrej Rehacek) for machines that must not send data to cloud services. **The plugin makes no network connections of its own.** Everything that needed one is gone, and a test keeps it that way.

## What is different

| Upstream feature | Offline edition |
| --- | --- |
| Connected apps through Composio (Gmail, Slack, Notion, 1,000+ more) | Removed, with its relay proxy, API key, sign-in cards and the roles built on it (Inbox, Watch, Ops) |
| Avatar pictures drawn by OpenAI | Removed; pixel-art faces, and pictures you upload |
| Pictures from an image address | Removed; a picture is kept only as an uploaded `data:` image |
| Importing skills from GitHub or a link | Imports from **a folder on this computer** instead |
| Testing MCP servers at a remote address (HTTP, SSE) | The plugin only tests programs and `http://localhost` addresses. A remote server (for example one inside your company) is imported and can be turned on without a test; the bot's agent is the one that connects to it |
| GitHub link on the start screen | Removed |

Everything else is unchanged: bots, memory, routines and webhooks, teams, the skill and MCP library, `/learn`, Paseo's own tools for bots, and sharing bots and teams as files.

## What this does not control

- **The bots' own agents.** A bot runs on a provider (Claude Code, for instance) that talks to its own service. That is the provider's traffic, not the plugin's.
- **MCP servers.** The agent connects to the servers you give a bot, remote ones included; the plugin never does. A server may itself reach the internet. Add only servers you trust.
- **Links in a chat.** A link in a bot's reply opens in your browser only when you press it.
- **The plugin runs unsandboxed**, like every Paseo plugin. Read the code before installing it.

## Screenshots

| | |
| --- | --- |
| **Bots** | **Bot settings** |
| ![Bots](docs/splash.png) | ![Bot settings](docs/bot.png) |
| **Skills** | **MCP servers** |
| ![Skills](docs/skills.png) | ![MCP servers](docs/mcp.png) |
| **Teams** | |
| ![Teams](docs/teams.png) | |

## Install

Get the plugin folder onto the machine (the offline package unzips into one), then install it from that folder.

```bash
wukong plugin install /path/to/paseo-bots      # Wukong
paseo plugin install /path/to/paseo-bots       # Paseo
```

Turn on **Settings → Plugins → Enable plugins** first. Requires Paseo 0.9.2 or later. Wukong installs plugins from a local folder only, which is what this edition is for.

## Usage

### Bots

1. Open **Bots** in Paseo's sidebar and press **New bot**. Start blank, from a role, from one of your presets, or paste a bot or team file under **Import**.
2. Chat with it. Every chat is a thread in the bot's workspace; **Open in Paseo** in a chat's menu shows it in Paseo's own view.
3. Open its settings with the panel button at the top right of a chat, or **Open bot settings** in the bot's menu. **Identity** holds the name, avatar and voice, **Soul** its standing instructions, **Model** the provider and model, and **Permissions** the approval mode.

Bots can do the setting up too. Ask one in a chat, for example "Create a research team of three bots with Scout as Chief of Staff", and it shows every change on one card; **Apply changes** makes them. A bot can create, edit and delete bots, teams, routines, library skills and MCP servers, and change what new bots start with. Each bot's earlier settings stay under **History** in its settings.

**Devin.** Devin has no system prompt, so the plugin writes each bot's identity (name, standing instructions, memory, skills, team) to `.devin/rules/bot-identity.md` in the bot's own folder, as an always-on rule that Devin reads when a chat starts. It is rewritten when the settings or the memory change and before each chat, so both a chat started in Bots and a plain new chat in the bot's workspace know who the bot is. The file is generated: edit the bot's settings, not the file. Over 32 KB it is split into several files, and the bot's Overview says so. A bot with its own working folder gets nothing written there; its Devin chats carry the identity in the first message instead. Tool access (`get_setup`, `propose_changes`, ...) still needs Devin to accept the plugin's MCP server.

**Set up with the bot.** A bot made with **Blank bot** opens with a short interview: it asks about what you want from it, how you work and what it must never do, then proposes its name, description and instructions on one card and writes a starting `MEMORY.md` once you confirm. It does not change its provider, model or approval mode; you set those under **Model** and **Permissions**. You can start the interview again from **Overview > Set up with the bot**. Under Settings > Plugins > paseo-bots, **Set up with the bot** holds the prompt (leave it empty for the built-in one; name a skill in it to have the bot use it, if the skill is on for that bot) and a switch to stop blank bots from starting it by themselves. Bots made from a role or preset never start it by themselves.

### Memory

A bot updates its `MEMORY.md` when it learns something worth keeping, for example when you say "Remember that I prefer short answers". New chats start with it.

In the bot's settings, **Memory** shows `MEMORY.md` and its topic files, which you can edit, a **Daily log** of its chats, and **Changes**, where **Undo** puts a file back the way it was.

**Maintenance.** Under **Memory > Maintenance** two switches keep memory useful as it grows (on for new bots, off for existing ones):

- **Save notes when a chat fills up.** When a chat passes the chosen share of its context window, the app asks it, once, to write what is worth keeping to `memory/inbox.md`. You see that message and a one-line reply in the chat. A provider that does not report context use is never asked.
- **Tidy memory automatically.** On an interval (it also runs after a laptop wakes), the app starts a "Memory tidy" chat that moves what is durable from the inbox and the daily log into `MEMORY.md`, merges duplicates, drops what is out of date and empties the inbox. It skips when there is nothing new, waits while you are chatting with the bot, runs at most six times a day, and backs off for a day if memory stays over budget. **Tidy now** runs it at once. The model is Paseo's Metadata generation setting by default, or the bot's own.

Every change shows under **Changes** with undo.

### Routines

1. In the bot's settings, open **Routines** and press **New routine**.
2. Give it a name and a prompt. The prompt is the first message of each run.
3. Pick when it repeats: a preset such as **Weekdays 9:00** or your own cron expression, **Once**, or **When its webhook is called**.
4. To collect results in one place, pick a chat under **Post results to**. Each run still gets its own chat.

Bots can propose routines too: ask in a chat, then press **Create routine** on the card. A webhook routine's URL is under **Copy webhook URL** in its menu; `POST` to it from this computer.

### Teams

1. Press **Team map** at the bottom of the bot list, then **New team**.
2. Name the team, switch on its members, pick a **Lead** as its Chief of Staff, and add shared instructions for every member. The team gets a pixel-art logo; **Reroll** draws another, or use your own picture.
3. Send your requests to the Chief of Staff. It hands parts of the work to its teammates.

With teams, the Bots screen gets a tab for each team, and **Other bots** for bots without one (a menu on phones); **+** next to the tabs adds a team, and right-clicking a tab edits it. A team file carries your bots and their teams: find it in **Settings → Plugins**, under **Bots** in the paseo-bots menu.

Whether a bot may ask others for help is set in its settings under **Permissions → Contact other bots**: **Ask first**, **Allowed** or **Off**.

### Skills & Tools

Press **Skills & Tools** at the bottom of the bot list.

- **Skills**: press **+** to import skills from a folder on this computer (the full path; every `SKILL.md` under it comes in, up to 30) or write a new one. Open an imported skill and press **Review** to turn it on. **Update** on a skill reads its folder again.
- **MCP servers**: press **+**, then **New server**, or **Import config** to pick up the servers set up in Claude Code, Claude Desktop or Cursor. Press **Test and turn on** on the server's page; a remote server has no test and is turned on with its switch.

Then give them to a bot in its settings: skills under **Skills**, MCP servers under **Access**.

### Learning

After a task, send `/learn` in the chat, or `/learn <what to focus on>`. The bot writes up what worked as a skill and shows it as a card; press **Save skill** to add it to Skills & Tools and turn it on for that bot.

### Paseo tools

Bots get Paseo's own tools, so you can ask one in a chat to start other agents, open workspaces and terminals, set up schedules or use the browser. A bot's **Access** settings show whether they're on, and **Turn on** there switches them on for every agent on the host.

## Building the offline package

```bash
npm ci --ignore-scripts
npm run typecheck && npm test
node scripts/pack-offline.mjs --out ../paseo-bots-offline
```

The package is a zip of the plugin's source files only (the daemon compiles them when the plugin starts). It has no runtime dependencies, so installing it needs no npm and no internet.

`tests/offline.test.ts` scans the whole source for network code (`fetch`, sockets, WebSocket, a remote address in code, an image loaded from an address) and fails if it finds any outside the one MCP probe, which refuses everything but this computer (remote MCP servers are the agent's to connect to). Run it after every change.

## Staying close to upstream

`upstream` is the original repository. Merge it into the `offline` branch from time to time; the removed features will conflict, and the test above will tell you if a merge brings network code back.

## License

MIT, as upstream. See `LICENSE`.
