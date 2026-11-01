import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Bot, BotAvatar, Preset } from "../shared/bot";
import { exportBotRpc } from "../shared/rpc";
import { BOT_TEMPLATES, templateText, type BotTemplate } from "../shared/templates";
import type { Translate } from "../shared/translate";
import { Avatar } from "./Avatar";
import { errorText, MONO_FONT, MONO_PROPS, nativeTokens, useHover } from "./native";
import { Button, FormTextArea, SheetActions } from "./panel/controls";
import { useT } from "./i18n/use-t";
import type { MenuEntry } from "./ui/Menu";
import { code, codeLine, ui } from "./typography";

type Colors = PluginTheme["colors"];

// ------------------------------------------------------------------ new bot

export function NewBotDialog({
  colors,
  presets,
  onClose,
  onCreate,
  onImport,
}: {
  colors: Colors;
  presets: readonly Preset[];
  onClose(): void;
  onCreate(start?: { template?: BotTemplate; preset?: Preset }): void;
  onImport(json: string): Promise<void>;
}) {
  const { t } = useT();
  const [json, setJson] = useState("");
  const [importing, setImporting] = useState(false);
  const toast = useToast();
  return (
    <Modal title={t("host.newBot")} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsSection title={t("dialogs.newBot.startFrom")}>
          <SettingsCard>
            <StartRow colors={colors} label={t("dialogs.newBot.blank")} hint={t("dialogs.newBot.blankHint")} onPress={() => onCreate()} />
            {BOT_TEMPLATES.map((template) => {
              const text = templateText(template, t);
              return <StartRow key={template.id} colors={colors} label={text.title} hint={text.description} avatar={{ seed: template.avatarSeed }} onPress={() => onCreate({ template })} />;
            })}
          </SettingsCard>
        </SettingsSection>
        {presets.length ? (
          <SettingsSection title={t("dialogs.newBot.presets")} info={t("dialogs.newBot.presetsInfo")}>
            <SettingsCard>
              {presets.map((preset) => (
                <StartRow key={preset.id} colors={colors} label={preset.name} hint={preset.title || preset.description} avatar={preset.avatar} onPress={() => onCreate({ preset })} />
              ))}
            </SettingsCard>
          </SettingsSection>
        ) : null}
        <SettingsSection title={t("dialogs.newBot.importButton")} info={t("dialogs.newBot.importInfo")}>
          <FormTextArea
            colors={colors}
            monospace
            accessibilityLabel={t("dialogs.newBot.importLabel")}
            value={json}
            onChangeText={setJson}
            autoCapitalize="none"
            autoCorrect={false}
            minHeight={120}
            placeholder='{"format": "aydo", …}'
          />
          <SheetActions>
            <Button
              colors={colors}
              variant="default"
              label={importing ? t("dialogs.newBot.importing") : t("dialogs.newBot.importButton")}
              loading={importing}
              disabled={!json.trim()}
              onPress={() => {
                setImporting(true);
                void onImport(json)
                  .catch((error: unknown) => toast.error(errorText(error)))
                  .finally(() => setImporting(false));
              }}
            />
          </SheetActions>
        </SettingsSection>
      </Modal.Content>
    </Modal>
  );
}

/** A whole-row pressable settings row (settings card geometry: 16 padding, 14/12 text). */
function StartRow({ colors, label, hint, avatar, onPress }: { colors: Colors; label: string; hint: string; avatar?: Partial<BotAvatar> & { seed: string }; onPress(): void }) {
  const { t } = useT();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("dialogs.createLabel", { label })}
      accessibilityHint={hint}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 16,
        paddingHorizontal: 16,
        backgroundColor: pressed || hovered ? colors.surface2 : "transparent",
      })}
    >
      {avatar ? (
        <Avatar avatar={avatar} size={28} dark={nativeTokens(colors).dark} />
      ) : (
        <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 }}>
          <Icon name="Plus" size={14} color={colors.foregroundMuted} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: ui(14), color: colors.foreground }}>
          {label}
        </Text>
        {hint ? (
          <Text numberOfLines={2} style={{ marginTop: 4, fontSize: ui(12), color: colors.foregroundMuted }}>
            {hint}
          </Text>
        ) : null}
      </View>
      <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}

// ------------------------------------------------------------------ rename

interface RenameDialogProps {
  colors: Colors;
  title: string;
  initialValue: string;
  placeholder?: string;
  submitLabel?: string;
  onClose(): void;
  onSubmit(value: string): Promise<void> | void;
}

/**
 * Paseo's AdaptiveRenameModal (components/rename-modal.tsx): the current name selected
 * in one input, the error inline, Cancel and Rename side by side. It stays open on errors.
 */
export function RenameDialog({ colors, title, initialValue, placeholder, submitLabel, onClose, onSubmit }: RenameDialogProps) {
  const { t } = useT();
  const [draft, setDraft] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const invalid = !draft.trim();
  const submitDisabled = pending || draft === initialValue || invalid;

  const submit = async () => {
    if (pending || draft === initialValue) return;
    if (invalid) {
      setError(t("dialogs.rename.required"));
      return;
    }
    try {
      setPending(true);
      await onSubmit(draft.trim());
      setPending(false);
      onClose();
    } catch (err) {
      setPending(false);
      setError(err instanceof Error && err.message ? err.message : t("dialogs.rename.unableToSave"));
    }
  };
  const cancel = () => {
    if (!pending) onClose();
  };

  return (
    <Modal title={title} open onOpenChange={(open) => !open && cancel()}>
      <Modal.Content>
        <View style={{ gap: 12, paddingBottom: 8 }}>
          <TextInput
            accessibilityLabel={title}
            defaultValue={initialValue}
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.foregroundMuted}
            autoFocus
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
            style={{
              backgroundColor: colors.surface0,
              color: colors.foreground,
              paddingVertical: 12,
              paddingHorizontal: 12,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: colors.border,
              fontSize: ui(14),
            }}
          />
          {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: ui(14) }}>{error}</Text> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <DialogButton colors={colors} label={t("dialogs.cancel")} disabled={pending} onPress={cancel} />
            <DialogButton colors={colors} label={pending ? t("dialogs.saving") : (submitLabel ?? t("dialogs.rename.submit"))} primary disabled={submitDisabled} onPress={() => void submit()} />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Paseo's Button size="sm": secondary (surface3) or default (accent). */
function DialogButton({ colors, label, primary, disabled, onPress }: { colors: Colors; label: string; primary?: boolean; disabled?: boolean; onPress(): void }) {
  const fill = primary ? colors.accent : nativeTokens(colors).surface3;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: fill,
        backgroundColor: fill,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: ui(14), color: primary ? colors.accentForeground : colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

// ------------------------------------------------------------------ menus

export interface BotMenuActions {
  bot: Bot;
  /** Set when the host exposes navigation and the bot's workspace is known. */
  onOpenInPaseo?: () => void;
  onOpenSettings(): void;
  onTogglePin(): void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRename(): void;
  onDuplicate(): Promise<void>;
  onExport(): void;
  onCopyId(): void;
  onSaveAsPreset(): void;
  onToggleArchive(): void;
  onDelete(): Promise<void>;
}

/** The bot menu, after Paseo's project menu (sidebar-workspace-list.tsx ProjectMenuItems). */
export function botMenuEntries(actions: BotMenuActions, t: Translate): MenuEntry[] {
  const { bot } = actions;
  const entries: MenuEntry[] = [{ label: t("dialogs.menu.openBotSettings"), icon: "Settings", onSelect: actions.onOpenSettings }];
  if (actions.onOpenInPaseo) entries.push({ label: t("dialogs.menu.openInPaseo"), icon: "ExternalLink", onSelect: actions.onOpenInPaseo });
  entries.push({ label: bot.pinned ? t("dialogs.menu.unpin") : t("dialogs.menu.pin"), icon: bot.pinned ? "PinOff" : "Pin", onSelect: actions.onTogglePin });
  if (actions.onMoveUp || actions.onMoveDown) {
    entries.push({ label: t("dialogs.menu.moveUp"), icon: "ArrowUp", disabled: !actions.onMoveUp, onSelect: () => actions.onMoveUp?.() });
    entries.push({ label: t("dialogs.menu.moveDown"), icon: "ArrowDown", disabled: !actions.onMoveDown, onSelect: () => actions.onMoveDown?.() });
  }
  entries.push(
    { label: t("dialogs.menu.renameBot"), icon: "Pencil", onSelect: actions.onRename },
    { label: t("dialogs.menu.duplicate"), icon: "CopyPlus", pendingLabel: t("dialogs.menu.duplicating"), onSelect: actions.onDuplicate },
    { label: t("dialogs.menu.saveAsPreset"), icon: "BookmarkPlus", onSelect: actions.onSaveAsPreset },
    { label: t("dialogs.menu.export"), icon: "Share", onSelect: actions.onExport },
    { label: t("dialogs.menu.copyBotId"), icon: "Copy", onSelect: actions.onCopyId },
    { kind: "separator" },
    { label: bot.archived ? t("dialogs.menu.unarchiveBot") : t("dialogs.menu.archiveBot"), icon: bot.archived ? "ArchiveRestore" : "Archive", onSelect: actions.onToggleArchive },
    { label: t("dialogs.menu.deleteBot"), icon: "Trash2", destructive: true, pendingLabel: t("dialogs.menu.deleting"), onSelect: actions.onDelete },
  );
  return entries;
}

export interface ChatMenuActions {
  pinned: boolean;
  onCopyPath(): void;
  onCopyId(): void;
  onCopyTranscript(): Promise<void>;
  onTogglePin(): void;
  /** Present in manual order; undefined at an edge. `null` hides the pair (pinned chats, activity order). */
  move: { up?: () => void; down?: () => void } | null;
  onOpenInPaseo?: () => void;
  onArchive(): Promise<void>;
}

/** The chat menu, after Paseo's workspace menu (sidebar/sidebar-workspace-menu.tsx). */
export function chatMenuEntries(actions: ChatMenuActions, t: Translate): MenuEntry[] {
  const entries: MenuEntry[] = [
    { label: t("dialogs.menu.copyPath"), icon: "Copy", onSelect: actions.onCopyPath },
    { label: t("dialogs.menu.copyChatId"), icon: "Copy", onSelect: actions.onCopyId },
    { label: t("dialogs.menu.copyTranscript"), icon: "FileText", pendingLabel: t("dialogs.menu.copying"), onSelect: actions.onCopyTranscript },
    { label: actions.pinned ? t("dialogs.menu.unpin") : t("dialogs.menu.pin"), icon: actions.pinned ? "PinOff" : "Pin", onSelect: actions.onTogglePin },
  ];
  if (actions.move) {
    entries.push({ label: t("dialogs.menu.moveUp"), icon: "ArrowUp", disabled: !actions.move.up, onSelect: () => actions.move?.up?.() });
    entries.push({ label: t("dialogs.menu.moveDown"), icon: "ArrowDown", disabled: !actions.move.down, onSelect: () => actions.move?.down?.() });
  }
  if (actions.onOpenInPaseo) entries.push({ label: t("dialogs.menu.openInPaseo"), icon: "ExternalLink", onSelect: actions.onOpenInPaseo });
  entries.push({ label: t("dialogs.menu.archive"), icon: "Archive", pendingLabel: t("dialogs.menu.archiving"), onSelect: actions.onArchive });
  return entries;
}

// ------------------------------------------------------------------ export

export function ExportDialog({ colors, bot, onClose }: { colors: Colors; bot: Bot; onClose(): void }) {
  const { t } = useT();
  const exportBot = useRpc(exportBotRpc);
  const toast = useToast();
  const [includeMemory, setIncludeMemory] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setJson(null);
    exportBot({ bot, includeMemory })
      .then((result) => !cancelled && setJson(result.json))
      .catch((error: unknown) => toast.error(errorText(error)));
    return () => {
      cancelled = true;
    };
    // The bot is a snapshot for this dialog; rebuild only when the memory choice changes.
  }, [includeMemory]);
  return (
    <Modal title={t("dialogs.export.title", { name: bot.name })} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <SettingsSwitch
            label={t("dialogs.export.includeMemory")}
            hint={t("dialogs.export.includeMemoryHint")}
            value={includeMemory}
            onValueChange={setIncludeMemory}
          />
          <SettingsAction
            label={t("dialogs.export.copyLabel")}
            hint={json ? t("dialogs.export.size", { size: (json.length / 1000).toFixed(1) }) : t("dialogs.export.building")}
            actionLabel={t("dialogs.export.copy")}
            disabled={!json}
            onPress={() => void copyText(json!).then(() => toast.show(t("dialogs.export.copied"), { variant: "success" }))}
          />
        </SettingsCard>
        <Text {...MONO_PROPS} selectable numberOfLines={16} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foregroundMuted }}>
          {json ?? ""}
        </Text>
      </Modal.Content>
    </Modal>
  );
}
