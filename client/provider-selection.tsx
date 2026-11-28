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

export type ProviderSnapshotBinding = {
  hostId: string;
  cwd: string;
  selectionGeneration: number;
};

function sameProviders(a: readonly ProviderId[], b: readonly ProviderId[]) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, idx) => value === sortedB[idx]);
}

export function ProviderSelection({
  theme,
  hostId,
  cwd,
  selectionGeneration = 0,
  selected,
  preferenceHint = "none",
  onToggle,
  onReplace,
}: {
  theme: PluginTheme;
  hostId: string;
  cwd: string;
  selectionGeneration?: number;
  selected: readonly ProviderId[];
  preferenceHint?: "none" | "restored" | "empty";
  onToggle: (id: ProviderId) => void;
  onReplace?: (next: readonly ProviderId[], binding: ProviderSnapshotBinding) => void;
}) {
  const paseo = usePaseo();
  const selectionId = useId();
  // P4: Scope provider discovery strictly to (hostId, cwd, selectionGeneration, selectionId) with zero retained cache.
  const snapshot = useQuery({
    queryKey: ["providers", hostId, cwd, selectionGeneration, selectionId],
    queryFn: () => paseo.providers.snapshot({ cwd }),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: ({ state }) => state.status === "success" && state.data?.entries.some(
      (entry) => entry.enabled && entry.status === "loading" && providers.some(([id]) => id === entry.provider),
    ) ? 1500 : false,
  });

  // D3 & P4: Wait until supported provider discovery finishes loading; never use obsolete/fetching snapshots.
  const supportedStillLoading = snapshot.isPending || snapshot.isRefetching || Boolean(
    snapshot.data?.entries.some(
      (entry) => entry.enabled && entry.status === "loading" && providers.some(([id]) => id === entry.provider),
    ),
  );
  const detectedReady: ProviderId[] = (!supportedStillLoading && snapshot.isSuccess && !snapshot.isError)
    ? providers
      .map(([id]) => id)
      .filter((id) => {
        const entry = snapshot.data.entries.find((candidate) => candidate.provider === id);
        return Boolean(entry && entry.enabled && entry.status === "ready");
      })
      .sort()
    : [];
  const binding: ProviderSnapshotBinding = { hostId, cwd, selectionGeneration };
  const canSelectDetected = Boolean(
    onReplace &&
    !supportedStillLoading &&
    snapshot.isSuccess &&
    !snapshot.isError &&
    detectedReady.length > 0 &&
    !sameProviders(selected, detectedReady),
  );

  return (
    <View style={{ gap: 8 }}>
      {snapshot.isError && (
        <View style={{ gap: 6 }}>
          <Detail theme={theme} error>Could not discover providers on this host.</Detail>
          <Action theme={theme} label="Retry discovery" onPress={() => void snapshot.refetch()} />
        </View>
      )}

      {/* Compact wrapped provider chips for Desktop and Mobile */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {providers.map(([id, label]) => {
          const entry = snapshot.data?.entries.find((candidate) => candidate.provider === id);
          const status = snapshot.isPending ? "loading" : snapshot.isError ? "error"
            : entry?.enabled ? entry.status : "unavailable";
          const checked = selected.includes(id);
          return (
            <Pressable
              key={id}
              accessibilityRole="checkbox"
              accessibilityLabel={`${label}, ${status}${checked ? ", selected" : ""}`}
              aria-checked={checked}
              accessibilityState={{ checked }}
              onPress={() => onToggle(id)}
              hitSlop={4}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                minHeight: 44,
                minWidth: 44,
                paddingVertical: 8,
                paddingHorizontal: 10,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: checked ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Icon
                name={checked ? "SquareCheck" : "Square"}
                size={16}
                color={checked ? theme.colors.accent : theme.colors.foregroundMuted}
              />
              <Text style={{ color: theme.colors.foreground }}>{label}</Text>
              <Detail theme={theme} error={status === "error"}>· {status}</Detail>
            </Pressable>
          );
        })}
      </View>

      {onReplace && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Action
            theme={theme}
            label={supportedStillLoading ? "Detecting providers…" : "Select Detected Providers"}
            disabled={!canSelectDetected}
            onPress={() => onReplace(detectedReady, binding)}
          />
          <Action
            theme={theme}
            label="Clear providers"
            disabled={selected.length === 0}
            onPress={() => onReplace([], binding)}
          />
        </View>
      )}

      {preferenceHint === "restored" && (
        <Detail theme={theme}>Restored saved provider preference for this project.</Detail>
      )}
      {preferenceHint === "empty" && (
        <Detail theme={theme}>Saved provider preference for this project is empty (canonical-only).</Detail>
      )}
      <Detail theme={theme}>
        Choose installation targets for later. Runtime status is informational and scanning works without a provider.
      </Detail>
    </View>
  );
}
