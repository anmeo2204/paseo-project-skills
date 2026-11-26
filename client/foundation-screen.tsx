import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { foundationStatusRpc } from "../shared/rpc";

export function FoundationScreen({ theme, layout }: PluginScreenProps) {
  const checkConnection = useRpc(foundationStatusRpc);
  const connection = useMutation({ mutationFn: checkConnection, retry: false });

  return (
    <View
      style={{
        flex: 1,
        alignItems: "flex-start",
        gap: 12,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600" }}>
        Plugin connection
      </Text>
      <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
        {connection.isPending && "Checking the Paseo host…"}
        {connection.isIdle && "Check whether the plugin server responds on this host."}
        {connection.data?.status === "ready" && "Connected to the plugin server."}
        {connection.isError && "Connection check failed. Try again."}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={connection.isPending}
        onPress={() => connection.mutate({})}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 6,
          backgroundColor: theme.colors.accent,
          opacity: connection.isPending ? 0.6 : 1,
        }}
      >
        <Text style={{ color: theme.colors.accentForeground }}>Check connection</Text>
      </Pressable>
    </View>
  );
}
