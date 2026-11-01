import type { PluginTheme } from "@getpaseo/plugin";
import type { PaseoAgent } from "./paseo";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard } from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, type LayoutRectangle, Platform, Text, View } from "react-native";
import { randomSeed } from "../shared/avatar";
import { applyDefaults, DEFAULT_BOT_DEFAULTS, DEFAULT_BOT_LIST_UI, EMPTY_LIBRARY, newBotId, newGroupId, presetFromBot, pushHistory, type Bot, type BotGroup, type BotListUi, type Library } from "../shared/bot";
import { saveTeam, tabOf, teamOf, teamTabs, withBot, withoutBot } from "../shared/groups";
import { addImportedBots, withDefaultProvider } from "../shared/library";
import { archiveOrphanBotWorkspaces, displayTitle, startBotChat, syncBotWorkspaceTitle } from "../shared/chat";
import { moveKey } from "../shared/sidebar";
import { chatTranscript } from "../shared/transcript";
import { ensureBotHomeRpc, hostCapsRpc, mountRpc, exportBotRpc, importBotRpc, importTeamRpc, systemPromptRpc } from "../shared/rpc";
import { botFromPreset, newBot } from "../shared/templates";
import { mergeDraft } from "./draft";
import { AvatarTheme } from "./Avatar";
import { botMenuEntries, chatMenuEntries, ExportDialog, NewBotDialog, RenameDialog } from "./BotDialogs";
import { NO_HOST_CAPS } from "../shared/host-caps";
import { sendsPromptInChat } from "../shared/identity";
import { usesFiles } from "../shared/tools-mode";
import { setupPromptText, shouldAutoSetup } from "../shared/setup";
import { BotSidebar, type ChatMenuContext, type MenuSource, type Selection } from "./BotSidebar";
import { ChatPane, type OutgoingMessage } from "./ChatPane";
import { ApprovalsList } from "./panel/ApprovalsList";
import { friendlyStartError } from "./workspace-choice";
import { useBotHost, useWorkspaceChoices, useChatInvalidation, useHostResolver, useProviders, type LocalHost } from "./data";
import { pendingAutoStart } from "./auto-start";
import { takeIntent } from "./intent";
import { LibraryView } from "./library/LibraryView";
import { onApprovalsOpen, onLibraryTarget, type LibraryTarget } from "./navigation";
import { Splash } from "./Splash";
import { TeamMap } from "./teams/TeamMap";
import { TeamSheet } from "./teams/TeamSheet";
import { TeamTabsRow, TeamTabSwitcher } from "./teams/TeamTabs";
import { ResizeHandle, SlideOver } from "./ui/Columns";
import { fitColumns } from "../shared/layout";
import { confirmDialog, errorText, nativeTokens } from "./native";
import { measureAnchor, MenuProvider, useMenu } from "./ui/Menu";
import { useT } from "./i18n/use-t";
import { useTooltipTheme } from "./ui/Tooltip";
import { homeIndicatorInset, useKeyboardHeight } from "./keyboard";
import { newMessageId } from "./sent-attachments";
import { BotPanel, type SectionId } from "./panel/BotPanel";
import { useBotSettings } from "./useBotSettings";
import { fullTimeline, useChat } from "./useChat";
import { newUuid } from "../shared/uuid";
import { ui, useTypeScale } from "./typography";

type Colors = PluginTheme["colors"];

/** Autosave delay after the last edit in the settings panel. */
const SAVE_DELAY_MS = 600;

export function BotsSurface(props: PluginSurfaceProps) {
  const { colors } = props.theme;
  useTooltipTheme(colors);
  return (
    <MenuProvider colors={colors} compact={props.layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <BotsSurfaceContent {...props} />
      </AvatarTheme>
    </MenuProvider>
  );
}


function BotsSurfaceContent({ theme, layout, host, navigation }: PluginSurfaceProps) {
  const { colors } = theme;
  const { settings, latest, commit } = useBotSettings();
  const { t, locale } = useT();
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const localHost: LocalHost = { id: host.id, label: host.label };
  const localBotHost = useBotHost(null, localHost);
  const localProviders = useProviders(localBotHost);
  const resolveHost = useHostResolver(localHost);

  // A deleted bot's workspace would stay in the sidebar (deleting from a card, or in another window, never passes through remove()),
  // so settle it whenever the bots change: archive the Bots-project workspaces whose bot is gone. Only once the bots have loaded.
  const botIds = settings.status === "ready" ? settings.values.bots.map((bot) => bot.id).sort().join(",") : null;
  const localApi = localBotHost.api;
  useEffect(() => {
    if (botIds === null || !localApi) return;
    const timer = setTimeout(() => void archiveOrphanBotWorkspaces(localApi, new Set(botIds ? botIds.split(",") : [])).catch(() => {}), 2000);
    return () => clearTimeout(timer);
  }, [botIds, localApi]);
  const exportBot = useRpc(exportBotRpc);
  const importBot = useRpc(importBotRpc);
  const importTeam = useRpc(importTeamRpc);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; section: SectionId | null }>({ open: false, section: null });
  const [panelVersion, setPanelVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  /** The team map replaces the chat pane while open. */
  const [teamMap, setTeamMap] = useState(false);
  const [editingTeam, setEditingTeam] = useState<BotGroup | "new" | null>(null);
  /** Skills & Tools replaces the bot list and chat while open; `target` is its page (null: the list, on compact). */
  const [libraryView, setLibraryView] = useState<{ target: LibraryTarget | null } | null>(null);
  /** The approvals list replaces the bot list and chat while open, as Skills & Tools does. */
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [renaming, setRenaming] = useState<Bot | null>(null);
  const [exporting, setExporting] = useState<Bot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Bot>>({});
  // List state (collapsed groups, pins, order, display options) applies at once and saves behind.
  const [uiOverride, setUiOverride] = useState<BotListUi | null>(null);
  const uiRef = useRef<BotListUi | null>(null);
  const paneRef = useRef<View>(null);
  const keyboardHeight = useKeyboardHeight();
  /** The home indicator on phones; the keyboard covers it while it's up. */
  const bottomInset = keyboardHeight > 0 ? 0 : homeIndicatorInset();
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  /** Widths while a resize handle is being dragged; saved to the list UI on release. */
  const [dragWidths, setDragWidths] = useState<{ list?: number; panel?: number }>({});
  // Re-renders the whole surface when Paseo's interface/content/code sizes change.
  const typeVersion = useTypeScale();
  useChatInvalidation();

  // ------------------------------------------------------------ persistence
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Each bot as it was when its draft began, so a save applies only what was edited. */
  const draftBases = useRef<Record<string, Bot>>({});

  const flush = async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const pending = draftsRef.current;
    if (Object.keys(pending).length === 0) return;
    const ok = await commit((values) => {
      let history = values.history;
      const bots = values.bots.map((bot) => {
        const draft = pending[bot.id];
        if (!draft) return bot;
        history = pushHistory(history, bot);
        return mergeDraft(bot, draft, draftBases.current[bot.id]);
      });
      return { ...values, bots, history };
    });
    if (ok) {
      setDrafts((current) => {
        const next = { ...current };
        for (const [id, bot] of Object.entries(pending)) {
          if (next[id] !== bot) continue;
          delete next[id];
          delete draftBases.current[id];
        }
        return next;
      });
    }
  };

  const patchBot = (botId: string, patch: Partial<Bot>) => {
    setDrafts((current) => {
      const base = current[botId] ?? (latest.current.status === "ready" ? latest.current.values.bots.find((bot) => bot.id === botId) : undefined);
      if (base && !current[botId]) draftBases.current[botId] = base;
      return base ? { ...current, [botId]: { ...base, ...patch, updatedAt: new Date().toISOString() } } : current;
    });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  // Save pending edits when the surface closes.
  useEffect(() => () => void flush(), []);

  const currentUi = (): BotListUi =>
    uiRef.current ?? (latest.current.status === "ready" ? latest.current.values.ui : undefined) ?? DEFAULT_BOT_LIST_UI;

  const updateUi = (mutate: (current: BotListUi) => BotListUi) => {
    const next = mutate(currentUi());
    uiRef.current = next;
    setUiOverride(next);
    void commit((values) => ({ ...values, ui: uiRef.current ?? next }));
  };

  /** Applies a patch to the saved bot and to any unsaved draft of it, so autosave can't undo it. */
  const updateBot = (botId: string, patch: Partial<Bot>, recordHistory = false) => {
    setDrafts((current) => (current[botId] ? { ...current, [botId]: { ...current[botId], ...patch } } : current));
    return commit((values) => {
      const previous = values.bots.find((entry) => entry.id === botId);
      if (!previous) return values;
      return {
        ...values,
        bots: values.bots.map((entry) => (entry.id === botId ? { ...entry, ...patch, updatedAt: new Date().toISOString() } : entry)),
        history: recordHistory ? pushHistory(values.history, previous) : values.history,
      };
    });
  };

  /** Opens Skills & Tools. Unsaved bot edits are saved first so the library sees them. */
  const enterLibrary = (target: LibraryTarget | null) => {
    void flush();
    setLibraryView({ target });
  };

  // A bot's settings and the bot list ask for Skills & Tools through the navigation store.
  const enterLibraryRef = useRef(enterLibrary);
  enterLibraryRef.current = enterLibrary;
  useEffect(
    () =>
      onLibraryTarget((target) => {
        enterLibraryRef.current(target);
      }),
    [],
  );

  // The sidebar's Approvals button asks for the list through the navigation store.
  useEffect(() => onApprovalsOpen(() => setApprovalsOpen(true)), []);

  // One step back through the Bots screen, as Paseo's own screens go back: a settings page to
  // the settings list, then the settings, Skills & Tools (page, then list), and on phones the
  // team map or a chat back to the bot list. Android's Back and the phone swipes use it; with
  // nothing left to step back from, Back leaves the plugin.
  const back = useRef({ panel, compact: layout.compact, selection, teamMap, libraryView, approvalsOpen });
  back.current = { panel, compact: layout.compact, selection, teamMap, libraryView, approvalsOpen };
  const goBack = (): boolean => {
    const state = back.current;
    if (state.approvalsOpen) {
      setApprovalsOpen(false);
      return true;
    }
    if (state.libraryView) {
      setLibraryView(state.compact && state.libraryView.target ? { target: null } : null);
      return true;
    }
    if (state.panel.open) {
      setPanel(state.panel.section ? { open: true, section: null } : { open: false, section: null });
      return true;
    }
    if (!state.compact) return false;
    if (state.teamMap) {
      setTeamMap(false);
      return true;
    }
    if (state.selection) {
      setSelection(null);
      return true;
    }
    return false;
  };
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => goBackRef.current());
    return () => subscription.remove();
  }, []);

  // "New bot" from the Command Center opens a fresh Bots screen; only that one consumes it.
  useEffect(() => {
    const intent = takeIntent();
    if (intent?.kind === "new-bot") setCreating(true);
  }, []);

  if (settings.status !== "ready") {
    return (
      <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: colors.surface0, justifyContent: settings.status === "loading" ? "center" : "flex-start", alignItems: settings.status === "loading" ? "center" : "stretch" }}>
        {settings.status === "loading" ? (
          <ActivityIndicator size="large" color={colors.foregroundMuted} accessibilityLabel={t("surface.loadingBots")} />
        ) : (
          <Text style={{ fontSize: ui(14), color: colors.statusDanger }}>{t("surface.readError", { error: settings.error })}</Text>
        )}
        {settings.status === "invalid" ? (
          <SettingsCard>
            <SettingsAction label={t("surface.resetBots")} hint={t("surface.resetBotsHint")} actionLabel={t("surface.reset")} onPress={() => void settings.reset()} />
          </SettingsCard>
        ) : null}
      </View>
    );
  }

  const listUi = uiOverride ?? settings.values.ui ?? DEFAULT_BOT_LIST_UI;
  const columns = fitColumns(
    surfaceWidth || 1600,
    dragWidths.list ?? listUi.listWidth,
    panel.open && selection ? (dragWidths.panel ?? listUi.panelWidth) : null,
  );
  const commitWidth = (key: "listWidth" | "panelWidth", width: number) => {
    setDragWidths({});
    updateUi((current) => ({ ...current, [key]: Math.round(width) }));
  };
  const allBots = settings.values.bots.map((bot) => drafts[bot.id] ?? bot);
  const library = settings.values.library ?? EMPTY_LIBRARY;
  const groups = settings.values.groups ?? [];
  const listed = allBots
    .filter((bot) => listUi.showArchived || !bot.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const selectedBot = selection ? allBots.find((bot) => bot.id === selection.botId) : undefined;
  const archivedCount = allBots.filter((bot) => bot.archived).length;
  const tabs = teamTabs(groups, listed);
  const openTab = tabs.find((tab) => tab.id === listUi.tab) ?? tabs[0] ?? null;

  // ------------------------------------------------------------ actions

  /** Opens a chat, showing its bot in the list: expanded, and its team's tab open. */
  const select = (next: Selection) => {
    setSelection(next);
    setTeamMap(false);
    const tab = openTab && tabOf(next.botId, groups) !== openTab.id ? tabOf(next.botId, groups) : null;
    if (tab || currentUi().collapsed.includes(next.botId)) {
      updateUi((current) => ({ ...current, tab: tab ?? current.tab, collapsed: current.collapsed.filter((id) => id !== next.botId) }));
    }
  };

  const openPanel = (bot: Bot, section: SectionId | null) => {
    if (selection?.botId !== bot.id) select({ botId: bot.id, chatId: null });
    setPanel({ open: true, section });
  };

  /** Saves a new bot and opens it with its settings. */
  const addBot = async (bot: Bot, section: SectionId | null = null, setupPrompt?: string) => {
    // Made while a team's tab is open, the bot joins that team.
    const teamId = openTab?.group?.id;
    const saved = await commit((values) => ({ ...values, bots: [...values.bots, bot], ...(teamId ? { groups: withBot(values.groups ?? [], teamId, bot.id, new Date().toISOString()) } : {}) }));
    if (saved) {
      // A blank bot starts its setup interview in the chat; the settings stay one tap away.
      select({ botId: bot.id, chatId: null, ...(setupPrompt ? { prompt: setupPrompt } : {}) });
      setPanel({ open: !setupPrompt, section });
    }
  };

  const defaultProvider = () => {
    const ready = (localProviders.data ?? []).filter((entry) => entry.status === "ready");
    return (ready.find((entry) => entry.provider === "claude") ?? ready[0])?.provider ?? "";
  };

  const duplicate = async (bot: Bot) => {
    await flush();
    const { json } = await exportBot({ bot, includeMemory: false });
    const { bot: copy } = await importBot({ botId: newBotId(), json });
    // Same library items as the original; the copy's own file only carries redacted server settings.
    await addBot({
      ...copy,
      name: t("templates.copyName", { name: bot.name }),
      hostId: bot.hostId,
      cwd: bot.cwd,
      alwaysAllow: bot.alwaysAllow,
      skillIds: bot.skillIds,
      mcpServerIds: bot.mcpServerIds,
      avatar: { ...bot.avatar, seed: randomSeed() },
    });
  };

  const remove = async (bot: Bot) => {
    const ok = await commit((values) => ({
      ...values,
      bots: values.bots.filter((entry) => entry.id !== bot.id),
      history: values.history.filter((entry) => entry.botId !== bot.id),
      groups: withoutBot(values.groups ?? [], bot.id, new Date().toISOString()),
    }));
    if (!ok) return;
    if (selection?.botId === bot.id) setSelection(null);
    updateUi((current) => {
      const { [bot.id]: _order, ...chatOrder } = current.chatOrder;
      return {
        ...current,
        collapsed: current.collapsed.filter((id) => id !== bot.id),
        pinnedChats: current.pinnedChats.filter((pin) => pin.botId !== bot.id),
        chatOrder,
      };
    });
  };

  /**
   * Swaps a bot with its neighbour as the list shows it: on a team's tab within the team,
   * whose Chief of Staff stays first; otherwise among the listed bots, where pinned and
   * unpinned bots keep their own runs.
   */
  const moveBot = (bot: Bot, delta: -1 | 1): (() => void) | undefined => {
    const shown = openTab?.bots ?? listed;
    const index = shown.findIndex((entry) => entry.id === bot.id);
    const neighbour = shown[index + delta];
    if (index === -1 || !neighbour) return undefined;
    const swap = (ids: readonly string[]) => ids.map((id) => (id === bot.id ? neighbour.id : id === neighbour.id ? bot.id : id));
    const group = openTab?.group;
    if (group) {
      if (bot.id === group.leadId || neighbour.id === group.leadId) return undefined;
      return () =>
        void commit((values) => ({
          ...values,
          groups: (values.groups ?? []).map((entry) => (entry.id === group.id ? { ...entry, memberIds: swap(entry.memberIds), updatedAt: new Date().toISOString() } : entry)),
        }));
    }
    if (neighbour.pinned !== bot.pinned) return undefined;
    return () =>
      void commit((values) => {
        const order = swap(values.bots.map((entry) => entry.id));
        return { ...values, bots: order.map((id) => values.bots.find((entry) => entry.id === id)!) };
      });
  };

  const copy = (text: string, done: string) =>
    void copyText(text)
      .then(() => toast.show(done, { variant: "success" }))
      .catch(() => toast.error(t("surface.unableToCopy")));

  const openBotMenu = (bot: Bot, anchor: LayoutRectangle, source: MenuSource) => {
    const botHost = resolveHost(bot.hostId);
    const chats = queryClient.getQueryData<PaseoAgent[]>(["aydo", "chats", botHost.key, bot.id]) ?? [];
    const workspaceId = chats.find((chat) => chat.workspaceId)?.workspaceId;
    const openWorkspace = navigation?.openWorkspace;
    menu.open({
      anchor,
      align: source === "kebab" ? "end" : "start",
      width: 220,
      title: t("sidebar.botActions"),
      entries: botMenuEntries({
        bot,
        onOpenInPaseo: openWorkspace && workspaceId && botHost.online ? () => openWorkspace({ workspaceId, serverId: botHost.key }) : undefined,
        onOpenSettings: () => openPanel(bot, null),
        onTogglePin: () => void updateBot(bot.id, { pinned: !bot.pinned }),
        onMoveUp: moveBot(bot, -1),
        onMoveDown: moveBot(bot, 1),
        onRename: () => setRenaming(bot),
        onDuplicate: () => duplicate(bot).catch((error: unknown) => toast.error(t("surface.couldntDuplicate", { error: errorText(error) }))),
        onExport: () => setExporting(bot),
        onCopyId: () => copy(bot.id, t("surface.botIdCopied")),
        onSaveAsPreset: () =>
          void flush()
            .then(() => commit((values) => ({ ...values, presets: [...(values.presets ?? []), presetFromBot(values.bots.find((entry) => entry.id === bot.id) ?? bot)] })))
            .then((saved) => saved && toast.show(t("surface.savedPreset", { name: bot.name }), { variant: "success" })),
        onToggleArchive: () => void updateBot(bot.id, { archived: !bot.archived }),
        onDelete: async () => {
          const confirmed = await confirmDialog({
            title: t("surface.deleteBotTitle"),
            message: t("surface.deleteBotMessage", { name: bot.name }),
            confirmLabel: t("settings.delete"),
            cancelLabel: t("dialogs.cancel"),
            destructive: true,
          });
          if (confirmed) await remove(bot);
        },
      }, t),
    });
  };

  const deleteTeam = async (group: BotGroup) => {
    const confirmed = await confirmDialog({ title: t("surface.deleteTeamTitle"), message: t("surface.deleteTeamMessage", { name: group.name }), confirmLabel: t("settings.delete"), cancelLabel: t("dialogs.cancel"), destructive: true });
    if (!confirmed) return false;
    await commit((values) => ({ ...values, groups: (values.groups ?? []).filter((entry) => entry.id !== group.id) }));
    return true;
  };

  const openTeamMenu = (group: BotGroup, anchor: LayoutRectangle) =>
    menu.open({
      anchor,
      align: "end",
      width: 200,
      title: t("surface.teamActions"),
      entries: [
        { label: t("teams.editTeam"), icon: "Pencil", onSelect: () => setEditingTeam(group) },
        { label: t("teams.teamMap"), icon: "Network", onSelect: () => setTeamMap(true) },
        { kind: "separator" },
        { label: t("teams.deleteTeam"), icon: "Trash2", destructive: true, onSelect: () => void deleteTeam(group) },
      ],
    });

  const openChatMenu = (bot: Bot, chat: PaseoAgent, anchor: LayoutRectangle, source: MenuSource, context: ChatMenuContext) => {
    const botHost = resolveHost(bot.hostId);
    const move = (delta: -1 | 1) => {
      const order = moveKey(context.siblings, chat.id, delta);
      return order ? () => updateUi((current) => ({ ...current, chatOrder: { ...current.chatOrder, [bot.id]: order } })) : undefined;
    };
    const unpin = (current: BotListUi) => ({ ...current, pinnedChats: current.pinnedChats.filter((pin) => pin.chatId !== chat.id) });
    const openAgent = navigation?.openAgent;
    menu.open({
      anchor,
      align: source === "kebab" ? "end" : "start",
      width: 260,
      title: t("sidebar.chatActions"),
      entries: chatMenuEntries({
        pinned: context.pinned,
        onCopyPath: () => (chat.cwd ? copy(chat.cwd, t("surface.pathCopied")) : toast.error(t("surface.chatPathUnavailable"))),
        onCopyId: () => copy(chat.id, t("surface.chatIdCopied")),
        onCopyTranscript: async () => {
          if (!botHost.api) {
            toast.error(t("surface.hostNotConnected"));
            return;
          }
          try {
            const entries = await fullTimeline(botHost.api, chat.id);
            await copyText(chatTranscript({ title: displayTitle(chat.title, t), botName: bot.name, entries, exportedAt: new Date() }));
            toast.show(t("surface.transcriptCopied"), { variant: "success" });
          } catch (error) {
            toast.error(t("surface.couldntCopyTranscript", { error: errorText(error) }));
          }
        },
        onTogglePin: () =>
          updateUi((current) =>
            context.pinned ? unpin(current) : { ...current, pinnedChats: [...current.pinnedChats, { botId: bot.id, chatId: chat.id }] },
          ),
        move: context.pinned || listUi.chatSort !== "manual" ? null : { up: move(-1), down: move(1) },
        onOpenInPaseo: openAgent && botHost.online ? () => openAgent({ agentId: chat.id, serverId: botHost.key }) : undefined,
        onArchive: async () => {
          if (!botHost.api) {
            toast.error(t("surface.hostNotConnected"));
            return;
          }
          try {
            await botHost.api.agents.ref(chat.id).archive();
            // The selection as it is now: the menu was opened some time ago and the person may have moved on.
            setSelection((current) => (current?.chatId === chat.id ? { botId: bot.id, chatId: null } : current));
            if (context.pinned) updateUi(unpin);
            await queryClient.invalidateQueries({ queryKey: ["aydo", "chats", botHost.key, bot.id] });
          } catch (error) {
            toast.error(t("surface.archiveFailed", { error: errorText(error) }));
          }
        },
      }, t),
    });
  };

  const openDisplayMenu = (anchor: LayoutRectangle) => {
    menu.open({
      anchor,
      align: "end",
      width: 232,
      title: t("surface.display"),
      entries: [
        {
          label: t("surface.archivedBots"),
          trailing: listUi.showArchived ? t("surface.shown") : archivedCount ? t("surface.hiddenCount", { n: archivedCount }) : t("surface.hidden"),
          onSelect: () => updateUi((current) => ({ ...current, showArchived: !current.showArchived })),
        },
        {
          label: t("surface.chatOrder"),
          trailing: listUi.chatSort === "manual" ? t("surface.manual") : t("surface.lastActivity"),
          onSelect: () => updateUi((current) => ({ ...current, chatSort: current.chatSort === "manual" ? "activity" : "manual" })),
        },
      ],
    });
  };

  /** The chat header's bot menu has no anchor of its own; hang it from the pane's top-right corner. */
  const openBotMenuFromPane = (bot: Bot) =>
    void measureAnchor(paneRef).then((rect) =>
      openBotMenu(bot, rect ? { x: rect.x + rect.width - 44, y: rect.y, width: 36, height: 36 } : { x: 0, y: 0, width: 0, height: 0 }, "kebab"),
    );

  const sidebar = (
    <BotSidebar
      colors={colors}
      bots={listed}
      openTab={openTab}
      hiddenArchivedCount={listUi.showArchived ? 0 : archivedCount}
      selection={selection}
      ui={listUi}
      localHost={localHost}
      touch={layout.compact || layout.platform !== "web"}
      splash={layout.compact}
      bottomInset={bottomInset}
      onToggle={(botId) =>
        updateUi((current) => ({
          ...current,
          collapsed: current.collapsed.includes(botId) ? current.collapsed.filter((id) => id !== botId) : [...current.collapsed, botId],
        }))
      }
      onTogglePinnedSection={() => updateUi((current) => ({ ...current, pinnedCollapsed: !current.pinnedCollapsed }))}
      onShowArchived={() => updateUi((current) => ({ ...current, showArchived: true }))}
      onSelect={select}
      onNewBot={() => setCreating(true)}
      onBotMenu={openBotMenu}
      onChatMenu={openChatMenu}
      onDisplayMenu={openDisplayMenu}
      onEditTeam={setEditingTeam}
      onTeamMap={() => setTeamMap(true)}
    />
  );

  const tabProps = openTab
    ? { colors, tabs, openTab, onTab: (tab: string) => updateUi((current) => ({ ...current, tab })), onTeamMenu: openTeamMenu, onNewTeam: () => setEditingTeam("new" as const) }
    : null;

  const pane = teamMap ? (
    <TeamMap
      colors={colors}
      groups={groups}
      bots={allBots}
      localHost={localHost}
      compact={layout.compact}
      bottomInset={bottomInset}
      onBack={layout.compact ? () => setTeamMap(false) : undefined}
      onNewTeam={() => setEditingTeam("new")}
      onEditTeam={setEditingTeam}
      onOpenBot={(bot) => {
        select({ botId: bot.id, chatId: null });
        setPanel({ open: true, section: "overview" });
      }}
    />
  ) : selectedBot && selection ? (
      <SelectedChat
        key={`${selectedBot.id}:${selection.chatId ?? "new"}`}
        colors={colors}
        bot={selectedBot}
        library={library}
        selection={selection}
        localHost={localHost}
        panelOpen={panel.open}
        layout={layout}
        keyboardOpen={keyboardHeight > 0}
        typeVersion={typeVersion}
        onBack={layout.compact ? () => setSelection(null) : undefined}
        onBotMenu={(anchor) => (anchor ? openBotMenu(selectedBot, anchor, "kebab") : openBotMenuFromPane(selectedBot))}
        onTogglePanel={() => setPanel({ open: !panel.open, section: panel.open ? panel.section : null })}
        // Only when the person is still on this bot: starting a chat takes a moment, and they may have gone elsewhere.
        onStarted={(chatId) => setSelection((current) => (current?.botId === selectedBot.id ? { botId: selectedBot.id, chatId } : current))}
      />
    ) : (
      <Splash colors={colors} />
    );

  const settingsPanel =
    selectedBot && panel.open ? (
      <BotPanel
        key={`${selectedBot.id}:${panelVersion}`}
        colors={colors}
        compact={layout.compact}
        bottomInset={bottomInset}
        bot={selectedBot}
        localHost={localHost}
        history={settings.values.history}
        library={library}
        groups={groups}
        section={panel.section}
        onSection={(section) => setPanel({ open: true, section })}
        onClose={() => setPanel({ open: false, section: panel.section })}
        onPatch={(patch) => patchBot(selectedBot.id, patch)}
        flush={flush}
        onRestore={(snapshot) => {
          patchBot(selectedBot.id, snapshot);
          setPanelVersion((version) => version + 1);
          toast.show(t("surface.restored"), { variant: "success" });
        }}
        onSetup={() => select({ botId: selectedBot.id, chatId: null, prompt: setupPromptText(settings.status === "ready" ? settings.values.setup : undefined, usesFiles(settings.status === "ready" ? settings.values.toolMode : undefined, selectedBot.provider, selectedBot.toolMode), locale) })}
        onOpenChat={(chatId) => {
          select({ botId: selectedBot.id, chatId });
          // On phones the panel covers the chat.
          if (layout.compact) setPanel({ open: false, section: panel.section });
        }}
      />
    ) : null;

  const approvalsScreen = approvalsOpen ? (
    <ApprovalsList
      colors={colors}
      compact={layout.compact}
      onBack={() => setApprovalsOpen(false)}
      onOpenChat={(botId, chatId) => {
        setApprovalsOpen(false);
        select({ botId, chatId });
      }}
    />
  ) : null;

  const libraryScreen = libraryView ? (
    <LibraryView
      colors={colors}
      layout={layout}
      bottomInset={bottomInset}
      values={settings.values}
      commit={commit}
      target={libraryView.target}
      onTarget={(target) => setLibraryView({ target })}
      onBack={() => setLibraryView(null)}
    />
  ) : null;

  // On desktop Skills & Tools takes over the screen, like Paseo's settings.
  if (approvalsScreen && !layout.compact) {
    return <View style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}>{approvalsScreen}</View>;
  }
  if (libraryScreen && !layout.compact) {
    return <View style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}>{libraryScreen}</View>;
  }

  return (
    <>
    {/* The host gives plugin surfaces no keyboard handling; lift everything above the keyboard. */}
    <View
      style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}
      onLayout={(event) => setSurfaceWidth(event.nativeEvent.layout.width)}
    >
      {layout.compact ? (
        <View ref={paneRef} collapsable={false} style={{ flex: 1 }}>
          {tabProps ? <TeamTabSwitcher {...tabProps} /> : null}
          {sidebar}
          {selection || teamMap ? <SlideOver onClose={() => (teamMap ? setTeamMap(false) : setSelection(null))}>{pane}</SlideOver> : null}
          {settingsPanel ? (
            <SlideOver onClose={() => setPanel({ open: false, section: null })} onBack={() => (panel.section ? goBack() : false)}>
              {settingsPanel}
            </SlideOver>
          ) : null}
          {libraryScreen ? <SlideOver onClose={() => setLibraryView(null)}>{libraryScreen}</SlideOver> : null}
          {approvalsScreen ? <SlideOver onClose={() => setApprovalsOpen(false)}>{approvalsScreen}</SlideOver> : null}
        </View>
      ) : (
        <>
          {tabProps ? <TeamTabsRow {...tabProps} /> : null}
          <View style={{ flex: 1, flexDirection: "row" }}>
            <View style={{ width: columns.list, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: nativeTokens(colors).surfaceSidebar }}>
              {sidebar}
              <ResizeHandle side="right" width={columns.list} onResize={(width) => setDragWidths((current) => ({ ...current, list: width }))} onCommit={(width) => commitWidth("listWidth", width)} />
            </View>
            <View ref={paneRef} collapsable={false} style={{ flex: 1, minWidth: 0 }}>{pane}</View>
            {settingsPanel && columns.panel !== null ? (
              <View style={{ width: columns.panel, borderLeftWidth: 1, borderLeftColor: colors.border }}>
                {settingsPanel}
                <ResizeHandle side="left" width={columns.panel} onResize={(width) => setDragWidths((current) => ({ ...current, panel: width }))} onCommit={(width) => commitWidth("panelWidth", width)} />
              </View>
            ) : null}
          </View>
        </>
      )}

      {editingTeam ? (
        <TeamSheet
          colors={colors}
          group={editingTeam === "new" ? null : editingTeam}
          groups={groups}
          bots={allBots}
          onClose={() => setEditingTeam(null)}
          onSave={(draft) => {
            const id = editingTeam === "new" ? null : editingTeam.id;
            const teamId = id ?? newGroupId();
            setEditingTeam(null);
            // A new team opens in its tab.
            void commit((values) => ({ ...values, groups: saveTeam(values.groups ?? [], id, draft, teamId, new Date().toISOString()) })).then((saved) => saved && !id && updateUi((current) => ({ ...current, tab: teamId })));
          }}
          onDelete={editingTeam === "new" ? undefined : () => void deleteTeam(editingTeam).then((deleted) => deleted && setEditingTeam(null))}
        />
      ) : null}
      {creating ? (
        <NewBotDialog
          colors={colors}
          onClose={() => setCreating(false)}
          presets={settings.status === "ready" ? (settings.values.presets ?? []) : []}
          onCreate={(start) => {
            setCreating(false);
            const bot = start?.preset ? botFromPreset(defaultProvider(), start.preset, t) : newBot(defaultProvider(), start?.template, t);
            const defaults = (settings.status === "ready" ? settings.values.defaults : undefined) ?? DEFAULT_BOT_DEFAULTS;
            const created = applyDefaults(bot, defaults, defaultProvider());
            const setup = settings.status === "ready" ? settings.values.setup : undefined;
            void addBot(created, start ? "overview" : null, shouldAutoSetup(start, setup, created.provider) ? setupPromptText(setup, usesFiles(settings.status === "ready" ? settings.values.toolMode : undefined, created.provider, created.toolMode), locale) : undefined);
          }}
          onImport={async (json) => {
            const { bots: imported, teams } = await importTeam({ json });
            const bots = withDefaultProvider(imported, defaultProvider());
            setCreating(false);
            const saved = await commit((values) => addImportedBots(values, bots, teams));
            const first = bots[0]?.bot;
            if (saved && first) {
              select({ botId: first.id, chatId: null });
              setPanel({ open: true, section: "overview" });
              if (bots.length > 1) toast.show(t("surface.addedBots", { count: bots.length }), { variant: "success" });
            }
          }}
        />
      ) : null}

      {renaming ? (
        <RenameDialog
          colors={colors}
          title={t("dialogs.menu.renameBot")}
          initialValue={renaming.name}
          placeholder={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            if (!(await updateBot(renaming.id, { name }, true))) throw new Error(t("dialogs.rename.unableToSave"));
            // The identity section holds its own copy of the name.
            if (panel.open && selection?.botId === renaming.id) setPanelVersion((version) => version + 1);
          }}
        />
      ) : null}

      {exporting ? <ExportDialog colors={colors} bot={exporting} onClose={() => setExporting(null)} /> : null}
    </View>
    </>
  );
}

interface SelectedChatProps {
  colors: Colors;
  bot: Bot;
  library: Library;
  selection: Selection;
  localHost: LocalHost;
  panelOpen: boolean;
  layout: PluginSurfaceProps["layout"];
  keyboardOpen: boolean;
  typeVersion: number;
  onBack?(): void;
  onBotMenu(anchor: LayoutRectangle | null): void;
  onTogglePanel(): void;
  onStarted(chatId: string): void;
}

function SelectedChat({ colors, bot, library, selection, localHost, panelOpen, layout, keyboardOpen, typeVersion, onBack, onBotMenu, onTogglePanel, onStarted }: SelectedChatProps) {
  const { t } = useT();
  const host = useBotHost(bot.hostId, localHost);
  const chat = useChat(host.api, selection.chatId);
  // Where a new chat runs: "" is the bot's own folder, else a workspace of one of the user's projects.
  const choices = useWorkspaceChoices(host);
  const [workspaceId, setWorkspaceId] = useState("");
  useEffect(() => setWorkspaceId(""), [selection.chatId, bot.id]);
  const ensureHome = useRpc(ensureBotHomeRpc);
  const compose = useRpc(systemPromptRpc);
  const mountServers = useRpc(mountRpc);
  const askHostCaps = useRpc(hostCapsRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { settings } = useBotSettings();

  const start = async (message: OutgoingMessage) => {
    if (!host.api) throw new Error(t("surface.hostOffline", { host: host.label }));
    // The bot's folder holds its memory and skills even when it works elsewhere.
    const home = await ensureHome({ botId: bot.id });
    const placement = bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root };
    // A chosen workspace must still exist; the chat then runs there and the bot's own folder is attached to it.
    const target = host.isLocal && workspaceId ? choices.data?.find((choice) => choice.id === workspaceId) : undefined;
    if (host.isLocal && workspaceId && !target) throw new Error(t("surface.workspaceGone"));
    const workspace = target ? { id: target.id, path: target.directory } : undefined;
    const chatFolder = workspace?.path ?? placement.path;
    const { systemPrompt } = await compose({ bot, local: host.isLocal, message: message.text });
    // What this host does for Devin; only this host's plugin can say, so a bot on another host gets the stock behaviour.
    const hostCaps = host.isLocal ? await askHostCaps({}).catch(() => NO_HOST_CAPS) : NO_HOST_CAPS;
    // The plugin's tools go through this host's relay, so only bots here get them.
    const agentId = newUuid();
    const mounted = host.isLocal && !usesFiles(settings.status === "ready" ? settings.values.toolMode : undefined, bot.provider, bot.toolMode) ? await mountServers({ botId: bot.id, agentId }) : {};
    // A team that lets its members ask each other freely also lets ask_bot run without a tool approval.
    const askFreely = settings.status === "ready" && !!teamOf(bot.id, settings.values.groups ?? [])?.askFreely;
    const plugin = askFreely ? { ...mounted, askFreely: true } : mounted;
    const id = await startBotChat(host.api, {
      bot,
      library,
      ...(host.isLocal ? { agentId } : {}),
      plugin,
      placement,
      ...(workspace ? { workspace } : {}),
      home: home.path,
      // A member of a team gets its team's report folder attached (a folder of this host, so only for a bot here).
      ...(host.isLocal && home.reports ? { extraFolders: [home.reports] } : {}),
      hostCaps,
      prompt: message.text,
      // A Devin chat in the bot's own folder reads its identity from the rules file the server just wrote.
      systemPrompt: sendsPromptInChat(bot.provider, chatFolder, home.path, hostCaps) ? systemPrompt : "",
      images: message.images,
      attachments: message.attachments,
      clientMessageId: message.messageId,
    }).catch((error: unknown) => {
      // The host's words for a vanished workspace carry its internal id; say it plainly.
      throw workspace ? new Error(friendlyStartError(error instanceof Error ? error.message : String(error), t)) : error;
    });
    await queryClient.invalidateQueries({ queryKey: ["aydo", "chats", host.key, bot.id] });
    onStarted(id);
  };

  // Keep the bot's workspace named after the bot.
  useEffect(() => {
    if (!host.api || bot.cwd || !bot.name.trim()) return;
    const api = host.api;
    const timer = setTimeout(() => {
      void ensureHome({ botId: bot.id })
        .then((home) => syncBotWorkspaceTitle(api, bot, { path: home.path, projectRoot: home.root }))
        .catch(() => {});
    }, 1000);
    return () => clearTimeout(timer);
    // Only the name matters here.
  }, [bot.name, host.api]);

  // "Set up with the bot" opens a new chat that sends its first message straight away. It runs for
  // each such selection, including a click while the new-chat pane is already open (no remount).
  const handledSelection = useRef<unknown>(null);
  useEffect(() => {
    if (!pendingAutoStart(selection, handledSelection.current, Boolean(host.api))) return;
    handledSelection.current = selection;
    start({ text: selection.prompt!, messageId: newMessageId(), images: [], attachments: [] }).catch((error: unknown) => toast.error(t("surface.couldntStart", { error: errorText(error) })));
    // Runs for the selection that carries the prompt, once the host is ready.
  }, [host.api, selection]);

  return (
    <ChatPane
      colors={colors}
      bot={bot}
      host={host}
      chat={chat}
      chatId={selection.chatId}
      panelOpen={panelOpen}
      layout={layout}
      keyboardOpen={keyboardOpen}
      typeVersion={typeVersion}
      onBack={onBack}
      onBotMenu={onBotMenu}
      onTogglePanel={onTogglePanel}
      onStart={start}
      onOpenChat={onStarted}
      workspaces={choices.data ?? []}
      newChatWorkspaceId={workspaceId}
      onNewChatWorkspaceChange={setWorkspaceId}
    />
  );
}
