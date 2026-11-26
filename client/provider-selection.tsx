import { usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Action, Detail } from "./controls";

const providers = [
  ["codex", "Codex"], ["cursor", "Cursor"], ["kiro", "Kiro"], ["antigravity", "Antigravity"],
] as const;
type ProviderId = (typeof providers)[number][0];

export function ProviderSelection({ theme, hostId, cwd }: {
  theme: PluginTheme;
  hostId: string;
  cwd: string;
}) {
  const paseo = usePaseo();
  const selectionId = useId();
  const [selected, setSelected] = useState<ProviderId[]>([]);
  const snapshot = useQuery({
    queryKey: ["providers", hostId, cwd, selectionId],
    queryFn: () => paseo.providers.snapshot({ cwd }),
    retry: false,
    gcTime: 0,
    refetchInterval: ({ state }) => state.status === "success" && state.data?.entries.some(
      (entry) => entry.status === "loading" && providers.some(([id]) => id === entry.provider),
    ) ? 1500 : false,
  });

  useEffect(() => {
    if (snapshot.isError || snapshot.data) {
      setSelected((previous) => previous.filter((id) => !snapshot.isError && snapshot.data?.entries.some(
        (entry) => entry.provider === id && entry.enabled && entry.status === "ready",
      )));
    }
  }, [snapshot.data, snapshot.isError]);

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
          const ready = status === "ready";
          const checked = ready && selected.includes(id);
          return (
            <Pressable key={id} accessibilityRole="checkbox" accessibilityLabel={`${label}, ${status}${checked ? ", selected" : ""}`}
              accessibilityState={{ checked, disabled: !ready }} disabled={!ready}
              onPress={() => setSelected((previous) => previous.includes(id)
                ? previous.filter((item) => item !== id)
                : [...previous, id])}
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
      <Detail theme={theme}>Availability describes this Paseo host. Skill support and read-only execution are unverified.</Detail>
    </>
  );
}
