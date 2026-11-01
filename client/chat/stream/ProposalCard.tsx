import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { EMPTY_LIBRARY, newRoutineId, type Bot } from "../../../shared/bot";
import { afterSetupNotes } from "../../../shared/setup";
import { applyChanges, changeWarnings, describeChange, type Change } from "../../../shared/changes";
import { setBotUses, updateSkill, upsertSkills } from "../../../shared/library";
import type { Proposal } from "../../../shared/proposals";
import { describeSchedule, upcomingRuns } from "../../../shared/routines";
import { proposalAcceptRpc, proposalDismissRpc, proposalGetRpc } from "../../../shared/rpc";
import { scanSkillText, skillBody } from "../../../shared/skills";
import { workspaceLabel } from "../../../shared/workspaces";
import { skillQueryKey } from "../../library/SkillPage";
import { Markdown } from "../../Markdown";
import { errorText } from "../../native";
import { Alert } from "../../panel/controls";
import { ui } from "../../typography";
import { useBotSettings } from "../../useBotSettings";
import { PlanCard } from "./PlanCard";
import { CardButton } from "./ui";
import { useT } from "../../i18n/use-t";
import type { Translate } from "../../../shared/translate";

type Colors = PluginTheme["colors"];

const proposalQueryKey = (id: string) => ["aydo", "proposal", id];

const OUTCOME = { pending: "pending", accepted: "approved", dismissed: "rejected" } as const;

/**
 * Something a bot proposed with propose_skill (usually after /learn),
 * propose_routine or propose_changes, laid out like Paseo's plan card with the
 * actions under it. Skills are saved to Skills & Tools as reviewed and turned on
 * for the bot; routines are added to the bot and report back to this chat;
 * setup changes are applied together.
 */
export function ProposalCard({ colors, compact, proposalId }: { colors: Colors; compact: boolean; proposalId: string }) {
  const { t } = useT();
  const get = useRpc(proposalGetRpc);
  const accept = useRpc(proposalAcceptRpc);
  const dismiss = useRpc(proposalDismissRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { settings, commit } = useBotSettings();
  const [busy, setBusy] = useState<"save" | "dismiss" | null>(null);
  // What went wrong with the last click, shown on the card itself (a toast alone is easy to miss).
  const [failure, setFailure] = useState<string | null>(null);
  const query = useQuery({ queryKey: proposalQueryKey(proposalId), queryFn: () => get({ id: proposalId }) });
  const proposal = query.data?.proposal;

  if (query.isPending) return null;
  if (!proposal) {
    return <Text style={{ marginVertical: 12, fontSize: ui(14), color: colors.foregroundMuted }}>{query.isError ? t("cards.proposal.loadError", { error: errorText(query.error) }) : t("cards.proposal.gone")}</Text>;
  }

  const values = settings.status === "ready" ? settings.values : null;
  const bot = values?.bots.find((entry) => entry.id === proposal.botId);
  const view =
    proposal.kind === "skill"
      ? skillView(proposal, bot, !!values?.library?.skills.some((skill) => skill.id === proposal.data.name), t)
      : proposal.kind === "routine"
        ? routineView(proposal, bot, t)
        : proposal.kind === "ask"
          ? askView(proposal, bot, t)
          : proposal.kind === "workspace"
            ? workspaceView(proposal, bot, t)
            : changesView(proposal, t);

  const save = async () => {
    setBusy("save");
    setFailure(null);
    const fail = (text: string) => {
      setFailure(text);
      toast.error(text);
    };
    try {
      if (proposal.kind === "ask" || proposal.kind === "workspace") {
        // The server acts when it accepts (sends the question, creates the workspace); nothing is saved in the settings.
        queryClient.setQueryData(proposalQueryKey(proposal.id), await accept({ id: proposal.id }));
        toast.show(proposal.kind === "ask" ? (proposal.data.workspace ? t("cards.proposal.toast.assigned") : t("cards.proposal.toast.questionSent")) : t("cards.proposal.toast.allowedCreating"), { variant: "success" });
        return;
      }
      if (proposal.kind === "changes") {
        // The card on screen may be out of date (it was dismissed in another window): ask the server first, so nothing is applied for a card that is no longer pending.
        const fresh = await get({ id: proposal.id });
        if (fresh.proposal?.status !== "pending") {
          queryClient.setQueryData(proposalQueryKey(proposal.id), fresh);
          fail(t("cards.proposal.alreadyHandled"));
          return;
        }
        // Applied before the proposal counts as accepted: a change that no longer fits leaves the card pending.
        const context = { now: new Date().toISOString(), provider: proposal.data.provider };
        if (!(await commit((current) => applyChanges(current, proposal.data.changes, context)))) {
          // commit has already said why when the settings changed under it; it is silent when they have not loaded.
          setFailure(t("cards.proposal.saveFailed"));
          return;
        }
        queryClient.setQueryData(proposalQueryKey(proposal.id), await accept({ id: proposal.id }));
        toast.show(t("cards.proposal.toast.applied", { count: proposal.data.changes.length }), { variant: "success" });
        return;
      }
      const { proposal: saved, skill } = await accept({ id: proposal.id });
      const applied = await commit((current) => {
        if (proposal.kind === "routine") {
          const routine = { id: newRoutineId(), ...proposal.data, enabled: true, createdAt: new Date().toISOString() };
          return { ...current, bots: current.bots.map((entry) => (entry.id === saved.botId ? { ...entry, routines: [...entry.routines, routine] } : entry)) };
        }
        if (!skill) return current;
        return {
          ...current,
          library: updateSkill(upsertSkills(current.library ?? EMPTY_LIBRARY, [{ id: skill.id, description: skill.description, source: "", reviewedSha: skill.sha }]), skill.id, { enabled: true }),
          bots: current.bots.map((entry) => (entry.id === saved.botId ? setBotUses(entry, "skill", skill.id, true) : entry)),
        };
      });
      queryClient.setQueryData(proposalQueryKey(proposal.id), { proposal: saved });
      // The server counts it as accepted already, so the card can't be tried again: say what is missing.
      if (!applied) fail(proposal.kind === "routine" ? t("cards.proposal.routineNotAdded") : t("cards.proposal.skillNotOn"));
      else toast.show(proposal.kind === "routine" ? t("cards.proposal.toast.routineCreated", { name: proposal.data.name }) : t("cards.proposal.toast.skillSaved", { name: proposal.data.name }), { variant: "success" });
      if (skill) void queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
    } catch (error) {
      fail(t("cards.proposal.saveError", { error: errorText(error) }));
      void query.refetch();
    } finally {
      setBusy(null);
    }
  };

  const drop = async () => {
    setBusy("dismiss");
    setFailure(null);
    try {
      queryClient.setQueryData(proposalQueryKey(proposal.id), await dismiss({ id: proposal.id }));
    } catch (error) {
      const text = t("cards.proposal.dismissError", { error: errorText(error) });
      setFailure(text);
      toast.error(text);
      void query.refetch();
    } finally {
      setBusy(null);
    }
  };

  // Once a bot's setup is applied: the model and the memory tidy it now has, and where to change them.
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const updatesItself = (change: Change) => change.type === "update_bot" && !!bot && (change.bot === bot.id || same(change.bot, bot.name) || (change.name !== undefined && same(change.name, bot.name)));
  const appliedBot = proposal.status === "accepted" && proposal.kind === "changes" && proposal.data.changes.some(updatesItself) ? bot : undefined;
  const afterNotes = appliedBot ? afterSetupNotes(appliedBot, t) : [];

  const failed = failure ? <Alert colors={colors} variant="error" title={t("cards.notDone")} description={[failure]} /> : null;
  const done = proposal.status === "accepted" ? doneNote(proposal, bot, t) : null;
  const footer =
    proposal.status === "pending" ? (
      <>
        {failed}
        {view.warnings.length ? <Alert colors={colors} variant="warning" title={t("library.checkFirst")} description={view.warnings} /> : null}
        {view.notes.map((note) => (
          <Text key={note} style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
            {note}
          </Text>
        ))}
        <View style={compact ? { gap: 8, marginTop: 4 } : { gap: 8, marginTop: 4, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
          <CardButton colors={colors} label={t("chat.stream.dismiss")} icon="X" busy={!!busy} spinning={busy === "dismiss"} onPress={() => void drop()} />
          <CardButton colors={colors} label={view.action} icon="Check" primary busy={!!busy} spinning={busy === "save"} onPress={() => void save()} />
        </View>
      </>
    ) : done || afterNotes.length || failed ? (
      <>
        {failed}
        {done ? <Markdown colors={colors} text={done} linkify={false} /> : null}
        {afterNotes.map((note) => (
          <Markdown key={note} colors={colors} text={note} linkify={false} />
        ))}
      </>
    ) : undefined;

  return <PlanCard colors={colors} title={view.titles[proposal.status]} description={view.description} text={view.text} outcome={OUTCOME[proposal.status]} footer={footer} />;
}

interface ProposalView {
  titles: Record<Proposal["status"], string>;
  description: string;
  text: string;
  warnings: string[];
  /** Lines above the buttons while it's pending. */
  notes: string[];
  action: string;
}

function skillView(proposal: Extract<Proposal, { kind: "skill" }>, bot: Bot | undefined, exists: boolean, t: Translate): ProposalView {
  const { name, description, text } = proposal.data;
  const titles = exists
    ? { pending: t("cards.proposal.skill.titleUpdated", { name }), accepted: t("cards.proposal.skill.titleSaved", { name }), dismissed: t("cards.proposal.skill.titleDismissed", { name }) }
    : { pending: t("cards.proposal.skill.titleNew", { name }), accepted: t("cards.proposal.skill.titleSaved", { name }), dismissed: t("cards.proposal.skill.titleDismissed", { name }) };
  return {
    titles,
    description,
    text: skillBody(text),
    warnings: scanSkillText(text, t),
    notes: [skillNote(exists, name, bot, t)],
    action: exists ? t("cards.proposal.skill.actionUpdate") : t("cards.proposal.skill.actionSave"),
  };
}

function skillNote(exists: boolean, name: string, bot: Bot | undefined, t: Translate): string {
  if (exists) return bot ? t("cards.proposal.skill.noteReplaceBot", { name, bot: bot.name }) : t("cards.proposal.skill.noteReplace", { name });
  return bot ? t("cards.proposal.skill.noteSaveBot", { bot: bot.name }) : t("cards.proposal.skill.noteSave");
}

function routineView(proposal: Extract<Proposal, { kind: "routine" }>, bot: Bot | undefined, t: Translate): ProposalView {
  const { name, prompt, schedule } = proposal.data;
  const now = new Date();
  const next = upcomingRuns(schedule, now, now, 3);
  const timing =
    schedule.kind === "webhook"
      ? t("cards.proposal.routine.webhook")
      : next.length
        ? t("cards.proposal.routine.next", { count: next.length, list: next.map((at) => at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })).join(" · ") })
        : t("cards.proposal.routine.noUpcoming");
  return {
    titles: { pending: t("cards.proposal.routine.titleNew", { name }), accepted: t("cards.proposal.routine.titleScheduled", { name }), dismissed: t("cards.proposal.routine.titleDismissed", { name }) },
    description: describeSchedule(schedule, t),
    text: prompt,
    warnings: [],
    notes: [timing, bot ? t("cards.proposal.routine.eachRunBot", { bot: bot.name }) : t("cards.proposal.routine.eachRun")],
    action: t("routines.create"),
  };
}

function askView(proposal: Extract<Proposal, { kind: "ask" }>, bot: Bot | undefined, t: Translate): ProposalView {
  const { toName, message, workspace } = proposal.data;
  if (workspace) {
    return {
      titles: { pending: t("cards.proposal.assign.titlePending", { name: toName }), accepted: t("cards.proposal.assign.titleAccepted", { name: toName }), dismissed: t("cards.proposal.assign.titleDismissed", { name: toName }) },
      description: t("cards.proposal.assign.description", { bot: bot?.name ?? t("cards.proposal.aBot"), name: toName, workspace: workspaceLabel(workspace) }),
      text: message,
      warnings: [],
      notes: [
        t("cards.proposal.assign.note", { name: toName, directory: workspace.directory }),
        ...(workspace.projectName ? [t("cards.proposal.assign.remembers", { project: workspace.projectName })] : []),
      ],
      action: t("cards.proposal.assign.action"),
    };
  }
  return {
    titles: { pending: t("cards.proposal.ask.titlePending", { name: toName }), accepted: t("cards.proposal.ask.titleAccepted", { name: toName }), dismissed: t("cards.proposal.ask.titleDismissed", { name: toName }) },
    description: t("cards.proposal.ask.description", { bot: bot?.name ?? t("cards.proposal.aBot"), name: toName }),
    text: message,
    warnings: [],
    notes: [t("cards.proposal.ask.note", { name: toName })],
    action: t("cards.proposal.ask.action"),
  };
}

function workspaceView(proposal: Extract<Proposal, { kind: "workspace" }>, bot: Bot | undefined, t: Translate): ProposalView {
  const { project, input, scope } = proposal.data;
  const what = worktreeText(input, t);
  return {
    titles: { pending: t("cards.proposal.workspace.titleNew", { title: input.title }), accepted: t("cards.proposal.workspace.titleAllowed", { title: input.title }), dismissed: t("cards.proposal.workspace.titleDismissed", { title: input.title }) },
    description: t("cards.proposal.workspace.description", { bot: bot?.name ?? t("cards.proposal.aBot"), project: project.name }),
    text: t("cards.proposal.workspace.what", { what }),
    warnings: [],
    notes: [scope.startsWith("team:") ? t("cards.proposal.workspace.remembersTeam", { project: project.name }) : t("cards.proposal.workspace.remembersBot", { project: project.name })],
    action: t("cards.proposal.workspace.action"),
  };
}

function worktreeText(input: Extract<Proposal, { kind: "workspace" }>["data"]["input"], t: Translate): string {
  if (!input.worktree) return t("cards.proposal.workspace.plainFolder");
  if (input.branch && input.base) return t("cards.proposal.workspace.worktreeBoth", { branch: input.branch, base: input.base });
  if (input.branch) return t("cards.proposal.workspace.worktreeBranch", { branch: input.branch });
  if (input.base) return t("cards.proposal.workspace.worktreeBase", { base: input.base });
  return t("cards.proposal.workspace.worktree");
}

function changesView(proposal: Extract<Proposal, { kind: "changes" }>, t: Translate): ProposalView {
  const { summary, changes } = proposal.data;
  const what = t("cards.proposal.changesCount", { count: changes.length });
  return {
    titles: { pending: t("cards.proposal.changesTitle.pending"), accepted: t("cards.proposal.changesTitle.accepted"), dismissed: t("cards.proposal.changesTitle.dismissed") },
    description: summary,
    // A change with lines of its own (a bot's name, title and instructions) stands as a block; the short ones are list items.
    text: changes.map((change) => describeChange(change, t)).map((line) => (line.includes("\n") ? `\n${line}\n` : `- ${line}`)).join("\n"),
    warnings: changeWarnings(changes, t),
    notes: [t("cards.proposal.changes.note", { what })],
    action: t("cards.proposal.changes.action"),
  };
}

/** What a saved proposal did and where to find it, so the card says more than its title. */
function doneNote(proposal: Proposal, bot: Bot | undefined, t: Translate): string | null {
  const who = bot?.name ?? t("cards.proposal.theBot");
  switch (proposal.kind) {
    case "changes": {
      const count = proposal.data.changes.length;
      return t("cards.proposal.changes.done", { what: t("cards.proposal.changesCount", { count }) });
    }
    case "routine":
      return t("cards.proposal.routine.done", { bot: who });
    case "skill":
      return t("cards.proposal.skill.done", { bot: who });
    case "ask":
      return proposal.data.workspace ? t("cards.proposal.assign.done", { name: proposal.data.toName }) : t("cards.proposal.ask.done");
    case "workspace":
      return t("cards.proposal.workspace.done");
  }
}
