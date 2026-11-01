import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { RoutineRunCard as RunCard } from "../../../shared/rpc";
import { relativeTime } from "../../../shared/time";
import { StatusBadge, type BadgeVariant } from "../../panel/controls";
import { ui } from "../../typography";
import { useT } from "../../i18n/use-t";
import type { Translate } from "../../../shared/translate";
import { CardButton } from "./ui";

type Colors = PluginTheme["colors"];

function statusOf(t: Translate, status: RunCard["status"]): { label: string; variant: BadgeVariant } {
  switch (status) {
    case "running":
      return { label: t("routines.running"), variant: "muted" };
    case "succeeded":
      return { label: t("text.bucket.done"), variant: "success" };
    case "failed":
      return { label: t("text.bucket.failed"), variant: "error" };
    case "skipped-busy":
      return { label: t("chat.stream.skipped"), variant: "muted" };
    case "skipped-missed":
      return { label: t("routines.statusMissed"), variant: "warning" };
  }
}

function triggerLabel(t: Translate, trigger: RunCard["trigger"]): string {
  switch (trigger) {
    case "schedule":
      return t("routines.onSchedule");
    case "manual":
      return t("routines.byYou");
    case "webhook":
      return t("routines.fromWebhook");
  }
}

/**
 * A routine run's result in the chat the routine reports to (OpenMausBot's
 * RoutineRunCard): the scheduler posts it when the run starts and replaces it
 * when the run ends. `onOpenChat` is only there where the app can navigate.
 */
export function RoutineRunCard({ colors, card, onOpenChat }: { colors: Colors; card: RunCard; onOpenChat?: (agentId: string) => void }) {
  const { t } = useT();
  const status = statusOf(t, card.status);
  const agentId = card.agentId;
  return (
    <View style={{ marginVertical: 12, padding: 12, borderRadius: 8, borderWidth: 1, backgroundColor: colors.surface1, borderColor: colors.border, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 }}>
        <Icon name="CalendarClock" size={16} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: ui(14), lineHeight: 22 }}>
          {card.routineName}
        </Text>
        <StatusBadge colors={colors} label={status.label} variant={status.variant} />
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: ui(13) }}>{t("cards.routine.runLine", { when: new Date(card.scheduledFor).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), trigger: triggerLabel(t, card.trigger), ago: relativeTime(card.scheduledFor, undefined, t) })}</Text>
      {card.output || card.error ? (
        <Text numberOfLines={6} style={{ color: card.error ? colors.statusDanger : colors.foreground, fontSize: ui(14), lineHeight: 20 }}>
          {card.error ?? card.output}
        </Text>
      ) : null}
      {onOpenChat && agentId ? (
        <View style={{ flexDirection: "row" }}>
          <CardButton colors={colors} label={t("cards.routine.openRun")} icon="ArrowUpRight" onPress={() => onOpenChat(agentId)} />
        </View>
      ) : null}
    </View>
  );
}
