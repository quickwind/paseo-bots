# Approvals: a bot asks the user for a decision and waits (design)

Status: built (2026-10-21).

## Why

The workflow the user wants for a team of bots (architect, designer, developer, admin) has points where a person must decide
before work goes on: an architecture, a design, a final acceptance. Which points exist will change over time and differ by
team and project. So the plugin must provide the **mechanism** (ask the user, block, record) and must not know the **process**
(which decisions exist, who asks, what follows). The process lives in the team's playbook and the bots' instructions.

An approval is not a proposal card. A proposal (skill, routine, changes, ask, workspace) is a request the user may answer
whenever; the bot goes on meanwhile. An approval **blocks the asking chat** until the user decides, and every approval is
**recorded for audit**.

## Goals

- A bot can ask the user to approve **a matter** (a title and a text; optionally a file such as a plan in markdown).
- Only the user can decide. No tool, file or command that the plugin or the host gives a bot can approve or reject (see "What is and
  is not guaranteed" for the one path that stays open). The asking bot may withdraw its own pending request; that grants nothing.
- While an approval is pending, the asking chat is blocked as far as the plugin can block it (see "Blocking").
- Rejecting means discussion: the user talks with the bot in the same chat, the bot revises and asks again (a new approval).
- Every approval leaves an append-only audit record: which bot, which chat, which team and project, what matter, when asked,
  when answered, the result and the user's note.
- Works for Claude (MCP tools) and for Devin and Antigravity (files twin), as every plugin tool does, and on stock Paseo.

## Non-goals

- No knowledge of "architecture", "design" or "acceptance". Names are free text chosen by the playbook.
- No version chain between approvals (a second ask after a rejection is a new approval; order in the audit shows the rounds).
- No rules engine in this step ("this action needs an approved approval"): that is process, and a prose playbook is advisory.
  A later optional layer in the team settings may enforce rules; it is not built here.
- No approval by anyone but the user (no delegation to another bot, no auto-approve switch).
- Not a replacement for a provider's own permission prompts (tool approvals stay as they are).

## Anti-goals (a failure even if it technically works)

- A bot able to mark its own approval as approved, by any tool or file the plugin provides.
- An audit record a bot can edit through the plugin's own folders.
- The plugin claiming it guarantees what it cannot (see "What is and is not guaranteed").

## What it is

### The approval

Fields: `id` (`a-` and ten hex), `botId`, `agentId` (the asking chat), `teamId` (or none), `project` and `workspace` of the
chat (when it runs in one), `title` (short), `text` (what is asked, markdown), `file` (optional: path the bot names, shown in
full on the card; read by the plugin, see "The file"), `status` (`pending`, `approved`, `rejected`, `withdrawn`),
`createdAt`, `decidedAt`, `note` (the user's note on approval, reason on rejection).

States: `pending` → `approved` or `rejected` (by the user) or `withdrawn` (the asking bot, or the user from the card or the
Bots list, cancels it while pending; the plugin does it when the asking chat is archived or its bot deleted; recorded with who).
Nothing else changes a state. A chat has at most one pending approval: a second `request_approval` while one waits is refused
("one at a time").

### The card

A timeline card in the asking chat (plugin item, like proposal cards): title, text, the file's text collapsible, buttons
Approve and Reject, a note field (optional on approve; required on reject, so the bot learns what to change). After the
decision the card shows the result, who decided and when. The decision is made by an RPC from the user's browser only, as
for proposals; no tool or file of a bot reaches it.

### Asking

- MCP tool `request_approval({ title, text, file? })` and tool `list_approvals({ status? })` (the bot's own, newest first),
  `withdraw_approval({ id })`.
- Files twin for providers on files: an `outbox/` file `{"kind":"approval","title":...,"text":...,"file":...}`; `setup/` gets a
  short page on approvals; `list_approvals` is `setup/approvals.md` (rewritten by the plugin, read only), as `setup/workspaces.md`
  is today.
- The tool's reply says the user decides, the bot must stop and wait, and the answer will arrive as a message in this chat.

### Blocking

What "blocked" means, in the order it happens:

1. **The turn stops.** After the ask, the bot is told to stop. If it goes on (MCP bots only; a files bot has already ended its
   turn when the outbox file is seen), the plugin interrupts the running turn by sending a short message with
   `activeTurnBehavior: "interrupt"` through `agents.ref(id).send` (the SDK has no cancel; the daemon interrupts a turn on
   `send` by default). Verified 2026-10-21 on a test instance: Claude (Haiku 5.5) stopped streaming and stopped a
   foreground shell command (no process left), Devin (swe-1-6-slow) stopped streaming, both answered the next message
   normally. OpenCode and Antigravity are not verified. The message costs one short extra turn. Best effort: the plugin
   records in the audit whether the chat went idle.
2. **The plugin's messages are held.** While an approval of this chat is pending, the plugin sends nothing into that chat
   except the answer to the approval itself: not ask replies and follow-ups, not assignment reports, not the memory save prompt,
   not refusal notes or workspace notices, not an ask's close notice. They are kept in a file and delivered, in order, after the
   decision and after the answer message; a held message is not lost if the plugin restarts. An ask counts as answered when the
   other bot's turn ends (as today); only the delivery waits.
   **An assignment or ask is not finished by a pending approval.** If the asking chat itself was started by an ask or an
   assignment, its turn ending to wait for approval is not its report: the request stays open, its report is the turn end
   after the decision, and its stall timer (12 hours, 30 minutes for a question) does not run while the approval is pending
   (it restarts at the decision). The team report line for the turn says `waiting for approval` (a new status beside done,
   failed, stopped, blocked), so the lead sees why the chat is quiet.
3. **Woken anyway is recorded.** If a turn starts in the chat while its approval is pending (a message the plugin did not send:
   the user typing, or something that bypassed the plugin), the plugin cannot tell the two apart, so it only notes it in the
   audit and on the card ("the chat was active while waiting: n times"). The user typing is allowed and is how a rejection
   is discussed.
4. **Plugin actions are checked when the bot cites an approval.** `assign_bot` and `create_workspace` (and their files
   twins) accept an optional `approval` id. If given, the plugin checks it exists, belongs to the same team (or bot),
   and is approved, else refuses with the reason. A made-up or pending id never passes. Whether a bot must cite one is
   the playbook's rule, not enforced here.
5. **After the decision** the answer is sent into the chat as a message ("Approved: <title>. Note: ..." or "Rejected: <title>.
   Reason: ..."), then held messages follow.

### What is and is not guaranteed

Guaranteed: no tool, file or command given to a bot decides an approval; the audit is complete for every approval asked through the
plugin; a cited approval is checked; the plugin's own messages into the chat are held; an approval can't be edited after the
decision.
Not guaranteed: that the decision cannot be forged by a bot that writes its own client for the daemon. The decision is a plugin RPC
(`plugin.rpc.invoke.request`, a WebSocket message that needs the daemon's `daemon.manage` permission); the host has no command-line
verb for it and a bot's MCP tools do not include it, but a bot with a shell and a WebSocket client could send it, and the plugin cannot
tell that caller from the browser. The same is true of proposal cards today. Closing it would need the host to mark UI calls (a host
change, not planned). The audit then shows a decision with no matching card interaction only if the card records its click, so the card
sends a click marker with the RPC and the audit stores it (a weak check, not a guarantee). Also not guaranteed: that a bot that ignores its playbook is stopped. It can skip asking, or write code in its own chat. On stock
Paseo another chat can also wake the chat through Paseo's own `send_agent_prompt` or `paseo send`; a host may
refuse messages that carry a source agent (stock Paseo does not); whether a bot can
drop the source marker was not checked. The plugin's answer to these is the audit note (3), not prevention.

### The audit

An append-only file `approvals/audit.jsonl` in the plugin data folder, outside every bot's folder and outside the shared
folders attached to any chat. One line per event: `asked`, `decided` (approved or rejected, with note), `withdrawn`,
`woken` (turn started while pending), `cited` (an action checked this approval: action, ok or reason). Each line has the
approval id, time (UTC and local), bot id and name, chat id and title, team, project, workspace. State (the current
approval records) is a separate file `approvals.json`, written atomically and serially like `proposals.json`. The audit is
kept forever (small). A bot with an unrestricted shell can still reach any file the provider lets it; the plugin does not
claim tamper-proofness against that (no hash chain in this step).

### Where the user sees them

- The card in the chat (above).
- A list in the Bots screen: pending first, then history from the audit (bot, matter, asked, answered, result, note), with a
  link to the chat; and a count of pending approvals on the Bots nav item. Pending approvals of chats the user has not
  opened are otherwise easy to miss, so this list matters.

## The file

The bot names a path; the plugin reads it as text (at most 200 KB, UTF-8, the whole file stored in the approval at ask time,
so the user approves exactly what was shown and a later edit cannot change what was approved; the card says which file and
its checksum). The path must be inside the bot's own folder or the chat's workspace; a link is never followed. A bigger or
missing file makes the tool refuse with the reason.

## What the playbook (process) decides, not the plugin

- Which decisions exist and their names ("architecture", "design", "acceptance", others).
- Who asks (architect, designer, developer, admin) and when.
- What a bot does after Approved or Rejected; whether it cites the approval when it assigns or creates a workspace.
- Per team or project differences. The three nodes the user named (architecture, design and final acceptance need the user's
  approval) are the first playbook that uses this; writing that playbook is a separate step.

## Constraints

- No network code (`tests/no-network.test.ts`).
- Runs on stock Paseo; no host change needed (the cancel API the host lacks is replaced by `send` with interrupt;
  a host `cancel()` would be a later improvement, announced through the host-capabilities environment variable).
- Approvals are only for chats on the plugin's own host (the app knows a bot's host); a bot on another host gets a refusal, as with asks.
- Devin: no MCP; files twin required. Chats whose provider cannot be interrupted still work (items 2, 3, 4 and the card hold).
- State files written with `writeAtomic`, serially; never follow links; text from bots is data, shown, never run.

## Left to the builder

Tool and file names beyond the above; exact card layout and wording; the shape of held-message storage; how the pending count
reaches the nav item; the exact interrupt message text and the delay before it is sent (the MCP reply must reach the bot first;
settle with a spike); how `woken` is detected (turn started while pending, not caused by a plugin send); test plan (unit tests,
then a real run on Claude and Devin).

## Decisions made by the user (2026-10-21)

- Approval is a general type for matters, not only plans; no versions.
- It differs from other cards in that it blocks the chat and is audited (who, when asked, when answered, result).
- Only the user can approve, even if another bot delegated the task; discussion continues until approved.
- The gate belongs to the process (playbook), not the mechanism; start soft, add enforcement rules later if wanted.
- The user typing in a pending chat is fine; the host's own composer cannot be locked by a plugin and need not be.
- Not testing OpenCode and Antigravity interruption now.

## Calls made by the writer (check these)

- Names `request_approval`, `list_approvals`, `withdraw_approval`, outbox kind `approval`.
- Free-text names are not needed: the matter's title serves; no separate "kind" field.
- Required note on reject, optional on approve.
- File up to 200 KB, stored whole at ask time; path inside the bot's folder or the chat's workspace.
- Pending never times out (no auto-reject); the Bots list and the nav count make it visible.
- The audit has no tamper-proofing beyond sitting outside the bots' folders.
- One pending approval per chat; refused otherwise.
- A pending approval does not finish an assignment or ask: the request stays open, the stall timer pauses, the team report says
  `waiting for approval` (this touches `server/asks.ts` and `shared/reports.ts`).
- All of the plugin's messages into the chat are held while pending, not only other bots' messages (the memory save prompt included).
- The user can cancel a pending approval from the card or the list; archiving the chat or deleting the bot withdraws it.
- The decision RPC can in principle be called by a bot that writes its own daemon client; documented as not guaranteed, with a
  click marker in the audit as a weak check.
- Bots on another host cannot ask for approvals.
- The Bots-screen list and the nav count are part of this step.
