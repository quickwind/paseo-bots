<p align="center">
  <img src="docs/bots.svg" width="512" alt="Six pixel-art assistants">
</p>

# Aydo

Aydo: personal assistants for [Paseo](https://paseo.sh): give each assistant instructions, a model, memory, skills and tools, then chat with it in its own workspace or let it run routines.

Aydo is based on [oliexe/paseo-bots](https://github.com/oliexe/paseo-bots) 0.2.0 (MIT, by Ondrej Rehacek) for machines that must not send data to cloud services. **The plugin makes no network connections of its own.** Everything that needed one is gone, and a test keeps it that way.

## What is different

| Upstream feature | Aydo |
| --- | --- |
| Connected apps through Composio (Gmail, Slack, Notion, 1,000+ more) | Removed, with its relay proxy, API key, sign-in cards and the roles built on it (Inbox, Watch, Ops) |
| Avatar pictures drawn by OpenAI | Removed; pixel-art faces, and pictures you upload |
| Pictures from an image address | Removed; a picture is kept only as an uploaded `data:` image |
| Importing skills from GitHub or a link | Imports from **a folder on this computer** instead |
| Testing MCP servers at a remote address (HTTP, SSE) | The plugin only tests programs and `http://localhost` addresses. A remote server (for example one on a private network) is imported and can be turned on without a test; the assistant's agent is the one that connects to it |
| GitHub link on the start screen | Removed |

Everything else is unchanged: assistants, memory, routines and webhooks, teams, the skill and MCP library, `/learn`, Paseo's own tools for assistants, and sharing assistants and teams as files.

## What this does not control

- **The assistants' own agents.** An assistant runs on a provider (Claude Code, for instance) that talks to its own service. That is the provider's traffic, not the plugin's.
- **MCP servers.** The agent connects to the servers you give an assistant, remote ones included; the plugin never does. A server may itself reach the internet. Add only servers you trust.
- **Links in a chat.** A link in an assistant's reply opens in your browser only when you press it.
- **The plugin runs unsandboxed**, like every Paseo plugin. Read the code before installing it.

## Screenshots

| | |
| --- | --- |
| **Assistants** | **Assistant settings** |
| ![Aydo](docs/splash.png) | ![Assistant settings](docs/bot.png) |
| **Skills** | **MCP servers** |
| ![Skills](docs/skills.png) | ![MCP servers](docs/mcp.png) |
| **Teams** | |
| ![Teams](docs/teams.png) | |

## Install

Get the plugin folder onto the machine (the package unzips into one), then install it from that folder.

``bash
paseo plugin install /path/to/aydo
``

Turn on **Settings → Plugins → Enable plugins** first. Requires Paseo 0.13 or later. Aydo shows in English and Chinese (zh-CN), following the Paseo language setting. Plugins install from a local folder, which is what this edition is for.

## Usage

### Assistants

1. Open **Aydo** in Paseo's sidebar and press **New assistant**. Start blank, from a role, from one of your presets, or paste an assistant or team file under **Import**.
2. Chat with it. Every chat is a thread in the assistant's workspace; **Open in Paseo** in a chat's menu shows it in Paseo's own view. On hosts that offer an embedded chat (`ui.AgentView`), an open chat is the host's own chat view inside the Assistants page, so the model, mode and thinking pickers, slash commands and other plugins' cards work there too; the first message of a new chat is still typed in the plugin's own box, because it builds the assistant's system prompt. On Paseo without it, the plugin's own chat window is used.
3. Open its settings with the panel button at the top right of a chat, or **Open assistant settings** in the assistant's menu. **Identity** holds the name, avatar and voice, **Soul** its standing instructions, **Model** the provider and model, and **Permissions** the approval mode.

Assistants can do the setting up too. Ask one in a chat, for example "Create a research team of three assistants with Scout as Chief of Staff", and it shows every change on one card; **Apply changes** makes them. An assistant can create, edit and delete assistants, teams, routines, library skills and MCP servers, and change what new assistants start with. Each assistant's earlier settings stay under **History** in its settings.

**Devin.** Devin has no system prompt, so the plugin writes each assistant's identity (name, standing instructions, memory, skills, team) to `.devin/rules/bot-identity.md` in the assistant's own folder, as an always-on rule that Devin reads when a chat starts. It is rewritten when the settings or the memory change and before each chat, so both a chat started in Assistants and a plain new chat in the assistant's workspace know who the assistant is. The file is generated: edit the assistant's settings, not the file. Over 32 KB it is split into several files, and the assistant's Overview says so. An assistant with its own working folder gets nothing written there; its Devin chats carry the identity in the first message instead. Its tools are files too; see **Assistant tools without MCP** below.

**Assistant tools without MCP.** The plugin's tools (reading the setup, proposing changes, routines and skills, asking another assistant, searching past chats) normally come to an assistant as an MCP server. Where MCP is not allowed (Devin here), they come as files in the assistant's own folder instead. Settings > Plugins > Aydo > **Default: tools come as** sets the default for every assistant, MCP or files; an assistant can choose its own under **Agent > Tools come as**. An assistant on Devin or Antigravity starts with its own choice, files.

- `setup/` describes the assistants and the setup, and the format of the proposal files; it is kept current by the plugin.
- `proposals/`: the assistant writes one JSON file (`changes`, `routine` or `skill`) as the last step of a turn; when the turn ends the plugin checks it and posts the same confirmation card as the tool would. A file that is not accepted is reported back to the assistant, with the reason in `proposals/done/`.
- `outbox/`: the assistant writes an `ask` file to ask another assistant. With "Ask first" the user approves a card; the other assistant answers in a chat of its own and the answer arrives in the asking chat as a message. A chat started by another assistant cannot ask further. A question unanswered for 30 minutes is closed. A follow-up to the same assistant from the same chat goes into the chat that assistant already has with it (an hour of quiet starts a new one); if that chat is still on the last question, the follow-up waits its turn. `ask_bot` does the same.
- `history/`: a transcript of each recent chat, for the assistant to search with its own file tools.

A file belongs to the chat whose turn wrote it (the turn's tool calls name the file), so two chats of one assistant do not take each other's files. An assistant with its own working folder writes into its home folder, which Devin may ask to approve. A plain new chat in an assistant's folder counts as that assistant's chat.

**Set up with the assistant.** An assistant made with **Blank assistant** opens with a short interview: it asks about what you want from it, how you work and what it must never do, then suggests three names (the last question), proposes its name, title, description and instructions on one card and writes a starting `MEMORY.md` once you confirm. After you press **Apply changes** the card says which model the assistant uses and how memory tidy is set, and where to change them. Every proposal card says what happened after you press a button, and shows why on the card when it did not work. It does not change its provider, model or approval mode; you set those under **Model** and **Permissions**. You can start the interview again from **Overview > Set up with the assistant**. Under Settings > Plugins > Aydo, **Set up with the assistant** holds the prompt (leave it empty for the built-in one; name a skill in it to have the assistant use it, if the skill is on for that assistant) and a switch to stop blank assistants from starting it by themselves. Assistants made from a role or preset never start it by themselves.

### Memory

An assistant updates its `MEMORY.md` when it learns something worth keeping, for example when you say "Remember that I prefer short answers". New chats start with it.

In the assistant's settings, **Memory** shows `MEMORY.md` and its topic files, which you can edit, a **Daily log** of its chats, and **Changes**, where **Undo** puts a file back the way it was.

**Maintenance.** Under **Memory > Maintenance** two switches keep memory useful as it grows (on for new assistants, off for existing ones):

- **Save notes when a chat fills up.** When a chat passes the chosen share of its context window, the app asks it, once, to write what is worth keeping to `memory/inbox.md`. You see that message and a one-line reply in the chat. A provider that does not report context use is never asked.
- **Tidy memory automatically.** On an interval (it also runs after a laptop wakes), the app starts a "Memory tidy" chat that moves what is durable from the inbox and the daily log into `MEMORY.md`, merges duplicates, drops what is out of date and empties the inbox. It skips when there is nothing new, waits while you are chatting with the assistant, runs at most six times a day, and backs off for a day if memory stays over budget. **Tidy now** runs it at once. The model is Paseo's Metadata generation setting by default, or the assistant's own. New Devin assistants start with tidy off, because every run spends your Devin quota.

Every change shows under **Changes** with undo.

### Routines

1. In the assistant's settings, open **Routines** and press **New routine**.
2. Give it a name and a prompt. The prompt is the first message of each run.
3. Pick when it repeats: a preset such as **Weekdays 9:00** or your own cron expression, **Once**, or **When its webhook is called**.
4. To collect results in one place, pick a chat under **Post results to**. Each run still gets its own chat.

Assistants can propose routines too: ask in a chat, then press **Create routine** on the card. A webhook routine's URL is under **Copy webhook URL** in its menu; `POST` to it from this computer.

### Teams

1. Press **Team map** at the bottom of the assistant list, then **New team**.
2. Name the team, switch on its members, pick a **Lead** as its Chief of Staff, and add shared instructions for every member. The team gets a pixel-art logo; **Reroll** draws another, or use your own picture.
3. Send your requests to the Chief of Staff. It hands parts of the work to its teammates.

With teams, the Aydo screen gets a tab for each team, and **Other assistants** for assistants without one (a menu on phones); **+** next to the tabs adds a team, and right-clicking a tab edits it. A team can let its members ask each other without you approving every question (off by default; an assistant set to never contact others still may not), and its Chief of Staff can ask several teammates at once. A team file carries your assistants and their teams: find it in **Settings → Plugins**, under **Assistants** in the paseo-bots menu.

Whether an assistant may ask others for help is set in its settings under **Permissions → Contact other assistants**: **Ask first**, **Allowed** or **Off**.

### Skills & Tools

Press **Skills & Tools** at the bottom of the assistant list.

- **Skills**: press **+** to import skills from a folder on this computer (the full path; every `SKILL.md` under it comes in, up to 30) or write a new one. Open an imported skill and press **Review** to turn it on. **Update** on a skill reads its folder again.
- **MCP servers**: press **+**, then **New server**, or **Import config** to pick up the servers set up in Claude Code, Claude Desktop or Cursor. Press **Test and turn on** on the server's page; a remote server has no test and is turned on with its switch.

Then give them to an assistant in its settings: skills under **Skills**, MCP servers under **Access**.

### Learning

After a task, send `/learn` in the chat, or `/learn <what to focus on>`. The assistant writes up what worked as a skill and shows it as a card; press **Save skill** to add it to Skills & Tools and turn it on for that assistant.

### Paseo tools

Assistants get Paseo's own tools, so you can ask one in a chat to start other agents, open workspaces and terminals, set up schedules or use the browser. An assistant's **Access** settings show whether they're on, and **Turn on** there switches them on for every agent on the host.

## Building the package

``bash
npm ci --ignore-scripts
npm run typecheck && npm test
node scripts/pack.mjs --out ../aydo-dist
``

The package is a zip of the plugin's source files only (the daemon compiles them when the plugin starts). It has no runtime dependencies, so installing it needs no npm and no internet.

`tests/no-network.test.ts` scans the whole source for network code (`fetch`, sockets, WebSocket, a remote address in code, an image loaded from an address) and fails if it finds any outside the one MCP probe, which refuses everything but this computer (remote MCP servers are the agent's to connect to). Run it after every change.

## Staying close to upstream

`upstream` is the original repository. Merge it from time to time; the removed features will conflict, and the test above will tell you if a merge brings network code back.

## License

MIT, as upstream. See `LICENSE`. Parts are adapted from OpenMausBot (Apache-2.0) and the design follows it; see `NOTICE` and `licenses/`.
