import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { DEFAULT_BOT_DEFAULTS, type Bot, type BotDefaults, type BotGroup } from "../../shared/bot";
import { addImportedBots } from "../../shared/library";
import { exportTeamRpc, importTeamRpc } from "../../shared/rpc";
import { useBotHost, useProviders } from "../data";
import { confirmDialog, errorText } from "../native";
import { Button, CardNote, FormTextArea, SheetActions } from "../panel/controls";
import { SearchableSelect } from "../ui/SearchableSelect";
import { useBotSettings } from "../useBotSettings";
import { useT } from "../i18n/use-t";
import { defaultSetupPrompt, type SetupSettings } from "../../shared/setup";
import type { ToolMode } from "../../shared/tools-mode";

type Colors = PluginSurfaceProps["theme"]["colors"];

/** Settings → Plugins → aydo: what new bots start with, saved presets, and team files. */
export function BotsSettings({ theme, host }: PluginSurfaceProps) {
  const { t } = useT();
  const colors = theme.colors;
  const { settings, commit } = useBotSettings();
  if (settings.status !== "ready") return <CardNote colors={colors} text={settings.status === "loading" ? t("settings.loading") : t("common.settingsUnreadable")} loading={settings.status === "loading"} />;
  const values = settings.values;
  return (
    <>
      <DefaultsSection
        colors={colors}
        localHost={{ id: host.id, label: host.label }}
        defaults={values.defaults ?? DEFAULT_BOT_DEFAULTS}
        onChange={(patch) => void commit((current) => ({ ...current, defaults: { ...(current.defaults ?? DEFAULT_BOT_DEFAULTS), ...patch } }))}
      />
      <ToolsSection mode={values.toolMode} onChange={(toolMode) => void commit((current) => ({ ...current, toolMode }))} />
      <SetupSection colors={colors} setup={values.setup} onChange={(setup) => void commit((current) => ({ ...current, setup }))} />
      <SettingsSection title={t("settings.presets.title")} info={t("settings.presets.info")}>
        <SettingsCard>
          {(values.presets ?? []).length === 0 ? <CardNote colors={colors} text={t("settings.presets.none")} /> : null}
          {(values.presets ?? []).map((preset) => (
            <SettingsAction
              key={preset.id}
              label={preset.name}
              hint={preset.title || preset.description || undefined}
              actionLabel={t("settings.delete")}
              onPress={() =>
                void confirmDialog({ title: t("settings.presets.deleteTitle"), message: t("settings.presets.deleteMessage", { name: preset.name }), confirmLabel: t("settings.delete"), cancelLabel: t("dialogs.cancel"), destructive: true }).then(
                  (confirmed) => confirmed && commit((current) => ({ ...current, presets: (current.presets ?? []).filter((entry) => entry.id !== preset.id) })),
                )
              }
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      <TeamSection colors={colors} bots={values.bots.filter((bot) => !bot.archived)} groups={values.groups ?? []} commit={commit} />
    </>
  );
}

/** The default for how bots get the plugin's tools: as an MCP server, or as files in their folder (for Devin, where MCP is not allowed). A bot can override it on its Agent page. */
function ToolsSection({ mode, onChange }: { mode: ToolMode | undefined; onChange(mode: "mcp" | "files"): void }) {
  const { t } = useT();
  return (
    <SettingsSection title={t("settings.tools.title")} info={t("settings.tools.info")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.tools.label")}
          value={mode === "files" ? "files" : "mcp"}
          options={[
            { label: t("settings.tools.mcp"), value: "mcp" },
            { label: t("settings.tools.files"), value: "files" },
          ]}
          onValueChange={(value) => onChange(value as "mcp" | "files")}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** The interview an assistant opens with ("Set up with the assistant"), and whether a new blank assistant starts it by itself. */
function SetupSection({ colors, setup, onChange }: { colors: Colors; setup: SetupSettings | undefined; onChange(setup: SetupSettings): void }) {
  const { t, locale } = useT();
  const current: SetupSettings = setup ?? { prompt: "", autoStart: true };
  const [text, setText] = useState(current.prompt);
  const custom = current.prompt.trim() !== "";
  return (
    <SettingsSection title={t("settings.setup.title")} info={t("settings.setup.info")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.setup.autoStart")}
          hint={t("settings.setup.autoStartHint")}
          value={current.autoStart}
          onValueChange={(autoStart) => onChange({ ...current, autoStart })}
        />
        <SettingsAction
          label={t("settings.setup.prompt")}
          hint={custom ? t("settings.setup.customPrompt") : t("settings.setup.builtInPrompt")}
          actionLabel={t("settings.setup.reset")}
          disabled={!custom && text.trim() === ""}
          onPress={() => {
            setText("");
            onChange({ ...current, prompt: "" });
          }}
        />
      </SettingsCard>
      <FormTextArea
        colors={colors}
        accessibilityLabel={t("settings.setup.promptLabel")}
        value={text}
        onChangeText={setText}
        onBlur={() => text !== current.prompt && onChange({ ...current, prompt: text })}
        autoCapitalize="none"
        placeholder={defaultSetupPrompt(false, locale)}
        minHeight={160}
      />
    </SettingsSection>
  );
}

function DefaultsSection({ colors, localHost, defaults, onChange }: { colors: Colors; localHost: { id: string; label: string }; defaults: BotDefaults; onChange(patch: Partial<BotDefaults>): void }) {
  const { t } = useT();
  const providers = useProviders(useBotHost(null, localHost));
  const provider = providers.data?.find((entry) => entry.provider === defaults.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  return (
    <SettingsSection title={t("settings.defaults.title")} info={t("settings.defaults.info")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.defaults.provider")}
          hint={defaults.provider ? undefined : t("settings.defaults.providerHint")}
          value={defaults.provider}
          options={[{ label: t("settings.defaults.automatic"), value: "" }, ...(providers.data ?? []).map((entry) => ({ label: (entry.label ?? entry.provider) + (entry.status === "ready" ? "" : ` (${entry.status})`), value: entry.provider }))]}
          onValueChange={(value) => onChange({ provider: value, model: null, modeId: null, thinkingOptionId: null })}
        />
        {provider ? (
          <>
            <SearchableSelect colors={colors} label={t("settings.defaults.model")} value={defaults.model ?? ""} options={[{ label: t("settings.defaults.default"), value: "" }, ...models.map((entry) => ({ label: entry.label, value: entry.id }))]} onValueChange={(value) => onChange({ model: value || null, thinkingOptionId: null })} />
            <SettingsSelect label={t("settings.defaults.mode")} value={defaults.modeId ?? ""} options={[{ label: t("settings.defaults.default"), value: "" }, ...(provider.modes ?? []).map((mode) => ({ label: mode.label, value: mode.id }))]} onValueChange={(value) => onChange({ modeId: value || null })} />
          </>
        ) : null}
        <SettingsSelect
          label={t("settings.defaults.contact")}
          value={defaults.contactBots}
          options={[
            { label: t("settings.defaults.contactAsk"), value: "ask" },
            { label: t("settings.defaults.contactAllow"), value: "allow" },
            { label: t("settings.defaults.contactOff"), value: "off" },
          ]}
          onValueChange={(contactBots) => onChange({ contactBots })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** A team file: every bot that isn't archived and the teams they're on, in one file; and adding those of one. */
function TeamSection({ colors, bots, groups, commit }: { colors: Colors; bots: Bot[]; groups: BotGroup[]; commit: ReturnType<typeof useBotSettings>["commit"] }) {
  const { t } = useT();
  const exportTeam = useRpc(exportTeamRpc);
  const importTeam = useRpc(importTeamRpc);
  const toast = useToast();
  const [includeMemory, setIncludeMemory] = useState(false);
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  const copyTeam = async () => {
    setBusy("export");
    try {
      const file = await exportTeam({ bots, groups, includeMemory });
      await copyText(file.json);
      toast.show(t("settings.team.copied", { count: bots.length }), { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const addTeam = async () => {
    setBusy("import");
    try {
      const imported = await importTeam({ json });
      if (await commit((current) => addImportedBots(current, imported.bots, imported.teams))) {
        setJson("");
        const teams = imported.teams.length ? t("settings.team.andTeams", { count: imported.teams.length }) : "";
        toast.show(t("settings.team.added", { count: imported.bots.length, teams }), { variant: "success" });
      }
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection title={t("settings.team.title")} info={t("settings.team.info")}>
      <SettingsCard>
        <SettingsSwitch label={t("dialogs.export.includeMemory")} hint={t("dialogs.export.includeMemoryHint")} value={includeMemory} onValueChange={setIncludeMemory} />
        <SettingsAction
          label={t("settings.team.copy")}
          hint={
            bots.length
              ? groups.length
                ? t("settings.team.copyHintTeams", { count: bots.length, teams: t("settings.team.teamCount", { count: groups.length }) })
                : t("settings.team.copyHint", { count: bots.length })
              : t("settings.team.none")
          }
          actionLabel={busy === "export" ? t("dialogs.menu.copying") : t("dialogs.export.copy")}
          disabled={!bots.length || busy !== null}
          onPress={() => void copyTeam()}
        />
      </SettingsCard>
      <FormTextArea colors={colors} monospace accessibilityLabel={t("settings.team.importLabel")} value={json} onChangeText={setJson} autoCapitalize="none" autoCorrect={false} minHeight={120} placeholder='{"format": "aydo-team", …}' />
      <SheetActions>
        <Button colors={colors} variant="default" label={busy === "import" ? t("settings.team.adding") : t("settings.team.add")} loading={busy === "import"} disabled={!json.trim() || busy !== null} onPress={() => void addTeam()} />
      </SheetActions>
    </SettingsSection>
  );
}
