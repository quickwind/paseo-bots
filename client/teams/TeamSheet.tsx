import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import { randomSeed } from "../../shared/avatar";
import type { Bot, BotGroup, TeamLogo as Logo } from "../../shared/bot";
import { teamLogoOf, teamOf, type TeamDraft } from "../../shared/groups";
import { TeamLogo } from "../Avatar";
import { errorText, nativeTokens } from "../native";
import { Button, InputField, SheetActions, TextAreaField } from "../panel/controls";
import { RememberedProjects } from "../panel/RememberedProjects";
import { ColourRow, pickPicture, PictureSource } from "../panel/picture";
import { canPickFiles } from "../web";
import { useT } from "../i18n/use-t";

type Colors = PluginTheme["colors"];

/**
 * A team's name, logo, members, Chief of Staff and shared instructions, as
 * OpenMausBot's team settings. A bot is on one team at most: adding it here
 * takes it off its other team.
 */
export function TeamSheet({
  colors,
  group,
  groups,
  bots,
  onClose,
  onSave,
  onDelete,
}: {
  colors: Colors;
  /** Null for a new team. */
  group: BotGroup | null;
  groups: readonly BotGroup[];
  bots: readonly Bot[];
  onClose(): void;
  onSave(team: TeamDraft): void;
  onDelete?: () => void;
}) {
  const toast = useToast();
  const { t } = useT();
  const [name, setName] = useState(group?.name ?? "");
  const [logo, setLogo] = useState<Logo>(() => (group ? teamLogoOf(group) : { seed: randomSeed(), palette: null, imageUrl: null }));
  const [memberIds, setMemberIds] = useState<string[]>(group ? [...new Set([...(group.leadId ? [group.leadId] : []), ...group.memberIds])] : []);
  const [leadId, setLeadId] = useState<string | null>(group?.leadId ?? null);
  const [instructions, setInstructions] = useState(group?.instructions ?? "");
  const [askFreely, setAskFreely] = useState(group?.askFreely ?? false);
  const live = bots.filter((bot) => !bot.archived);
  const members = live.filter((bot) => memberIds.includes(bot.id));
  const lead = leadId && memberIds.includes(leadId) ? leadId : null;
  // A Chief of Staff set to never contact other bots cannot hand anything on.
  const quietLead = lead ? members.find((bot) => bot.id === lead && bot.contactBots === "off") : undefined;

  const toggle = (botId: string, on: boolean) => setMemberIds((current) => (on ? [...current, botId] : current.filter((id) => id !== botId)));
  const patchLogo = (patch: Partial<Logo>) => setLogo((current) => ({ ...current, ...patch }));
  const upload = () =>
    void pickPicture(t)
      .then((imageUrl) => imageUrl && patchLogo({ imageUrl }))
      .catch((error: unknown) => toast.error(errorText(error)));

  return (
    <Modal title={group ? t("teams.editTeam") : t("teams.newTeam")} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField colors={colors} label={t("teams.name")} initialValue={name} placeholder={t("teams.namePlaceholder")} onChangeText={setName} />
          </SettingsCard>
        </View>
        <SettingsSection title={t("teams.logo")}>
          <SettingsCard>
            <SettingsRow label={t("teams.picture")} hint={logo.imageUrl?.startsWith("data:") ? t("teams.yourPicture") : logo.imageUrl ? t("teams.imageFromUrl") : t("teams.pixelArt")}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <TeamLogo group={{ id: group?.id ?? "", logo }} size={40} dark={nativeTokens(colors).dark} />
                <Button colors={colors} variant="outline" size="sm" label={t("teams.reroll")} onPress={() => patchLogo({ seed: randomSeed(), imageUrl: null })} />
              </View>
            </SettingsRow>
            {canPickFiles ? <SettingsAction label={t("teams.uploadPicture")} hint={t("teams.croppedSquare")} actionLabel={t("teams.upload")} onPress={upload} /> : null}
            <ColourRow colors={colors} value={logo.palette} onChange={(palette) => patchLogo({ palette })} />
            <PictureSource colors={colors} imageUrl={logo.imageUrl} onChange={(imageUrl) => patchLogo({ imageUrl })} />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title={t("teams.members")} info={t("teams.membersInfo")}>
          <SettingsCard>
            {live.map((bot) => {
              const other = teamOf(bot.id, groups);
              const elsewhere = other && other.id !== group?.id ? other : null;
              return (
                <SettingsSwitch
                  key={bot.id}
                  label={bot.name}
                  hint={elsewhere ? t("teams.onOtherTeam", { team: elsewhere.name || t("teams.anotherTeam") }) : bot.title || undefined}
                  value={memberIds.includes(bot.id)}
                  onValueChange={(on) => toggle(bot.id, on)}
                />
              );
            })}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title={t("teams.chiefOfStaff")} info={t("teams.chiefOfStaffInfo")}>
          <SettingsCard>
            <SettingsSelect
              label={t("teams.lead")}
              value={lead ?? ""}
              disabled={members.length === 0}
              options={[{ label: t("teams.none"), value: "" }, ...members.map((bot) => ({ label: bot.name, value: bot.id }))]}
              onValueChange={(value) => setLeadId(value || null)}
            />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title={t("teams.asking")} info={t("teams.askingInfo")}>
          <SettingsCard>
            <SettingsSwitch label={t("teams.askFreely")} hint={quietLead ? t("teams.quietLead", { name: quietLead.name }) : t("teams.askFreelyHint")} value={askFreely} onValueChange={setAskFreely} />
          </SettingsCard>
        </SettingsSection>
        {group ? <RememberedProjects colors={colors} scope={{ teamId: group.id }} title={t("teams.projects")} /> : null}
        <SettingsSection title={t("teams.sharedInstructions")} info={t("teams.sharedInstructionsInfo")}>
          <SettingsCard>
            <TextAreaField colors={colors} accessibilityLabel={t("teams.sharedInstructions")} value={instructions} onChangeText={setInstructions} minHeight={160} placeholder={t("teams.instructionsPlaceholder")} />
          </SettingsCard>
        </SettingsSection>
        <SheetActions leading={onDelete ? <Button colors={colors} variant="ghost" label={t("teams.deleteTeam")} icon="Trash2" onPress={onDelete} /> : null}>
          <Button colors={colors} variant="ghost" label={t("dialogs.cancel")} onPress={onClose} />
          <Button
            colors={colors}
            variant="default"
            label={group ? t("teams.save") : t("teams.createTeam")}
            disabled={!name.trim()}
            onPress={() => onSave({ name: name.trim().slice(0, 60), logo, leadId: lead, memberIds: members.map((bot) => bot.id), instructions, askFreely })}
          />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
