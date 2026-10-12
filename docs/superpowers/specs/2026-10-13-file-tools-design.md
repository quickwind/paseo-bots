# Bot tools without MCP: files in the bot's folder

Status: draft for review. Nothing here is built yet.

## Problem

Everything a bot can *do from a chat* (read the setup, propose changes, routines and skills, search
its past chats, ask another bot) is offered as tools of an MCP server the plugin adds to each chat
(`server/relay.ts:102`, `shared/bot.ts:613`). The company does not allow MCP in Devin and the rule
cannot be worked around, so on Devin all eight tools are missing, silently. Everything done from
the app's screens (settings, routines, memory upkeep, teams, skills) does not use MCP and is
unaffected.

## Idea

A Devin chat can always read and write files in the bot's folder, and the plugin already uses that
channel to give Devin the bot's identity (`.devin/rules/bot-identity.md`, verified with real Devin).
Replace each tool with a file convention:

| Tool | Replacement |
|---|---|
| `get_setup`, `list_bots` | The plugin keeps `setup/` up to date; the bot reads it |
| `propose_changes`, `propose_routine`, `propose_skill` | The bot writes a JSON file to `proposals/`; the plugin validates it and puts the same confirmation card in the chat |
| `ask_bot`, `check_chat` | The bot writes a JSON file to `outbox/`; the plugin asks the other bot and sends the answer back into the asking chat |
| `search_chats` | The plugin keeps `history/` (one transcript per chat); the bot searches it with its own file tools |

Nothing about safety changes: proposals still wait for the user's click, asking another bot still
needs the user's approval unless the bot is set to "Allowed", and the plugin validates every file
with the schemas the tools use today.

## Scope

In: the five behaviours above, a setting for when to use files, the prompt text for them, and a
card the plugin can post. Out: changing how Claude works (it keeps MCP), anything in the Wukong
repository, a bot-to-bot "room".

## Design

### 1. When files replace tools ("tool mode")

A plugin setting **Bot tools**: `Automatic` (default), `Files for every provider`, `MCP for every
provider`. Automatic means files for Devin, MCP for every other provider (`filesFor(provider)` in
`shared/tools-mode.ts`). In files mode the chat does not get the `bots` MCP server at all (no
`mountTools`), and the system prompt (the Devin rules file, or the first message block) describes
the files instead of `botToolsPrompt` (`shared/bot-tools.ts:33`).

### 2. Where the files are

All under the bot's own folder `botDataPath(bot.id)`:

```
setup/overview.md        bots (name, role, provider, contact setting), teams, library skills and
                         MCP servers, new-bot defaults, presets, providers with models and modes
setup/bots/<id>.md       one bot in full: instructions, playbooks, routines, skills, memory limits
proposals/*.json         written by the bot
proposals/done/          the plugin moves each processed file here with <name>.result.txt beside it
outbox/*.json            written by the bot (asking another bot)
outbox/done/             as above
history/*.md             one transcript per chat of this bot, newest 40
```

The prompt gives absolute paths, because a bot with its own working folder (`bot.cwd`) runs
somewhere else and must still reach its home. (Devin may ask to approve writes outside its working
folder; those bots work, with prompts. See Risks.)

### 3. Read-only snapshots (`setup/`, `history/`)

- `setup/` is rendered from the same code as `get_setup` (`shared/changes.ts` `setupOverview`,
  `botDetails`) and rewritten whenever the identity is (settings change, start, after a turn, before a
  chat starts), under the same per-bot lock (`server/identity.ts`).
- `history/` is written for a chat when its turn ends: the user and assistant messages only (not tool
  calls), secrets redacted (`redactSecrets`), at most 200 messages per chat, the newest 40 chats, 2 MB
  per bot. File name `YYYY-MM-DD-<title slug>-<chat id 8>.md`. The bot's daily log and memory are
  already files, so searching all of them is one file search.

### 4. Proposals (`proposals/*.json`)

The bot writes one file per proposal, using the arguments of the tool it replaces:

```json
{ "kind": "changes", "summary": "Set up Scout", "changes": [ { "type": "update_bot", "bot": "Scout", "instructions": "..." } ] }
{ "kind": "routine", "name": "Morning check", "instructions": "...", "schedule": { "type": "daily", "time": "08:30" } }
{ "kind": "skill", "name": "weekly-report", "description": "...", "instructions": "..." }
```

When a chat's turn ends (`agent.turn_ended`, already hooked in `server/activity.ts`) the plugin scans
the bot's `proposals/` and `outbox/`:

1. **Which files belong to this chat: the ones this turn wrote.** The event carries the turn's tool
   calls (`timeline`, as `lastTurn` already reads it). A file belongs to the chat if a call in it wrote
   that file: a `write` or `edit` call whose `filePath` names the file, or a `shell` call whose command
   names it. Devin's `filePath` is the tool title ("Wrote ./proposals/x.json"), so the match is on the
   file's unique base name inside that string (see the spike results). This is
   evidence from the chat itself, so two chats of one bot never take each other's files. The prompt asks
   for a unique file name (a time and a short random suffix) so two chats never write the same path.
2. A file with no evidence in this turn is left alone: it may belong to a chat whose turn has not ended.
   Such a file older than 10 minutes with no evidence anywhere is handed to the bot's chat that ended a
   turn most recently before the file was written, and the plugin logs that it guessed. This is the only
   guess, and only for a tool call the plugin could not read.
3. At most 20 files per scan; each at most 256 KB; names must match `^[\w.-]+\.json$`.
4. Parse and validate with the schemas the tools already export (`ChangesSchema`,
   `ScheduleInput`, the skill input). For changes, run the existing dry run (`applyChanges`).
5. Success: `createProposal` (`server/proposals.ts`), post the card in the chat (section 5), move the
   file to `done/`, write `<name>.result.txt` ("Proposal p-xxxx: the user sees ... as a card").
6. Failure: move the file to `done/`, write the error to `<name>.result.txt`, and send one message
   into the chat ("[Bots] Your proposal <name> was not accepted: <error>. Fix it and write it again.")
   so the bot sees it without being asked. The message is sent when the chat is idle, the same way
   the memory save is (`server/activity.ts` `askToSave`, verified from a hook).

The prompt says to write the file as the last step of a turn.

### 5. The card for a file proposal

Today `proposalIdOf` (`shared/proposals.ts`) finds the proposal from a finished tool call's output.
A file has no tool call, so the plugin appends a plugin timeline item (the way routine results are
posted, `server/scheduler.ts:242`): `{ type: "plugin", id: <proposal id>, kind: "proposal", version: 1,
data: { proposalId } }`. `client/chat/stream/model.ts:203` (which already maps the routine-result
item) maps it to a row that renders the existing `ProposalCard`. Accepting or dismissing is unchanged.

### 6. Asking another bot (`outbox/*.json`)

```json
{ "kind": "ask", "to": "Scout", "message": "How many unread mails? Write it so it works without this chat." }
```

On scan:

1. Refuse (result file and message into the chat) when: the bot's contact setting is "off"; the chat
   was itself started by another bot (`ASKED_BY_LABEL`, the existing loop guard, `server/tools/bots.ts:73`);
   the target is not a bot on this host.
2. Setting "ask": create a proposal of a new kind `ask` (`{ toBotId, message }`) and post its card:
   "Scout wants to ask Inbox: ...", Approve / Dismiss. "Allowed": go straight to step 3.
3. Run: `startChat` for the target with `askPrompt` and the label `ASKED_BY_LABEL` (as `ask_bot` does,
   `server/tools/bots.ts:93`), and record `{ requestId, fromChat, toChat }` in `requests.json` in the
   plugin's data folder.
4. When the target chat's turn ends (`turnEnded`, label present), take its reply (`lastTurn`) and send it
   into the asking chat: "[Reply from Scout to your request <id>] ...", framed as information from
   another bot, not an instruction (`askPrompt`'s wording). If the asking chat is busy, keep the
   delivery and try after its next turn. A request unanswered for 30 minutes is closed with a message
   saying so.

There is no `check_chat`: answers are pushed. The asking bot is told to end its turn after writing
the file ("you will get the answer as a message here").

### 7. Prompt for files mode

`botFilesPrompt(bot, home)` replaces `botToolsPrompt`: where the setup and history files are, the three
proposal shapes and the ask shape (the schemas the bot needs are in `setup/overview.md`, which also
lists valid provider, model and mode ids), write one file per proposal, write it as the last step of a
turn, read `<name>.result.txt` when told a proposal was not accepted. For the setup interview the
default prompt (`shared/setup.ts`) says "write a proposals file" instead of "call propose_changes" in
files mode.

## Settings and data

- Plugin setting `toolMode: "auto" | "files" | "mcp"` (optional, default `auto`) in `botSettings`.
- `requests.json` (ask requests) in the plugin data folder; proposals keep their file.
- New proposal kind `ask` in `shared/proposals.ts` (`ProposalSchema`).

## Risks and open points

- **Attribution** rests on the turn's tool calls naming the file. Verified in code for ACP edits; **not
  yet verified against a real Devin run** (spike 1 below). A file written some way the plugin cannot read
  falls back to the 10-minute guess in section 4.
- **Bots with their own working folder** write outside their working folder; Devin may prompt for
  approval each time. Not verified.
- **Latency**: a card appears when the turn ends, not in the middle of it.
- **Devin follows instructions imperfectly**: a malformed file is reported back and the bot retries;
  the prompt shows an example of each shape.
- **Size**: `setup/` grows with the number of bots; the overview lists names and roles only, details
  are per bot.
- **Untrusted text**: transcripts and other bots' replies are data; both are framed as such, and
  nothing in `history/` or a reply can approve anything.

## Spikes before building

1. With real Devin (a few short messages): ask it to create `proposals/x.json` with its file tool, and
   again with a shell command; read the `agent.turn_ended` timeline. Does the call come as `write` or
   `edit` with a usable `filePath` (absolute?), and as `shell` with the command?
2. Can Devin write a file outside its working folder (a bot with `bot.cwd`), and does it ask?
3. Does a message the plugin sends into an idle Devin chat start a new turn (the memory save was
   verified on Claude only)?

## Testing

Unit: file validation and result files per kind, size and name limits, attribution by tool call (write,
edit, shell, relative and absolute paths, two chats at once, no evidence), the `ask`
lifecycle (refused, approved, answered, busy asker, timeout), transcript writer limits and redaction,
`setup/` rendering equals `get_setup`, tool-mode choice, the card timeline item round trip. Live (real
Devin, few short messages): the setup interview ends with a card; a routine proposal; one bot asks
another and the answer arrives; a search of history. Claude regression: chat still gets the MCP tools
and no files prompt.

## Phases

1. Tool mode, `setup/`, `proposals/`, the card, the prompt: setup interview, routines and skills work
   on Devin.
2. `history/` (search) and `outbox/` (asking another bot).

## Spike results (2026-10-13, real Devin 3000.11.3 through Wukong, isolated instance)

Six Devin turns in total (swe-1-6-slow).

1. **File tool write.** The turn's tool call is `{ type: "edit", filePath: "Wrote ./proposals/a1.json",
   newString: "{}" }`. The `filePath` is the tool's *title* ("Wrote " plus the path, relative to the
   working folder), not a clean path, because Devin sends no `locations`. Attribution therefore matches
   the file's **unique base name** inside the written string (after dropping a leading verb such as
   "Wrote"/"Edited"), and compares full paths only when the string is a clean path. File names must be
   unique per chat (the prompt asks for a time and a random suffix).
2. **Shell write.** `{ type: "shell", command: "echo {} > proposals/a2.json" }`: the command contains the
   path, so the same base-name match works.
3. **Approvals.** In Devin's default mode (`accept-edits`, "Code") a write **inside** the working folder
   is not asked about; a write **outside** it (an absolute path to another folder) leaves a pending
   `edit` permission. So a bot with its own working folder (`bot.cwd`) needs the user's approval for every
   proposal file unless it runs in `bypass`. Devin's modes are `accept-edits`, `smart`, `ask`, `plan`,
   `bypass`; the tidy chat's mode choice (`editApprovingMode`) already matches `accept-edits`.
4. **Send into an idle chat.** `agents.ref(id).send(...)` from the `agent.turn_ended` hook started a new
   turn in an idle Devin chat and Devin answered. Replies pushed into a chat (errors, answers from
   another bot) work on Devin.

Design consequences: attribution by base name (section 4 updated), and bots with their own working
folder are documented as needing approval for the files.
