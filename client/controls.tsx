import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View, type TextInputProps } from "react-native";

type Themed = { theme: PluginTheme };

export function Section({ theme, title, children }: Themed & { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10, padding: 16, borderWidth: 1, borderRadius: 10,
      borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "600" }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

export function Detail({ theme, children, error = false }: Themed & { children: ReactNode; error?: boolean }) {
  return <Text style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{children}</Text>;
}

export function Action({ theme, label, onPress, disabled = false, primary = false }: Themed & {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6,
        borderWidth: 1, borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2, opacity: disabled ? 0.55 : 1 }}>
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function Input({ theme, ...props }: Themed & TextInputProps) {
  return (
    <TextInput {...props} autoCapitalize="none" autoCorrect={false} spellCheck={false}
      placeholderTextColor={theme.colors.foregroundMuted}
      style={{ minHeight: 38, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1,
        borderRadius: 6, borderColor: theme.colors.border, color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0 }} />
  );
}

export function Disclosure({ theme, label, expanded, onPress }: Themed & {
  label: string; expanded: boolean; onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" aria-expanded={expanded} accessibilityState={{ expanded }} onPress={onPress}
    style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, alignSelf: "flex-start" }}>
    <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={16} color={theme.colors.foregroundMuted} />
    <Text style={{ color: theme.colors.foreground }}>{label}</Text>
  </Pressable>;
}
