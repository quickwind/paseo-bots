import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { dayName, journalSource, journalSummary } from "../../shared/activity";
import type { Bot } from "../../shared/bot";
import { memoryJournalRpc, memoryLogDeleteRpc, memoryLogRpc, memoryUndoRpc, type JournalRow } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { ToolCallDetailsContent } from "../chat/stream/details";
import { confirmDialog, errorText, MONO_FONT, MONO_PROPS } from "../native";
import { useT } from "../i18n/use-t";
import { code, codeLine, ui } from "../typography";
import type { PanelProps } from "./BotPanel";
import { Button, CardNote, DrillRow, SheetActions } from "./controls";

type Colors = PanelProps["colors"];

const SHOWN = 20;
const DAYS = 14;
const journalKey = (botId: string) => ["aydo", "memory-journal", botId];
const logKey = (botId: string) => ["aydo", "memory-log", botId];

// OpenMausBot's memory "Changes" card and daily log, each browsed in a modal from the bot's Memory section.

export function useMemoryJournal(botId: string) {
  const journal = useRpc(memoryJournalRpc);
  return useQuery({ queryKey: journalKey(botId), queryFn: () => journal({ botId }), refetchInterval: 20_000 });
}

export function useDailyLog(botId: string) {
  const log = useRpc(memoryLogRpc);
  return useQuery({ queryKey: logKey(botId), queryFn: () => log({ botId }), refetchInterval: 30_000 });
}

/** Every change to the memory files, by the bot or by you; one opens with its diff and Undo. */
export function ChangesSheet({ colors, bot, onUndone, onClose }: { colors: Colors; bot: Bot; onUndone(): void; onClose(): void }) {
  const { t } = useT();
  const query = useMemoryJournal(bot.id);
  const undo = useRpc(memoryUndoRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<JournalRow | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = (query.data?.entries ?? []).slice(0, SHOWN);

  const revert = async (row: JournalRow) => {
    setBusy(true);
    try {
      await undo({ botId: bot.id, id: row.id });
      await queryClient.invalidateQueries({ queryKey: journalKey(bot.id) });
      onUndone();
      setOpen(null);
    } catch (error) {
      toast.error(t("panel.couldntUndo", { error: errorText(error) }));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    const file = open.file === "MEMORY.md" ? open.file : `memory/${open.file}`;
    return (
      <Modal title={journalSummary(open, bot.name, t)} open onOpenChange={(value) => !value && !busy && onClose()}>
        <Modal.Content>
          <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{`${file} · ${relativeTime(open.at, undefined, t)} · ${journalSource(open, t)}`}</Text>
          {open.diff ? (
            <ToolCallDetailsContent colors={colors} detail={{ type: "edit", filePath: file, unifiedDiff: open.diff }} maxHeight={420} />
          ) : (
            <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{open.kind === "deleted" ? t("panel.fileDeleted") : t("panel.tooLargeToShow")}</Text>
          )}
          {!open.canUndo ? <Text style={{ fontSize: ui(13), color: colors.foregroundMuted }}>{t("panel.tooLargeToUndo")}</Text> : null}
          <SheetActions>
            <Button colors={colors} variant="ghost" label={t("panel.back")} disabled={busy} onPress={() => setOpen(null)} />
            <Button colors={colors} variant="default" label={busy ? t("panel.undoing") : t("panel.undo")} disabled={!open.canUndo || busy} onPress={() => void revert(open)} />
          </SheetActions>
        </Modal.Content>
      </Modal>
    );
  }

  return (
    <Modal title={t("panel.memoryChanges")} open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content>
        <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{t("panel.changesIntro")}</Text>
        <SettingsCard>
          {rows.length === 0 ? <CardNote colors={colors} text={query.isLoading ? t("settings.loading") : t("panel.noChanges")} loading={query.isLoading} /> : null}
          {rows.map((row) => (
            <DrillRow key={row.id} colors={colors} label={journalSummary(row, bot.name, t)} hint={`${relativeTime(row.at, undefined, t)} · ${journalSource(row, t)}`} onPress={() => setOpen(row)} />
          ))}
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}

/** The bot's daily log, a day at a time; a day can be deleted. */
export function LogSheet({ colors, bot, onClose }: { colors: Colors; bot: Bot; onClose(): void }) {
  const { t, locale } = useT();
  const query = useDailyLog(bot.id);
  const [open, setOpen] = useState<string | null>(null);
  const days = (query.data?.days ?? []).slice(0, DAYS);
  const now = new Date();

  if (open) return <LogDay colors={colors} bot={bot} day={open} onBack={() => setOpen(null)} onClose={onClose} />;
  return (
    <Modal title={t("panel.dailyLog")} open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content>
        <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{t("panel.logIntro")}</Text>
        <SettingsCard>
          {days.length === 0 ? <CardNote colors={colors} text={query.isLoading ? t("settings.loading") : t("panel.noEntries")} loading={query.isLoading} /> : null}
          {days.map((entry) => (
            <DrillRow key={entry.day} colors={colors} label={dayName(entry.day, now, { t, locale })} hint={t("panel.entries", { count: entry.lines })} onPress={() => setOpen(entry.day)} />
          ))}
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}

function LogDay({ colors, bot, day, onBack, onClose }: { colors: Colors; bot: Bot; day: string; onBack(): void; onClose(): void }) {
  const { t, locale } = useT();
  const log = useRpc(memoryLogRpc);
  const remove = useRpc(memoryLogDeleteRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const text = useQuery({ queryKey: [...logKey(bot.id), day], queryFn: () => log({ botId: bot.id, day }) });

  const destroy = async () => {
    const label = dayName(day, new Date(), { t, locale });
    if (!(await confirmDialog({ title: t("panel.deleteLog"), message: t("panel.deleteLogMessage", { day: label }), confirmLabel: t("settings.delete"), cancelLabel: t("dialogs.cancel"), destructive: true }))) return;
    try {
      await remove({ botId: bot.id, day });
      await queryClient.invalidateQueries({ queryKey: logKey(bot.id) });
      onBack();
    } catch (error) {
      toast.error(t("panel.couldntDelete", { error: errorText(error) }));
    }
  };

  return (
    <Modal title={`memory/log/${day}.md`} open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content>
        <View style={{ padding: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, minHeight: 120 }}>
          {text.data ? (
            <Text selectable {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foreground }}>
              {text.data.text?.trim() || t("panel.logEmpty")}
            </Text>
          ) : (
            <ActivityIndicator size="small" color={colors.foregroundMuted} />
          )}
        </View>
        <SheetActions leading={<Button colors={colors} variant="ghost" label={t("settings.delete")} icon="Trash2" onPress={() => void destroy()} />}>
          <Button colors={colors} variant="default" label={t("panel.back")} onPress={onBack} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
