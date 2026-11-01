import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { randomSeed } from "../../shared/avatar";
import type { Bot, BotAvatar, BotVoice } from "../../shared/bot";
import { Avatar } from "../Avatar";
import type { PanelProps } from "./BotPanel";
import { errorText } from "../native";
import { canSpeak, speak, useVoices } from "../speech";
import { canPickFiles } from "../web";
import { useT } from "../i18n/use-t";
import { Button, DrillRow, InputField, SheetActions, TextAreaField } from "./controls";
import { ColourRow, pickPicture, PictureSource } from "./picture";
import { englishTranslate, type Translate } from "../../shared/translate";

const DESCRIPTION_MAX = 4000;

export function IdentitySection({ colors, bot, onPatch }: PanelProps) {
  const { t } = useT();
  const setAvatar = (patch: Partial<BotAvatar>) => onPatch({ avatar: { ...bot.avatar, ...patch } });
  const [sheet, setSheet] = useState<"avatar" | null>(null);
  const [nameEmpty, setNameEmpty] = useState(!bot.name.trim());
  const length = bot.description.length;

  return (
    <>
      <SettingsSection title={t("panel.avatar")}>
        <SettingsCard>
          <DrillRow colors={colors} label={t("teams.picture")} hint={pictureHint(bot, t)} hintLines={2} trailing={<Avatar avatar={bot.avatar} size={40} />} onPress={() => setSheet("avatar")} />
        </SettingsCard>
      </SettingsSection>
      {sheet === "avatar" ? <AvatarEditor colors={colors} bot={bot} setAvatar={setAvatar} onClose={() => setSheet(null)} /> : null}
      <SettingsSection title={t("panel.profile")}>
        <SettingsCard>
          <InputField colors={colors}
            label={t("teams.name")}
            error={nameEmpty ? t("panel.nameRequired") : null}
            initialValue={bot.name}
            placeholder={t("panel.namePlaceholder")}
            onChangeText={(name) => {
              setNameEmpty(!name.trim());
              onPatch({ name: name.replace(/\n/g, " ").slice(0, 100) });
            }}
          />
          <InputField colors={colors}
            label={t("panel.title")}
            hint={t("panel.titleHint")}
            initialValue={bot.title}
            placeholder={t("panel.titlePlaceholder")}
            onChangeText={(title) => onPatch({ title: title.replace(/\n/g, " ").slice(0, 200) })}
          />
          <TextAreaField
            colors={colors}
            label={t("panel.blurb")}
            hint={t("panel.blurbHint")}
            error={length >= DESCRIPTION_MAX ? t("panel.blurbLimit", { max: DESCRIPTION_MAX }) : null}
            defaultValue={bot.description}
            maxLength={DESCRIPTION_MAX}
            onChangeText={(description) => onPatch({ description: description.slice(0, DESCRIPTION_MAX) })}
            placeholder={t("panel.blurbPlaceholder")}
          />
        </SettingsCard>
      </SettingsSection>
      {canSpeak ? <VoiceSection bot={bot} onPatch={onPatch} /> : null}
    </>
  );
}

function pictureHint(bot: Bot, t: Translate = englishTranslate): string {
  if (bot.avatar.imageUrl?.startsWith("data:")) return t("teams.yourPicture");
  return t("panel.pixelFace");
}

/** Everything about the picture: the face, its colour and shape, or a picture of your own. */
function AvatarEditor({ colors, bot, setAvatar, onClose }: { colors: PanelProps["colors"]; bot: Bot; setAvatar(patch: Partial<BotAvatar>): void; onClose(): void }) {
  const { t } = useT();
  const toast = useToast();
  const upload = () =>
    void pickPicture(t)
      .then((imageUrl) => imageUrl && setAvatar({ imageUrl }))
      .catch((error: unknown) => toast.error(errorText(error)));
  return (
    <Modal title={t("panel.avatar")} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <SettingsRow label={t("teams.picture")} hint={pictureHint(bot, t)}>
            <Avatar avatar={bot.avatar} size={56} />
          </SettingsRow>
          <SettingsAction label={t("panel.newFace")} hint={t("panel.newFaceHint")} actionLabel={t("teams.reroll")} onPress={() => setAvatar({ seed: randomSeed(), imageUrl: null })} />
          {canPickFiles ? (
            <>
              <SettingsAction label={t("teams.uploadPicture")} hint={t("teams.croppedSquare")} actionLabel={t("teams.upload")} onPress={upload} />
            </>
          ) : null}
          <ColourRow colors={colors} value={bot.avatar.palette} onChange={(palette) => setAvatar({ palette })} />
          <SettingsSelect
            label={t("panel.shape")}
            value={bot.avatar.shape}
            options={[
              { label: t("panel.shapeCircle"), value: "circle" },
              { label: t("panel.shapeRounded"), value: "rounded" },
              { label: t("panel.shapeSquare"), value: "square" },
            ]}
            onValueChange={(shape) => setAvatar({ shape })}
          />
          <PictureSource colors={colors} imageUrl={bot.avatar.imageUrl} onChange={(imageUrl) => setAvatar({ imageUrl })} />
        </SettingsCard>
        <SheetActions>
          <Button colors={colors} variant="default" label={t("panel.done")} onPress={onClose} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

/** The device voice a bot's replies are read in, and whether finished replies are read out. */
function VoiceSection({ bot, onPatch }: Pick<PanelProps, "bot" | "onPatch">) {
  const { t } = useT();
  const voices = useVoices();
  const setVoice = (patch: Partial<BotVoice>) => onPatch({ voice: { ...bot.voice, ...patch } });
  const missing = bot.voice.name !== null && voices.length > 0 && !voices.some((voice) => voice.name === bot.voice.name);
  return (
    <SettingsSection title={t("panel.voice")} info={t("panel.voiceInfo")}>
      <SettingsCard>
        <SettingsSelect
          label={t("panel.voice")}
          hint={missing ? t("panel.voiceMissing", { name: bot.voice.name ?? "" }) : undefined}
          value={bot.voice.name ?? ""}
          options={[{ label: t("settings.defaults.default"), value: "" }, ...voices.map((voice) => ({ label: voice.name.includes("(") ? voice.name : `${voice.name} (${voice.lang})`, value: voice.name }))]}
          onValueChange={(name) => setVoice({ name: name || null })}
        />
        <SettingsAction label={t("panel.hearIt")} hint={t("panel.hearItHint")} actionLabel={t("panel.play")} onPress={() => speak(`voice-test:${bot.id}`, t("panel.voiceHello", { name: bot.name || t("panel.yourBot") }), bot.voice.name)} />
        <SettingsSwitch label={t("panel.readReplies")} hint={t("panel.readRepliesHint")} value={bot.voice.readReplies} onValueChange={(readReplies) => setVoice({ readReplies })} />
      </SettingsCard>
    </SettingsSection>
  );
}
