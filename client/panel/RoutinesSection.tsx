import { useRpc } from "@getpaseo/plugin/client";
import { Modal, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { newRoutineId, type Bot, type Routine, type RoutineSchedule } from "../../shared/bot";
import { displayTitle, ROUTINE_LABEL } from "../../shared/chat";
import { CRON_PRESETS, describeCron, describeSchedule, formatLocalDateTime, nextRun, parseLocalDateTime, scheduleToCron, upcomingRuns, validateCron } from "../../shared/routines";
import { routineRunNowRpc, routineStatusRpc, routineWebhookRpc, type RoutineRun } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { isChineseLocale, type Translate } from "../../shared/translate";
import { useBotChats, useBotHost, type BotHost } from "../data";
import { confirmDialog, errorText } from "../native";
import { useT } from "../i18n/use-t";
import { useMenu } from "../ui/Menu";
import { Alert, type BadgeVariant, Button, CardNote, DrillRow, InputField, KebabButton, PressableRow, RowText, SectionLink, SheetFooter, StatusBadge, TextAreaField } from "./controls";
import type { PanelProps } from "./BotPanel";

type Colors = PanelProps["colors"];

// Routines follow Paseo's Schedules (components/schedules/*): a card of rows with a status
// badge and a kebab (Edit, Pause/Resume, Run now, Delete), and a sheet form with a cadence
// preset + cron field. Runs happen on the host that stores the bot (server/scheduler.ts).

/** Paseo's formatNextRun (utils/schedule-format.ts): "soon", "in 12m", "in 3h", "in 2d". */
function formatNextRun(next: Date, now: number, t: Translate): string {
  const diff = next.getTime() - now;
  if (diff < 60_000) return t("routines.nextSoon");
  if (diff < 3_600_000) return t("routines.inMinutes", { n: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return t("routines.inHours", { n: Math.round(diff / 3_600_000) });
  return t("routines.inDays", { n: Math.round(diff / 86_400_000) });
}

function routineState(routine: Routine, next: Date | null, t: Translate): { label: string; variant: BadgeVariant } {
  if (!routine.enabled) return { label: t("routines.paused"), variant: "muted" };
  // A webhook routine has no next time but stays ready to run.
  if (!next && routine.schedule.kind !== "webhook") return { label: t("routines.finished"), variant: "muted" };
  return { label: t("routines.active"), variant: "success" };
}

/** Cadence → history → future, like Paseo's schedule rows; status stays on the badge. */
function routineMeta(routine: Routine, run: RoutineRun | undefined, next: Date | null, t: Translate): string {
  const parts = [describeSchedule(routine.schedule, t)];
  const when = relativeTime(run?.startedAt, undefined, t);
  if (!run) parts.push(t("routines.neverRun"));
  else if (run.status === "failed") parts.push(t("routines.failedAt", { when, error: run.error ?? t("routines.unknownError") }));
  else if (run.status === "skipped-busy") parts.push(t("routines.skippedAt", { when }));
  else if (run.status === "skipped-missed") parts.push(t("routines.missedAt", { when }));
  else parts.push(t("routines.lastRun", { when }));
  if (routine.enabled && next) parts.push(t("routines.nextRun", { when: formatNextRun(next, Date.now(), t) }));
  return parts.join(" · ");
}

const ROUTINES_KEY = ["aydo", "routines"];
const UPCOMING = 6;
const UPCOMING_DAYS = 7;
const RECENT = 10;

function runLabel(status: RoutineRun["status"], t: Translate): string {
  switch (status) {
    case "running":
      return t("routines.running");
    case "succeeded":
      return t("text.bucket.done");
    case "failed":
      return t("text.bucket.failed");
    case "skipped-busy":
      return t("routines.skippedBusy");
    case "skipped-missed":
      return t("routines.statusMissed");
  }
}

function triggerLabel(trigger: RoutineRun["trigger"], t: Translate): string {
  switch (trigger) {
    case "schedule":
      return t("routines.onSchedule");
    case "manual":
      return t("routines.byYou");
    case "webhook":
      return t("routines.fromWebhook");
  }
}

/** A preset's label in the UI language; the English labels in shared/routines.ts are only the fallback. */
function presetLabel(preset: { id: string; label: string }, t: Translate): string {
  switch (preset.id) {
    case "every-minute":
      return t("text.schedule.cronEveryMinute");
    case "every-hour":
      return t("text.schedule.cronEveryHour");
    case "daily-9":
      return t("routines.presetDaily");
    case "weekdays-9":
      return t("routines.presetWeekdays");
    case "mondays-9":
      return t("routines.presetMondays");
    default:
      return preset.label;
  }
}

/** "Today 09:00", "Tomorrow 09:00" or "Mon, Sep 28 09:00". */
function runTime(at: Date, now: Date, dateLocale: string | undefined, t: Translate): string {
  const time = at.toLocaleTimeString(dateLocale, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const offset = Math.round((day - today) / 86_400_000);
  if (offset === 0) return t("routines.today", { time });
  if (offset === 1) return t("routines.tomorrow", { time });
  if (offset === -1) return t("routines.yesterday", { time });
  return `${at.toLocaleDateString(dateLocale, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

export function RoutinesSection({ colors, bot, localHost, onPatch, flush, onOpenChat }: PanelProps) {
  const { t, locale } = useT();
  // Dates follow the app language only when it is Chinese; otherwise the system locale, as before.
  const dateLocale = isChineseLocale(locale) ? "zh-CN" : undefined;
  const host = useBotHost(bot.hostId, localHost);
  const status = useRpc(routineStatusRpc);
  const runNow = useRpc(routineRunNowRpc);
  const webhook = useRpc(routineWebhookRpc);
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const records = useQuery({ queryKey: ROUTINES_KEY, queryFn: () => status({}), refetchInterval: 15_000, enabled: host.isLocal });
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [runs, setRuns] = useState(false);

  const setRoutines = (routines: Routine[]) => onPatch({ routines });
  const update = (id: string, patch: Partial<Routine>) => setRoutines(bot.routines.map((routine) => (routine.id === id ? { ...routine, ...patch } : routine)));
  const recordOf = (routine: Routine) => records.data?.routines[routine.id];

  const run = async (routine: Routine) => {
    try {
      await flush();
      const { run: started } = await runNow({ botId: bot.id, routineId: routine.id });
      if (started.status === "running") toast.show(t("routines.started", { name: routine.name, bot: bot.name }), { variant: "success" });
      else if (started.status === "skipped-busy") toast.show(t("routines.stillWorking", { name: routine.name }));
      else toast.error(started.error ?? t("routines.couldntStart"));
      void queryClient.invalidateQueries({ queryKey: ["aydo"] });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const copyWebhook = async (routine: Routine) => {
    try {
      await flush();
      await copyText((await webhook({ routineId: routine.id })).url);
      toast.show(t("routines.webhookCopied"), { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const remove = async (routine: Routine) => {
    const confirmed = await confirmDialog({
      title: t("routines.deleteRoutine"),
      message: t("knowledge.deleteNamed", { name: routine.name }),
      confirmLabel: t("settings.delete"),
      cancelLabel: t("dialogs.cancel"),
      destructive: true,
    });
    if (confirmed) setRoutines(bot.routines.filter((entry) => entry.id !== routine.id));
  };

  if (!host.isLocal) {
    return <Alert colors={colors} description={t("routines.localOnly")} />;
  }

  const now = new Date();
  const upcoming = bot.routines
    .filter((routine) => routine.enabled)
    .flatMap((routine) => upcomingRuns(routine.schedule, new Date(recordOf(routine)?.lastRunAt ?? routine.createdAt), now, UPCOMING).map((at) => ({ at, routine })))
    .filter(({ at }) => at.getTime() - now.getTime() <= UPCOMING_DAYS * 86_400_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, UPCOMING);
  const recent = bot.routines
    .flatMap((routine) => (recordOf(routine)?.runs ?? []).map((entry) => ({ run: entry, routine })))
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt))
    .slice(0, RECENT);

  return (
    <>
      {records.data?.scheduler === false ? (
        <View style={{ marginBottom: 24 }}>
          <Alert colors={colors} variant="warning" description={t("routines.schedulerStarting")} />
        </View>
      ) : null}
      <SettingsSection
        title={t("panel.routines")}
        info={t("routines.info")}
        trailing={<SectionLink colors={colors} label={t("panel.newRoutine")} onPress={() => setEditing("new")} />}
      >
        <SettingsCard>
          {bot.routines.length === 0 ? <CardNote colors={colors} text={t("routines.noRoutines")} /> : null}
          {bot.routines.map((routine) => {
            const record = recordOf(routine);
            const next = nextRun(routine.schedule, new Date(record?.lastRunAt ?? routine.createdAt), now);
            const badge = routineState(routine, next, t);
            return (
              <PressableRow key={routine.id} colors={colors} accessibilityLabel={t("routines.editNamed", { name: routine.name })} onPress={() => setEditing(routine)}>
                {() => (
                  <>
                    <RowText colors={colors} label={routine.name || t("routines.untitled")} hint={routineMeta(routine, record?.runs.at(-1), next, t)} hintLines={2} />
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <StatusBadge colors={colors} label={badge.label} variant={badge.variant} />
                      <KebabButton
                        colors={colors}
                        label={t("routines.actions")}
                        onOpen={(anchor) =>
                          menu.open({
                            anchor,
                            align: "end",
                            width: 220,
                            title: routine.name || t("routines.routine"),
                            entries: [
                              { label: t("routines.edit"), icon: "Pencil", onSelect: () => setEditing(routine) },
                              routine.enabled
                                ? { label: t("routines.pause"), icon: "Pause", onSelect: () => update(routine.id, { enabled: false }) }
                                : { label: t("routines.resume"), icon: "Play", onSelect: () => update(routine.id, { enabled: true }) },
                              { label: t("panel.runNow"), icon: "RotateCw", disabled: !routine.prompt.trim(), pendingLabel: t("routines.starting"), onSelect: () => run(routine) },
                              ...(routine.schedule.kind === "webhook" ? [{ label: t("routines.copyWebhook"), icon: "Webhook", onSelect: () => copyWebhook(routine) }] : []),
                              { kind: "separator" as const },
                              { label: t("routines.deleteRoutine"), icon: "Trash2", destructive: true, onSelect: () => void remove(routine) },
                            ],
                          })
                        }
                      />
                    </View>
                  </>
                )}
              </PressableRow>
            );
          })}
        </SettingsCard>
      </SettingsSection>
      {bot.routines.length ? (
        <SettingsSection title={t("panel.group.activity")}>
          <SettingsCard>
            <DrillRow
              colors={colors}
              label={t("panel.runs")}
              hint={
                [upcoming[0] ? t("routines.nextAt", { when: runTime(upcoming[0].at, now, dateLocale, t) }) : null, recent[0] ? t("routines.lastAt", { when: runTime(new Date(recent[0].run.startedAt), now, dateLocale, t) }) : null]
                  .filter(Boolean)
                  .join(t("text.change.listSep")) || t("panel.noneYet")
              }
              onPress={() => setRuns(true)}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {runs ? (
        <Modal title={t("panel.runs")} open onOpenChange={(next) => !next && setRuns(false)}>
          <Modal.Content contentContainerStyle={{ gap: 0 }}>
            <SettingsSection title={t("routines.upcoming")} info={t("routines.upcomingInfo", { days: UPCOMING_DAYS })}>
              <SettingsCard>
                {upcoming.length === 0 ? <CardNote colors={colors} text={t("routines.nothingScheduled")} /> : null}
                {upcoming.map(({ at, routine }) => (
                  <SettingsRow key={`${routine.id}:${at.getTime()}`} label={runTime(at, now, dateLocale, t)} hint={routine.name} />
                ))}
              </SettingsCard>
            </SettingsSection>
            <SettingsSection title={t("routines.recentRuns")} info={t("routines.recentInfo")}>
              <SettingsCard>
                {recent.length === 0 ? <CardNote colors={colors} text={t("routines.noRuns")} /> : null}
                {recent.map(({ run: entry, routine }) => {
                  const hint = [`${runTime(new Date(entry.startedAt), now, dateLocale, t)} · ${runLabel(entry.status, t)} · ${triggerLabel(entry.trigger, t)}`, entry.error ?? entry.output]
                    .filter(Boolean)
                    .join("\n");
                  const agentId = entry.agentId;
                  return agentId ? (
                    <DrillRow
                      key={entry.id}
                      colors={colors}
                      label={routine.name}
                      hint={hint}
                      hintLines={2}
                      onPress={() => {
                        setRuns(false);
                        onOpenChat(agentId);
                      }}
                    />
                  ) : (
                    <SettingsRow key={entry.id} label={routine.name} hint={hint} />
                  );
                })}
              </SettingsCard>
            </SettingsSection>
          </Modal.Content>
        </Modal>
      ) : null}
      {editing ? (
        <RoutineForm
          colors={colors}
          bot={bot}
          host={host}
          routine={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSubmit={(routine) => {
            setRoutines(editing === "new" ? [...bot.routines, routine] : bot.routines.map((entry) => (entry.id === routine.id ? routine : entry)));
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- form

const ONCE = "once";
const WEBHOOK = "webhook";
const OWN_CHAT = "own";

function inAnHour(): Date {
  const at = new Date(Date.now() + 60 * 60_000);
  at.setSeconds(0, 0);
  return at;
}

interface RoutineFormProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  routine: Routine | null;
  onCancel(): void;
  onSubmit(routine: Routine): void;
}

function RoutineForm({ colors, bot, host, routine, onCancel, onSubmit }: RoutineFormProps) {
  const { t } = useT();
  const original: RoutineSchedule = routine?.schedule ?? { kind: "cron", expression: "0 9 * * 1-5" };
  // A new routine's id is picked now so its webhook URL can be shown before saving.
  const [id] = useState(() => routine?.id ?? newRoutineId());
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [schedule, setSchedule] = useState<RoutineSchedule>(original);
  const [resultsChatId, setResultsChatId] = useState<string | null>(routine?.resultsChatId ?? null);
  const [cronText, setCronText] = useState(() => scheduleToCron(original) ?? "0 9 * * *");
  const [onceText, setOnceText] = useState(() => formatLocalDateTime(original.kind === "once" ? new Date(original.at) : inAnHour()));
  // Presets rewrite the cron field; remounting it is how Paseo's CadenceEditor resets it too.
  const [cronKey, setCronKey] = useState(0);
  const chats = useBotChats(host, bot.id);

  const once = schedule.kind === "once";
  const hook = schedule.kind === "webhook";
  const trimmedCron = cronText.trim();
  // Null for a cron that matches no preset: the select shows its translated text, as it has no option for it.
  const presetValue = once ? ONCE : hook ? WEBHOOK : (CRON_PRESETS.find((preset) => preset.expression === trimmedCron)?.id ?? null);
  const cronError = once || hook ? null : validateCron(trimmedCron);
  const onceDate = once ? parseLocalDateTime(onceText) : null;
  const onceChanged = original.kind !== "once" || onceDate?.getTime() !== new Date(original.at).getTime();
  const onceError = !once ? null : !onceDate ? t("routines.onceFormat") : onceChanged && onceDate.getTime() <= Date.now() ? t("routines.futureTime") : null;
  const canSubmit = prompt.trim().length > 0 && !cronError && !onceError;

  // Runs' own chats aren't offered as a results chat; a chosen chat that's gone stays listed so it can be changed.
  const resultChats = (chats.data ?? []).filter((chat) => !chat.labels?.[ROUTINE_LABEL]);
  const resultOptions = [
    { label: t("routines.ownChat"), value: OWN_CHAT },
    ...resultChats.map((chat) => ({ label: displayTitle(chat.title, t), value: chat.id })),
    ...(resultsChatId && !resultChats.some((chat) => chat.id === resultsChatId) ? [{ label: t("routines.chatGone"), value: resultsChatId }] : []),
  ];

  const submit = () => {
    const firstLine = prompt.trim().split("\n")[0]!.slice(0, 60);
    const base: Routine = routine ?? { id, name: "", prompt: "", enabled: true, schedule, resultsChatId: null, createdAt: new Date().toISOString() };
    onSubmit({ ...base, name: name.trim().slice(0, 80) || firstLine, prompt, schedule, resultsChatId });
  };

  return (
    <Modal title={routine ? t("routines.edit") : t("panel.newRoutine")} open onOpenChange={(open) => !open && onCancel()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label={t("teams.name")} initialValue={name} placeholder={t("routines.namePlaceholder")} onChangeText={setName} />
            <TextAreaField colors={colors} label={t("settings.setup.prompt")} hint={t("routines.promptHint")} defaultValue={prompt} onChangeText={setPrompt} placeholder={t("routines.promptPlaceholder")} />
          </SettingsCard>
        </View>
        <SettingsSection title={t("panel.cadence")} info={t("routines.cadenceInfo")}>
          <SettingsCard>
            <SettingsSelect
              label={t("routines.repeats")}
              value={presetValue ?? t("routines.customCron")}
              options={[
                ...CRON_PRESETS.map((preset) => ({ label: presetLabel(preset, t), value: preset.id })),
                { label: t("routines.once"), value: ONCE },
                { label: t("text.schedule.webhook"), value: WEBHOOK },
              ]}
              onValueChange={(value) => {
                if (value === ONCE) {
                  setSchedule({ kind: "once", at: (parseLocalDateTime(onceText) ?? inAnHour()).toISOString() });
                  return;
                }
                if (value === WEBHOOK) {
                  setSchedule({ kind: "webhook" });
                  return;
                }
                const preset = CRON_PRESETS.find((entry) => entry.id === value);
                if (!preset) return;
                setCronText(preset.expression);
                setCronKey((key) => key + 1);
                setSchedule({ kind: "cron", expression: preset.expression });
              }}
            />
            {hook ? (
              <WebhookRows colors={colors} routineId={id} />
            ) : once ? (
              <InputField colors={colors}
                key="once"
                label={t("routines.at")}
                hint={onceDate ? onceDate.toLocaleString() : "YYYY-MM-DD HH:MM"}
                error={onceError}
                initialValue={onceText}
                placeholder="2026-09-27 09:00"
                onChangeText={(text) => {
                  setOnceText(text);
                  const at = parseLocalDateTime(text);
                  if (at) setSchedule({ kind: "once", at: at.toISOString() });
                }}
              />
            ) : (
              <InputField colors={colors}
                key={`cron-${cronKey}`}
                label={t("routines.cron")}
                monospace
                autoCapitalize="none"
                autoCorrect={false}
                hint={trimmedCron ? (describeCron(trimmedCron, t) ?? trimmedCron) : undefined}
                error={cronError}
                initialValue={cronText}
                placeholder="0 9 * * *"
                onChangeText={(text) => {
                  setCronText(text);
                  setSchedule({ kind: "cron", expression: text.trim() });
                }}
              />
            )}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title={t("routines.results")} info={t("routines.resultsInfo")}>
          <SettingsCard>
            <SettingsSelect label={t("routines.postResults")} value={resultsChatId ?? OWN_CHAT} options={resultOptions} onValueChange={(value) => setResultsChatId(value === OWN_CHAT ? null : value)} />
          </SettingsCard>
        </SettingsSection>
        <SheetFooter>
          <Button colors={colors} size="md" label={t("dialogs.cancel")} onPress={onCancel} style={{ flex: 1 }} />
          <Button colors={colors} size="md" variant="default" label={routine ? t("routines.saveChanges") : t("routines.create")} disabled={!canSubmit} onPress={submit} style={{ flex: 1 }} />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}

/** The routine's webhook URL with Copy, and New URL to stop the old one working. */
function WebhookRows({ colors, routineId }: { colors: Colors; routineId: string }) {
  const { t } = useT();
  const webhook = useRpc(routineWebhookRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["aydo", "webhook", routineId];
  const url = useQuery({ queryKey: key, queryFn: () => webhook({ routineId }) });

  const rotate = async () => {
    const confirmed = await confirmDialog({ title: t("routines.newWebhook"), message: t("routines.rotateMessage"), confirmLabel: t("routines.replace"), cancelLabel: t("dialogs.cancel"), destructive: true });
    if (!confirmed) return;
    try {
      queryClient.setQueryData(key, await webhook({ routineId, rotate: true }));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const value = url.data?.url;
  return (
    <>
      <SettingsAction
        label={t("routines.webhookUrl")}
        hint={value ?? (url.isError ? errorText(url.error) : t("settings.loading"))}
        actionLabel={t("dialogs.export.copy")}
        disabled={!value}
        onPress={() => void copyText(value!).then(() => toast.show(t("routines.webhookCopied"), { variant: "success" }))}
      />
      <SettingsAction label={t("routines.newUrl")} hint={t("routines.newUrlHint")} actionLabel={t("routines.replace")} disabled={!value} onPress={() => void rotate()} />
    </>
  );
}
