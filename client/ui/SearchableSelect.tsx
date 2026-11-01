import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsRow } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { nativeTokens, useHover } from "../native";
import { useT } from "../i18n/use-t";
import { ui } from "../typography";

type Colors = PluginTheme["colors"];

export interface SearchableSelectProps {
  colors: Colors;
  label: string;
  value: string;
  options: readonly { label: string; value: string }[];
  onValueChange(value: string): void;
  disabled?: boolean;
  hint?: string;
  /** One line: the label in muted text, then the value as a chip, with no settings row around it (for a spot above a composer). */
  compact?: boolean;
}

/**
 * A select for long lists, like the model picker in an agent chat: a search field on top and a
 * list that scrolls. Paseo's SettingsSelect shows every option in one unscrollable menu, which
 * cuts off a provider with dozens of models.
 */
export function SearchableSelect({ colors, label, value, options, onValueChange, disabled, hint, compact }: SearchableSelectProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const tokens = nativeTokens(colors);
  const selected = options.find((option) => option.value === value)?.label ?? value;
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? options.filter((option) => words.every((word) => option.label.toLowerCase().includes(word))) : options;
  }, [options, query]);
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const trigger = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          maxWidth: 260,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderWidth: 1,
          borderColor: tokens.borderAccent,
          borderRadius: 8,
          backgroundColor: colors.surface2,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: ui(14), color: colors.foreground }}>
          {selected}
        </Text>
        <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
      </Pressable>
  );
  const modal = open ? (
        <Modal title={label} open onOpenChange={(next) => !next && close()}>
          <Modal.Content scrollable={false} contentContainerStyle={{ flex: 1, padding: 12, gap: 8 }}>
            <TextInput
              accessibilityLabel={t("common.searchIn", { label: label.toLowerCase() })}
              placeholder={t("common.searchInPlaceholder", { label: label.toLowerCase() })}
              placeholderTextColor={colors.foregroundMuted}
              value={query}
              onChangeText={setQuery}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontSize: ui(14),
                color: colors.foreground,
                borderWidth: 1,
                borderColor: tokens.borderAccent,
                borderRadius: 8,
                backgroundColor: colors.surface1,
              }}
            />
            <FlatList
              data={shown}
              keyExtractor={(option) => option.value}
              keyboardShouldPersistTaps="handled"
              style={{ flex: 1, minHeight: 240 }}
              ListEmptyComponent={<Text style={{ padding: 12, fontSize: ui(14), color: colors.foregroundMuted }}>{t("common.noMatch")}</Text>}
              renderItem={({ item }) => (
                <Option
                  colors={colors}
                  label={item.label}
                  selected={item.value === value}
                  onPress={() => {
                    onValueChange(item.value);
                    close();
                  }}
                />
              )}
            />
          </Modal.Content>
        </Modal>
  ) : null;

  if (compact) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: ui(13), color: colors.foregroundMuted }}>{label}</Text>
        {trigger}
        {modal}
      </View>
    );
  }
  return (
    <SettingsRow label={label} hint={hint}>
      {trigger}
      {modal}
    </SettingsRow>
  );
}

function Option({ colors, label, selected, onPress }: { colors: Colors; label: string; selected: boolean; onPress(): void }) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      {...hoverProps}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 36,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: hovered ? colors.surface2 : "transparent",
      }}
    >
      <Text numberOfLines={1} style={{ flex: 1, fontSize: ui(14), lineHeight: 18, color: colors.foreground }}>
        {label}
      </Text>
      {selected ? <Icon name="Check" size={16} color={colors.foregroundMuted} /> : null}
    </Pressable>
  );
}
