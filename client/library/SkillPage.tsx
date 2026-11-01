import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { skillNeedsReview, type Bot, type LibrarySkill } from "../../shared/bot";
import { skillImportRpc, skillReadRpc } from "../../shared/rpc";
import { isLocalFolder } from "../../shared/skills";
import { errorText, MONO_FONT, MONO_PROPS } from "../native";
import { Alert, Button, CardNote, SectionLink } from "../panel/controls";
import { code, codeLine } from "../typography";
import { BotsCard, DangerZone, PageTitle } from "./parts";
import { useT } from "../i18n/use-t";
import { EditSkillSheet, ReviewSkillSheet, type SavedSkill } from "./SkillSheets";

type Colors = PluginTheme["colors"];

interface SkillPageProps {
  colors: Colors;
  skill: LibrarySkill;
  bots: Bot[];
  /** Compact layouts show the name in the back bar instead of a page title. */
  showTitle: boolean;
  onPatch(patch: Partial<LibrarySkill>): void;
  onToggleBot(bot: Bot, on: boolean): void;
  onImported(skills: SavedSkill[]): void;
  onDelete(): void;
}

export const skillQueryKey = (id: string) => ["aydo", "library-skill", id];

/** A skill imported from a folder on this computer updates by reading that folder again. */
function updateSource(source: string): string | null {
  return isLocalFolder(source) ? source : null;
}

export function SkillPage({ colors, skill, bots, showTitle, onPatch, onToggleBot, onImported, onDelete }: SkillPageProps) {
  const { t } = useT();
  const read = useRpc(skillReadRpc);
  const importSkills = useRpc(skillImportRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const file = useQuery({ queryKey: skillQueryKey(skill.id), queryFn: () => read({ id: skill.id }) });
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const source = updateSource(skill.source);
  const needsReview = skillNeedsReview(skill, file.data?.sha ?? null);
  const changedSinceReview = typeof skill.reviewedSha === "string" && needsReview;

  const update = async () => {
    if (!source) return;
    setUpdating(true);
    try {
      const { skills } = await importSkills({ source });
      onImported(skills);
      await queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
      toast.show(t("library.skillUpdated"), { variant: "success" });
    } catch (error) {
      toast.error(t("library.couldntUpdate", { error: errorText(error) }));
    } finally {
      setUpdating(false);
    }
  };

  return (
    <>
      {showTitle ? <PageTitle colors={colors} title={skill.id} /> : null}
      {needsReview && file.data && !file.data.missing ? (
        <View style={{ marginBottom: 24, gap: 12 }}>
          <Alert
            colors={colors}
            variant="warning"
            title={changedSinceReview ? t("library.skillChanged") : t("library.reviewBeforeUse")}
            description={changedSinceReview ? t("library.changedInfo") : t("library.outsideSkillInfo")}
          />
          <View style={{ alignItems: "flex-start" }}>
            <Button colors={colors} variant="outline" icon="ScanEye" label={t("library.review")} onPress={() => setReviewing(true)} />
          </View>
        </View>
      ) : null}
      <SettingsSection title={t("library.skill")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("library.enabled")}
            hint={needsReview ? t("library.reviewToEnable") : t("library.skillOffHint")}
            value={skill.enabled && !needsReview}
            onValueChange={(enabled) => (enabled && needsReview ? setReviewing(true) : onPatch({ enabled }))}
          />
          {source ? <SettingsAction label={t("library.source")} hint={skill.source} actionLabel={updating ? t("library.updating") : t("library.update")} disabled={updating} onPress={() => void update()} /> : null}
        </SettingsCard>
      </SettingsSection>

      <BotsCard colors={colors} bots={bots} info={t("library.botsInfoSkill")} uses={(bot) => bot.skillIds.includes(skill.id)} onToggle={onToggleBot} />

      <SettingsSection
        title="SKILL.md"
        info={t("library.skillMdInfo")}
        trailing={file.data && !file.data.missing ? <SectionLink colors={colors} icon="Pencil" label={t("teams.edit")} onPress={() => setEditing(true)} /> : undefined}
      >
        <SettingsCard>
          {file.isLoading ? (
            <View style={{ padding: 16, alignItems: "center" }}>
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            </View>
          ) : file.data?.missing ? (
            <CardNote colors={colors} text={source ? t("library.skillMissingUpdate") : t("library.skillMissing")} />
          ) : (
            <View style={{ padding: 16 }}>
              <Text selectable {...MONO_PROPS} style={{ fontFamily: MONO_FONT, fontSize: code(), lineHeight: codeLine(), color: colors.foreground }}>
                {file.data?.text ?? ""}
              </Text>
            </View>
          )}
        </SettingsCard>
      </SettingsSection>

      <DangerZone
        label={t("library.deleteSkill")}
        hint={t("library.removeEverywhere")}
        actionLabel={t("settings.delete")}
        confirmTitle={t("library.deleteSkillTitle")}
        confirmMessage={t("library.deleteSkillMessage", { name: skill.id })}
        onConfirm={onDelete}
      />

      {editing && file.data ? (
        <EditSkillSheet
          colors={colors}
          id={skill.id}
          saved={file.data.text}
          onClose={() => setEditing(false)}
          onSaved={(description, sha) => {
            setEditing(false);
            // You wrote it, so it counts as reviewed.
            onPatch({ description, reviewedSha: sha });
            void queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
          }}
        />
      ) : null}
      {reviewing && file.data?.sha ? (
        <ReviewSkillSheet
          colors={colors}
          id={skill.id}
          text={file.data.text}
          sha={file.data.sha}
          files={file.data.files}
          onClose={() => setReviewing(false)}
          onApprove={(sha) => {
            setReviewing(false);
            onPatch({ enabled: true, reviewedSha: sha });
          }}
        />
      ) : null}
    </>
  );
}
