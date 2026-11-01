import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { botMcpServers, toolGrants } from "../../shared/bot";
import { TOOLS_MCP_NAME } from "../../shared/bot-tools";
import { teamOf } from "../../shared/groups";
import { filesOnlyProvider, usesFiles, type BotToolMode } from "../../shared/tools-mode";
import { commandListRpc, commandRemoveRpc } from "../../shared/rpc";
import { useAgentProfiles, useBotHost, useHostWorkspaces, usePaseoTools, useProviders } from "../data";
import { errorText } from "../native";
import { useBotSettings } from "../useBotSettings";
import type { PanelProps } from "./BotPanel";
import { AdvancedToggle, CardNote, DrillRow, InputField, SectionMeta, StatusBadge, TextAreaField } from "./controls";
import { SearchableSelect } from "../ui/SearchableSelect";
import { useT } from "../i18n/use-t";
import { LibraryPicker } from "./LibraryPicker";
import { RememberedProjects } from "./RememberedProjects";

const MANAGED = "__managed__";
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/]|\\\\)/;

// ---------------------------------------------------------------- access

export function AccessSection(props: PanelProps) {
  const { t } = useT();
  const { colors, bot, localHost, onPatch } = props;
  // A folder or grants already set count as in use, so they show.
  const [advanced, setAdvanced] = useState(bot.cwd !== null || bot.alwaysAllow.length > 0);
  return (
    <>
      <PaseoToolsSection colors={colors} bot={bot} localHost={localHost} />
      <LibraryPicker {...props} kind="mcp" title={t("panel.mcpServers")} info={t("panel.mcpInfo")} />
      <AdvancedToggle colors={colors} open={advanced} onToggle={() => setAdvanced(!advanced)} />
      {advanced ? (
        <>
          <FolderSection {...props} />
          <GrantsSection {...props} />
        </>
      ) : null}
    </>
  );
}

function FolderSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const workspaces = useHostWorkspaces(host);
  const [pathText, setPathText] = useState(bot.cwd ?? "");
  // Picking a folder from the list rewrites the path field; remounting resets its text.
  const [pathKey, setPathKey] = useState(0);
  const options = [
    ...(host.isLocal ? [{ label: t("panel.shared"), value: MANAGED }] : []),
    ...(workspaces.data ?? []).map((workspace) => ({ label: workspace.label, value: workspace.directory })),
  ];
  // Shown by a select whose value isn't one of its options (SettingsSelect displays the raw value).
  const custom = t("panel.custom");
  const folderValue = bot.cwd === null ? (host.isLocal ? MANAGED : t("panel.chooseFolder")) : options.some((option) => option.value === bot.cwd) ? bot.cwd : custom;
  const pathError = pathText.trim() && !ABSOLUTE_PATH.test(pathText.trim()) ? t("panel.absolutePath") : null;
  return (
    <SettingsSection title={t("panel.workingFolder")} info={t("panel.folderInfo")}>
      <SettingsCard>
        <SettingsSelect
          label={t("panel.folder")}
          value={folderValue}
          options={options}
          onValueChange={(next) => {
            const cwd = next === MANAGED ? null : next;
            onPatch({ cwd });
            setPathText(cwd ?? "");
            setPathKey((key) => key + 1);
          }}
        />
        <InputField
          colors={colors}
          key={pathKey}
          label={t("panel.path")}
          hint={host.isLocal ? t("panel.pathHintLocal") : t("panel.pathHintRemote")}
          error={pathError}
          initialValue={pathText}
          placeholder={host.isLocal ? t("panel.sharedBotsFolder") : "/Users/me/work"}
          onChangeText={(text) => {
            setPathText(text);
            const trimmed = text.trim();
            if (!trimmed) onPatch({ cwd: null });
            else if (ABSOLUTE_PATH.test(trimmed)) onPatch({ cwd: trimmed });
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function GrantsSection({ colors, bot, library, localHost, onPatch }: PanelProps) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const [allowText, setAllowText] = useState(bot.alwaysAllow.join("\n"));
  const lines = allowText.split("\n").map((line) => line.trim()).filter(Boolean);
  // Only grants for the bot's own servers are sent; Paseo rejects the rest.
  const active = new Set([...botMcpServers(bot, library).map((server) => server.name), ...(host.isLocal ? [TOOLS_MCP_NAME] : [])]);
  const grants = toolGrants(lines).filter((grant) => active.has(grant.server));
  const ignored = lines.length - grants.length;
  return (
    <SettingsSection
      title={t("panel.alwaysAllowed")}
      info={t("panel.grantsInfo")}
      trailing={<SectionMeta colors={colors} text={`${t("panel.validCount", { n: grants.length })}${ignored ? t("panel.ignoredCount", { n: ignored }) : ""}`} tone={ignored ? "warning" : undefined} />}
    >
      <SettingsCard>
        <TextAreaField
          colors={colors}
          monospace
          accessibilityLabel={t("panel.alwaysAllowedTools")}
          value={allowText}
          onChangeText={(text) => {
            setAllowText(text);
            onPatch({ alwaysAllow: text.split("\n").map((line) => line.trim()).filter(Boolean) });
          }}
          autoCapitalize="none"
          autoCorrect={false}
          minHeight={72}
          placeholder={"files/read_file\nfetch/fetch"}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Paseo adds its own tools (other agents, workspaces, terminals, schedules, the
 * browser) to every agent it starts, bots included. Whether it does is a host
 * setting, so this shows it and can turn it back on.
 */
function PaseoToolsSection({ colors, bot, localHost }: Pick<PanelProps, "colors" | "bot" | "localHost">) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const tools = usePaseoTools(host, bot.provider);
  const [busy, setBusy] = useState(false);
  const state = tools.state;
  const label = !state ? (tools.loading ? t("panel.checking") : t("panel.cantReadHost")) : state.on ? t("panel.includedEveryChat") : t("panel.turnedOff");
  const hint = !state
    ? null
    : state.on
      ? t("panel.paseoToolsList")
      : state.reason === "provider"
        ? t("panel.offForProvider", { provider: bot.provider, host: host.label })
        : state.reason === "host"
          ? t("panel.offForHost", { host: host.label })
          : t("panel.mcpOff", { host: host.label });
  return (
    <SettingsSection title={t("panel.paseoTools")} info={t("panel.paseoToolsInfo")}>
      <SettingsCard>
        {state && !state.on && state.reason !== "mcp" ? (
          <SettingsAction
            label={label}
            hint={hint ?? undefined}
            actionLabel={busy ? t("panel.turningOn") : t("panel.turnOn")}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void tools.turnOn().finally(() => setBusy(false));
            }}
          />
        ) : (
          <SettingsRow label={label} hint={hint ?? undefined}>
            {state?.on ? <StatusBadge colors={colors} label={t("panel.on")} variant="success" /> : null}
          </SettingsRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------- model

export function ModelSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const hosts = useHosts();
  const providers = useProviders(host);
  const profiles = useAgentProfiles(host);
  const provider = providers.data?.find((entry) => entry.provider === bot.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  const model = models.find((entry) => entry.id === bot.model);
  const thinking = model?.thinkingOptions ?? models.find((entry) => entry.isDefault)?.thinkingOptions ?? [];
  const profile = (profiles.data ?? []).find((entry) => entry.provider === bot.provider && (entry.model ?? null) === bot.model);
  const providerPlaceholder = providers.isLoading ? t("settings.loading") : t("panel.chooseProvider");
  // Shown by a select whose value isn't one of its options (SettingsSelect displays the raw value).
  const custom = t("panel.custom");
  const { settings } = useBotSettings();
  const globalMode = settings.status === "ready" ? settings.values.toolMode : undefined;
  const toolsAreFiles = usesFiles(globalMode, bot.provider, bot.toolMode);
  const defaultLabel = usesFiles(globalMode, bot.provider) ? t("settings.tools.files") : t("settings.tools.mcp");
  // Another host counts as in use, so it shows.
  const [advanced, setAdvanced] = useState(bot.hostId !== null);

  return (
    <>
      <SettingsSection title={t("panel.agent")} info={t("panel.modelInfo")}>
        <SettingsCard>
          <SettingsSelect
            label={t("settings.defaults.provider")}
            value={bot.provider || providerPlaceholder}
            disabled={providers.isLoading}
            options={(providers.data ?? []).map((entry) => ({ label: (entry.label ?? entry.provider) + (entry.status === "ready" ? "" : ` (${entry.status})`), value: entry.provider }))}
            onValueChange={(value) => {
              const entry = providers.data?.find((candidate) => candidate.provider === value);
              // A provider that cannot use MCP starts with its own "files" choice; the bot keeps one it already has.
              onPatch({ provider: value, model: null, modeId: entry?.defaultModeId ?? null, thinkingOptionId: null, ...(filesOnlyProvider(value) && !bot.toolMode ? { toolMode: "files" as const } : {}) });
            }}
          />
          <SettingsSelect
            label={t("panel.toolsComeAs")}
            hint={!toolsAreFiles && filesOnlyProvider(bot.provider) ? t("panel.filesOnlyHint") : t("panel.toolsComeAsHint")}
            value={bot.toolMode ?? ""}
            options={[
              { label: t("panel.defaultWith", { tools: defaultLabel }), value: "" },
              { label: t("settings.tools.mcp"), value: "mcp" },
              { label: t("settings.tools.files"), value: "files" },
            ]}
            onValueChange={(value) => onPatch({ toolMode: value ? (value as BotToolMode) : undefined })}
          />
          <SearchableSelect
            colors={colors}
            label={t("settings.defaults.model")}
            value={provider ? (bot.model ?? "") : t("panel.chooseProviderFirst")}
            disabled={!provider}
            options={provider ? [{ label: t("settings.defaults.default"), value: "" }, ...models.map((entry) => ({ label: entry.label, value: entry.id }))] : []}
            onValueChange={(value) => onPatch({ model: value || null, thinkingOptionId: null })}
          />
          {thinking.length > 0 ? (
            <SettingsSelect
              label={t("panel.thinking")}
              value={bot.thinkingOptionId ?? ""}
              options={[{ label: t("settings.defaults.default"), value: "" }, ...thinking.map((option) => ({ label: option.label, value: option.id }))]}
              onValueChange={(value) => onPatch({ thinkingOptionId: value || null })}
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <AdvancedToggle colors={colors} open={advanced} onToggle={() => setAdvanced(!advanced)} />
      {advanced ? (
        <SettingsSection title={t("panel.whereItRuns")} info={t("panel.whereInfo")}>
          <SettingsCard>
            <SettingsSelect
              label={t("panel.host")}
              hint={host.isLocal ? t("panel.thisHost") : undefined}
              error={host.online ? null : t("panel.hostOffline", { host: host.label })}
              value={bot.hostId ?? ""}
              options={[
                { label: localHost.label, value: "" },
                ...hosts
                  .filter((entry) => entry.serverId !== localHost.id)
                  .map((entry) => ({ label: `${entry.label}${entry.status === "online" ? "" : ` (${entry.status})`}`, value: entry.serverId })),
              ]}
              onValueChange={(value) => onPatch({ hostId: value || null, provider: "", model: null, modeId: null, thinkingOptionId: null, cwd: value ? bot.cwd : null })}
            />
            {(profiles.data ?? []).length > 0 ? (
              <SettingsSelect
                label={t("panel.agentProfile")}
                hint={t("panel.profileHint")}
                value={profile?.id ?? custom}
                options={profiles.data!.map((entry) => ({ label: entry.name, value: entry.id }))}
                onValueChange={(id) => {
                  const chosen = profiles.data?.find((entry) => entry.id === id);
                  if (chosen) onPatch({ provider: chosen.provider, model: chosen.model ?? null, modeId: chosen.modeId ?? null, thinkingOptionId: chosen.thinkingOptionId ?? null });
                }}
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- permissions

export function PermissionsSection({ colors, bot, localHost, groups, onPatch }: PanelProps) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const providers = useProviders(host);
  const provider = providers.data?.find((entry) => entry.provider === bot.provider);
  const modes = provider?.modes ?? [];
  const current = modes.find((mode) => mode.id === (bot.modeId ?? provider?.defaultModeId));
  return (
    <>
      <SettingsSection title={t("panel.approval")} info={t("panel.approvalInfo")}>
        <SettingsCard>
          <SettingsSelect
            label={t("settings.defaults.mode")}
            hint={provider ? (current?.description ? t("panel.modeHint", { label: current.label, description: current.description }) : undefined) : t("panel.pickProviderForModes")}
            value={provider ? (bot.modeId ?? "") : t("panel.chooseProviderFirst")}
            disabled={!provider}
            options={provider ? [{ label: t("settings.defaults.default"), value: "" }, ...modes.map((mode) => ({ label: mode.label, value: mode.id }))] : []}
            onValueChange={(value) => onPatch({ modeId: value || null })}
          />
        </SettingsCard>
      </SettingsSection>
      {host.isLocal ? (
        <SettingsSection title={t("panel.otherBots")} info={t("panel.otherBotsInfo")}>
          <SettingsCard>
            <SettingsSelect
              label={t("panel.contactBots")}
              hint={bot.contactBots === "ask" ? t("panel.contactAskHint") : bot.contactBots === "allow" ? t("panel.contactAllowHint") : t("panel.contactNever")}
              value={bot.contactBots}
              options={[
                { label: t("settings.defaults.contactAsk"), value: "ask" },
                { label: t("settings.defaults.contactAllow"), value: "allow" },
                { label: t("settings.defaults.contactOff"), value: "off" },
              ]}
              onValueChange={(contactBots) => onPatch({ contactBots })}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {host.isLocal ? <AllowedCommands colors={colors} bot={bot} /> : null}
      {host.isLocal && !teamOf(bot.id, groups) ? <RememberedProjects colors={colors} scope={{ botId: bot.id }} title={t("teams.projects")} /> : null}
    </>
  );
}

/** OpenMausBot's saved commands: each is one exact command in one folder, added from its approval card. */
function AllowedCommands({ colors, bot }: Pick<PanelProps, "colors" | "bot">) {
  const { t } = useT();
  const list = useRpc(commandListRpc);
  const remove = useRpc(commandRemoveRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const key = ["aydo", "commands", bot.id];
  const rules = useQuery({ queryKey: key, queryFn: () => list({ botId: bot.id }) });
  const items = rules.data?.rules ?? [];
  const info = t("panel.commandsInfo");
  return (
    <SettingsSection title={t("panel.commands")} info={info}>
      <SettingsCard>
        <DrillRow colors={colors} label={t("panel.allowedCommands")} hint={rules.isLoading ? t("settings.loading") : items.length ? t("panel.commandCount", { count: items.length }) : t("panel.noneYet")} onPress={() => setOpen(true)} />
      </SettingsCard>
      {open ? (
        <Modal title={t("panel.allowedCommands")} open onOpenChange={(next) => !next && setOpen(false)}>
          <Modal.Content>
            <SettingsCard>
              {items.length === 0 ? <CardNote colors={colors} text={t("panel.noCommands")} /> : null}
              {items.map((rule) => (
                <SettingsAction
                  key={rule.id}
                  label={rule.command}
                  hint={rule.cwd}
                  actionLabel={t("attachment.remove")}
                  onPress={() =>
                    void remove({ botId: bot.id, id: rule.id })
                      .then(() => queryClient.invalidateQueries({ queryKey: key }))
                      .catch((error: unknown) => toast.error(errorText(error)))
                  }
                />
              ))}
            </SettingsCard>
          </Modal.Content>
        </Modal>
      ) : null}
    </SettingsSection>
  );
}
