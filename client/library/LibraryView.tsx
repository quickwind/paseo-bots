import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View, type LayoutRectangle } from "react-native";
import { EMPTY_LIBRARY, type Bot, type BotMcpServer, type BotSettingsValues, type Library, type LibraryMcpServer, type LibrarySkill } from "../../shared/bot";
import { addMcpServers, forgetItem, newMcpServerId, renameGrants, setBotUses, updateMcpServer, updateSkill, upsertSkills, type LibraryKind } from "../../shared/library";
import { skillDeleteRpc } from "../../shared/rpc";
import type { LibraryTarget } from "../navigation";
import { errorText, nativeTokens } from "../native";
import { SlideOver } from "../ui/Columns";
import { useMenu } from "../ui/Menu";
import { LibraryList } from "./LibraryList";
import { McpPage } from "./McpPage";
import { BLANK_SERVER, ImportSheet, ServerSheet, type McpDraft } from "./McpSheets";
import { BackBar, PAGE_STYLE } from "./parts";
import { ImportSkillsSheet, NewSkillSheet, type SavedSkill } from "./SkillSheets";
import { skillQueryKey, SkillPage } from "./SkillPage";
import { useT } from "../i18n/use-t";


/** Settings sidebar width (constants/layout.ts SETTINGS_DESKTOP_SIDEBAR_WIDTH). */
const LIST_WIDTH = 320;

type Sheet = { kind: "import-skills" } | { kind: "new-skill" } | { kind: "new-server"; initial: McpDraft } | { kind: "paste-servers" };

interface LibraryViewProps {
  colors: PluginSurfaceProps["theme"]["colors"];
  layout: PluginSurfaceProps["layout"];
  values: BotSettingsValues;
  commit(mutate: (values: BotSettingsValues) => BotSettingsValues): Promise<boolean>;
  /** Page shown; null is the list screen on compact. */
  target: LibraryTarget | null;
  onTarget(target: LibraryTarget | null): void;
  /** Back to the bot list. */
  onBack(): void;
  /** The home indicator on phones, kept clear below lists and pages. */
  bottomInset: number;
}

/**
 * Skills & Tools inside the Bots screen: the shared library of skills and MCP
 * servers that bots switch on in their own settings. Laid out like Paseo's
 * settings screen, which also takes over the sidebar: a list column headed by a
 * back row and a 720-wide page on desktop; on compact the list is a screen
 * that pushes the page.
 */
export function LibraryView({ colors, layout, values, commit, target, onTarget: setTarget, onBack, bottomInset }: LibraryViewProps) {
  const { t } = useT();
  const compact = layout.compact;
  const toast = useToast();
  const menu = useMenu();
  const queryClient = useQueryClient();
  const deleteSkillFiles = useRpc(skillDeleteRpc);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const library = values.library ?? EMPTY_LIBRARY;
  const bots = values.bots;

  // ------------------------------------------------------------ actions

  /** Changes the library and the bots together in one write. */
  const save = (mutate: (library: Library, bots: Bot[]) => { library?: Library; bots?: Bot[] }) =>
    commit((values) => {
      const current = values.library ?? EMPTY_LIBRARY;
      const next = mutate(current, values.bots);
      return { ...values, library: next.library ?? current, bots: next.bots ?? values.bots };
    });

  const addSkills = async (skills: SavedSkill[]) => {
    if (skills.length === 0) return;
    if (!(await save((current) => ({ library: upsertSkills(current, skills) })))) return;
    for (const skill of skills) void queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
    const added = skills.length === 1 ? t("library.addedOne", { name: skills[0]!.id }) : t("library.addedMany", { count: skills.length });
    const unreviewed = skills.filter((skill) => !skill.reviewedSha).length;
    toast.show(unreviewed ? t("library.addedReview", { added, review: t("library.reviewFirst", { count: unreviewed }) }) : added, { variant: "success" });
    setTarget({ kind: "skill", id: skills[0]!.id });
  };

  const addServers = async (drafts: BotMcpServer[]) => {
    let ids: string[] = [];
    const ok = await save((current) => {
      const added = addMcpServers(current, drafts);
      ids = added.ids;
      return { library: added.library };
    });
    if (ok && ids[0]) setTarget({ kind: "mcp", id: ids[0] });
  };

  const createServer = async (draft: McpDraft) => {
    const now = new Date().toISOString();
    // Off until a test connects to it.
    const server: LibraryMcpServer = { ...draft, id: newMcpServerId(), enabled: false, tools: null, checkedAt: null, checkError: null, createdAt: now, updatedAt: now };
    if (await save((current) => ({ library: { ...current, mcpServers: [...current.mcpServers, server] } }))) setTarget({ kind: "mcp", id: server.id });
  };

  const patchSkill = (id: string, patch: Partial<LibrarySkill>) => void save((current) => ({ library: updateSkill(current, id, patch) }));

  const patchServer = (id: string, patch: Partial<LibraryMcpServer>) =>
    void save((current, currentBots) => {
      const before = current.mcpServers.find((server) => server.id === id);
      const renamed = patch.name !== undefined && before && patch.name !== before.name;
      return { library: updateMcpServer(current, id, patch), bots: renamed ? renameGrants(currentBots, before.name, patch.name!) : currentBots };
    });

  const toggleBot = (kind: LibraryKind, id: string, bot: Bot, on: boolean) =>
    void save((_current, currentBots) => ({ bots: currentBots.map((entry) => (entry.id === bot.id ? setBotUses(entry, kind, id, on) : entry)) }));

  const removeSkill = async (id: string) => {
    try {
      await deleteSkillFiles({ id });
    } catch (error) {
      toast.error(t("library.deleteFilesFailed", { error: errorText(error) }));
      return;
    }
    if (await save((current, currentBots) => ({ library: { ...current, skills: current.skills.filter((skill) => skill.id !== id) }, bots: forgetItem(currentBots, "skill", id) }))) {
      setTarget(null);
    }
  };

  const removeServer = async (id: string) => {
    if (await save((current, currentBots) => ({ library: { ...current, mcpServers: current.mcpServers.filter((server) => server.id !== id) }, bots: forgetItem(currentBots, "mcp", id) }))) {
      setTarget(null);
    }
  };

  const openSkillMenu = (anchor: LayoutRectangle) =>
    menu.open({
      anchor,
      align: "end",
      width: 220,
      title: t("library.addSkill"),
      entries: [
        { label: t("library.importSkills"), icon: "Download", onSelect: () => setSheet({ kind: "import-skills" }) },
        { label: t("library.newSkill"), icon: "FilePlus", onSelect: () => setSheet({ kind: "new-skill" }) },
      ],
    });

  const openServerMenu = (anchor: LayoutRectangle) =>
    menu.open({
      anchor,
      align: "end",
      width: 220,
      title: t("library.addMcpServer"),
      entries: [
        { label: t("library.newServer"), icon: "Plus", onSelect: () => setSheet({ kind: "new-server", initial: BLANK_SERVER }) },
        { label: t("library.importConfig"), icon: "Import", onSelect: () => setSheet({ kind: "paste-servers" }) },
      ],
    });

  // ------------------------------------------------------------ layout

  // Desktop always shows a page, like Paseo's settings: the first item until one is picked.
  const firstSkill = library.skills.map((entry) => entry.id).sort((a, b) => a.localeCompare(b))[0];
  const firstServer = library.mcpServers.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
  const first: LibraryTarget | null = firstSkill ? { kind: "skill", id: firstSkill } : firstServer ? { kind: "mcp", id: firstServer.id } : null;
  const shown = target ?? (compact ? null : first);
  const skill = shown?.kind === "skill" ? library.skills.find((entry) => entry.id === shown.id) : undefined;
  const server = shown?.kind === "mcp" ? library.mcpServers.find((entry) => entry.id === shown.id) : undefined;
  const pageTitle = skill ? skill.id : server ? server.name : "";
  const showTitle = !compact;

  const page = skill ? (
    <SkillPage
      key={`skill:${skill.id}`}
      colors={colors}
      skill={skill}
      bots={bots}
      showTitle={showTitle}
      onPatch={(patch) => patchSkill(skill.id, patch)}
      onToggleBot={(bot, on) => toggleBot("skill", skill.id, bot, on)}
      onImported={(skills) => void save((current) => ({ library: upsertSkills(current, skills) }))}
      onDelete={() => void removeSkill(skill.id)}
    />
  ) : server ? (
    <McpPage
      key={`mcp:${server.id}`}
      colors={colors}
      server={server}
      bots={bots}
      otherNames={library.mcpServers.filter((entry) => entry.id !== server.id).map((entry) => entry.name)}
      showTitle={showTitle}
      onPatch={(patch) => patchServer(server.id, patch)}
      onToggleBot={(bot, on) => toggleBot("mcp", server.id, bot, on)}
      onDelete={() => void removeServer(server.id)}
    />
  ) : (
    <View style={{ ...PAGE_STYLE, padding: 24 }}>
      <Text style={{ color: colors.foregroundMuted }}>{t("library.nothingHere")}</Text>
    </View>
  );

  const list = (
    <LibraryList
      colors={colors}
      library={library}
      query={query}
      onQuery={setQuery}
      selected={compact ? null : shown}
      onSelect={setTarget}
      onAddSkill={openSkillMenu}
      onAddServer={openServerMenu}
      touch={compact || layout.platform !== "web"}
      onBack={compact ? undefined : onBack}
      bottomInset={bottomInset}
    />
  );

  const scrollPage = (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[PAGE_STYLE, { paddingBottom: PAGE_STYLE.paddingBottom + bottomInset }]}>
      {page}
    </ScrollView>
  );

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.surface0 }}>
      {compact ? (
        // Phones stack a page over the list, so a swipe or Back returns to it.
        <View style={{ flex: 1 }}>
          <View style={{ flex: 1, backgroundColor: nativeTokens(colors).surfaceSidebar }}>
            <BackBar colors={colors} title={t("sidebar.skillsAndTools")} backLabel={t("sidebar.backToBots")} onBack={onBack} />
            {list}
          </View>
          {shown ? (
            <SlideOver onClose={() => setTarget(null)}>
              <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
                <BackBar colors={colors} title={pageTitle} onBack={() => setTarget(null)} />
                {scrollPage}
              </View>
            </SlideOver>
          ) : null}
        </View>
      ) : (
        <>
          <View style={{ width: LIST_WIDTH, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: nativeTokens(colors).surfaceSidebar }}>{list}</View>
          <View style={{ flex: 1, minWidth: 0 }}>{scrollPage}</View>
        </>
      )}

      {sheet?.kind === "import-skills" ? (
        <ImportSkillsSheet
          colors={colors}
          onClose={() => setSheet(null)}
          onImported={(skills) => {
            setSheet(null);
            void addSkills(skills);
          }}
        />
      ) : null}
      {sheet?.kind === "new-skill" ? (
        <NewSkillSheet
          colors={colors}
          taken={library.skills.map((entry) => entry.id)}
          onClose={() => setSheet(null)}
          onCreated={(created) => {
            setSheet(null);
            void addSkills([created]);
          }}
        />
      ) : null}
      {sheet?.kind === "new-server" ? (
        <ServerSheet
          colors={colors}
          initial={sheet.initial}
          isNew
          otherNames={library.mcpServers.map((entry) => entry.name)}
          onClose={() => setSheet(null)}
          onSave={(draft) => {
            setSheet(null);
            void createServer(draft);
          }}
        />
      ) : null}
      {sheet?.kind === "paste-servers" ? (
        <ImportSheet
          colors={colors}
          onClose={() => setSheet(null)}
          onImport={(drafts) => {
            setSheet(null);
            void addServers(drafts);
          }}
        />
      ) : null}
    </View>
  );
}
