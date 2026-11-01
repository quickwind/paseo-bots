import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { approvalSummary, sortApprovals, type ApprovalSummary } from "../../shared/approvals";
import { useApprovals } from "../approvals";
import { ApprovalCard } from "../chat/stream/ApprovalCard";
import { BackBar, PAGE_STYLE } from "../library/parts";
import { useT } from "../i18n/use-t";
import { ui } from "../typography";

type Colors = PluginSurfaceProps["theme"]["colors"];

interface ApprovalsListProps {
  colors: Colors;
  compact: boolean;
  onBack(): void;
  /** Opens the asking chat in the Bots screen. */
  onOpenChat(botId: string, chatId: string): void;
}

/**
 * Every approval a bot asked for: what waits for the user first (decided here, on the same card as in the chat),
 * then the history with who decided and when. The audit file behind it keeps more (docs/specs/2026-10-21-approvals-design.md).
 */
export function ApprovalsList({ colors, compact, onBack, onOpenChat }: ApprovalsListProps) {
  const { t } = useT();
  const query = useApprovals();
  const all = sortApprovals(query.data?.approvals ?? []);
  const waiting = all.filter((entry) => entry.status === "pending");
  const decided = all.filter((entry) => entry.status !== "pending");
  const link = (entry: ApprovalSummary) => (
    <Pressable accessibilityRole="button" accessibilityLabel={t("panel.openChatOf", { title: entry.title })} onPress={() => onOpenChat(entry.botId, entry.agentId)}>
      <Text style={{ fontSize: ui(13), color: colors.accent }}>{t("panel.openChat")}</Text>
    </Pressable>
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <BackBar colors={colors} title={t("sidebar.approvals")} backLabel={t("panel.backToBots")} onBack={onBack} />
      <ScrollView contentContainerStyle={PAGE_STYLE}>
        <Text style={{ fontSize: ui(13), color: colors.foregroundMuted, marginBottom: 12 }}>{t("panel.approvalsIntro")}</Text>
        {query.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>{t("panel.loadingEllipsis")}</Text> : null}
        {query.isError ? <Text style={{ color: colors.statusDanger, fontSize: ui(14) }}>{t("panel.loadFailed")}</Text> : null}
        {!query.isPending && all.length === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>{t("panel.noApprovals")}</Text> : null}
        {waiting.length ? <Text style={{ fontSize: ui(14), color: colors.foreground, marginTop: 8 }}>{t("panel.waitingCount", { n: waiting.length })}</Text> : null}
        {waiting.map((entry) => (
          <View key={entry.id}>
            <ApprovalCard colors={colors} compact={compact} approvalId={entry.id} />
            {link(entry)}
          </View>
        ))}
        {decided.length ? <Text style={{ fontSize: ui(14), color: colors.foreground, marginTop: 16, marginBottom: 4 }}>{t("panel.history")}</Text> : null}
        {decided.map((entry) => (
          <View key={entry.id} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border, gap: 2 }}>
            <Text style={{ fontSize: ui(14), color: colors.foreground }}>{approvalSummary(entry, t)}</Text>
            <Text style={{ fontSize: ui(12), color: colors.foregroundMuted }}>{`${t("panel.askedAt", { time: new Date(entry.createdAt).toLocaleString() })}${entry.decidedAt ? t("panel.answeredAt", { time: new Date(entry.decidedAt).toLocaleString() }) : ""}${entry.workspace ? ` · ${entry.workspace}` : ""}`}</Text>
            {link(entry)}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
