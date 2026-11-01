import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { tidyRunRpc, tidyStatusRpc } from "../../shared/rpc";
import { useBotHost, useProviders } from "../data";
import { errorText } from "../native";
import { SearchableSelect } from "../ui/SearchableSelect";
import { useT } from "../i18n/use-t";
import type { PanelProps } from "./BotPanel";
import { describeTidy, intervalLabel } from "./maintenance-text";

const INTERVALS = [30, 60, 120, 240, 480, 1440];
const THRESHOLDS = [50, 60, 70, 80, 90];

export function MaintenanceSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const providers = useProviders(host);
  const queryClient = useQueryClient();
  const toast = useToast();
  const statusRpc = useRpc(tidyStatusRpc);
  const runRpc = useRpc(tidyRunRpc);
  const [starting, setStarting] = useState(false);
  const { tidy, saveAt } = bot.memory;
  const status = useQuery({ queryKey: ["aydo", "tidy", bot.id], queryFn: () => statusRpc({ botId: bot.id }), refetchInterval: 15_000, enabled: host.isLocal });
  const provider = providers.data?.find((entry) => entry.provider === bot.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  const setTidy = (patch: Partial<typeof tidy>) => onPatch({ memory: { ...bot.memory, tidy: { ...tidy, ...patch } } });
  const setSave = (patch: Partial<typeof saveAt>) => onPatch({ memory: { ...bot.memory, saveAt: { ...saveAt, ...patch } } });

  if (!host.isLocal) return null;
  return (
    <SettingsSection title={t("panel.maintenance")} info={t("panel.maintenanceInfo")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("panel.saveNotes")}
          hint={t("panel.saveNotesHint")}
          value={saveAt.enabled}
          onValueChange={(enabled) => setSave({ enabled })}
        />
        {saveAt.enabled ? (
          <SettingsSelect
            label={t("panel.saveAt")}
            value={String(saveAt.percent)}
            options={[...new Set([...THRESHOLDS, saveAt.percent])].sort((a, b) => a - b).map((value) => ({ label: t("panel.contextPercent", { value }), value: String(value) }))}
            onValueChange={(value) => setSave({ percent: Number(value) })}
          />
        ) : null}
        <SettingsSwitch
          label={t("panel.tidyAuto")}
          hint={t("panel.tidyHint")}
          value={tidy.enabled}
          onValueChange={(enabled) => setTidy({ enabled })}
        />
        {tidy.enabled ? (
          <>
            <SettingsSelect
              label={t("panel.tidy")}
              value={String(tidy.everyMinutes)}
              options={[...new Set([...INTERVALS, tidy.everyMinutes])].sort((a, b) => a - b).map((value) => ({ label: intervalLabel(value, t), value: String(value) }))}
              onValueChange={(value) => setTidy({ everyMinutes: Number(value) })}
            />
            <SettingsSelect
              label={t("panel.tidyModel")}
              hint={t("panel.tidyModelHint")}
              value={tidy.source}
              options={[
                { label: t("panel.publicModel"), value: "public" },
                { label: t("panel.sameAsBot"), value: "bot" },
                { label: t("panel.providerModel"), value: "model" },
              ]}
              onValueChange={(source) => setTidy({ source })}
            />
            {tidy.source === "model" ? (
              <SearchableSelect
                colors={colors}
                label={t("settings.defaults.model")}
                value={tidy.model ?? ""}
                options={models.map((entry) => ({ label: entry.label, value: entry.id }))}
                onValueChange={(model) => setTidy({ model: model || null })}
              />
            ) : null}
            <SettingsAction
              label={t("panel.status")}
              hint={status.data ? describeTidy(status.data, new Date(), t) : t("settings.loading")}
              actionLabel={starting || status.data?.running ? t("panel.working") : t("panel.tidyNow")}
              disabled={starting || status.data?.running === true}
              onPress={() => {
                setStarting(true);
                void runRpc({ botId: bot.id })
                  .then(() => queryClient.invalidateQueries({ queryKey: ["aydo", "tidy", bot.id] }))
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
