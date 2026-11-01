# Bots working in a project's workspaces

Status: approved. Parts 1 (placement, per-provider folder attachment, Antigravity files mode) and 2 (create and list
workspaces, remembered projects) are built on branch `project-workspaces`; parts 3 and 4 are not.

## Problem

A team of bots (an admin, also called Chief of Staff, plus an architect, designers and developers) is set up with
roles and knows how to ask each other. But every bot chat runs in the bot's own folder in the Bots project
(`server/chats.ts:34`, `client/BotsSurface.tsx:786`). The repository the team is meant to work on, with its code,
`AGENTS.md`, rules and skills, is somewhere else.

The workboard plugin (`paseo-workboard` 0.3.0, installed in the user's Paseo) shows **one card per workspace** and
filters by project (`client/filters.ts`, `projectId`). So with today's setup the board shows the bots' own folders
in the Bots project, not the project's tasks.

The one existing escape, a bot's fixed working folder (`bot.cwd`), is set per bot. All of that bot's chats then go
into one folder: one card, no worktree per task. Writing memory back to the bot's folder also asks for approval
on every write.

## Idea

Separate **who** from **where**:

- **Who**: the bot's persona, standing instructions, memory and skills stay in the bot's own folder, as today.
- **Where**: each chat is placed in a workspace of a project, one workspace per piece of work. For development
  that is a git worktree; for other kinds of work (research, reports, documents) it is a plain folder. The
  bot's own folder comes along as an *additional directory* of the session. It can then read and write its
  memory there without approval prompts, and the project's own `AGENTS.md`, `CLAUDE.md`, rules and skills apply
  because the chat's working directory is the project.

**Mechanisms** go into the plugin's code. **The workflow** (who does what, in which order, where a human approves)
is written as text in playbooks, so each user can arrange their team differently, including teams that do not
write software at all. The code knows no roles (architect, designer) and no stages; the technical ideas stay the
same for everyone.

## Goals

- A bot's chat can be started in a given project workspace (a worktree or a plain folder), with the bot's own
  folder attached.
- One piece of work is one workspace and one board card. When it splits into parallel lanes (for example front
  end and back end), each lane is its own workspace and its own card.
- Bots hand work to each other as long-running assignments (hours), not as questions with a 30-minute timeout.
- Every bot reports its progress to the admin, and the admin reports to the user.
- Each bot remembers which projects and tasks it works on, and how far each one has got, in its own memory. Old
  tasks fade out over time.
- Approval points (today: architecture, design, final acceptance) and the whole flow are text in playbooks that
  the user edits, not code.

## Non-goals

- A fixed, coded workflow engine (stages, transitions, state machine), or anything that only fits software work.
- Roles in code. Who may create workspaces, judge size or merge is playbook text.
- Several bots editing one workspace at the same time. Within one workspace the work is a relay, one bot after
  another. Parallel work gets its own workspace.
- Parent and child cards on the board. Workboard has no such concept; related cards share a name prefix.
- Replacing the repository as the project's record. Designs, plans, code and review results live in the repo.

## Anti-goals (would make it a failure even if it works)

- The board shows bots instead of tasks again.
- A bot forgets who it is (persona, memory) when it works in a project folder, on either provider.
- The plugin writes its own files (identity, proposals, outbox) into the user's repository.
- One bot's memory mixes up two projects.
- Changing the flow or the approval points needs a new plugin version.
- A bot touches a project the user never agreed to.

## The workflow the user described (an example playbook, editable)

This is the user's software team as it is today. It goes into a team playbook, not into code. Other teams write
their own.

1. **Intake.** The user tells the admin "in project X, do Y". The admin creates the feature's worktree (one card
   appears on the board), then assigns the feature to the architect. The admin does not judge the size and does
   not dispatch further.
2. **Architecture.** The architect's chat opens in the feature's worktree. The user talks to the architect directly
   there for the deep discussion; the admin does not relay it. The architect judges the size:
   - a large feature gets an architecture document in the repo, and the architect sends the user an approval card;
   - a small one gets a short look and goes straight to the designer.
3. **Design.** The designer writes the detailed design and plan in the same worktree and sends the user an approval
   card.
4. **Lanes.** The designer splits the plan into lanes when parts can be done in parallel. Each lane gets a
   worktree branched from the feature branch (for example `login-frontend`, `login-backend` from `login`), with
   its own card. The designer assigns each lane to a developer. A feature that does not split stays in one
   worktree.
5. **Build.** The developer implements and tests in the lane's worktree, then hands it back to the designer.
6. **Review.** The designer reviews the lane against the feature branch. If it fails, it goes back to the developer;
   if it passes, the designer merges it into the feature branch and the lane's card is done.
7. **Acceptance.** The designer sends the user the acceptance card, with a summary of the feature branch's changes
   and test results. After approval the feature's card is done and its worktrees are archived.
8. **Throughout.** Each bot reports to the admin at key moments: started, done, stuck, waiting for approval. These
   are one-way notices. The admin keeps the overall status in its memory and reports to the user when asked, or
   on a routine.

Approval cards come **from the owner of the stage**, directly to the user (decided: faster, and the card has the
full context). The result of each card (approved, or changes requested with comments) is also reported to the
admin, so its status stays current.

Everything in this section is a default the user can change: the approval points, who judges size, who manages
lanes, the size rules.

## Mechanisms (plugin code)

### 1. Placement per chat

Today a chat's folder comes from the bot (`bot.cwd`, or the bot's own folder). Add a per-chat placement: an
existing workspace of a project, by workspace id or directory. `startChat` and `startBotChat` take it; when it is
missing, today's behaviour stays.

The chat keeps the plugin's label `aydo.bot`, so it still counts as the bot's chat: it is in the bot's chat
list, gets its daily log and memory save, and is recognised by `host.ts:68`.

### 2. The bot's own folder, per provider

When the chat's folder is not the bot's own folder, the bot still needs three things: its identity, its own folder
for memory (and, in files mode, `setup/`, `proposals/`, `outbox/`), and the plugin's tools. Each provider gets
these differently. The plugin keeps one rule ("attach the bot's folder") and a small per-provider adapter that
turns it into what the provider understands.

Four providers must work: Claude, Devin, OpenCode and Antigravity (all on stock Paseo).

| | Claude | Devin | OpenCode | Antigravity |
|---|---|---|---|---|
| Identity | real system prompt | stock Paseo: dropped (a host may inject it into the first message) | real system prompt (v2: `session.instructions`, `opencode/v2/session.ts:174`) | prepended to the first message (`plugins/antigravity-provider/server/internal/session.ts:117`) |
| Bot's folder attached | `options.additionalDirectories` (`providers/claude/options.ts:50`) | ACP `additionalDirectories`, which stock Paseo does not pass yet (`acp-agent.ts:1817`) | `options.permission.external_directory` allow rule for the folder (`opencode/options.ts:25`) | nothing to do: always full access, no prompts (`catalog.ts:11`); a second `--add-dir` moves shell commands into that folder, so do **not** add one (`test/fixtures/README.md:39`) |
| Writes to the bot's folder today | ask | ask once per session | ask (default `external_directory: ask`) | never ask |
| Project instructions from cwd | `CLAUDE.md`, `.claude/` | `AGENTS.md`, `.devin/rules` | `AGENTS.md`, skills folders; not `CLAUDE.md` | `AGENTS.md`, `GEMINI.md`, `.agents/rules`, `.agents/skills`; not `CLAUDE.md` |
| Plugin's MCP tools | yes | not allowed in some deployments (a restriction on which tools it may use): files | yes | **silently dropped** (`plugin-provider.ts:1587` claims support; the provider ignores `mcpServers`): files |
| Context use reported (memory save) | yes | unverified on Windows | yes (`opencode/v2/usage.ts`) | no |

What this means for the plugin:

- **Claude**: pass `options.additionalDirectories = [botHome]`. Not yet tried end to end from the plugin.
- **Devin**: pass `options.additionalDirectories = [botHome]` too. A host may map it to ACP's `additionalDirectories`
  on `session/new`. The field name is the same name and shape as Claude's, and
  `providerOptions` is free-form in the protocol (`messages.ts:423`). Verified with real Devin 3000.11.92:
  - the `.devin/rules` of an additional directory load;
  - writes there no longer ask for approval.

  Until a host passes it, a Devin bot in a project may lack its injected identity, and writes to its own folder
  ask once. Once rules from the bot's folder load, the chat must not also send the system prompt, or the identity
  arrives twice. `sendsPromptInChat` (`shared/identity.ts:100`) has to learn this case. It decides from the host
  capability below.
- **OpenCode**: pass `options: { permission: { external_directory: { "<botHome>/*": "allow", "<botHome>/**": "allow" } } }`.
  Both patterns are there because it is unverified whether `*` matches nested folders. OpenCode's own ACP adapter
  turns `additionalDirectories` into exactly such a rule. The schema is strict, so any other field is refused.
- **Antigravity**: no change for the folder. It must use **files mode**. Today "automatic" picks MCP for everything
  except Devin (`shared/tools-mode.ts`), so an Antigravity bot loses its tools without a word. This is a bug
  today too, independent of this design: "automatic" should pick files for every provider that cannot take the
  plugin's MCP server. Memory save does not trigger (no context use), as for any provider without it.
- **Stock Paseo Devin** drops the system prompt. A Devin bot there has no identity in a project folder; the bot's
  Overview says so.

**Host capability:** the plugin's server cannot tell today what the host does for Devin. The only
signals are client-side `ui.capabilities` (`packages/plugin/src/client/host-ui.ts`), and `startChat` also runs on
the server. A host may announce a capability the server side can read: whether Devin gets `systemPrompt` injected,
and whether `additionalDirectories` is honoured. Without it the plugin assumes stock Paseo behaviour.


### 3. Workspaces in a project

The plugin creates workspaces through the client API. `workspace.create` accepts a source of kind `directory`, or
of kind `worktree` with `projectId`, `baseBranch` and `branchName` (`@getpaseo/protocol`
`WorkspaceCreateRequestSchema`). One tool lets a bot create a workspace in a project:

- a worktree when the project is a git repository and the bot asks for one (with a base branch, so a lane can
  branch from a feature branch);
- otherwise a plain folder in the project.

Another tool lists the project's workspaces. The code does not restrict these tools to roles; the playbook says
who uses them (in the example, the admin creates the feature's workspace and the designer the lanes').

**Which projects (decided):** first time, then remembered. The first time a team wants to create a workspace in a
project it has not used, the user gets a card. "Allow" remembers that project for that team, and later workspaces
there need no card. The team's settings list the remembered projects and can remove them. This is the same idea
as the saved "always allow" shell commands. Placing a chat in an existing workspace of a remembered project needs
no card either.

**Verified on the test instance (0.11.2, 2026-10-19), through `@getpaseo/client`:**

- Worktree: `workspaces.create({ title, source: { kind: "worktree", projectId, baseBranch, branchName } })` works for
  a git project. The result has the same `projectId` as the repository's project, `projectRootPath` is the
  repository, `workspaceKind` is `worktree`, and `workspaceDirectory` is under Paseo's own folder
  (`<PASEO_HOME>/worktrees/<hash>/<slug>`), not under the project. `projects.list()` still shows one project, and
  `workspaces.list()` shows the new workspace under that `projectId`, so the board's project filter sees it.
- A taken branch name is not an error: Paseo makes the branch `<name>-1` (then `-2`, ...) and the worktree folder
  slug follows it. The plugin cannot count on the branch it asked for; it reports `workspaceDirectory` and tells
  the bot the branch may carry a suffix. A branch name Git rejects fails with
  `Invalid branch name: Git rejected ref name 'a..b'`; an unknown base fails with `Base branch not found: nope`.
- Plain folder: a `worktree` source in a project that is not a git repository fails with
  `Create worktree requires a git repository`.
- Plain folder: `{ kind: "directory", path, projectId }` does **not** create the folder. A path that does not exist
  fails with `Directory not found: <path>`. Once the folder exists, the workspace is created under the given
  `projectId` (`workspaceKind` `directory`, `projectKind` `non_git`, `projectRootPath` is the project's root).
- Paseo does not check that `path` lies inside the project: a path outside the root (here, the root's parent) was
  accepted and attached to the project. Creating the same directory twice makes two workspaces (no de-duplication).
  So the plugin must itself check the path and look for an existing workspace of that folder.
- The workspace's title (`title`) is kept as given; a workspace of the project's root folder has `title: null`.

**Ruling (Paseo does not create the folder, and does not check the path):** for a plain folder the plugin creates
the folder with `mkdir` under the project's root after checking that the resolved path stays inside the root
(`realDirUnder`, `server/managed-files.ts`; no links followed), then calls `workspaces.create` with the `directory`
source. If a workspace of that folder already exists, the plugin returns it instead of creating a second one.

### 4. Assign (built as an ask with a workspace)

Built on the ask machinery instead of beside it: the first version has no team switch of its own, no depth limit, no explicit
reports and no automatic nudge, and an assigned chat cannot assign onward. The text below is the original wish, kept for the
parts that are still to do.


`ask_bot` is a question with an answer, and it closes after 30 minutes. A handoff is hours of work. A new action
**assign** starts a chat for the target bot in a given workspace, with a brief and a link back to the assigner.
When the target says it is done (or stuck), the assigner and the admin are told. It needs:

- an MCP tool and a files-mode equivalent (an `outbox/` kind), like `ask_bot`;
- guards (decided):
  - a team switch **"members may assign to each other freely"**, separate from `askFreely`, default off. Off, every
    assignment raises the user's approval card; on, assignments within the team need none, and the user only sees
    the playbook's approval points. An assignment to a bot outside the team always asks;
  - a chat started by an assignment may assign onward, send reports and send approval cards. It still may not
    **ask** (a question that waits for an answer), so today's loop guard for asking stays as it is;
  - a depth limit on the chain of assignments within one workspace (default 10), and an hourly limit on
    assignments per workspace. Hitting either stops the chain and tells the admin and the user;
- one assignment per bot per workspace at a time. A second assignment to the same bot in the same workspace goes
  into its existing chat.

### 5. Reports to the admin (built)

Built as automatic lines for every finished turn of a team member in a project workspace, in a team-shared, per-project report
folder; not as a tool the bots call. The text below is the original wish.


A one-way notice from any team member to the team's admin (started, done, stuck, waiting for approval, approval
result). It does not wait for an answer and does not start a turn for every notice. How the admin receives them
(appended to a per-project log the admin reads, or batched into its chat) is left to the builder.

### 6. Approval cards

The owner of a stage asks the user to approve a document or a result. This is a plugin card (like the proposal
cards, `kind: "proposal"` timeline items) with:

- what is approved, with a repo path or a change summary;
- two actions, **Approve** and **Request changes** with a comment.

It never times out. After a click the card shows the result, and the result goes back to the bot that asked and to
the admin. Which points need approval is in the playbook, not in code.

### 7. Board status (to verify)

Moving a lane's card to "done" or a card to "waiting for approval" would make the board honest. Workboard keeps
status as managed workspace labels and uses an internal bridge because the public SDK does not expose label
operations (its README, "Compatibility and trust"). Whether the plugin can set them is open. If it cannot, the user
moves cards by hand, and archiving the workspace at the end is enough.

### 8. Memory per project

The convention, written in the standing instructions and the tidy prompt:

- `memory/projects/<project>.md` per project: context, my tasks (workspaces) in it, where each one stands, my next
  step.
- `MEMORY.md` keeps one index line per active project, so many projects do not fill the prompt.
- Tidy compresses a finished task to one line, and archives a project's file after a long quiet period, removing
  its index line. The signal "finished" is a card done, a workspace archived, or the bot's own note.

Daily logs and save stay as they are. The memory is the bot's working notebook; the project's record is the repo.

### 9. Playbooks

Today's playbooks belong to one bot and are picked by words in a chat's first message (`shared/changes.ts:57`).
This flow spans bots, so it needs a team-level text every member reads (a team playbook, or a team skill), plus
each role's own playbook for its part. The default team playbook holds the workflow above. Where it lives, and
how it reaches a chat started by an assignment (whose first message is the brief, not the user's words), is left
to the builder.

## Testing

Unit tests come first (`npx tsc --noEmit && npm test`). They cover:
- the per-provider adapter (what `options` each provider gets);
- `sendsPromptInChat` for every provider, host and placement;
- "automatic" picking files for Antigravity;
- the assignment guards (switch, depth, hourly limit, no asking from an assigned chat);
- the remembered-project rule.

Then each provider is run for real, all of them on this Mac (all four are installed: `claude`, `devin`,
`/opt/homebrew/bin/opencode` 2.0.25, `~/.local/bin/agy` 1.4.2):

- **the test instance** (own `PASEO_HOME`, port 6897): Claude and Devin.
- **Stock Paseo test instance** (own home folder and its own port, never the main daemon on 6767): OpenCode,
  Antigravity, and Devin without injection.

The same checks for each provider, in a scratch git repository registered as a project:

1. A bot chat placed in a worktree of the project:
   - the chat runs in the worktree;
   - the board shows the worktree under the project;
   - the chat is in the bot's chat list.
2. Identity: the bot answers as its persona and knows a fact that is only in its `MEMORY.md`.
3. Project instructions: the bot follows a marker rule written in the project's own instruction file (the file that
   provider reads, per the table).
4. Memory: the bot appends to `memory/inbox.md` in its own folder. Expected: no approval prompt (Antigravity: none
   anyway; Devin on stock Paseo: one prompt, as documented).
5. Tools: the bot proposes a change. Expected: it reaches the user as a card, through MCP or files mode as the
   table says.
6. Assignment: bot A assigns bot B in the same worktree. Expected:
   - B's chat opens there;
   - B's done notice reaches A and the admin.
7. Nothing the plugin writes appears in the project repository (`git status` clean apart from the bot's real work).

Keep real-model runs short: one or two messages per check. Devin is a personal free subscription with one model;
Antigravity and Devin may spend quota.

## Constraints

- No network code (`tests/no-network.test.ts`). Everything here is local daemon API.
- Nothing the plugin writes goes into the user's repository. The bot's files stay in its own folder.
- Must work on Claude, Devin, OpenCode and Antigravity. Must still run on stock Paseo (no `additionalDirectories`
  for Devin, no prompt injection). Degrade and say so.
- 
- Test with real Devin sparingly.
- State files through `writeAtomic`; folder safety rules as in AGENTS.md.

## Decided in the discussion

- Worktree per piece of work, not per bot. Lanes for parallel work, each with its own card (fine-grained).
- The designer manages lanes, reviews and merges.
- The architect judges size and hands to the designer. The admin takes the request in and reports status; it does
  not dispatch.
- The user talks to the architect and designer directly for deep discussion.
- Approval cards come from the stage owner. Results are also reported to the admin.
- Approval points and the flow are editable text.
- Not only for software: a workspace is a worktree or a plain folder, and the code has no roles or stages.
- Assigning: a separate team switch "members may assign to each other freely" (default off); chats started by an
  assignment may assign, report and request approval, but not ask; a depth limit and an hourly limit per workspace.
- Projects: the first workspace in a new project asks the user, then the project is remembered per team.
- Progress lives in each bot's memory under `memory/projects/<project>.md` and fades with time.

## Calls made by the writer (check these)

- The designer, not the architect, sends the acceptance card.
- An "assign" action separate from `ask_bot`, rather than stretching `ask_bot`'s timeout.
- Reports to the admin are one-way notices, not questions.
- Board status updates are optional, depending on what the host allows.
- Host signal for Devin: a host may announce a capability the plugin's **server** can read
  (whether Devin gets `config.systemPrompt` injected, and whether it gets additional directories). Today's only
  signals are client-side `ui.capabilities`, and `startChat` runs on the server too. Without the signal the
  plugin assumes stock Paseo behaviour and says so on the bot's Overview.
- End of a feature: the plugin archives nothing automatically. Merging the feature branch into the main branch and
  archiving the worktrees are left to the user or to a bot step in the playbook; workboard's own auto-archive
  can also do it. An archive tool, if added, refuses a worktree whose branch is not merged.
- "Automatic" tool mode picks files for Antigravity (it drops the plugin's MCP server). Fixed as part of this work.
- Antigravity gets no extra `--add-dir` for the bot's folder, because that moves its shell commands there.
- OpenCode and Antigravity are tested on a separate stock Paseo test instance, which are not on the main test instance.
- Devin bots may be placed in a project before a host passes additional directories. Their writes to their own
  folder then ask for approval, and the bot's Overview says why.

## Left to the builder

- Tool names and shapes for placement, workspaces, assign, report and approval.
- How the admin receives reports.
- Where the team playbook lives and how assigned chats get it.
- How the Bots screen shows a bot's chats that live in project workspaces.

## Open questions


- Can the plugin set workboard's status labels?
- Does the Claude provider accept `additionalDirectories` from a plugin-created chat as expected?
- OpenCode: does `<dir>/*` in `external_directory` cover nested folders?
- Antigravity: do rules in the bot's folder ever load (they need not; the identity is in the first message)?
- Devin and Antigravity: does an identity carried in the first message survive compaction? Over 32 KiB, how is the rule split under an additional
  directory?
