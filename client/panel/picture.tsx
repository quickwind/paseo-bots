import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import { Pressable, View } from "react-native";
import { PALETTE_COUNT, paletteSwatch } from "../../shared/pixel";
import { englishTranslate, type Translate } from "../../shared/translate";
import { useT } from "../i18n/use-t";
import { pickFileHandles, squareImage } from "../web";
import { StackedRow } from "./controls";

// The picture controls bot avatars and team logos share.

type Colors = PluginTheme["colors"];

/** Pictures are stored with the bot or team, so they're scaled down to this many pixels. */
export const PICTURE_SIZE = 192;
const MAX_UPLOAD = 20 * 1024 * 1024;

/** Picks an image file (web) and returns it as a square data URL; null when nothing was picked. */
export async function pickPicture(t: Translate = englishTranslate): Promise<string | null> {
  const [file] = await pickFileHandles({ accept: "image/png,image/jpeg,image/webp,image/gif", multiple: false });
  if (!file) return null;
  if (file.size > MAX_UPLOAD) throw new Error(t("panel.pictureTooLarge"));
  return squareImage(`data:${file.mimeType};base64,${await file.readBase64(t)}`, PICTURE_SIZE, t);
}

/** The generated picture's colour: automatic, or one of the palettes. */
export function ColourRow({ colors, value, onChange }: { colors: Colors; value: number | null; onChange(palette: number | null): void }) {
  const { t } = useT();
  return (
    <StackedRow colors={colors} label={t("panel.colour")}>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <Swatch colors={colors} label={t("panel.automaticColour")} color={null} selected={value === null} onPress={() => onChange(null)} />
        {Array.from({ length: PALETTE_COUNT }, (_, index) => (
          <Swatch key={index} colors={colors} label={t("panel.colourN", { n: index + 1 })} color={paletteSwatch(index)} selected={value === index} onPress={() => onChange(index)} />
        ))}
      </View>
    </StackedRow>
  );
}

/**
 * Paseo's colour swatch (workspace-labels/swatch.tsx): 20pt circle, a 2pt foreground ring drawn
 * inside the box when selected, 12pt hit slop to reach 44pt, radio semantics. The automatic
 * option is an outlined circle.
 */
function Swatch({ colors, label, color, selected, onPress }: { colors: Colors; label: string; color: string | null; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      hitSlop={12}
      onPress={onPress}
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: color ?? "transparent",
        borderWidth: selected ? 2 : color ? 0 : 1,
        borderColor: selected ? colors.foreground : colors.foregroundMuted,
        borderStyle: color || selected ? "solid" : "dashed",
      }}
    />
  );
}

/**
 * An uploaded picture with Remove. Pictures are stored as data: URLs; there is no field for an
 * address on the web, because showing one would make the browser fetch it.
 */
export function PictureSource(props: { colors: Colors; imageUrl: string | null; onChange(imageUrl: string | null): void }) {
  const { t } = useT();
  if (!props.imageUrl?.startsWith("data:")) return null;
  return <SettingsAction label={t("panel.image")} hint={t("panel.uploaded")} actionLabel={t("attachment.remove")} onPress={() => props.onChange(null)} />;
}
