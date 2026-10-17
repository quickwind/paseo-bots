import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { tidyRunRpc, tidyStatusRpc } from "../../shared/rpc";
import { useBotHost, useProviders } from "../data";
import { errorText } from "../native";
import { SearchableSelect } from "../ui/SearchableSelect";
import type { PanelProps } from "./BotPanel";
import { describeTidy, intervalLabel } from "./maintenance-text";

const INTERVALS = [30, 60, 120, 240, 480, 1440];
const THRESHOLDS = [50, 60, 70, 80, 90];

export function MaintenanceSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const providers = useProviders(host);
  const queryClient = useQueryClient();
  const toast = useToast();
  const statusRpc = useRpc(tidyStatusRpc);
  const runRpc = useRpc(tidyRunRpc);
  const [starting, setStarting] = useState(false);
  const { tidy, saveAt } = bot.memory;
  const status = useQuery({ queryKey: ["bot-crew", "tidy", bot.id], queryFn: () => statusRpc({ botId: bot.id }), refetchInterval: 15_000, enabled: host.isLocal });
  const provider = providers.data?.find((entry) => entry.provider === bot.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  const setTidy = (patch: Partial<typeof tidy>) => onPatch({ memory: { ...bot.memory, tidy: { ...tidy, ...patch } } });
  const setSave = (patch: Partial<typeof saveAt>) => onPatch({ memory: { ...bot.memory, saveAt: { ...saveAt, ...patch } } });

  if (!host.isLocal) return null;
  return (
    <SettingsSection title="Maintenance" info="Keeps this bot's memory useful as it grows. Everything it changes shows under Changes, with undo.">
      <SettingsCard>
        <SettingsSwitch
          label="Save notes when a chat fills up"
          hint="Asks the chat to write what is worth keeping to memory/inbox.md before its context is compacted."
          value={saveAt.enabled}
          onValueChange={(enabled) => setSave({ enabled })}
        />
        {saveAt.enabled ? (
          <SettingsSelect
            label="Save at"
            value={String(saveAt.percent)}
            options={[...new Set([...THRESHOLDS, saveAt.percent])].sort((a, b) => a - b).map((value) => ({ label: `${value}% of the context window`, value: String(value) }))}
            onValueChange={(value) => setSave({ percent: Number(value) })}
          />
        ) : null}
        <SettingsSwitch
          label="Tidy memory automatically"
          hint="Moves what is worth keeping from the inbox and the daily log into MEMORY.md, merges duplicates and removes what is out of date."
          value={tidy.enabled}
          onValueChange={(enabled) => setTidy({ enabled })}
        />
        {tidy.enabled ? (
          <>
            <SettingsSelect
              label="Tidy"
              value={String(tidy.everyMinutes)}
              options={[...new Set([...INTERVALS, tidy.everyMinutes])].sort((a, b) => a - b).map((value) => ({ label: intervalLabel(value), value: String(value) }))}
              onValueChange={(value) => setTidy({ everyMinutes: Number(value) })}
            />
            <SettingsSelect
              label="Tidy model"
              hint="The public model is the first usable entry of Paseo's Metadata generation setting; without one, the bot's own model is used."
              value={tidy.source}
              options={[
                { label: "Public model", value: "public" },
                { label: "Same as the bot", value: "bot" },
                { label: "A model of the bot's provider", value: "model" },
              ]}
              onValueChange={(source) => setTidy({ source })}
            />
            {tidy.source === "model" ? (
              <SearchableSelect
                colors={colors}
                label="Model"
                value={tidy.model ?? ""}
                options={models.map((entry) => ({ label: entry.label, value: entry.id }))}
                onValueChange={(model) => setTidy({ model: model || null })}
              />
            ) : null}
            <SettingsAction
              label="Status"
              hint={status.data ? describeTidy(status.data, new Date()) : "Loading..."}
              actionLabel={starting || status.data?.running ? "Working..." : "Tidy now"}
              disabled={starting || status.data?.running === true}
              onPress={() => {
                setStarting(true);
                void runRpc({ botId: bot.id })
                  .then(() => queryClient.invalidateQueries({ queryKey: ["bot-crew", "tidy", bot.id] }))
                  .catch((caught: unknown) => toast.error(errorText(caught)))
                  .finally(() => setStarting(false));
              }}
            />
          </>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
