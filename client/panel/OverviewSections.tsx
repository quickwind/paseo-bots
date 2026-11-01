import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { botLimits, botMcpServers, botSkills, estimateTokens, utf8Bytes, type Bot } from "../../shared/bot";
import { projectFoldersNote } from "../../shared/folder-access";
import { teamOf } from "../../shared/groups";
import { describeSchedule } from "../../shared/routines";
import { hostCapsRpc, identityStatusRpc, systemPromptRpc } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { englishTranslate, type Translate } from "../../shared/translate";
import { useBotChats, useBotHost } from "../data";
import { MONO_FONT, MONO_PROPS } from "../native";
import { useT } from "../i18n/use-t";
import { code, codeLine, ui } from "../typography";
import type { PanelProps } from "./BotPanel";
import { CardNote, DrillRow, SectionMeta } from "./controls";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

// ---------------------------------------------------------------- overview

function size(text: string, t: Translate = englishTranslate): string {
  return t("panel.sizeTokens", { kb: (utf8Bytes(text) / 1000).toFixed(1), tokens: estimateTokens(text).toLocaleString() });
}

/** "Chief of Staff of Ops", "On Ops" or "No team". */
function teamLine(bot: Bot, groups: PanelProps["groups"], t: Translate = englishTranslate): string {
  const group = teamOf(bot.id, groups);
  if (!group) return t("panel.noTeam");
  if (group.leadId === bot.id) return t("panel.chiefOfStaffOf", { name: group.name });
  return t("panel.onTeam", { name: group.name });
}

export function OverviewSection({ colors, bot, library, groups, localHost, onSetup }: PanelProps) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const compose = useRpc(systemPromptRpc);
  const promptBot = useDebounced(bot, 600);
  const prompt = useQuery({
    // The server reads skills and teams from the saved settings, so changes there recompose too.
    queryKey: ["aydo", "prompt", JSON.stringify(promptBot), host.isLocal, JSON.stringify(library.skills), JSON.stringify(groups)],
    queryFn: () => compose({ bot: promptBot, local: host.isLocal }),
    // Keep the previous composition while edits recompose it, so the card doesn't jump.
    placeholderData: (previous) => previous,
  });
  const [sheet, setSheet] = useState<"summary" | "prompt" | null>(null);
  // Devin reads the identity from rule files that it cuts at 32 KB; say so when this one is long.
  const identityRpc = useRpc(identityStatusRpc);
  const identity = useQuery({
    queryKey: ["aydo", "identity", bot.id, prompt.dataUpdatedAt],
    queryFn: () => identityRpc({ botId: bot.id }),
    enabled: host.isLocal && /^devin(\b|$)/.test(bot.provider) && prompt.isSuccess,
  });

  // What the host does for Devin changes the note about project folders; only the local plugin can say.
  const askHostCaps = useRpc(hostCapsRpc);
  const caps = useQuery({ queryKey: ["aydo", "hostCaps"], queryFn: () => askHostCaps({}), enabled: host.isLocal, staleTime: Infinity });
  const foldersNote = projectFoldersNote(bot.provider, caps.data, t);

  const tools = [
    ...botMcpServers(bot, library).map((server) => server.name),
    ...botSkills(bot, library).map((skill) => t("panel.skillName", { name: skill.id })),
  ];
  const sections = prompt.data?.sections ?? [];

  return (
    <>
      <SettingsSection title={t("panel.setup")}>
        <SettingsCard>
          <SettingsAction label={t("panel.setUp")} hint={t("panel.setUpHint")} actionLabel={t("panel.start")} onPress={onSetup} />
        </SettingsCard>
      </SettingsSection>
      {identity.data?.note ? (
        <SettingsSection title={t("panel.devinRules")}>
          <SettingsCard>
            <CardNote colors={colors} text={identity.data.note} />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {foldersNote ? (
        <SettingsSection title={t("panel.inProjectFolder")}>
          <SettingsCard>
            <CardNote colors={colors} text={foldersNote} />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      <SettingsSection title={t("panel.aboutBot")}>
        <SettingsCard>
          <DrillRow colors={colors} label={t("panel.summary")} hint={t("panel.summaryHint")} onPress={() => setSheet("summary")} />
          <DrillRow colors={colors} label={t("panel.systemPrompt")} hint={prompt.data ? size(prompt.data.systemPrompt, t) : prompt.isError ? t("panel.composeFailed") : t("settings.loading")} onPress={() => setSheet("prompt")} />
        </SettingsCard>
      </SettingsSection>
      {sheet === "summary" ? (
        <Modal title={t("panel.summary")} open onOpenChange={(next) => !next && setSheet(null)}>
          <Modal.Content>
            <SettingsCard>
              <SettingsRow label={t("panel.does")} hint={bot.title || bot.description || t("panel.noTitle")} />
              <SettingsRow label={t("panel.team")} hint={teamLine(bot, groups, t)} />
              <SettingsRow label={t("panel.canReach")} hint={tools.length ? tools.join(t("text.change.listSep")) : t("panel.onlyBuiltIn")} />
              <SettingsRow label={t("panel.runs")} hint={bot.routines.length ? bot.routines.map((routine) => `${t("panel.routineLine", { name: routine.name, schedule: describeSchedule(routine.schedule, t) })}${routine.enabled ? "" : t("panel.pausedTag")}`).join("\n") : t("panel.onlyWhenMessaged")} />
              <SettingsRow label={t("panel.wont")} hint={botLimits(bot, { local: host.isLocal }, t).join("\n")} />
            </SettingsCard>
          </Modal.Content>
        </Modal>
      ) : null}
      {sheet === "prompt" ? (
        <Modal title={t("panel.systemPrompt")} open onOpenChange={(next) => !next && setSheet(null)}>
          <Modal.Content>
            <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{prompt.data ? t("panel.sentWithSize", { size: size(prompt.data.systemPrompt, t) }) : t("panel.sentWith")}</Text>
            {sections.length === 0 ? <CardNote colors={colors} text={prompt.isError ? t("panel.composeFailed") : t("settings.loading")} loading={!prompt.isError} /> : null}
            {sections.map((section) => (
              <View key={section.title} style={{ gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <Text style={{ fontSize: ui(14), color: colors.foreground }}>{section.title}</Text>
                  <SectionMeta colors={colors} text={size(section.text, t)} />
                </View>
                <View style={{ padding: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
                  <Text selectable {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foreground }}>
                    {section.text}
                  </Text>
                </View>
              </View>
            ))}
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- history

function summarize(before: Bot, after: Bot, t: Translate = englishTranslate): string {
  const labels: [keyof Bot, string][] = [
    ["name", t("panel.field.name")],
    ["title", t("panel.field.title")],
    ["description", t("panel.field.blurb")],
    ["avatar", t("panel.field.avatar")],
    ["soul", t("panel.field.standingInstructions")],
    ["skillIds", t("panel.field.skills")],
    ["routines", t("panel.field.routines")],
    ["playbooks", t("panel.field.playbooks")],
    ["mcpServerIds", t("panel.mcpServers")],
    ["alwaysAllow", t("panel.field.alwaysAllowed")],
    ["contactBots", t("panel.field.contactBots")],
    ["cwd", t("panel.field.folder")],
    ["hostId", t("panel.field.host")],
    ["provider", t("panel.field.provider")],
    ["model", t("panel.field.model")],
    ["modeId", t("panel.field.mode")],
    ["thinkingOptionId", t("panel.field.thinking")],
  ];
  const changed = labels.filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(([, label]) => label);
  return changed.length ? t("panel.changedSince", { list: changed.join(t("text.change.listSep")) }) : t("panel.sameAsNow");
}

export function HistorySection({ colors, bot, history, onRestore }: PanelProps) {
  const { t } = useT();
  const mine = history.filter((entry) => entry.botId === bot.id).reverse();
  return (
    <SettingsSection title={t("panel.earlierVersions")} info={t("panel.historyInfo")}>
      <SettingsCard>
        {mine.length === 0 ? <CardNote colors={colors} text={t("panel.noEarlier")} /> : null}
        {mine.map((entry) => (
          <SettingsAction key={entry.at} label={t("panel.versionFrom", { when: relativeTime(entry.at, undefined, t) })} hint={summarize(entry.snapshot, bot, t)} actionLabel={t("panel.restore")} onPress={() => onRestore(entry.snapshot)} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------- usage

export function UsageSection({ bot, localHost }: PanelProps) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const chats = useBotChats(host, bot.id);
  const list = chats.data ?? [];
  const sum = (pick: (usage: NonNullable<(typeof list)[number]["lastUsage"]>) => number | undefined) =>
    list.reduce((total, chat) => total + (chat.lastUsage ? (pick(chat.lastUsage) ?? 0) : 0), 0);
  const input = sum((usage) => usage.inputTokens);
  const output = sum((usage) => usage.outputTokens);
  const cost = sum((usage) => usage.totalCostUsd);
  const working = list.filter((chat) => chat.status === "running").length;
  const loading = chats.isLoading;
  return (
    <SettingsSection title={t("panel.allChats")} info={t("panel.usageInfo")}>
      <SettingsCard>
        <SettingsRow label={t("panel.chats")} hint={loading ? t("settings.loading") : `${t("panel.openCount", { n: list.length })}${working ? t("panel.workingNow", { n: working }) : ""}`} />
        <SettingsRow label={t("panel.tokens")} hint={loading ? t("settings.loading") : t("panel.tokensInOut", { input: input.toLocaleString(), output: output.toLocaleString() })} />
        <SettingsRow label={t("panel.cost")} hint={loading ? t("settings.loading") : cost > 0 ? `$${cost.toFixed(2)}` : t("panel.notReported")} />
      </SettingsCard>
    </SettingsSection>
  );
}
