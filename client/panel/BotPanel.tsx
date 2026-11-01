import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { botProblems, type Bot, type BotGroup, type HistoryEntry, type Library } from "../../shared/bot";
import type { Translate } from "../../shared/translate";
import { useBotHost, type LocalHost } from "../data";
import { nativeTokens, useHover } from "../native";
import { useT } from "../i18n/use-t";
import { ui } from "../typography";
import { AccessSection, ModelSection, PermissionsSection } from "./AgentSections";
import { Alert, SearchField, useCompact } from "./controls";
import { IdentitySection } from "./IdentitySection";
import { MemorySection, PlaybooksSection, SkillsSection, SoulSection } from "./KnowledgeSections";
import { HistorySection, OverviewSection, UsageSection } from "./OverviewSections";
import { RoutinesSection } from "./RoutinesSection";
import { tooltip } from "../ui/Tooltip";

type Colors = PluginTheme["colors"];

export type SectionId = "overview" | "identity" | "soul" | "skills" | "playbooks" | "memory" | "routines" | "access" | "model" | "permissions" | "history" | "usage";

interface SectionEntry {
  id: SectionId;
  label: string;
  icon: string;
  /** Setting names inside the section; search matches and lists them. */
  rows: string[];
  keywords: string;
  /** Browsing rather than settings: opens as a modal instead of a page. */
  modal?: boolean;
}

interface SectionGroup {
  label: string;
  sections: SectionEntry[];
}

// OpenMausBot's order (bot-settings/sections.ts), minus sections Paseo has no equivalent for,
// grouped like Paseo's settings sidebar. A function, so the labels follow the language.
function sectionGroups(t: Translate): SectionGroup[] {
  return [
    {
      label: t("panel.group.bot"),
      sections: [
        { id: "overview", label: t("panel.overview"), icon: "LayoutDashboard", rows: [t("panel.setUp"), t("panel.systemPrompt")], keywords: t("panel.keywords.overview") },
        { id: "identity", label: t("panel.identity"), icon: "IdCard", rows: [t("panel.avatar"), t("panel.colour"), t("panel.shape"), t("panel.imageUrl"), t("teams.name"), t("panel.title"), t("panel.blurb"), t("panel.voice"), t("panel.readReplies")], keywords: t("panel.keywords.identity") },
        { id: "soul", label: t("panel.soul"), icon: "ScrollText", rows: [t("panel.standingInstructions")], keywords: t("panel.keywords.soul") },
      ],
    },
    {
      label: t("panel.group.knowledge"),
      sections: [
        { id: "skills", label: t("panel.skills"), icon: "Puzzle", rows: [t("panel.librarySkills")], keywords: t("panel.keywords.skills") },
        { id: "playbooks", label: t("panel.playbooks"), icon: "BookOpenCheck", rows: [t("panel.newPlaybook"), t("panel.triggerWords"), t("panel.steps")], keywords: t("panel.keywords.playbooks") },
        { id: "memory", label: t("panel.memory"), icon: "Brain", rows: ["MEMORY.md", t("panel.topicFiles"), t("panel.changes"), t("panel.dailyLog"), t("panel.newTopicFile")], keywords: t("panel.keywords.memory") },
      ],
    },
    {
      label: t("panel.group.automation"),
      sections: [{ id: "routines", label: t("panel.routines"), icon: "CalendarClock", rows: [t("panel.newRoutine"), t("panel.cadence"), t("panel.runNow")], keywords: t("panel.keywords.routines") }],
    },
    {
      label: t("panel.agent"),
      sections: [
        { id: "access", label: t("panel.access"), icon: "KeyRound", rows: [t("panel.workingFolder"), t("panel.paseoTools"), t("panel.mcpServers"), t("panel.alwaysAllowed")], keywords: t("panel.keywords.access") },
        { id: "model", label: t("settings.defaults.model"), icon: "Sparkles", rows: [t("panel.host"), t("panel.agentProfile"), t("settings.defaults.provider"), t("settings.defaults.model"), t("panel.thinking")], keywords: t("panel.keywords.model") },
        { id: "permissions", label: t("panel.permissions"), icon: "Shield", rows: [t("settings.defaults.mode"), t("panel.contactBots"), t("panel.allowedCommands")], keywords: t("panel.keywords.permissions") },
      ],
    },
    {
      label: t("panel.group.activity"),
      sections: [
        { id: "history", label: t("panel.history"), icon: "History", rows: [t("panel.earlierVersions")], keywords: t("panel.keywords.history"), modal: true },
        { id: "usage", label: t("panel.usage"), icon: "ChartNoAxesColumn", rows: [t("panel.chats"), t("panel.tokens"), t("panel.cost")], keywords: t("panel.keywords.usage"), modal: true },
      ],
    },
  ];
}

export interface PanelProps {
  colors: Colors;
  bot: Bot;
  localHost: LocalHost;
  history: HistoryEntry[];
  /** The shared skills and MCP servers the bot picks from. */
  library: Library;
  groups: readonly BotGroup[];
  onPatch(patch: Partial<Bot>): void;
  /** Saves pending edits now (routines run from the saved bot). */
  flush(): Promise<void>;
  onRestore(snapshot: Bot): void;
  onSetup(): void;
  /** Shows one of the bot's chats (a routine run). */
  onOpenChat(chatId: string): void;
}

interface BotPanelProps extends PanelProps {
  /** Open section (detail view), or null for the section list. */
  section: SectionId | null;
  onSection(section: SectionId | null): void;
  onClose(): void;
  /** The surface's compact layout; falls back to the window width. */
  compact?: boolean;
  /** The home indicator on phones. */
  bottomInset: number;
}

/**
 * Bot settings as Paseo's list+detail (docs/design.md §9) in its compact form: a
 * section list, and a pushed detail page whose header carries a back arrow.
 */
export function BotPanel(props: BotPanelProps) {
  const { colors, bot, localHost, section, onSection, onClose, bottomInset } = props;
  const { t } = useT();
  const groups = sectionGroups(t);
  const sections = groups.flatMap((group) => group.sections);
  const compact = useCompact(props.compact);
  const [query, setQuery] = useState("");
  const host = useBotHost(bot.hostId, localHost);
  const problems = botProblems(bot, host.isLocal, t);
  const open = section ? sections.find((entry) => entry.id === section && !entry.modal) : undefined;
  const [sheet, setSheet] = useState<SectionEntry | null>(null);
  const choose = (entry: SectionEntry) => (entry.modal ? setSheet(entry) : onSection(entry.id));

  if (open) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
        <PanelHeader colors={colors} compact={compact} title={open.label} onBack={() => onSection(null)} onClose={onClose} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingTop: 24, paddingBottom: 32 + bottomInset }}>
          {renderSection(open.id, props)}
        </ScrollView>
      </View>
    );
  }

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? sections.flatMap((entry) => {
        const rows = entry.rows.filter((row) => row.toLowerCase().includes(needle));
        const hit = rows.length > 0 || `${entry.label} ${entry.keywords}`.toLowerCase().includes(needle);
        return hit ? [{ entry, rows }] : [];
      })
    : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <PanelHeader colors={colors} compact={compact} title={bot.name || t("panel.untitled")} onClose={onClose} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 + bottomInset }}>
        <View style={{ paddingHorizontal: 8, paddingTop: 8, gap: 8 }}>
          <SearchField colors={colors} value={query} onChangeText={setQuery} placeholder={t("panel.searchSettings")} />
          {problems.length > 0 ? <Alert colors={colors} variant="warning" title={t("panel.needsAttention")} description={problems} /> : null}
        </View>
        {needle ? (
          <View style={{ paddingVertical: 8, paddingHorizontal: 8, gap: 2 }}>
            {matches.map(({ entry, rows }) => (
              <SectionRow key={entry.id} colors={colors} compact={compact} entry={entry} hint={rows.join(t("text.change.listSep"))} onPress={() => choose(entry)} />
            ))}
            {matches.length === 0 ? (
              <Text style={{ fontSize: ui(14), color: colors.foregroundMuted, textAlign: "center", paddingVertical: 32 }}>{t("panel.noMatch", { query: query.trim() })}</Text>
            ) : null}
          </View>
        ) : (
          groups.map((group) => (
            <View key={group.label} style={{ paddingVertical: 8, paddingHorizontal: 8, gap: 2 }}>
              <Text style={{ fontSize: ui(14), color: nativeTokens(colors).foregroundExtraMuted, paddingHorizontal: 8, paddingVertical: 4 }}>{group.label}</Text>
              {group.sections.map((entry) => (
                <SectionRow key={entry.id} colors={colors} compact={compact} entry={entry} onPress={() => choose(entry)} />
              ))}
            </View>
          ))
        )}
      </ScrollView>
      {sheet ? (
        <Modal title={sheet.label} open onOpenChange={(next) => !next && setSheet(null)}>
          <Modal.Content>{renderSection(sheet.id, props)}</Modal.Content>
        </Modal>
      ) : null}
    </View>
  );
}

function renderSection(id: SectionId, props: PanelProps): ReactNode {
  switch (id) {
    case "overview":
      return <OverviewSection {...props} />;
    case "identity":
      return <IdentitySection {...props} />;
    case "soul":
      return <SoulSection {...props} />;
    case "skills":
      return <SkillsSection {...props} />;
    case "playbooks":
      return <PlaybooksSection {...props} />;
    case "memory":
      return <MemorySection {...props} />;
    case "routines":
      return <RoutinesSection {...props} />;
    case "access":
      return <AccessSection {...props} />;
    case "model":
      return <ModelSection {...props} />;
    case "permissions":
      return <PermissionsSection {...props} />;
    case "history":
      return <HistorySection {...props} />;
    case "usage":
      return <UsageSection {...props} />;
  }
}

/**
 * Paseo's settings sidebar item (settings-screen.tsx sidebarStyles.item: 28 min height, 4/8
 * padding, radius 8, 16pt icon, muted 14pt label, surfaceSidebarHover on hover) with a
 * drill-in chevron when the detail replaces the list. Touch-sized (36) on compact.
 */
function SectionRow({ colors, compact, entry, hint, onPress }: { colors: Colors; compact: boolean; entry: SectionEntry; hint?: string; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: compact ? 36 : 28,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: hovered || pressed ? colors.surface1 : "transparent",
      })}
    >
      <Icon name={entry.icon} size={16} color={hovered ? colors.foreground : colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: ui(14), color: hovered ? colors.foreground : colors.foregroundMuted }}>
          {entry.label}
        </Text>
        {hint ? (
          <Text numberOfLines={1} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
            {hint}
          </Text>
        ) : null}
      </View>
      {entry.modal ? null : <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />}
    </Pressable>
  );
}

/**
 * One header row: the bot name on the list, a back arrow and the section title on a
 * detail page (BackHeader), and the close button. 36 high on desktop, 48 on compact;
 * the title is ScreenTitle (14pt, weight 300 desktop / 400 compact).
 */
function PanelHeader({ colors, compact, title, onBack, onClose }: { colors: Colors; compact: boolean; title: string; onBack?: () => void; onClose(): void }) {
  const { t } = useT();
  return (
    <View
      style={{
        height: compact ? 56 : 36,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingLeft: onBack ? 4 : compact ? 16 : 12,
        paddingRight: compact ? 8 : 4,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.surface0,
      }}
    >
      {onBack ? <HeaderButton colors={colors} compact={compact} icon="ArrowLeft" label={t("panel.backToSettings")} iconSize={20} onPress={onBack} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: ui(14), fontWeight: compact ? "400" : "300", color: colors.foreground }}>
        {title}
      </Text>
      <HeaderButton colors={colors} compact={compact} icon="X" label={t("panel.closeSettings")} iconSize={18} onPress={onClose} />
    </View>
  );
}

/** Header control: 34 box on desktop, 32 on compact; interactionHighlight on hover and press. */
function HeaderButton({ colors, compact, icon, label, iconSize, onPress }: { colors: Colors; compact: boolean; icon: string; label: string; iconSize: number; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  const box = compact ? 32 : 34;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label, "bottom")}
      hitSlop={8}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        width: box,
        height: box,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered || pressed ? nativeTokens(colors).interactionHighlight : "transparent",
      })}
    >
      <Icon name={icon} size={iconSize} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}
