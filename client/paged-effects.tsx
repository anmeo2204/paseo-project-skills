import type { PluginTheme } from "@getpaseo/plugin";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { Action, Detail } from "./controls";

const pageSize = 25;

export function PagedEffects<T>({ theme, label, items, render }: {
  theme: PluginTheme; label: string; items: readonly T[]; render: (item: T) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const index = Math.min(page, Math.max(0, Math.ceil(items.length / pageSize) - 1));
  const start = index * pageSize;
  if (items.length <= pageSize) return <>{items.map(render)}</>;
  return <>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Action theme={theme} label={`Previous ${label}`} disabled={start === 0} onPress={() => setPage(index - 1)} />
      <Action theme={theme} label={`Next ${label}`} disabled={start + pageSize >= items.length} onPress={() => setPage(index + 1)} />
      <View accessibilityLiveRegion="polite"><Detail theme={theme}>{start + 1}–{Math.min(start + pageSize, items.length)} of {items.length}</Detail></View>
    </View>
    {items.slice(start, start + pageSize).map(render)}
  </>;
}
