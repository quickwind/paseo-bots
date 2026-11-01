import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Bot, LibraryMcpServer } from "../../shared/bot";
import { isRemoteMcp } from "../../shared/bot";
import { mcpServerTested, mcpTarget } from "../../shared/library";
import { mcpProbeRpc } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { errorText, MONO_FONT, MONO_PROPS } from "../native";
import { Alert, Button, CardNote, SectionLink, SectionMeta } from "../panel/controls";
import { code, ui } from "../typography";
import { ServerSheet, type McpDraft } from "./McpSheets";
import { BotsCard, DangerZone, PageTitle } from "./parts";
import { useT } from "../i18n/use-t";
import type { Translate } from "../../shared/translate";

type Colors = PluginTheme["colors"];

interface McpPageProps {
  colors: Colors;
  server: LibraryMcpServer;
  bots: Bot[];
  otherNames: string[];
  showTitle: boolean;
  onPatch(patch: Partial<LibraryMcpServer>): void;
  onToggleBot(bot: Bot, on: boolean): void;
  onDelete(): void;
}

/** Keys only: values are usually secrets. */
function keysHint(server: LibraryMcpServer, t: Translate): string | null {
  const { config } = server;
  const keys = Object.keys(config.type === "stdio" ? config.env : config.headers);
  const label = config.type === "stdio" ? t("library.environment") : t("library.headers");
  return keys.length ? t("library.keysLine", { label, keys: keys.join(", ") }) : null;
}

export function McpPage({ colors, server, bots, otherNames, showTitle, onPatch, onToggleBot, onDelete }: McpPageProps) {
  const { t } = useT();
  const probe = useRpc(mcpProbeRpc);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);

  /** Tests the connection; `enable` turns the server on when it connects. */
  const test = async (config = server.config, enable = false) => {
    setTesting(true);
    try {
      const result = await probe({ config });
      const checkedAt = new Date().toISOString();
      onPatch(result.ok ? { tools: result.tools, checkError: null, checkedAt, ...(enable ? { enabled: true } : {}) } : { checkError: result.error, checkedAt });
    } catch (error) {
      onPatch({ checkError: errorText(error), checkedAt: new Date().toISOString() });
    } finally {
      setTesting(false);
    }
  };
  const tested = mcpServerTested(server);
  // A remote server is connected to by the agent, never by this plugin, so there is nothing to test here.
  const remote = isRemoteMcp(server.config);

  const tools = server.tools ?? [];
  const checked = server.checkedAt ? t("library.checkedAt", { time: relativeTime(server.checkedAt, undefined, t) }) : "";
  const toolsMeta = testing ? t("library.connecting") : server.checkedAt ? `${server.tools ? `${t("library.toolCount", { count: tools.length })} · ` : ""}${checked}` : "";

  return (
    <>
      {showTitle ? <PageTitle colors={colors} title={server.name} /> : null}
      {remote ? (
        <View style={{ marginBottom: 24 }}>
          <Alert colors={colors} variant="warning" title={t("library.remoteServer")} description={t("library.remoteServerInfo")} />
        </View>
      ) : null}
      {!remote && !server.enabled && !tested ? (
        <View style={{ marginBottom: 24, gap: 12 }}>
          <Alert colors={colors} variant="warning" title={t("library.testBeforeUse")} description={t("library.testBeforeUseInfo")} />
          <View style={{ alignItems: "flex-start" }}>
            <Button colors={colors} variant="outline" icon="PlugZap" label={testing ? t("library.testing") : t("library.testAndTurnOn")} disabled={testing} onPress={() => void test(server.config, true)} />
          </View>
        </View>
      ) : null}
      <SettingsSection title={t("library.server")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("library.enabled")}
            hint={tested || remote ? t("library.serverOffHint") : t("library.testToTurnOn")}
            value={server.enabled}
            disabled={testing}
            onValueChange={(enabled) => (enabled && !tested && !remote ? void test(server.config, true) : onPatch({ enabled }))}
          />
          <SettingsAction label={t("library.connection")} hint={[mcpTarget(server.config), keysHint(server, t)].filter(Boolean).join("\n")} actionLabel={t("teams.edit")} onPress={() => setEditing(true)} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t("settings.tools.title")}
        info={t("library.toolsInfo")}
        trailing={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {toolsMeta ? <SectionMeta colors={colors} text={toolsMeta} /> : null}
            {testing || remote ? null : <SectionLink colors={colors} icon="RefreshCw" label={server.checkedAt ? t("library.testAgain") : t("library.testConnection")} onPress={() => void test()} />}
          </View>
        }
      >
        <SettingsCard>
          {testing ? <CardNote colors={colors} loading text={t("library.startingServer")} /> : null}
          {!testing && server.checkError ? <SettingsRow label={t("library.couldntConnect")} error={server.checkError} /> : null}
          {!testing && remote ? <CardNote colors={colors} text={t("library.notListed")} /> : null}
          {!testing && !remote && !server.checkError && server.tools === null ? <CardNote colors={colors} text={t("library.testToSeeTools")} /> : null}
          {!testing && !server.checkError && server.tools?.length === 0 ? <CardNote colors={colors} text={t("library.noTools")} /> : null}
          {!testing && !server.checkError
            ? tools.map((tool) => (
                <View key={tool.name} style={{ paddingVertical: 12, paddingHorizontal: 16, gap: 4 }}>
                  <Text selectable numberOfLines={1} {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), color: colors.foreground }}>
                    {server.name}/{tool.name}
                  </Text>
                  {tool.description ? (
                    <Text numberOfLines={2} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
                      {tool.description}
                    </Text>
                  ) : null}
                </View>
              ))
            : null}
        </SettingsCard>
      </SettingsSection>

      <BotsCard colors={colors} bots={bots} info={t("library.botsInfoServer")} uses={(bot) => bot.mcpServerIds.includes(server.id)} onToggle={onToggleBot} />

      <DangerZone
        label={t("library.deleteServer")}
        hint={t("library.removeEverywhere")}
        actionLabel={t("settings.delete")}
        confirmTitle={t("library.deleteServerTitle")}
        confirmMessage={t("library.deleteServerMessage", { name: server.name })}
        onConfirm={onDelete}
      />

      {editing ? (
        <ServerSheet
          colors={colors}
          initial={server}
          isNew={false}
          otherNames={otherNames}
          onClose={() => setEditing(false)}
          onSave={(draft: McpDraft) => {
            setEditing(false);
            const changed = JSON.stringify(draft.config) !== JSON.stringify(server.config);
            // A changed connection makes the old tool list stale; test the new one right away.
            onPatch({ ...draft, ...(changed ? { tools: null, checkError: null, checkedAt: null } : {}) });
            if (changed) void test(draft.config);
          }}
        />
      ) : null}
    </>
  );
}
