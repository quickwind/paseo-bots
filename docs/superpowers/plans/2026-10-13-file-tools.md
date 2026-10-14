# Bot tools as files: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give bots on providers without MCP (Devin) the plugin's tools through files in the bot's folder: setup snapshots, proposals, asking other bots, chat history.

**Architecture:** The plugin keeps read-only snapshots (`setup/`, `history/`) next to the identity rules file, and scans `proposals/` and `outbox/` when a chat's turn ends. A file is attributed to the chat whose turn's tool calls wrote it. Valid files are run through the existing tool implementations (`proposeChanges.run` and friends), so validation, dry runs and cards are reused. The card is posted as a plugin timeline item.

**Tech Stack:** TypeScript, zod, vitest, the Paseo plugin SDK.

**Spec:** `docs/superpowers/specs/2026-10-13-file-tools-design.md`

## Global Constraints

- Offline: no new network code; `tests/offline.test.ts` stays green; `npx tsc --noEmit` clean.
- Claude keeps MCP in `Automatic`; nothing about Claude chats changes.
- Nothing is written into a bot's own working folder (`bot.cwd`); all files live under `botDataPath(bot.id)`.
- Proposals still need the user's click; asking another bot still needs approval unless the bot is "Allowed"; the loop guard (`ASKED_BY_LABEL`) and the tidy exclusion (`TIDY_LABEL`) stay.
- Limits: 20 files per scan, 256 KB per file, names `^[\w.-]+\.json$`; history: 200 messages per chat, newest 40 chats, 2 MB per bot; ask requests close after 30 minutes.
- Do not touch the Irix repository. Real Devin use is limited (personal free subscription, one model): a few short messages, and `devin rules list` where it is enough.
- Test instances: own `IRIX_HOME` (`/tmp/irix-files`), port 6897. Never touch 6767 or 6899; stop only with `irix daemon stop` and your own `IRIX_HOME`; never `pkill` by name; never read Devin's credentials.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A file written by chat A is never taken by chat B of the same bot, including both ending turns together.
- A malformed, oversized or badly named file never crashes the scan and is reported back to the bot.
- The loop guard: a chat started by another bot cannot ask a third bot through `outbox/`.
- An ask in "ask" mode runs nothing before the user approves; dismissing it tells the asking chat.
- A Claude bot in `Automatic` still gets the MCP server and no files prompt; a Devin bot gets no MCP server.

---

### Task 0: Spikes with real Devin

**Files:** none kept; results go into the spec ("Spike results").

- [ ] **Step 1:** Start an isolated instance (`IRIX_HOME=/tmp/irix-files`, port 6897, plugin installed from this folder), create a bot on Devin with a temporary logging line in the `agent.turn_ended` handler that appends the turn's tool-call items (`name`, `detail`) to `/tmp/files-spike.ndjson` (do not commit it).
- [ ] **Step 2:** One short Devin message: "Create the file proposals/a1.json containing {} using your file tool." Read the log: expect a `write` or `edit` call with `detail.filePath` (absolute?). Record the exact shape.
- [ ] **Step 3:** One short Devin message asking for the same with a shell command (`echo {} > proposals/a2.json`). Record whether a `shell` call with `detail.command` appears and whether Devin asks for approval.
- [ ] **Step 4:** With the bot's working folder set to another folder (`bot.cwd`), one message asking it to write to the bot's home by absolute path. Record whether it asks for approval.
- [ ] **Step 5:** From the same handler, `agents.ref(id).send("[spike] reply ok")` once while the Devin chat is idle; record whether a new turn starts.
- [ ] **Step 6:** Revert the logging, stop the instance (`irix daemon stop` with the same `IRIX_HOME`), remove `/tmp/irix-files`; add the results to the spec; commit. If step 2 shows no usable `filePath`, stop and revise the attribution design before Task 3.

### Task 1: Tool mode

**Files:** create `shared/tools-mode.ts`; modify `shared/bot.ts` (settings, `PromptContext`, `promptSections`, `botSettings.schema`), `shared/bot-tools.ts` (`botFilesPrompt` import point), `server/chats.ts`, `client/BotsSurface.tsx` (skip `mountServers`), `server/prompt.ts`, `client/settings/BotsSettings.tsx`; test `tests/tools-mode.test.ts`.

**Interfaces:** Produces `type ToolMode = "auto" | "files" | "mcp"`; `ToolModeSchema`; `usesFiles(mode: ToolMode | undefined, provider: string): boolean` (auto: `/^devin(\b|$)/`); setting `toolMode` (optional) in the settings schema; `PromptContext.botFiles?: { home: string } | null`.

- [ ] Write failing tests: `usesFiles(undefined,"devin")` true, `("auto","claude")` false, `("files","claude")` true, `("mcp","devin")` false; settings parse without `toolMode`; a Devin bot in auto mode: `buildAgentConfig` given no `plugin.tools` has no `bots` server; the system prompt of a files-mode bot contains the files section and not "MCP server \"bots\"".
- [ ] Run, see them fail; implement (prompt section is added in Task 5: here the section may be a stub returning the heading only, replaced in Task 5).
- [ ] Wire: `server/chats.ts` and `client/BotsSurface.tsx` skip `relay.mountTools`/`mountServers` when `usesFiles`; settings page gets a **Bot tools** select with a hint.
- [ ] Run the suite, commit.

### Task 2: Snapshots (`setup/`)

**Files:** create `server/setup-files.ts`; modify `server/identity.ts` (call it from `writeIdentity`'s lock), `index.server.ts` if needed; test `tests/setup-files.test.ts`.

**Interfaces:** Produces `renderSetupFiles(host, bot): Promise<{ path: string; text: string }[]>` — `setup/overview.md` from `setupOverview(values, providers)` and `setup/bots/<id>.md` per bot from `botDetails`; `writeSetupFiles(host, bot)` (atomic, removes stale bot files, only for bots in files mode).

- [ ] Tests: overview lists bots, teams, skills, providers with model and mode ids; one file per bot with its instructions; a bot in MCP mode gets none; stale `setup/bots/<gone>.md` is removed; writing twice leaves no temp files.
- [ ] Implement with `setupOverview`/`botDetails` from `shared/changes.ts` and `providerInfo` from the provider snapshot; refresh at the same moments as the identity (settings change, start, turn end, before a chat).
- [ ] Commit.

### Task 3: Proposal files

**Files:** create `shared/file-tools.ts` (pure: `writtenPaths`, `fileBelongsToTurn`, `parseToolFile`, limits), `server/file-tools.ts` (`scanToolFiles`); modify `server/tools/skills.ts` (export input schema); tests `tests/file-tools.test.ts`.

**Interfaces:**
- `writtenPaths(timeline, cwd): { files: string[]; commands: string[] }` — from `tool_call` items with `detail.type` `write`/`edit` (`filePath`) and `shell` (`command`).
- `fileBelongsToTurn(path, written, cwd): boolean` — absolute or relative path equality via `samePath`; or a shell command containing the path or its base name.
- `parseToolFile(text): { kind: "changes" | "routine" | "skill" | "ask"; args: unknown } | { error: string }`.
- `scanToolFiles(input: { host; relay; bot; agentId; cwd; turnTimeline; now }): Promise<{ done: ScanResult[] }>` where `ScanResult = { name; kind; ok: boolean; text: string; proposalId: string | null }`.

- [ ] Tests (pure): write/edit absolute, relative to cwd, shell `echo > proposals/x.json`, two chats' timelines (only the writer matches), no evidence → not claimed; `parseToolFile` for each kind, bad JSON, unknown kind, oversized, wrong name.
- [ ] Tests (scan, temp bot folder, fake host): valid changes file → proposal created through `proposeChanges.run`, file moved to `done/`, `<name>.result.txt` holds the reply and `proposalId` is set; invalid changes (unknown bot) → result file has the dry-run error, `ok` false; 25 files → only 20 processed; file with no evidence untouched; a file older than 10 minutes with no evidence is handed back to the caller as `unclaimed` (Task 4 decides the guess).
- [ ] Implement by reusing `proposeChanges.run`, `proposeRoutine.run`, `proposeSkill.run` with `{ bot, agentId, host, relay }`; commit.

### Task 4: The card and the loop in `turnEnded`

**Files:** modify `shared/rpc.ts` (`PROPOSAL_CARD = { kind: "proposal", version: 1 }`, schema), `client/chat/stream/model.ts`, `index.client.tsx` (register the card), `server/activity.ts`, `index.server.ts`; tests `tests/file-tools.test.ts`, `tests/stream.test.ts`.

- [ ] Tests: a plugin timeline item `{kind:"proposal", data:{proposalId}}` becomes the same row a finished `propose_changes` call gives; `turnEnded` for a files-mode bot scans, posts one card per proposal, and sends one message into the chat for a failed file (and none for success); an MCP-mode bot never scans; a tidy or routine chat never scans.
- [ ] Implement: card append via `agents.ref(id).timeline.append({ type: "plugin", id: proposalId, ...PROPOSAL_CARD, data })` (idempotent id); error message via `agents.ref(id).send` when idle, otherwise kept and sent after the chat's next turn; the 10-minute guess for `unclaimed` files (log it).
- [ ] Commit.

### Task 5: Prompts for files mode

**Files:** modify `shared/bot-tools.ts` (`botFilesPrompt(bot, home)`), `shared/bot.ts`, `shared/setup.ts`; tests `tests/identity.test.ts`, `tests/setup.test.ts`.

- [ ] Tests: the prompt names `home/setup/overview.md`, `home/proposals/`, `home/outbox/`, `home/history/` as absolute paths, shows one example per proposal kind and the ask shape, asks for a unique file name and to write the file as a turn's last step; it does not mention MCP tools; `setupPromptText` in files mode says to write a proposals file instead of calling `propose_changes`; the identity rules file of a Devin bot contains it.
- [ ] Implement; commit.

### Task 6: History (search)

**Files:** create `server/history-files.ts`; modify `server/activity.ts`; test `tests/history-files.test.ts`.

- [ ] Tests: a chat becomes `history/<date>-<slug>-<id8>.md` with user and assistant messages only; secrets redacted; 200-message cap; only the newest 40 chats and 2 MB kept (oldest removed); another bot's chat never appears; MCP-mode bots get none.
- [ ] Implement with `timeline.refetch` like `search_chats` (`server/tools/chats.ts`), written on turn end under the bot lock; commit.

### Task 7: Asking another bot

**Files:** modify `shared/proposals.ts` (kind `ask`), `server/proposals.ts` if needed, create `server/asks.ts`; modify `server/file-tools.ts`, `server/activity.ts`, `client/chat/stream/ProposalCard.tsx`, `shared/rpc.ts`; tests `tests/asks.test.ts`.

**Interfaces:** `startAsk(host, relay, from: { bot; agentId }, args: { to; message }): Promise<{ requestId }>`; `requests.json` records `{ id, fromBot, fromChat, toBot, toChat, createdAt, delivered }`; `onAskTurnEnded(host, event)` delivers the reply.

- [ ] Tests: refused (contact off, asked chat is itself an ask chat, unknown or archived target, asking itself); "allowed" runs at once and records the request; "ask" creates an `ask` proposal and runs nothing until accepted; dismissing sends the asker a message; the target's turn end sends the reply into the asking chat framed as another bot's information; asker busy → delivered after its next turn; request older than 30 minutes closed with a message; the target chat cannot ask further.
- [ ] Implement using `askPrompt`, `startChat` (labels `ASKED_BY_LABEL`), `lastTurn`; the card shows "<Bot> wants to ask <Bot>" with Approve/Dismiss; commit.

### Task 8: Docs, live check, package

- [ ] README section "Bot tools without MCP"; mention in the Devin paragraph.
- [ ] Live with real Devin (a few short messages, isolated instance): the setup interview ends with a changes card; a routine proposal card; one bot asks another and the answer arrives in the asking chat; a search finds a past chat in `history/`. Claude regression: a Claude bot still lists the `bots` tools.
- [ ] `npx tsc --noEmit && npm test`; bump to `0.2.0-offline.9`; `npm run pack:offline -- --out ~/irix-dist` replacing offline.8; do not edit the Irix repo.
- [ ] Final whole-branch review, one fix pass, update my MEMORY.md, report.
