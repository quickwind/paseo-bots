import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View, type TextStyle } from "react-native";
import type { Approval } from "../../../shared/approvals";
import { approvalDecideRpc, approvalGetRpc, approvalWithdrawRpc } from "../../../shared/rpc";
import { Markdown } from "../../Markdown";
import { errorText } from "../../native";
import { Alert } from "../../panel/controls";
import { ui } from "../../typography";
import { PlanCard } from "./PlanCard";
import { useT } from "../../i18n/use-t";
import type { Translate } from "../../../shared/translate";
import { CardButton, isWeb } from "./ui";

type Colors = PluginTheme["colors"];

export const approvalQueryKey = (id: string) => ["aydo", "approval", id];

const OUTCOME = { pending: "pending", approved: "approved", rejected: "rejected", withdrawn: "canceled" } as const;

function titleOf(t: Translate, status: Approval["status"]): string {
  switch (status) {
    case "pending":
      return t("cards.approval.pending");
    case "approved":
      return t("cards.approval.approved");
    case "rejected":
      return t("cards.approval.rejected");
    case "withdrawn":
      return t("cards.approval.withdrawn");
  }
}

/** A marker for this click: kept in the audit with the decision (a weak check that it came from a card). */
const clickMarker = () => `${new Date().toISOString()}:${Math.random().toString(36).slice(2, 10)}`;

/** What the card shows: the matter, then the file the bot named, whole. */
function cardText(approval: Approval, t: Translate): string {
  const file = approval.file ? `\n\n---\n\n${t("cards.approval.fileLine", { path: approval.file.path, hash: approval.file.sha256.slice(0, 12) })}\n\n${approval.file.text}` : "";
  return `${approval.text}${file}`;
}

function decidedLine(approval: Approval, t: Translate): string {
  const who = approval.decidedBy === "user" ? t("cards.by.you") : approval.decidedBy === "asking-bot" ? `${approval.botName}` : t("cards.by.plugin");
  const when = approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : "";
  let text = decisionSentence(approval.status, who, t);
  if (when) text = t("cards.decidedOn", { text, when });
  text = t("cards.decidedEnd", { text });
  return approval.note ? t("cards.decidedNote", { text, note: approval.note }) : text;
}

function decisionSentence(status: Approval["status"], who: string, t: Translate): string {
  switch (status) {
    case "approved":
      return t("cards.decided.approved", { who });
    case "rejected":
      return t("cards.decided.rejected", { who });
    default:
      return t("cards.decided.withdrawn", { who });
  }
}

/**
 * A matter a bot asked the user to approve with request_approval. The bot is stopped until the user decides here;
 * only a click on this card can decide (no tool of a bot reaches it). Rejecting needs a note, which goes back to the bot.
 */
export function ApprovalCard({ colors, compact, approvalId }: { colors: Colors; compact: boolean; approvalId: string }) {
  const { t } = useT();
  const get = useRpc(approvalGetRpc);
  const decide = useRpc(approvalDecideRpc);
  const withdraw = useRpc(approvalWithdrawRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | "cancel" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Polled while it waits, so a decision made in another window shows here too.
  const query = useQuery({ queryKey: approvalQueryKey(approvalId), queryFn: () => get({ id: approvalId }), refetchInterval: (state) => (state.state.data?.approval?.status === "pending" ? 5_000 : false) });
  const approval = query.data?.approval;

  if (query.isPending) return null;
  if (!approval) {
    return <Text style={{ marginVertical: 12, fontSize: ui(14), color: colors.foregroundMuted }}>{query.isError ? t("cards.approval.loadError", { error: errorText(query.error) }) : t("cards.approval.gone")}</Text>;
  }

  const run = async (action: "approve" | "reject" | "cancel") => {
    if (action === "reject" && !note.trim()) {
      setFailure(t("cards.approval.noteNeeded"));
      return;
    }
    setBusy(action);
    setFailure(null);
    try {
      const result = action === "cancel" ? await withdraw({ id: approval.id }) : await decide({ id: approval.id, approve: action === "approve", note, click: clickMarker() });
      queryClient.setQueryData(approvalQueryKey(approval.id), { approval: result.approval });
      void queryClient.invalidateQueries({ queryKey: ["aydo", "approvals"] });
    } catch (error) {
      const text = action === "cancel" ? t("cards.approval.couldntCancel", { error: errorText(error) }) : t("cards.approval.couldntSend", { error: errorText(error) });
      setFailure(text);
      toast.error(text);
      void query.refetch();
    } finally {
      setBusy(null);
    }
  };

  const failed = failure ? <Alert colors={colors} variant="error" title={t("cards.notDone")} description={[failure]} /> : null;
  const footer =
    approval.status === "pending" ? (
      <>
        {failed}
        <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
          {t("cards.approval.waiting", { name: approval.botName })}
          {approval.woken > 0 ? t("cards.approval.woken", { count: approval.woken }) : ""}
        </Text>
        <TextInput
          accessibilityLabel={t("cards.approval.note")}
          value={note}
          onChangeText={setNote}
          placeholder={t("cards.approval.notePlaceholder")}
          placeholderTextColor={colors.foregroundMuted}
          editable={!busy}
          multiline
          style={{
            borderWidth: 1,
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 10,
            fontSize: ui(14),
            minHeight: 44,
            borderColor: colors.border,
            color: colors.foreground,
            backgroundColor: colors.surface2,
            ...(isWeb ? ({ outlineStyle: "none", outlineWidth: 0 } as unknown as TextStyle) : {}),
          }}
        />
        <View style={compact ? { gap: 8, marginTop: 4 } : { gap: 8, marginTop: 4, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
          <CardButton colors={colors} label={t("cards.approval.cancelRequest")} icon="Undo2" busy={!!busy} spinning={busy === "cancel"} onPress={() => void run("cancel")} />
          <CardButton colors={colors} label={t("cards.approval.reject")} icon="X" busy={!!busy} spinning={busy === "reject"} onPress={() => void run("reject")} />
          <CardButton colors={colors} label={t("cards.approval.approve")} icon="Check" primary busy={!!busy} spinning={busy === "approve"} onPress={() => void run("approve")} />
        </View>
      </>
    ) : (
      <>
        {failed}
        <Markdown colors={colors} text={decidedLine(approval, t)} linkify={false} />
      </>
    );

  return <PlanCard colors={colors} title={t("cards.approval.titled", { status: titleOf(t, approval.status), title: approval.title })} description={`${approval.botName}${approval.workspace ? ` · ${approval.workspace}` : ""}`} text={cardText(approval, t)} outcome={OUTCOME[approval.status]} footer={footer} />;
}
