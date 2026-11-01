import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PlanOutcome } from "../../../shared/tools";
import { Markdown } from "../../Markdown";
import { ui } from "../../typography";
import { useT } from "../../i18n/use-t";
import type { Translate } from "../../../shared/translate";

type Colors = PluginTheme["colors"];

interface PlanCardProps {
  colors: Colors;
  title?: string;
  description?: string;
  text: string;
  outcome?: PlanOutcome;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
}

function outcomeTitle(t: Translate, outcome: Exclude<PlanOutcome, "pending">): string {
  switch (outcome) {
    case "rejected":
      return t("cards.plan.rejected");
    case "approved":
      return t("cards.plan.approved");
    case "canceled":
      return t("cards.plan.canceled");
  }
}

/** Paseo's PlanCard (components/plan-card.tsx): a collapsible plan with an optional action footer. */
export function PlanCard(props: PlanCardProps) {
  // A resolution starts its own presentation state.
  return <PlanCardContent key={props.outcome ?? "proposed"} {...props} />;
}

function PlanCardContent({ colors, title, description, text, outcome, footer, disableOuterSpacing = false }: PlanCardProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(outcome !== "rejected" && outcome !== "canceled");
  const resolvedTitle = title ?? (!outcome || outcome === "pending" ? t("chat.permission.plan") : outcomeTitle(t, outcome));
  return (
    <View
      style={{
        marginVertical: disableOuterSpacing ? 0 : 12,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        gap: 8,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={resolvedTitle}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 }}
      >
        <View style={expanded ? { transform: [{ rotate: "90deg" }] } : undefined}>
          <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />
        </View>
        <Text style={{ color: colors.foreground, flexShrink: 1, fontSize: ui(14), lineHeight: 22 }}>{resolvedTitle}</Text>
      </Pressable>
      {expanded ? (
        <View style={{ gap: 8 }}>
          {description ? <Text style={{ color: colors.foregroundMuted, fontSize: ui(14), lineHeight: 20 }}>{description}</Text> : null}
          <View>
            <Markdown colors={colors} text={text} linkify={false} />
          </View>
        </View>
      ) : null}
      {footer ? <View style={{ gap: 8 }}>{footer}</View> : null}
    </View>
  );
}
