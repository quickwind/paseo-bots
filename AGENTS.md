# AGENTS.md: decisions and working rules for this repo

This is a fork of `oliexe/paseo-bots` (MIT), a Paseo plugin called Aydo, built for deployments with restrictions (for example no
outbound network access, or limits on which tools a provider may use). Any provider the host offers can be used (the list comes from the host). Claude Code and Devin are the ones tested for real; Codex,
OpenCode and Antigravity have their own handling in places (tool grants, attached folders, files mode); every other provider gets the generic behaviour.
Read this before changing anything; each decision says why, so you can tell when it no longer holds.
This file holds the decisions and their reasons. Longer design documents, one per area, are in `docs/specs/` (memory maintenance, files mode of the tools,
project workspaces, approvals, languages); the sections below name the one that goes with them.

## Where things are

- Remotes: `origin` = `quickwind/paseo-bots` (our public fork), `upstream` = `oliexe/paseo-bots`.
- Branches: `aydo` is the main line (it tracks `origin/aydo`). Every change is made on a short-lived feature branch off `aydo` and merged back
  into `aydo` when it is done (`--no-ff`); do not commit to `aydo` directly. `bot-crew` (an earlier stable line), `feature/project-workspaces`
  (the line `aydo` was squashed from) and `main` (reset to `upstream/main` on purpose, so it is upstream's code without our changes) are not
  worked on any more: do not commit to or merge into them unless the user says so. Nothing is pushed unless the user asks.
- Releases: the user says when to release; then, and only then, bump the version in `package.json`, `package-lock.json` (two places) and
  `shared/version.ts` (plain semver). Do not bump it with each change and do not build zips: another session publishes the package
  (`paseo-aydo`). `npm run pack -- --out <dir>` still makes `aydo-<version>.zip`, if one is asked for.
- Tests: `npx tsc --noEmit && npm test` (includes `tests/no-network.test.ts`).

## Decisions

### No network, restricted deployments

- The plugin makes no network connections of its own, for deployments where outbound network access is restricted. `tests/no-network.test.ts` scans the source for
  network code (calls, imports of network modules, run-time module names, download tools, runtime dependencies)
  and must stay green. Removed: Composio connected apps, OpenAI avatar generation,
  GitHub skill import (replaced by a local folder import), remote image URLs (only `data:`), the
  community/inbox/ops templates.
- Remote MCP servers are the agent's business, not the plugin's: the plugin imports them and hands
  them to the agent, but only tests programs and `localhost` servers itself. Why: the provider
  connects to them, and whether it may reach them depends on the deployment.
- Skills reach the agent through the system prompt (an index with the path of each `SKILL.md`), not
  through any provider feature.

### Licence and naming

- Upstream is MIT (Ondrej Rehacek). Keep `LICENSE` (both copyright lines) and `NOTICE` in every copy; the `package.json` author is Qiang Wei (the repo owner), upstream is credited in `LICENSE`, `NOTICE` and the README.
  MIT has no trademark clause, so renaming is allowed.
- Upstream status (checked 2026-10-31): `oliexe/paseo-bots` is not archived but its last commit is 2026-09-28; it has no
  releases, and its five open issues have no replies (two from users on 2026-10-27 and 10-30). We carry on alone; there is
  nothing to merge from it and no fix to wait for. Keep the `upstream` remote (harmless, lets us pick a fix later).
  Legally that is fine under MIT as long as `LICENSE` and `NOTICE` stay. Rewriting from scratch "after its ideas" would
  free us of the notice only if no expression is copied (code, prompt text, UI strings, docs, tests; a rewrite made by
  people who read the code is not a clean room), and it gains one line of notice for a large cost: not worth it. Do it
  for a single part only if that part's origin is in doubt (see the OpenMausBot question below).
- Paseo itself (`getpaseo/paseo`, not our upstream) is Apache-2.0, copyright Mohamed Boudra. No Paseo source is known to be copied (the plugin
  imports `@getpaseo/*` packages and comments say which Paseo behaviour a piece follows, for example the timeline paging in `useChat.ts`; not audited). If Paseo source is ever
  copied in (for example its chat view), add Paseo to `NOTICE`, keep its licence text and mark changed files.
- Named "Aydo" since 2026-10-31 (build 59), fully: plugin id `aydo`, data folder `plugin-data/aydo`, chat labels `aydo.*`,
  export formats `aydo` and `aydo-team`, plugin-message prefix `[Aydo ...]` (the plugin tells its own messages apart by it,
  `shared/reports.ts`, `server/history-files.ts`), the sidebar item, screen and settings titles, package and zip names
  (`aydo-0.2.0 build <n>` zips). Why: "Bot" put some people off, and the product is a personal assistant; "Aydo" is "aide" plus
  "I do". Earlier names, newest first: "Aidy" (build 58 only, dropped because an AI desktop assistant called Aidy exists,
  Product Hunt, 2025), "Bot Crew" (until build 57), `paseo-bots`, `paseo-bot`. Web check of 2026-10-31 (English only;
  nothing was checked in the official trademark databases): no product called Aydo found, no slang meaning found; npm package
  `aydo` is free, the GitHub user `aydo` is taken (2012), a small Windows security project `NRG-Wardog/Aydo` has 5 stars; a
  pending US application AYDO (serial 99485905, class 20 furniture, Chello Supply LLC) and a near-homophone, aidoo systems
  (AI software, Isle of Man). It sounds like the wedding vow "I do", and AY-doh or EYE-doh are both heard. Before telling
  people outside the team, do a proper trademark search (classes 9 and 42), and check the domains.
  There is no migration: nothing was deployed under an older id, so an install of "Bot Crew" or "Aidy" is a different plugin to
  the host, needs removing, and its chats keep their old labels (`bot-crew.*`, `aidy.*`) that Aydo does not read (an old chat in a
  bot's folder still counts as the bot's, by its folder). Old export files (`format: "bot-crew"` or `"aidy"`) are not read.
  Kept on purpose: the git branch `bot-crew` (the stable line, renaming a branch is the user's call), the repo names
  `quickwind/paseo-bots` and `oliexe/paseo-bots`, the MCP server name `bots`, internal names such as `Bot`, `BotsSurface`, and
  internal names such as `Bot`. Since build 65 every screen text says "assistant" (English `en.json` has no "bot" in a value; prompts the agent reads, such as the overview and tool texts, still say "bot").
- `LICENSE` has both lines: Ondrej Rehacek (upstream, must stay) and Qiang Wei (the repo owner; the GitHub account is quickwind). `NOTICE` credits upstream
  (MIT) and OpenMausBot (Apache-2.0, `milind-soni/OpenMausBot`, checked on GitHub; only its `enterprise/`
  folder is under another licence). Its names and mascot are trademarks of Supamaus Software Private
  Limited: never use them for this project (comments saying which design a piece follows are fine).
- OpenMausBot comparison (2026-11-01, a read-only comparison of our source with a shallow clone; one pass, not exhaustive): found two pieces adapted from it,
  `shared/playbooks.ts` (from `server/installed-playbooks.ts`) and `scanSkillText` in `shared/skills.ts` (from `shared/skill-md.ts`), now marked in the
  file comments and listed in `NOTICE`, with the Apache-2.0 text in `licenses/Apache-2.0.txt` (shipped in the package). The role templates
  (`shared/templates.ts`, `templates.*` in both locale files) copied its `ready-bots.ts` word for word and were rewritten the same day. A few short
  constants and sentences match too (memory limits, webhook limits, one prompt sentence); `NOTICE` says so. Not checked: `client/` panels,
  `shared/groups.ts`, `activity.ts`, `share.ts`, `tests/`, older OpenMausBot history, and whether upstream (oliexe) or we made each copy. Do not copy more
  of it; if a piece is adapted, add it to `NOTICE` and mark the file.
- The fork is public (a fork of a public repo cannot be private).

### Providers

- Devin has no system prompt channel over ACP on stock Paseo (`config.systemPrompt` is dropped). A host that injects it into the
  session's first message (as plain user text) is not assumed; whether such text survives compaction is
  not verified. The plugin still writes the bot's identity as a rule file, which needs no host support. The bot's identity (persona, standing instructions,
  memory, skills, team) is written to `.devin/rules/bot-identity.md` in the bot's folder as an
  always-on rule (frontmatter `trigger: always_on`). Devin takes a snapshot when a chat is created.
  It is written for every bot whatever its provider, so switching provider needs no re-save. It is
  rewritten when settings change, before each chat, and after each turn (the memory changes).
- Over 32 KB the identity is split into several files (Devin cuts a rule at 32 KiB) and the bot's
  Overview says so. Playbooks are not in the file (they depend on a chat's first message).
- A Devin chat in the bot's own folder does not also send `systemPrompt`; one in the bot's own
  working folder (`bot.cwd`) sends it, and nothing is ever written into the user's folder.
- Maintenance chats (memory tidy) run in a mode that approves edits (`accept-edits`, `acceptEdits`),
  preferred even over a bypass mode, because they read untrusted text unattended.
- A chat running in a bot's own folder counts as that bot's chat even without the plugin's label
  (a plain new chat in the Bots project). Side effect: it gets the bot's memory log and upkeep.

### Project workspaces

Design: `docs/specs/2026-10-19-project-workspaces-design.md` (placement, creating workspaces, assign, reports, blueprints); approvals: `docs/specs/2026-10-21-approvals-design.md`.

- A bot's chat can run in a project's workspace instead of the bot's own folder (`startBotChat` inputs `workspace` and
  `home`); the bot's own folder is then attached to the session (`shared/folder-access.ts`). Claude: `options.additionalDirectories`.
  OpenCode: an `external_directory` allow rule. Devin: `additionalDirectories`, only when the host announces it honours it:
  a host may set an environment variable (see `server/host-caps.ts`)
  (JSON) for the plugin process; `server/host-caps.ts` reads it, the app asks through the RPC `bots.host.caps` (only for
  its own host, a bot on another host gets the stock behaviour), stock Paseo announces nothing so all is false. A Devin
  session forgets the directories on resume, so the host must pass them again. Antigravity: nothing, because
  a second `--add-dir` moves its shell commands into that folder. The idea: separate *who* (persona, memory, skills: the bot's own folder)
  from *where* (a workspace per piece of work: a git worktree, or a plain folder for non-code work). The plugin holds the
  mechanisms; the workflow (who does what, where a human approves) is team text, never code, so teams that write no software
  fit too. Never wanted: a coded workflow engine or roles in code, several bots editing one workspace at once (work in one
  workspace is a relay; parallel work gets its own workspace), the plugin writing its identity, proposal or outbox files into
  the user's repository, one bot's memory mixing two projects, a bot touching a project the user never agreed to.
  Per provider: Claude and OpenCode take the system prompt for real; Antigravity gets it prepended to the first message;
  Devin gets it only where the host injects it (the identity file in the attached folder covers the rest). Project
  instructions come from the working directory (`CLAUDE.md` for Claude; `AGENTS.md` for Devin, OpenCode and Antigravity).
  Context use is reported by Claude and OpenCode, not by Antigravity (so no memory save there). Checked for real on all four
  (stock Paseo 0.11.4, Devin 3000.11.92): the cwd is the workspace, the label is kept, identity and memory reach the chat,
  the project's own rule file is followed, nothing lands in the repository. OpenCode's `<dir>/*` rule covers nested folders
  (a deny rule showed it); on Devin the folder is attached once the host honours it, then the identity comes from the rule
  file in that folder and a write there asks nothing, also after a daemon restart; without it one edit prompt per session.
  A Claude bot in a mode that asks for every write still asks for its own folder (the mode's rule, not the folder's).
  Whether an identity carried in a first message or rule file survives compaction is unverified, as is how a Devin rule over
  32 KiB is split under an attached folder. Not done: setting the work-board's status labels (the host exposes no label
  operation, so the user moves cards or archives the workspace), automatic archiving at the end of a feature (the user or a
  playbook step merges and archives), and lanes: that one piece of work is one workspace and one card, with parallel
  lanes as further workspaces branched from the feature branch, is only a convention in team text.
- Creating workspaces (part 2): tools `list_workspaces` and `create_workspace` (MCP), and for providers on files an `outbox/`
  file of kind `workspace` plus `setup/workspaces.md`. A worktree needs a git project; a plain folder is made by the
  plugin (one new folder under the project root, never through a link, and a workspace already at that folder is
  reused), because Paseo neither creates it nor checks it stays inside the project. A taken branch name is not an
  error: Paseo adds a number (`<name>-1`), so the plugin reports the real folder and tells the bot the branch may carry a suffix;
  Paseo's own refusals (not a git repository, unknown base, invalid branch) go to the bot verbatim and the project is not
  remembered. Paseo does not check that a plain folder's path lies inside the project and does not de-duplicate workspaces of
  one folder, which is why the plugin does both. The first workspace in a project the team has not used makes a card (proposal kind
  `workspace`; the server acts on Accept, like `ask`); Allow remembers the project in `project-grants.json`, apart from
  the settings, per team (or per bot when it has no team). Settings are read-only on the server, which is why the
  grants are their own file. Remove them in the team sheet or on a team-less bot's Agent page.
  Seen in real runs: on stock Paseo an OpenCode agent called Paseo's own `paseo_create_workspace` (no card, no grant) until told
  to use the plugin's tool, so tool texts name the plugin's tool; MCP tools answer "isn't connected yet" after a plugin or
  daemon restart until some RPC that attaches has run (opening the screen does it); Antigravity on files did not find the
  outbox protocol by itself in one run; a workspace opened by path outside Paseo's worktree folder becomes its own project.
  Known wording gaps: the project list on the team sheet shows names only (two projects with one name look alike) and an
  archived plain-folder workspace may stay listed in the picker.
- Assign (the smallest hop of the workflow): an assignment is an ask request with a workspace, not a second subsystem.
  `Asks.request` takes `{ to, message, workspace?, assign? }`; the MCP tool `assign_bot` and the outbox file
  `{"kind":"assign",...}` both call it (`relay.asks`). The other bot's chat is started in the workspace (a name, an id or
  "project · title"; by default the one the assigning chat runs in, else refused) and never goes into an existing chat.
  Its report is pushed back when its turn ends, as asks are; an assignment closes after 12 hours without one (asks: 30
  minutes). Gate unchanged: contact setting, team `askFreely`, the user's card (the ask card, with the workspace line),
  the hourly limit; a chat another bot started cannot assign (loop guard); `assign_bot` is quiet because that gate is the
  authority. Because the other bot then works in a project's files, the first assignment into a project the bot's team (or
  the bot) has not used asks the user on the card even when the contact setting is Allowed or the team lets members ask
  freely, unless it is the workspace the assigning chat itself runs in; Assign remembers the project (the same
  `project-grants.json` as create_workspace). A report that arrives while the assigning chat is busy is delivered at the end
  of that chat's next turn, for bots on MCP as well as on files (`FileTools.afterTurn`). A plain question never goes into an
  assignment's chat. Two assignments to one bot in one workspace start two chats in one worktree (not prevented). A refusal over the workspace tells the bot to ask the user which one is meant, because a Devin bot otherwise rewrites the file with another workspace by itself (seen in the real check). An assigned chat may assign onward (label `aydo.assign-depth`, set on every assignment's chat: 1 for a lead's, +1 for each hop; `MAX_ASSIGN_DEPTH` 3), but a chat that only answers a question may not, and no chat started by another bot may ask. Not built yet: an own team switch, explicit "done/blocked" reports and the automatic nudge
  (only the turn's end counts). The assigner may be in its own folder only when it names a workspace; a workspace archived
  between the card and the click tells the assigner and starts nothing; an assignment text is another bot's message, framed as
  data. In real runs a report that arrives while the assigner works was held and delivered after its turn; a question sent
  while an assignment runs goes to a new chat in the target's own folder, not behind the assignment. Known: the card and the
  failure message name a workspace by its bare title (several "main" are ambiguous) and a failed send after the click still
  shows "Assigned" on the card.
- Team reports and the daily log (v2; v1 was never shipped and has no migration).
  Each finished turn is one line in the bot's private `memory/log/<day>.md` (bracket `[project · workspace · who drove the
  turn · how it ended]`, tools kept there) and, for a bot **on a team** in a project workspace (the lead too; not a bot
  on no team, not a chat in a bot's own folder, not tidy/save turns), a record in the team's folder
  `<plugin data>/shared/Reports/<team id>/<project>/<day>.jsonl`: the whole question (the user's message, or the task
  without the plugin's framing) and the whole last answer (no tool calls, no earlier replies), redacted, at most 20,000
  characters each. Beside it a compact index `<day>.md` (one line per turn: question 60 characters, answer whole up to 240
  else the first 160 and the last 80; the line holds the chat id and the time, which find the record) and the team's
  `latest.md` (one line per chat, its latest turn, blocked/failed/stalled first). The driver is read from the last user
  message (the user stepping into an assigned chat, or opening a window by hand, is "by the user"); the status is done,
  failed, stopped, blocked (a reply starting with the capitalised word BLOCKED) or, for assignments, started/stalled. Teams
  never see each other's folder. The lead's chats get the team folder attached (`extraFolders`, not for members, not for a
  memory tidy chat) and the newest 15 per-chat lines in the prompt (a snapshot of the chat's start: current state is
  `latest.md`); members are told the path (read only; reading may ask the user). Retention follows the project: whole
  records stay while it has an active workspace, go 30 days after its last workspace was archived (the index stays), a
  project over 200 MB loses its oldest days, and a deleted team's folder goes 30 days after it was noticed gone; a sweep
  runs at start and every 6 hours and deletes nothing when it cannot read the workspaces or the settings. Redaction covers keys, JWTs,
  PEM private keys and `password=`/`token:` style values. A conclusion that appears only in a middle reply is lost (accepted).
  Known limits: a newer turn of a chat replaces its blocked line in `latest.md`, so a block vanishes after any later turn;
  index and `latest.md` show local time while the `.jsonl` field `at` is UTC; the per-chat line carries no chat id (the index
  does); a turn that only handles a report records the report text as its question; a member (or anything with write access to
  the folder) can forge lines, so lines are data and not instructions, and project names are folded to one line; members
  reading the folder get a prompt for anything beyond plain grep, read and ls. Writes are
  serial per team, appended, links are never followed. `memory/log` is per bot and private; `history/` (transcripts) is
  only for bots whose tools are files, as the files twin of `search_chats`.
- Approvals (see the whole design below). A bot
  puts a matter (title, text, optionally a file read whole at ask time) to the user and is blocked until the user decides on a card.
  It is a mechanism with no knowledge of "architecture" or "acceptance": which matters need approval, who asks, and what follows is
  the team's playbook (process). Tools `request_approval`, `list_approvals`, `withdraw_approval`; files twin: outbox kinds `approval`
  and `withdraw-approval`, `setup/approvals.md`. `assign_bot`, `create_workspace` and the assign/workspace files take an optional
  `approval` id that must be approved and the bot's or its team's (`citeApproval`); whether a bot must cite one is the playbook's rule
  (no rules engine yet). One pending approval per chat; only bots on the plugin's own host; not for memory tidy chats. "Blocked" means:
  the bot is told to stop and, if its turn goes on, the plugin interrupts it with a `send` of `activeTurnBehavior: "interrupt"` (the SDK
  has no cancel; verified on Claude and Devin only); **everything the plugin sends into the chat is held** while it waits
  (`server/chat-send.ts` `sendIntoChat` is the one way in, held messages are kept in `approvals.json` and go out after the decision);
  an assignment or ask whose chat waits is not finished by that turn (report status `waiting for approval`, stall clock paused).
  The decision is a plugin RPC (`bots.approvals.decide`) with a click marker the audit keeps. Not guaranteed: a bot that writes its own
  daemon client can call that RPC (the same is true of proposal cards), and on stock Paseo another chat can wake the chat with
  `send_agent_prompt`/`paseo send` (a host may refuse such messages; stock Paseo does not). The audit is `approvals/audit.jsonl` in the plugin data folder (append-only, kept forever, outside every bot's folder);
  state is `approvals.json`. Details: the audit has one line per event (`asked`, `decided`, `withdrawn`, `woken` = a turn started
  while pending, `cited`) with bot, chat, team, project, workspace, title, text, file and note; a named file is read at ask time
  (at most 200 KB, UTF-8, inside the bot's folder or the chat's workspace, links not followed) and stored whole with its checksum, so
  the user approves exactly what was shown; Reject needs a note, Approve may have one; a rejection is discussed in the same
  chat and the retry is a new approval (no versions); a pending approval never times out, and the user, the card or the list can
  cancel it (archiving the chat or deleting the bot withdraws it); a bot on another host cannot ask; only the user's click
  decides, and the click marker is a weak check, not a guarantee. A turn that starts while pending is only noted (the user
  typing is allowed and is how a rejection is discussed); the interrupt costs one short extra turn and the audit records whether
  the chat went idle; OpenCode and Antigravity interruption is unverified. Real runs on Claude and Devin: the decision and the
  held messages go out as one message (a second `send` right behind the first would interrupt the turn the decision starts); an
  assigned Devin bot that asks by file stays `running` and the report waits for the decision; a plugin reload keeps a pending
  approval. The user sees the card in the chat, a list (sidebar footer button "Approvals", where pending ones can be
  decided too) and a dot for pending ones.
- Blueprints (`docs/blueprints/`): a blueprint is a team set up with its process as text: the bots, who leads, and the team's shared
  instructions. The example is `docs/blueprints/software-team/` (admin, architect, designer, developer; three approval points; lanes;
  README says where each text goes in Paseo). The plugin knows none of it: process lives in the team's *Shared instructions* and each bot's
  *Instructions*, never in code. The team file `software-team.team.json` is built from the markdown by `node scripts/build-software-team.mjs`
  (a test fails when they differ); it names no provider or model, and an import gives bots without a provider the default one. It is not
  a *playbook*: playbooks are per bot and chosen by trigger phrases in a chat's first message. A full real run (admin, architect
  and designer on Claude Haiku, developer on Devin, a small feature in a scratch repo, about 15 minutes) worked end to end:
  intake, a worktree, onward assignments, a design rejected once then approved with a request for two lanes, two lane
  worktrees built and merged, acceptance, and a fresh admin chat reporting the right status from `latest.md`; every approval was
  decided by the user, and `main` stayed untouched. It showed that assigned chats must be able to assign onward (now built).
  Not exercised: the architecture approval, a lane sent back, BLOCKED handling, a second feature at once, other providers for
  lanes. Leftovers of an aborted run (old reports, notes, requests) leak into the next one, so clean them before a test. Later turns of a chain are
  not pushed to the admin as new reports (it reads `latest.md`); whether to push is open.
- Antigravity ignores the plugin's MCP server, so a bot on it starts with the files choice (see Bot tools), as one on Devin does.
- A bot with its own working folder (`bot.cwd`) now also gets its own folder attached.

### Shared folder name

- Since build 65 the shared folder is `plugin-data/aydo/shared/Aydo` (Paseo names the project after the folder, so the sidebar says
  "Aydo"); it was `shared/Bots`. `ensureBotsHome` moves an older `Bots` folder there and leaves `Bots` as a link, so memory and chats
  survive. `shared/chat.ts` knows both roots (`BOTS_ROOT_SUFFIXES`); a workspace made under `Bots` is reused (`isPlacementPath`), so
  an existing install keeps its Paseo project named "Bots" until the user archives those workspaces, after which new ones go to "Aydo".

### Bot tools: MCP or files

Design of the files mode: `docs/specs/2026-10-13-file-tools-design.md`.

- The plugin's tools (get_setup, propose_*, ask_bot, check_chat, search_chats, list_bots) are an MCP
  server `bots`. Devin cannot use MCP in some deployments (a restriction on which tools it may use, not a Paseo limit,
  and Claude Code uses MCP normally), so a files mode exists. Since build 60 there is no "automatic" mode: the settings hold one default for every
  bot, MCP or files (`toolMode`, set to MCP by default), and a bot may override it with its own `toolMode` ("Tools come as" on
  its Agent page; unset follows the default). Why: "automatic" was a fixed list of provider names (Devin, Antigravity) that
  only looked automatic, and provider ids change (renamed, gone, new), so the choice now sits on the bot, where it does not
  depend on a name. `usesFiles(default, provider, botOverride)` in `shared/tools-mode.ts` decides everywhere (chat start, prompt,
  setup/history files, after-turn scan, the app's mounting); the bot's choice wins, then the default.
  A bot on a provider that cannot use MCP (`filesOnlyProvider`: ids starting `devin` or `antigravity`) gets the files choice written when it is
  created (role, preset, defaults, import without provider), when a change or the Agent page switches it to such a provider
  (`withToolModeFor`), and by the settings migration v4 for every existing bot (default MCP, files override on those bots, so
  nothing changed for anyone). The seed is only a starting value: the Agent page warns when such a provider is on MCP, and a
  provider the list does not know (a custom provider that runs Devin under another name) has to be set to files by hand. A
  bot cannot set it itself (no `propose_changes` field, so a bot cannot loosen the restriction); a setting that still says
  "auto" (an older client wrote it after the migration) is read by the old by-provider rule. Exported bots do not carry the choice.
- Cost of the files mode (measured 2026-10-31): about 790 lines (`server/file-tools.ts` 411, `managed-files.ts`, `setup-files.ts`,
  `history-files.ts`, `approvals-file.ts`, `identity.ts`) and about 1,280 lines of tests, next to about 600 lines for the MCP tools
  in `server/tools/`. It is a second implementation of each tool-like feature (ask, assign, workspaces, approvals, proposals).
  Rule: before adding a tool-like feature, decide whether a files version is really needed; every one doubles that
  feature's work and adds the guesswork of attributing a file to a chat. The files code is in separate modules, so if Devin
  is ever allowed MCP everywhere it can be removed as a whole.
- Files mode (all in the bot's own folder): `setup/` (read only, written by the plugin, includes
  `proposal-format.md`), `proposals/` (bot writes JSON of kind changes, routine or skill), `outbox/`
  (kind ask), `history/` (a transcript per recent chat, for searching). Done files go to `done/` with
  a `.result.txt`. A scan takes at most 20 files, each at most 256 KB, named `^[\w.-]+\.json$`; the prompt asks for a unique
  name (time plus a random suffix) and for the file to be written as the last step of a turn. `history/` keeps the user and
  assistant messages only (secrets redacted, at most 200 messages a chat, the newest 40 chats, 2 MB a bot). A proposal file is
  validated with the same schemas as the tools (changes also get the dry run); a refused one is reported into the chat with the
  reason. A message the plugin sends into an idle Devin chat starts a turn (verified), which is how errors and answers reach it.
  A bot whose own working folder differs from its home writes outside its working folder and Devin asks each time (accepted).
- A file belongs to the chat whose last turn's tool calls wrote it (match on the unique file name
  inside the call's file path or shell command; Devin's `filePath` is a title like
  "Wrote ./proposals/x.json"). The scan claims a file by first creating `done/<name>.claim` exclusively, then moving the file to `done/`
  (one winner; two plain renames of one file can both succeed on Windows, found by CI, so the marker is needed).
  Files nobody accounts for after 10 minutes go to the next chat that ends a turn, for proposals
  only and never while another chat of the bot works; an ask file is never guessed.
- Confirmations are unchanged: the user clicks a card; the plugin posts it as a plugin timeline item
  (`kind: "proposal"`). A file that is not accepted is reported to the bot in the chat (three times in
  a row at most).
- Asking another bot: with "Ask first" the user approves a card; the answer is pushed into the asking
  chat as a message. A chat started by another bot cannot ask (loop guard); a chat may ask five times
  an hour; unanswered after 30 minutes (counted from sending) the question closes; one waiting for the
  user never times out. A follow-up to the same bot from the same chat goes into the chat it already
  has (up to an hour of quiet; a busy chat makes the follow-up wait its turn); `ask_bot` does the same.
  Shared code: `server/ask-store.ts`.
- Teams and asking: a Chief of Staff's team text says how to ask (`ask_bot`, the outbox, or "you can't
  contact them" when its contact setting is Off or the bot is off the plugin's host); `teamPrompt` takes
  that as a parameter. A team has a switch `askFreely` (default off, never in team files, so a shared file
  cannot loosen it): its members ask each other without the user's approval; a bot set to Off still may
  not, and a question to someone outside the team still asks. For the MCP tool it also pre-approves
  `ask_bot`, which then refuses non-teammates (nothing would have asked the user). The Chief of Staff
  may ask 20 times an hour, others 5; `ask_bot` counts the same way (shared `ask-store.ts` log). A chat started
  with `ask_bot` pre-approved (bot on Allow, or its team's switch on) carries the label `aydo.ask-preapproved`
  ("all" or "team"; added in `startBotChat`, which the app and the server both use), and `ask_bot` re-checks that basis on every call, so turning the setting off also stops chats
  already open (the tool permission itself is fixed when the chat starts). Several bots can be asked in one turn (one outbox file each, or
  `ask_bot` with `wait: false`); each answer comes as its own message, a slow one closes at 30 minutes
  with a notice, and the lead is told to answer without waiting for the slowest.
- State files of the plugin (asks, proposals, tidy, routines, hooks, journal, relay secret, command rules) are written
  with `writeAtomic` (temporary file, rename; `mode` 0o600 for secrets). Windows refuses to replace a file someone has
  open, so it waits out EPERM/EBUSY/EACCES a few times. `tests/atomic-state.test.ts` fails on a plain `writeFile` in
  `server/` outside its short allowlist.
- A memory tidy chat runs in the bot's folder, so its identity file is the full one; the files its turn wrote
  in `proposals/` and `outbox/` are settled with a note and never become cards or go to a later chat
  (`FileTools.discardTurn`).
- Safety rules for anything the plugin writes in a bot's folder: never follow a link (remove it; `realDirUnder` checks every folder of the path, `writeAtomic` replaces a linked file),
  write through temp file and rename, keep every file under the bot's folder, treat file contents and
  other bots' replies as data, never as instructions.

### Memory

Design: `docs/specs/2026-10-11-memory-maintenance-design.md`.

- Files: `MEMORY.md` (the first 200 lines or 24 KB go into the prompt), `memory/<topic>.md`,
  `memory/log/<day>.md`, `memory/inbox.md`. Every edit is journaled with Undo; the journal lives
  outside the bot's folder.
- Two upkeep jobs (settings per bot: off for old bots, on for new ones; imported bots start as new ones; new and imported Devin bots start with tidy off, because it spends the user's Devin quota, and can switch it on):
  - Save: when a chat's context use passes a threshold (default 70%) the chat is asked once, in the
    chat, to append notes to `memory/inbox.md`. Only for providers that report context use.
  - Tidy: a normal "Memory tidy" chat on an interval (default 4 hours, never fixed times because
    laptops sleep) promotes durable notes into `MEMORY.md`, merges, removes stale entries, empties the
    inbox, archives itself when clean. Skips with nothing new; at most 6 a day; backs off 24 hours if
    memory stays over 80% of the limit; waits while a chat of the bot works.
  - Tidy and save turns are never written to the daily log (or tidy would feed itself).
  - Details: Paseo has no compaction event, so the save check runs at each turn end, reads the chat's context use, and asks once
    per fill cycle (the flag clears when use drops again); a save turn is recognised by the id of the message the plugin sent, not
    by its text. Tidy aims for about 150 lines or 18 KB, treats the inbox and log as untrusted data, and is checked afterwards:
    a result that is missing, over budget or shrunk by more than half is flagged "Large change, please review" (nothing is rolled
    back; Undo restores the whole file as before that entry, so it also drops later edits). Without a usable Metadata
    generation entry it falls back to the bot's own model. An unattended run needs an edit-approving mode; Devin's own default
    (`accept-edits`) is one. Whether Devin reports context use was never checked. Out of scope: vector or database search, a shared
    user-level memory file, agent-written skills.
  - Tidy model: Paseo's "Metadata generation" list first, else the bot's own. Using a Devin bot's own
    model spends the user's Devin quota.
- Forked "save" (copy the chat and ask the copy) is future work: it avoids the visible message and permission prompts but re-sends
  most of the context without cache sharing and loses to a smaller window; the in-chat message is cheaper and more faithful.

### Setup interview

- "Set up with the bot" interviews, then proposes name, title, description and instructions on one
  card and writes a starting `MEMORY.md`. It must not change provider, model, mode or thinking.
  The prompt is configurable (plugin settings) with a files-mode version; a blank new bot starts it
  by itself (switchable, default on); bots from a role or preset do not.

### Native chat view (optional host extension)

- On a host that exports `ui.AgentView` with `ui.capabilities.agentView === 1`, an open bot chat is
  rendered by the host's own chat view (`client/native-agent-view.ts`, used in `client/ChatPane.tsx`), so the model,
  mode and thinking pickers, slash commands, permission prompts and other plugins' timeline cards work. Without
  it (stock Paseo, hosts without it) the plugin's own window (`client/chat/*`, `useChat.ts`) is the fallback. Do not
  delete the fallback: the plugin still has to run on Paseo. Why: the SDK has no embeddable chat component.
  Checked 2026-10-31 on the newest public `@getpaseo/plugin` (0.14.0): still no `AgentView`, no `capabilities`, and no chat
  component in `client/ui` (it has Markdown, Modal, TextInput, ScrollView, FlatList, StreamedText, settings and sidebar
  parts). The public hooks go the other way (an agent panel contribution, timeline renderers, composer pills, slash
  commands, `useAgent`). So `AgentView` is an optional host extension, not something stock Paseo offers; the plugin checks for it at run time.
- Why the plugin shows chats at all: the Bots screen puts the bot list and its chat side by side, a host may hide the Bots project from
  its sidebar (see Sidebar), and a new chat's first message has to go through `startBotChat`. A bot chat is an ordinary Paseo
  agent, so opening it in a normal workspace also works, but then playbooks, MCP and labels from the first message are
  missing (a chat in the bot's own folder still counts as the bot's, with its identity file and memory).
- The own window (`client/chat/*`, `useChat.ts`, about 1,700 lines) already gets its data the way Paseo does (the
  `timeline` of `api.agents.ref(id)`, tail page then pages after the end cursor), sends, answers permissions and has
  slash commands, attachments, proposal cards and thinking rows. What it lacks against the native view: pickers for
  model, mode and thinking (the SDK exposed no setter in the 0.14.0 types we read; not checked in the source) and other
  plugins' timeline cards (the host would have to render them). Copying Paseo's chat view is allowed (Apache-2.0) but it
  is an internal app component that needs Paseo's stores, theme and routing and changes with every release: not worth it.
  Fill single gaps instead, if the SDK allows.
- The first message of a new chat stays in our own composer: it builds the system prompt (playbooks are picked
  by that message), mounts MCP, writes the Devin identity file and sets labels (`startBotChat`). Opening an empty
  chat first would lose playbooks and leave empty chats behind; decided against it. An open chat shows the native
  view at once; until `workspaceId` is known it shows an empty pane, never our stream. Find in chat is off in the
  native view (it searches our stream only).
- Host side: props are
  `{ agentId, serverId, workspaceId }`. The plugin SDK types are `@getpaseo/plugin` and `@getpaseo/client` ^0.14.0
  (since build 63; they were 0.11.2); the public types (0.11.2 and 0.14.0) have no `AgentView`, so the type is declared locally.
- Known, not ours: a host's mode picker may hide when the chat column is narrow; a Devin draft chat with no model
  chosen has no slash commands until a model is picked.
- Paseo versions: `paseo-plugin.json` asks for `paseo >=0.13.0` (no upper limit; it was `>=0.9.2` until the language work, see Languages); the SDK types are ^0.14.0 (build 63; they only
  type-check the build, the host supplies the modules at run time). `tsc` and all tests pass against both 0.11.2 and 0.14.0. The
  plugin as a whole has not been run on 0.12 or later. 
  Run on a stock Paseo 0.14.0 test instance (2026-10-31, own home and port 6897, a throw-away probe plugin and a real Claude
  Haiku 5.5 chat): `turn_ended.timeline` is empty, a read of the chat's tail with `projection: "projected"` already holds the whole
  turn (user message, tool call, reply) when the event fires and is the same 3 seconds later, and the tool call's `detail`
  carries `type: "write"` and `filePath`. One run, one tool; shell calls and Devin's titles are not checked on 0.14. Everything that
  needs a host extension is detected and optional: the native view (`ui.AgentView` and `capabilities.agentView === 1`), the single "Bots"
  sidebar row (`capabilities.managedProjectsHidden === 1`) and Devin additional directories (the host-capabilities environment variable); on stock Paseo
  the own window, the host's Bots project and the stock Devin behaviour apply. Nothing tests the plugin on stock Paseo (CI is
  unit tests only). On Paseo 0.13.0 and later `agent.turn_ended` carries an empty `timeline` (the SDK types say "Always empty", also
  reported in `oliexe/paseo-bots`, issue of 2026-10-30; 0.12.0 still fills it). The plugin read the reply, the tools, which
  files a turn wrote (the files mode's attribution) and who drove the turn from it, so on such a host they would all have been empty.
  Since build 62 `turnEnded` calls `turnTimeline` (`server/turn-timeline.ts`): the event's own timeline when it has one, else the
  tail of the chat read with `timeline.refetch` (`projection: "projected"`, 100 per page), going back until two user messages
  are in (a long turn is more than a page; the second message tells a routine's first turn from a later one); a chat that
  cannot be read gives an empty timeline and the turn is recorded without its text. Unit tests with a fake daemon cover it, and the check on stock Paseo 0.14.0 above showed it works for a Claude write call. Not
  verified: Devin (its `detail` is a title like "Wrote ./proposals/x.json"), shell calls, a turn that ends while the
  daemon is busy, and other Paseo versions. Check those first when the SDK is raised.
- The deprecated entry `@getpaseo/plugin/client/react-native` (marked "removed after 2027-04-20" from 0.13.0) is still what the client
  imports (44 imports: Icon, useToast, Modal, ScrollView, copyText, TextInput, useRevealedText, FlatList). `@getpaseo/plugin/client/ui` has Modal, useToast, ScrollView, Icon and copyText only from 0.13.0 (0.11.2 and 0.12.0 do not). Since the
  language work Aydo requires Paseo 0.13, so moving the 44 imports to `client/ui` is now possible; it is not done (the user said it is not needed
  now), and it has to be done before 2027-04-20, when the deprecated entry is removed.

### Sidebar

- A host may hide the Bots project from its sidebar and from New workspace (`ui.capabilities.managedProjectsHidden`);
  the plugin then shows one "Bots" row with a single status dot for all bots (`client/BotsNav.tsx`). Elsewhere the
  host's own Bots project and the plain row stay. A team tree in the sidebar was built and dropped: it repeated the
  Bots screen's list, and its row clicks and status dots had bugs. Do not rebuild it without a new reason.
- Deleting a bot archives its workspace (`archiveOrphanBotWorkspaces`, run while the Bots screen is open); chats stay
  in Paseo's history. Other plugins such as workboard read workspaces from the host API, so they still list bots.

- The Aydo row is ours on every host: `addSidebarHeaderItem` with `BotsNav` (since build 74; before that stock Paseo got the deprecated
  `addSidebarItem` row). It carries one status dot for all assistants; on stock Paseo, where the Bots project is also in the sidebar, the dot
  repeats what those workspaces show. `hostHidesBotsProject` is no longer used by the row (the function stays).
- No host name on the row or in the screen's title (tried in build 71 to .75, removed in 0.3.0). Read in the Paseo 0.14.0 app (2026-11-01,
  `Paseo.app` web bundle): the host shows one row per plugin, for the host it remembers (`getPreferredPluginContributionHost`), not one per
  host; a plugin screen has the host's own `HostFilter` picker (`plugin-host-filter-trigger`), and choosing a host does
  `router.replace(buildPluginSurfaceRoute(newHost, pluginId, identity, sameParams))`, so the params stay and a title made from them goes stale.
  The screen title is therefore a fixed "Aydo".

### Proposal cards

- Change proposals are strict: a field the schema does not know is refused (and reported to the bot) instead of
  being dropped, so a misspelt `name` can no longer vanish silently. The files-mode example shows `name`.
- Each card says what happened after Apply or Dismiss (on the card and in a toast), and a failure shows on the
  card (a toast alone is easy to miss in the native view). After a bot's own setup is applied, the card also states
  the model and the memory tidy setting and where to change them (`afterSetupNotes`).
- The setup interview asks for the bot's name last, with three suggestions. A custom interview prompt in the
  settings does not get this change.
- Not reproduced: a routine card "doing nothing" on Windows. A schedule type the schema does not know (for example
  `weekdays`) is refused, so no card appears; the bot is told in the chat. Accepting common aliases is open.

### UI

- Model pickers use our searchable select (`client/ui/SearchableSelect.tsx`); Paseo's own select
  cannot scroll or search.
- Chat follows new messages until the reader scrolls up (`client/chat/follow.ts`); distance from the
  bottom must not decide it.

### Languages

Design: `docs/specs/2026-10-31-i18n-design.md`.

- Locales: `en` (the source) and `zh-CN`. The app language decides (the Paseo language setting, read through the SDK's
  `useTranslation`, so it switches live); there is no setting of our own.
- Aydo needs Paseo 0.13 (`paseo-plugin.json` `>=0.13.0`), because the plugin translation API arrived there. Paseo 0.11.2
  therefore cannot run it; the target is Paseo 0.14.
- Where strings live: `shared/locales/en.json` and `zh-CN.json` (keys with `_one`/`_other` for plurals, `{{name}}` placeholders),
  `client/i18n/` (`messages.ts` registers the files, `use-t.ts` is the `useT()` hook), `shared/translate.ts` (`Translate`,
  `englishTranslate`, `isChineseLocale`).
- Convention for text builders in `shared/` and `server/`: they take `t: Translate` as the last parameter, default `englishTranslate`, so server
  callers and tests keep English; the screens pass the hook's `t`. Host labels (slash command, sidebar item) use `messages.message(key)` in
  `index.client.tsx`. Never call `t` or `useT` at module level (the language is not known then): build text inside functions.
- Not translated on purpose: prompts the user does not read (system prompts, playbooks, the files-mode setup texts), the `[Aydo ...]`
  notices the plugin sends into chats (the plugin recognises them by prefix), bot replies and anything the user wrote, the `get_setup`
  text, agent-facing deny and interrupt messages, the attachment title "Pasted text", `botDetails`.
- Interview prompt: a prompt the user saved in the settings is theirs and is never replaced. The defaults exist in English and Chinese, in
  the MCP and the files form; `isChineseLocale` picks Chinese for `zh-CN`, `zh` and `zh-Hans*` only, every other locale (`zh-TW` too) gets English.
- SDK constraints behind the gates: a zh-CN file with a key English lacks, or with different placeholders, throws when the client loads
  and takes the whole UI down; keys may not contain `.`; there is no translation API on the server, so displayed text is built in the
  client when drawn (a proposal card stores only `{ proposalId }`, so nothing needs re-translating on a language change). The interview
  language is fixed when its chat starts (the first message carries it; the Chinese prompt tells the assistant to talk and write its
  proposal in Chinese); the identity prompt stays English. Other Chinese tags (`zh-TW`, `zh-HK`) show English everywhere. Resources are
  bundled JSON, no network.
- Stored names (a new assistant, a team from a template) are made at creation in the language of that moment and never matched by text later.
- Add a string: a key in both files, English exact, Chinese by the glossary below, then `npm test`. Add a language: a JSON file registered in
  `client/i18n/messages.ts`, plus a choice like `isChineseLocale` for the interview prompt; a language the gates do not know needs its own parity check.
- Glossary (zh-CN): assistant 助理, team 团队, chat 聊天, routine 定时任务, skill 技能, tool 工具, approval 审批, Chief of Staff 幕僚长,
  Agent stays Agent; full-width punctuation next to Chinese text.
- Gates in `tests/i18n.test.ts`: zh-CN keys are a subset of en keys with the same placeholders; every literal key used exists; every en key is used
  (a key read from a variable needs a prefix with a reason in `DYNAMIC_PREFIXES`; unused keys are deleted, not allowlisted); no `t(` or `useT(` at
  module level (`moduleLevelTranslateCalls`); best-effort scan for English literals in text props under `client/` (`ENGLISH_LITERAL_ALLOWLIST`
  holds files with a reason: agent-facing messages, examples a user types); no two keys share an English value; full-width punctuation; one Chinese
  word per common English word.
- Verified (2026-11-01): unit tests with test doubles, 866 tests, `tsc` clean, and these runs on an isolated stock Paseo 0.14.0 daemon (own home and port 6897,
  stopped with `paseo daemon stop --home`, the main daemon on 6767 untouched): Aydo installed from the repo directory runs (status running, its RPC methods
  registered, no errors); the host built the client bundle (about 966 KB) and accepted `requirements.paseo >=0.13.0`; the built bundle, evaluated in node with
  stubbed host modules and the real SDK, loaded (`defineTranslations` validated the real resources) and its host labels resolve to Chinese for `zh-CN`, English for
  `en`, and English for `zh-TW` and `ja`; the Chinese interview prompts are in the bundle. Reading the Paseo 0.14 web app bundle: timeline
  renderers are wrapped in `PluginInstallationProvider`, which provides `PluginTranslationProvider`, so `useT()` works in the approval, proposal and routine
  cards (read, not run: no fallback was written). The 0.14 bundle also turns the app languages `zh`, `zh-cn` and `zh-hans*` into `zh-CN` before the plugin sees them,
  the same rule as `isChineseLocale`. A whole-branch review (AST scan of all 1,415 translate calls, all 1,194 English values compared with the pre-branch sources) found
  no unknown key, no missing placeholder, no hook-order bug and no stale-language capture.
  NOT verified: rendering in the real app (screens, settings, chat) and the live language switch there, the native `AgentView`, the files-mode texts with Devin, the
  Chinese interview in a real chat, date formats (they follow the host's system locale except in routine run times, which use `zh-CN` in a Chinese app).
- Known gaps, accepted: a role created from a bot's proposal (`applyChange` in `shared/changes.ts`) keeps the English title and description (no `t` there); the
  attachment name "Pasted image N" (`client/web.ts`) and "Pasted text" are stored English; a raw `JSON.parse` message in the MCP import sheet; `once` schedule
  dates use the host locale; unknown tool names in permission cards stay English; one English fix made on purpose: the status dot's accessibility label reads
  "Needs input" instead of the raw id (R8 in the work log). The toast and one-word gates only see literals on the same line as the call.

## Working rules

- Test with real Devin sparingly: it is a personal free subscription with one model
  (`swe-1-6-slow`); use `devin rules list` and unit tests where they are enough, a few short messages
  otherwise. New bots default to tidy on, which also spends it.
- Run test instances only with their own `PASEO_HOME` and their own port (we used 6897). Never touch
  the main Paseo daemon (6767) Stop a daemon only with
  `paseo daemon stop` under the same `PASEO_HOME`; never kill by process name. Never read Devin's
  credentials.
- Do not mention any organisation's internal or modified Paseo, a special edition or version made for one organisation, or that organisation's rules or policies anywhere (the user's rule, 2026-11-01): write as if the plugin supports stock Paseo only,
  and describe optional host extensions neutrally ("a host may offer X; the plugin checks at run time"). One exception is left on purpose: the
  host-capabilities environment variable is read under its real name in `server/host-caps.ts` (and its test), for compatibility; do not edit them.
- Test first and watch it fail. Never run `git checkout <file>` to undo an experiment while other work
  in that file is uncommitted (it once discarded real work); commit first.
- Do not bump the version or build a zip per change; only when the user says to release (see Releases). End commit messages with the Co-Authored-By line.

## Not verified / open

- CI (`.github/workflows/test.yml`) runs typecheck and tests on Ubuntu and Windows. Check it with
  `gh api repos/quickwind/paseo-bots/actions/runs` (plain `gh run list` here asks the upstream repo).
  It only covers the unit tests, not a real Paseo or Devin on Windows.
- Windows, known and not fixed: the MCP probe (`server/mcp-probe.ts`, only behind the "test" button of a
  library MCP server; the agents run their servers themselves) starts servers through `cmd.exe`
  (`shell: true`), so an argument with a space or a quote is split. Fixing it means resolving the
  executable via PATH/PATHEXT and using the shell only for .cmd/.bat shims. Paths in prompts are
  written with `/` (`promptPath` in `shared/bot.ts`), so a Unix-style shell on Windows does not read `\`
  as an escape; whether Devin there uses such a shell is not verified.
- Windows, and Devin's own behaviour for: a bot with its own working folder writing to its home
  (it asks approval each time), context use reporting, the held follow-up when the other chat is busy.
- Minor, deferred: a file with a name the plugin rejects is only reported when the chat wrote it; file-name matching is
  case-insensitive; in-memory notice counters are not pruned; hand-opened chats in a bot's folder get
  the bot's saved shell-command approvals.
