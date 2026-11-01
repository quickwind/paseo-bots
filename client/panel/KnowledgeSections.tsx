import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { newPlaybookId, SOUL_MAX_BYTES, utf8Bytes, type Playbook } from "../../shared/bot";
import { parseTriggers } from "../../shared/playbooks";
import { memoryDeleteRpc, memoryListRpc, memoryReadRpc, memoryWriteRpc } from "../../shared/rpc";
import { useBotHost } from "../data";
import { confirmDialog, errorText } from "../native";
import { useT } from "../i18n/use-t";
import { MaintenanceSection } from "./MaintenanceSection";
import type { PanelProps } from "./BotPanel";
import { LibraryPicker } from "./LibraryPicker";
import { Alert, Button, CardNote, DrillRow, FormTextArea, InputField, SectionLink, SectionMeta, SheetActions, TextAreaField } from "./controls";
import { ChangesSheet, LogSheet, useDailyLog, useMemoryJournal } from "./MemoryActivity";

type Colors = PanelProps["colors"];

const kb = (bytes: number) => (bytes / 1000).toFixed(1);


function LocalOnly({ colors, what }: { colors: Colors; what: string }) {
  const { t } = useT();
  return (
    <View style={{ marginBottom: 24 }}>
      <Alert colors={colors} description={t("knowledge.localOnly", { what })} />
    </View>
  );
}

// ---------------------------------------------------------------- soul

/** Paseo's "Append system prompt": a row with Edit that opens a sheet with the text, Reset and Save. */
export function SoulSection({ colors, bot, onPatch }: PanelProps) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const bytes = utf8Bytes(bot.soul);
  return (
    <>
      <SettingsSection title={t("knowledge.instructions")} info={t("knowledge.instructionsInfo")}>
        <SettingsCard>
          <SettingsAction label={t("panel.standingInstructions")} hint={t("knowledge.standingHint")} actionLabel={t("teams.edit")} onPress={() => setEditing(true)} />
          <SettingsRow
            label={t("knowledge.size")}
            hint={bytes ? t("knowledge.sizeOf", { used: kb(bytes), limit: SOUL_MAX_BYTES / 1000 }) : t("knowledge.empty")}
            error={bytes > SOUL_MAX_BYTES ? t("knowledge.overLimit", { limit: SOUL_MAX_BYTES / 1000 }) : null}
          />
        </SettingsCard>
      </SettingsSection>
      {editing ? (
        <SoulSheet
          colors={colors}
          saved={bot.soul}
          onClose={() => setEditing(false)}
          onSave={(soul) => {
            onPatch({ soul });
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}

function SoulSheet({ colors, saved, onClose, onSave }: { colors: Colors; saved: string; onClose(): void; onSave(soul: string): void }) {
  const { t } = useT();
  const [draft, setDraft] = useState(saved);
  const bytes = utf8Bytes(draft);
  const changed = draft !== saved;
  return (
    <Modal title={t("panel.standingInstructions")} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <FormTextArea
          colors={colors}
          accessibilityLabel={t("panel.standingInstructions")}
          value={draft}
          onChangeText={setDraft}
          minHeight={320}
          placeholder={t("knowledge.soulPlaceholder")}
        />
        <SheetActions
          leading={
            <SectionMeta colors={colors} text={`${kb(bytes)} / ${SOUL_MAX_BYTES / 1000} KB`} tone={bytes > SOUL_MAX_BYTES ? "danger" : bytes > SOUL_MAX_BYTES * 0.8 ? "warning" : undefined} />
          }
        >
          <Button colors={colors} variant="ghost" label={t("surface.reset")} disabled={!changed} onPress={() => setDraft(saved)} />
          <Button colors={colors} variant="default" label={t("teams.save")} disabled={!changed} onPress={() => onSave(draft)} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------- skills

export function SkillsSection(props: PanelProps) {
  const { t } = useT();
  const host = useBotHost(props.bot.hostId, props.localHost);
  return (
    <>
      {!host.isLocal ? <LocalOnly colors={props.colors} what={t("panel.skills")} /> : null}
      <LibraryPicker {...props} kind="skill" title={t("panel.skills")} info={t("knowledge.skillsInfo")} />
    </>
  );
}

// ---------------------------------------------------------------- memory

const TOPIC_NAME = /^[A-Za-z0-9 ._-]+$/;
const MEMORY_LINES = 200;
const MEMORY_BYTES = 24_000;

export function MemorySection(props: PanelProps) {
  const { t } = useT();
  const { colors, bot, localHost } = props;
  const host = useBotHost(bot.hostId, localHost);
  const list = useRpc(memoryListRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"topic" | "changes" | "log" | null>(null);
  const files = useQuery({ queryKey: ["aydo", "memory", bot.id], queryFn: () => list({ botId: bot.id }), refetchInterval: 20_000 });
  const journal = useMemoryJournal(bot.id);
  const log = useDailyLog(bot.id);
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: ["aydo", "memory", bot.id] }), queryClient.invalidateQueries({ queryKey: ["aydo", "memory-journal", bot.id] })]);

  const data = files.data;
  const over = data ? data.injectedLines > MEMORY_LINES || data.injectedBytes > MEMORY_BYTES : false;
  const changes = journal.data?.entries.length ?? 0;
  const days = log.data?.days.length ?? 0;

  return (
    <>
      {!host.isLocal ? <LocalOnly colors={colors} what={t("knowledge.memoryFiles")} /> : null}
      <SettingsSection
        title={t("settings.tools.files")}
        info={t("knowledge.filesInfo")}
        trailing={<SectionLink colors={colors} label={t("panel.newTopicFile")} onPress={() => setSheet("topic")} />}
      >
        <SettingsCard>
          {(data?.files ?? [{ name: "MEMORY.md", bytes: 0, lines: 0, topic: false }]).map((file) => (
            <DrillRow
              key={file.name}
              colors={colors}
              label={file.topic ? `memory/${file.name}` : file.name}
              hint={
                !data
                  ? t("settings.loading")
                  : file.topic
                    ? t("knowledge.fileStats", { lines: file.lines, size: kb(file.bytes) })
                    : t("knowledge.loadedInto", { lines: data.injectedLines, maxLines: MEMORY_LINES, size: kb(data.injectedBytes), maxSize: MEMORY_BYTES / 1000 })
              }
              error={!file.topic && over ? t("knowledge.overBudget") : null}
              hintLines={2}
              onPress={() => setOpen(file.name)}
            />
          ))}
          {data ? (
            <SettingsAction
              label={t("panel.folder")}
              hint={data.folder.replace(/^\/(?:Users|home)\/[^/]+/, "~")}
              actionLabel={t("dialogs.export.copy")}
              onPress={() => void copyText(data.folder).then(() => toast.show(t("surface.pathCopied"), { variant: "success" }))}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <MaintenanceSection {...props} />
      <SettingsSection title={t("panel.group.activity")}>
        <SettingsCard>
          <DrillRow
            colors={colors}
            label={t("panel.changes")}
            hint={journal.isLoading ? t("settings.loading") : changes ? t("knowledge.changesCount", { count: changes }) : t("panel.noChanges")}
            onPress={() => setSheet("changes")}
          />
          <DrillRow colors={colors} label={t("panel.dailyLog")} hint={log.isLoading ? t("settings.loading") : days ? t("knowledge.daysCount", { count: days }) : t("panel.noEntries")} onPress={() => setSheet("log")} />
        </SettingsCard>
      </SettingsSection>
      {sheet === "topic" ? (
        <TopicSheet
          colors={colors}
          botId={bot.id}
          onClose={() => setSheet(null)}
          onCreated={(name) => {
            setSheet(null);
            setOpen(name);
            void refresh();
          }}
        />
      ) : null}
      {sheet === "changes" ? <ChangesSheet colors={colors} bot={bot} onUndone={() => void refresh()} onClose={() => setSheet(null)} /> : null}
      {sheet === "log" ? <LogSheet colors={colors} bot={bot} onClose={() => setSheet(null)} /> : null}
      {open ? <MemorySheet colors={colors} botId={bot.id} name={open} onChanged={() => void refresh()} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** A new topic file: its name, then it opens to write in. */
function TopicSheet({ colors, botId, onClose, onCreated }: { colors: Colors; botId: string; onClose(): void; onCreated(name: string): void }) {
  const { t } = useT();
  const write = useRpc(memoryWriteRpc);
  const toast = useToast();
  const [topic, setTopic] = useState("");
  const name = topic.trim().replace(/\.md$/, "");
  const error = name && !TOPIC_NAME.test(name) ? t("knowledge.topicError") : null;
  const create = () =>
    void write({ botId, name: `${name}.md`, text: `# ${name}\n` })
      .then(() => onCreated(`${name}.md`))
      .catch((caught: unknown) => toast.error(errorText(caught)));
  return (
    <Modal title={t("panel.newTopicFile")} open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <InputField colors={colors} label={t("teams.name")} hint={t("knowledge.topicHint")} error={error} initialValue="" placeholder="projects" onChangeText={setTopic} />
        </SettingsCard>
        <SheetActions>
          <Button colors={colors} variant="ghost" label={t("dialogs.cancel")} onPress={onClose} />
          <Button colors={colors} variant="default" label={t("knowledge.create")} disabled={!name || !!error} onPress={create} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

/** One memory file in a sheet. Closing with unsaved edits asks before discarding them. */
function MemorySheet({ colors, botId, name, onChanged, onClose }: { colors: Colors; botId: string; name: string; onChanged(): void; onClose(): void }) {
  const { t } = useT();
  const read = useRpc(memoryReadRpc);
  const write = useRpc(memoryWriteRpc);
  const remove = useRpc(memoryDeleteRpc);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const topic = name !== "MEMORY.md";
  const label = topic ? `memory/${name}` : name;
  const dirty = text !== null && text !== saved;

  useEffect(() => {
    let cancelled = false;
    void read({ botId, name })
      .then(({ text: loaded }) => {
        if (cancelled) return;
        setText(loaded);
        setSaved(loaded);
      })
      .catch((error: unknown) => !cancelled && toastRef.current.error(errorText(error)));
    return () => {
      cancelled = true;
    };
  }, [botId, name, read]);

  const close = async () => {
    if (dirty && !(await confirmDialog({ title: t("knowledge.discardTitle"), message: t("knowledge.discardMessage", { name: label }), confirmLabel: t("knowledge.discard"), cancelLabel: t("dialogs.cancel"), destructive: true }))) return;
    onClose();
  };

  const save = async () => {
    if (text === null) return;
    setSaving(true);
    try {
      // Bots edit their memory themselves; don't overwrite a change made since it was opened.
      const current = (await read({ botId, name })).text;
      if (current !== saved && current !== text) {
        toast.error(t("knowledge.changedSince"));
        return;
      }
      await write({ botId, name, text });
      setSaved(text);
      onChanged();
      onClose();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const destroy = async () => {
    const confirmed = await confirmDialog({ title: t("knowledge.deleteTopicTitle"), message: t("knowledge.deleteTopicMessage", { name: label }), confirmLabel: t("settings.delete"), cancelLabel: t("dialogs.cancel"), destructive: true });
    if (!confirmed) return;
    try {
      await remove({ botId, name });
    } catch (error) {
      toast.error(t("knowledge.deleteFailed", { error: errorText(error) }));
      return;
    }
    onChanged();
    onClose();
  };

  return (
    <Modal title={label} open onOpenChange={(value) => !value && void close()}>
      <Modal.Content>
        {text === null ? (
          <SettingsCard>
            <View style={{ minHeight: 320, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            </View>
          </SettingsCard>
        ) : (
          <FormTextArea colors={colors} monospace accessibilityLabel={t("knowledge.contents", { name: label })} value={text} onChangeText={setText} minHeight={320} placeholder={t("knowledge.memoryPlaceholder")} />
        )}
        <SheetActions leading={topic ? <Button colors={colors} variant="ghost" label={t("settings.delete")} icon="Trash2" onPress={() => void destroy()} /> : null}>
          <Button colors={colors} variant="ghost" label={t("surface.reset")} disabled={!dirty || saving} onPress={() => setText(saved)} />
          <Button colors={colors} variant="default" label={saving ? t("dialogs.saving") : t("teams.save")} disabled={!dirty || saving} onPress={() => void save()} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

// ---------------------------------------------------------------- playbooks

/** OpenMausBot's playbooks: step-by-step guidance a chat gets when its first message mentions a trigger. */
export function PlaybooksSection({ colors, bot, onPatch }: PanelProps) {
  const { t } = useT();
  const [editing, setEditing] = useState<Playbook | "new" | null>(null);
  const save = (playbook: Playbook) => {
    onPatch({ playbooks: bot.playbooks.some((entry) => entry.id === playbook.id) ? bot.playbooks.map((entry) => (entry.id === playbook.id ? playbook : entry)) : [...bot.playbooks, playbook] });
    setEditing(null);
  };
  const remove = async (playbook: Playbook) => {
    if (!(await confirmDialog({ title: t("knowledge.deletePlaybookTitle"), message: t("knowledge.deleteNamed", { name: playbook.name }), confirmLabel: t("settings.delete"), cancelLabel: t("dialogs.cancel"), destructive: true }))) return;
    onPatch({ playbooks: bot.playbooks.filter((entry) => entry.id !== playbook.id) });
    setEditing(null);
  };
  return (
    <>
      <SettingsSection
        title={t("panel.playbooks")}
        info={t("knowledge.playbooksInfo")}
        trailing={<SectionLink colors={colors} label={t("panel.newPlaybook")} onPress={() => setEditing("new")} />}
      >
        <SettingsCard>
          {bot.playbooks.length === 0 ? <CardNote colors={colors} text={t("knowledge.noPlaybooks")} /> : null}
          {bot.playbooks.map((playbook) => (
            <DrillRow
              key={playbook.id}
              colors={colors}
              label={playbook.name || t("knowledge.untitledPlaybook")}
              hint={playbook.triggers.length ? t("knowledge.playbookTriggers", { triggers: playbook.triggers.join(t("text.change.listSep")) }) : t("knowledge.noTriggers")}
              onPress={() => setEditing(playbook)}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      {editing ? <PlaybookSheet colors={colors} playbook={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={save} onDelete={editing === "new" ? undefined : () => void remove(editing)} /> : null}
    </>
  );
}

function PlaybookSheet({ colors, playbook, onClose, onSave, onDelete }: { colors: Colors; playbook: Playbook | null; onClose(): void; onSave(playbook: Playbook): void; onDelete?: () => void }) {
  const { t } = useT();
  const [name, setName] = useState(playbook?.name ?? "");
  const [triggers, setTriggers] = useState(playbook?.triggers.join(", ") ?? "");
  const [instructions, setInstructions] = useState(playbook?.instructions ?? "");
  const parsed = parseTriggers(triggers);
  const canSave = !!name.trim() && parsed.length > 0 && !!instructions.trim();
  return (
    <Modal title={playbook ? t("knowledge.editPlaybook") : t("panel.newPlaybook")} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label={t("teams.name")} initialValue={name} placeholder={t("knowledge.playbookNamePlaceholder")} onChangeText={setName} />
            <InputField colors={colors} label={t("panel.triggerWords")} hint={t("knowledge.triggersHint")} initialValue={triggers} placeholder={t("knowledge.triggersPlaceholder")} onChangeText={setTriggers} />
            <TextAreaField colors={colors} label={t("panel.steps")} hint={t("knowledge.stepsHint")} value={instructions} onChangeText={setInstructions} minHeight={240} placeholder={t("knowledge.stepsPlaceholder")} />
          </SettingsCard>
        </View>
        <SheetActions leading={onDelete ? <Button colors={colors} variant="ghost" label={t("settings.delete")} icon="Trash2" onPress={onDelete} /> : null}>
          <Button colors={colors} variant="ghost" label={t("dialogs.cancel")} onPress={onClose} />
          <Button
            colors={colors}
            variant="default"
            label={t("teams.save")}
            disabled={!canSave}
            onPress={() => onSave({ id: playbook?.id ?? newPlaybookId(), name: name.trim().slice(0, 80), triggers: parsed, instructions })}
          />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
