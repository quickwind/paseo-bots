import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { formatPairs, joinArgs, MCP_NAME, RESERVED_MCP_NAMES, parseMcpJson, parsePairs, splitArgs, type BotMcpServer, type LibraryMcpServer, type McpServerConfig } from "../../shared/bot";
import { PASEO_MCP_NAME } from "../../shared/paseo-tools";
import { mcpSourcesRpc } from "../../shared/rpc";
import { Button, FormTextArea, InputField, SheetFooter, TextAreaField } from "../panel/controls";
import { ui } from "../typography";
import { useT } from "../i18n/use-t";

type Colors = PluginTheme["colors"];

/** The editable part of a library MCP server. */
export type McpDraft = Pick<LibraryMcpServer, "name" | "description" | "config">;

export const BLANK_SERVER: McpDraft = { name: "", description: "", config: { type: "stdio", command: "", args: [], env: {} } };


interface ServerSheetProps {
  colors: Colors;
  initial: McpDraft;
  isNew: boolean;
  /** Names of the library's other servers; a server name must be unique. */
  otherNames: string[];
  onClose(): void;
  onSave(server: McpDraft): void;
}

/** Adds or edits one MCP server: name, how to start or reach it, and its env vars or headers. */
export function ServerSheet({ colors, initial, isNew, otherNames, onClose, onSave }: ServerSheetProps) {
  const { t } = useT();
  const [server, setServer] = useState<McpDraft>(() => JSON.parse(JSON.stringify(initial)) as McpDraft);
  const { config } = server;
  const [pairsText, setPairsText] = useState(() => formatPairs(config.type === "stdio" ? config.env : config.headers));
  const setConfig = (next: McpServerConfig) => setServer({ ...server, config: next });
  const setType = (type: McpServerConfig["type"]) => {
    if (type === config.type) return;
    const next: McpServerConfig =
      type === "stdio" ? { type, command: "", args: [], env: {} } : { type, url: config.type === "stdio" ? "" : config.url, headers: config.type === "stdio" ? {} : config.headers };
    setConfig(next);
    setPairsText(formatPairs(next.type === "stdio" ? next.env : next.headers));
  };

  const name = server.name.trim();
  const nameError = !name
    ? null
    : !MCP_NAME.test(name)
      ? t("library.nameRules")
      : RESERVED_MCP_NAMES.includes(name)
        ? t("library.nameTakenBy", { name, owner: name === PASEO_MCP_NAME ? t("library.paseoOwnTools") : t("library.pluginOwnTools") })
        : otherNames.includes(name)
          ? t("library.nameInLibrary", { name })
          : null;
  const urlError = config.type !== "stdio" && config.url.trim() && !/^https?:\/\/\S+$/i.test(config.url.trim()) ? t("library.urlRules") : null;
  const complete = !!name && (config.type === "stdio" ? !!config.command.trim() : !!config.url.trim());
  const canSave = complete && !nameError && !urlError;

  return (
    <Modal title={isNew ? t("library.newMcpServer") : t("library.editMcpServer")} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label={t("teams.name")} hint={t("library.nameHint")} error={nameError} initialValue={server.name} placeholder="gmail" onChangeText={(text) => setServer({ ...server, name: text })} />
            <InputField colors={colors} label={t("library.description")} initialValue={server.description} placeholder={t("library.descriptionPlaceholder")} onChangeText={(description) => setServer({ ...server, description })} />
            <SettingsSelect
              label={t("library.transport")}
              value={config.type}
              options={[
                { label: t("library.transportStdio"), value: "stdio" },
                { label: t("library.transportHttp"), value: "http" },
                { label: "SSE", value: "sse" },
              ]}
              onValueChange={setType}
            />
            {config.type === "stdio" ? (
              <InputField colors={colors} key="command" label={t("library.command")} monospace autoCapitalize="none" autoCorrect={false} initialValue={config.command} placeholder="npx" onChangeText={(command) => setConfig({ ...config, command })} />
            ) : (
              <InputField colors={colors} key={`url-${config.type}`} label={t("library.url")} error={urlError} initialValue={config.url} placeholder="https://mcp.example.com/mcp" onChangeText={(url) => setConfig({ ...config, url: url.trim() })} />
            )}
            {config.type === "stdio" ? (
              <InputField colors={colors}
                key="args"
                label={t("library.arguments")}
                monospace
                autoCapitalize="none"
                autoCorrect={false}
                hint={t("library.argsHint")}
                initialValue={joinArgs(config.args)}
                placeholder="-y @modelcontextprotocol/server-memory"
                onChangeText={(text) => setConfig({ ...config, args: splitArgs(text) })}
              />
            ) : null}
            <TextAreaField
              key={config.type === "stdio" ? "env" : "headers"}
              colors={colors}
              monospace
              label={config.type === "stdio" ? t("library.environment") : t("library.headers")}
              hint={t("library.pairsHint")}
              value={pairsText}
              onChangeText={(text) => {
                setPairsText(text);
                const pairs = parsePairs(text);
                setConfig(config.type === "stdio" ? { ...config, env: pairs } : { ...config, headers: pairs });
              }}
              autoCapitalize="none"
              autoCorrect={false}
              minHeight={72}
              placeholder={config.type === "stdio" ? "API_KEY=..." : "Authorization=Bearer ..."}
            />
          </SettingsCard>
        </View>
        <SheetFooter>
          <Button colors={colors} size="md" label={t("dialogs.cancel")} onPress={onClose} style={{ flex: 1 }} />
          <Button
            colors={colors}
            size="md"
            variant="default"
            label={isNew ? t("library.addServer") : t("routines.saveChanges")}
            disabled={!canSave}
            onPress={() => onSave({ ...server, name, description: server.description.trim() })}
            style={{ flex: 1 }}
          />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}

/**
 * Adds servers from an `{"mcpServers": {...}}` block: pasted, or read from
 * Claude Code, Claude Desktop or Cursor on this computer. They arrive off.
 */
export function ImportSheet({ colors, onClose, onImport }: { colors: Colors; onClose(): void; onImport(servers: BotMcpServer[]): void }) {
  const { t } = useT();
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const readSources = useRpc(mcpSourcesRpc);
  const sources = useQuery({ queryKey: ["aydo", "mcp-sources"], queryFn: () => readSources({}) });
  return (
    <Modal title={t("library.importMcpServers")} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        {sources.data?.sources.length ? (
          <SettingsSection title={t("library.onThisComputer")} info={t("library.onThisComputerInfo")}>
            <SettingsCard>
              {sources.data.sources.map((source) => (
                <SettingsAction
                  key={source.label}
                  label={source.label}
                  hint={t("library.serverCount", { count: source.count })}
                  actionLabel={t("library.use")}
                  onPress={() => {
                    setJson(source.json);
                    setError(null);
                  }}
                />
              ))}
            </SettingsCard>
          </SettingsSection>
        ) : null}
        <SettingsSection title="JSON" info={t("library.jsonInfo")}>
          <FormTextArea
            colors={colors}
            monospace
            accessibilityLabel={t("library.mcpJson")}
            value={json}
            onChangeText={(text) => {
              setJson(text);
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            minHeight={160}
            placeholder='{"mcpServers": {"fetch": {"command": "uvx", "args": ["mcp-server-fetch"]}}}'
          />
          {error ? (
            <Text accessibilityRole="alert" style={{ fontSize: ui(12), color: colors.statusDanger, marginLeft: 4 }}>
              {error}
            </Text>
          ) : null}
        </SettingsSection>
        <SheetFooter>
          <Button colors={colors} size="md" label={t("dialogs.cancel")} onPress={onClose} style={{ flex: 1 }} />
          <Button
            colors={colors}
            size="md"
            variant="default"
            label={t("library.addServers")}
            disabled={!json.trim()}
            onPress={() => {
              try {
                onImport(parseMcpJson(json, t));
              } catch (caught) {
                setError((caught instanceof Error ? caught.message : String(caught)).replace(/\.$/, ""));
              }
            }}
            style={{ flex: 1 }}
          />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}
