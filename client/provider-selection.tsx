import { usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Pressable, Text, View } from "react-native";
import { Action, Detail } from "./controls";

const providers = [
  ["codex", "Codex"], ["cursor", "Cursor"], ["kiro", "Kiro"], ["antigravity", "Antigravity"],
] as const;
export type ProviderId = (typeof providers)[number][0];

export function ProviderSelection({ theme, hostId, cwd, selected, onToggle }: {
  theme: PluginTheme;
  hostId: string;
  cwd: string;
  selected: readonly ProviderId[];
  onToggle: (id: ProviderId) => void;
}) {
  const paseo = usePaseo();
  const selectionId = useId();
  const snapshot = useQuery({
    queryKey: ["providers", hostId, cwd, selectionId],
    queryFn: () => paseo.providers.snapshot({ cwd }),
    retry: false,
    gcTime: 0,
    refetchInterval: ({ state }) => state.status === "success" && state.data?.entries.some(
      (entry) => entry.enabled && entry.status === "loading" && providers.some(([id]) => id === entry.provider),
    ) ? 1500 : false,
  });

  return (
    <>
      {snapshot.isError && <>
        <Detail theme={theme} error>Could not discover providers on this host.</Detail>
        <Action theme={theme} label="Retry discovery" onPress={() => void snapshot.refetch()} />
      </>}
      <View style={{ gap: 4 }}>
        {providers.map(([id, label]) => {
          const entry = snapshot.data?.entries.find((candidate) => candidate.provider === id);
          const status = snapshot.isPending ? "loading" : snapshot.isError ? "error"
            : entry?.enabled ? entry.status : "unavailable";
          const checked = selected.includes(id);
          return (
            <Pressable key={id} accessibilityRole="checkbox" accessibilityLabel={`${label}, ${status}${checked ? ", selected" : ""}`}
              aria-checked={checked} accessibilityState={{ checked }} onPress={() => onToggle(id)}
              style={{ flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 6, paddingHorizontal: 8,
                borderRadius: 6, backgroundColor: theme.colors.surface2 }}>
              <Icon name={checked ? "SquareCheck" : "Square"} size={16}
                color={checked ? theme.colors.accent : theme.colors.foregroundMuted} />
              <Text style={{ color: theme.colors.foreground, flex: 1 }}>{label}</Text>
              <Detail theme={theme} error={status === "error"}>{status}</Detail>
            </Pressable>
          );
        })}
      </View>
      <Detail theme={theme}>Choose installation targets for later. Runtime status is informational and scanning works without a provider.</Detail>
    </>
  );
}
