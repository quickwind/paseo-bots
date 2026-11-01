# The software team: an example blueprint

A **blueprint** is a team set up with its process written down: the bots, who leads, and the text they all follow. This is a worked
example of a team that builds features in the user's projects: an admin (the lead), an architect, a designer and a
developer. It exists for two reasons: to show how a team's process is written as text, and to be the full test of the plugin's
mechanisms (workspaces, assignment, approvals, team reports) with real bots.

(It is not what the plugin calls a *playbook*: that is a per-bot text picked by trigger words in a chat's first message. See "Where each
text goes" below.)

**The plugin knows none of this.** It has no roles and no stages. Everything below is text the bots read: the team's shared
instructions (`team.md`, the same for every bot on the team) and a short text for each role (`admin.md`, `architect.md`,
`designer.md`, `developer.md`, each bot's own instructions). Change the text and the process changes; no new plugin version is needed.
What the plugin provides is the mechanism the text uses: bots create workspaces, assign work to each other in a workspace, ask the
user for approval (only the user can give it), and the team's reports record what each bot did.

## The flow

1. **Intake**: the user asks the admin; the admin opens the feature's workspace and assigns the architect.
2. **Architecture**: the architect judges the size; a large feature gets an architecture document and the user's approval.
3. **Design**: the designer writes the design and plan; the user approves it.
4. **Lanes**: the designer splits the plan into lanes (one workspace each, branched from the feature) and assigns developers.
5. **Build**: the developer builds and tests a lane and reports (starting with BLOCKED when stuck).
6. **Review**: the designer reviews each lane, sends it back or merges it into the feature's branch.
7. **Acceptance**: the designer asks the user to approve the finished feature. Nobody merges into the main branch or pushes.

Three approval points, all the user's: architecture (large features only), design, acceptance. Each is a card in the asking bot's
chat; the bot waits until the user decides; a rejection is a conversation until it is approved.

## Where each text goes

| Text | Where in Paseo | Who reads it | When |
|---|---|---|---|
| The team's flow (`team.md`) | Team menu, edit team, *Shared instructions* | Every bot on the team | Always, in every chat, including chats started by an assignment |
| A role's way of working (`admin.md` ...) | The bot's settings, *Instructions* | That bot | Always |
| A *playbook* (not used here) | The bot's settings, *Playbooks* | That bot | Only in a chat whose first message contains one of the playbook's trigger words (you write the words); the plugin matches them, the model does not guess |
| A *skill* (not used here) | Skills & Tools | Bots you switch it on for | The bot reads its `SKILL.md` when it decides it fits; it can have files and scripts |

## Use it

1. Build the team file after editing the text: `node scripts/build-software-team.mjs` (a test fails if the file and the text differ).
2. In the Bots screen, import `software-team.team.json` (Import, then the file). Four bots appear in one team, Admin as lead.
3. The file names no provider and no model, so it works anywhere: the import gives every bot the default provider (Claude when
   it is ready), and you choose each bot's provider and model in its settings (for example Devin for the Developer). The text works
   with any provider: bots with MCP tools use them, bots on files use their outbox.
4. Let the team assign work to each other: turn on the team's "members may ask each other without asking you" switch, or set each
   bot's "Contact other bots" to Allowed. Otherwise you approve each assignment on a card.
5. In a project, tell the admin what to build. The first workspace in a project the team has not used asks you once.

## Change it

- **Fewer approvals**: delete the stage's "ask the user to approve" lines in `team.md` (and the matching sentence under Approvals).
- **A different size rule**: edit the *Large* and *Small* lines in stage 2.
- **Another role** (tester, reviewer): add a bot, add its stage to `team.md`, say who hands work to it.
- **Not software**: a workspace can be a plain folder. Replace the stages with yours (research, draft, review, publish) and keep
  the approvals you want. The mechanisms are the same.

## The full test (what it proves)

Run on a scratch project in a test instance of Paseo. Each step has something to see:

1. The user asks the admin for a small feature: the admin creates a worktree workspace and assigns the architect; the board shows the workspace.
2. The architect judges it large, writes `docs/architecture/<feature>.md`, and the card shows the file; the user rejects once
   with a reason; the architect revises and asks again; the user approves.
3. The designer (assigned with the approval cited) writes the design, the user approves, the designer opens two lane workspaces and assigns developers (one on Devin through files).
4. The developers build, one reports BLOCKED and gets help, the designer reviews, sends one back, merges both.
5. The designer asks for acceptance; the user approves; the admin's memory and answer to "how is it going?" match the reports.
6. The audit lists every approval with who, when and the decision; no bot approved anything.
