import type { PluginTheme } from "@getpaseo/plugin";
import { useHosts, useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { View } from "react-native";
import { catalogSettings } from "../shared/catalog-settings";
import { applyTargetStatusRpc, type ApplyTargetStatusOutput } from "../shared/apply";
import { foundationStatusRpc, validateDirectoryRpc } from "../shared/rpc";
import { CatalogSection } from "./catalog-section";
import { Action, Detail, Section } from "./controls";
import { FixtureOperations, useFixtureApproval } from "./fixture-approval";
import { ProviderSelection, type ProviderId } from "./provider-selection";
import { RecommendationRun } from "./recommendation-run";
import { TargetPicker, type Target } from "./target-picker";

const directoryErrors = {
  invalid_path: "Enter an absolute path on this host.",
  missing: "The directory does not exist on this host.",
  not_directory: "The path does not point to a directory.",
  permission_denied: "The Paseo daemon does not have permission to access this directory.",
  unreadable: "The Paseo daemon could not read this path.",
};

export function FoundationScreen({ theme, layout, host }: PluginScreenProps) {
  const status = useHosts().find((entry) => entry.serverId === host.id)?.status;
  const disconnected = status !== "online";
  const fixture = useFixtureApproval();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 20 }}>
      <View style={{ width: "100%", maxWidth: 880, alignSelf: "center", gap: 12 }}>
        {disconnected ? <>
          <Section theme={theme} title="Target Project">
            <Detail theme={theme} error>{host.label} is {status ?? "unavailable"}. Connect to this host to choose a directory.</Detail>
          </Section>
          <Section theme={theme} title="Target Providers"><Detail theme={theme}>Connect to the host to discover providers.</Detail></Section>
          <Section theme={theme} title="Skill Catalog"><Detail theme={theme}>Host settings are unavailable.</Detail></Section>
        </> : <HostScreen key={host.id} theme={theme} hostId={host.id} hostLabel={host.label} compact={layout.compact} />}
        {fixture && <FixtureOperations theme={theme} host={host} online={!disconnected} />}
      </View>
    </ScrollView>
  );
}

const targetApplyLabels: Record<ApplyTargetStatusOutput["targetState"], string | null> = {
  none: null,
  enrolled_enabled: "Safe Apply: Enrolled and active for this target (create-only).",
  enrolled_disabled: "Safe Apply: Preview-only — enrollment for this project is currently disabled via host CLI.",
  not_enrolled: "Safe Apply: Preview-only — this project is not enrolled. Enroll via host CLI (scripts/enroll-project-skills.mjs) to enable Apply.",
  root_identity_mismatch: "Safe Apply: Preview-only — enrolled root identity could not be verified (directory replaced or moved). Re-enroll via host CLI.",
  host_unavailable: "Safe Apply: Preview-only — unavailable on this host.",
};

function TargetApplyStatus({ theme, hostId, directory }: { theme: PluginTheme; hostId: string; directory: string }) {
  const fetchStatus = useRpc(applyTargetStatusRpc);
  const query = useQuery({
    queryKey: ["apply-target-status", hostId, directory],
    queryFn: () => fetchStatus({ canonicalDirectory: directory }),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  if (!query.isSuccess) return null;
  const label = targetApplyLabels[query.data.targetState];
  if (!label) return null;
  const isError = query.data.targetState === "root_identity_mismatch" || query.data.targetState === "host_unavailable";
  return <Detail theme={theme} error={isError}>{label}</Detail>;
}

function HostScreen({ theme, hostId, hostLabel, compact }: { theme: PluginTheme; hostId: string; hostLabel: string; compact: boolean }) {
  const approvalScope = useFixtureApproval();
  const [target, setTarget] = useState<{ value: Target; selection: number } | null>(null);

  const settings = useSettings(catalogSettings);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderId[]>([]);
  const [providerGeneration, setProviderGeneration] = useState(0);
  const validate = useRpc(validateDirectoryRpc);
  const screenId = useId();
  const path = target?.value.path;
  const result = useQuery({
    queryKey: ["target-directory", hostId, screenId, target?.selection, path],
    queryFn: () => validate({ path: path ?? "" }),
    enabled: path !== undefined,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const directory = !result.isError && result.data?.status === "ready" ? result.data.directory : null;

  return (
    <>
      <Section theme={theme} title="Target Project">
        <Detail theme={theme}>Paseo host: {hostLabel}</Detail>
        <TargetPicker theme={theme} hostId={hostId} onSelect={(value) => {
          setProviders([]);
          setTarget((current) => ({ value, selection: (current?.selection ?? 0) + 1 }));
        }} />
        {!target && <Detail theme={theme}>No target directory selected.</Detail>}
        {target && <View style={{ gap: 4 }} accessibilityLiveRegion="polite">
          <Detail theme={theme}>{target.value.label} · {target.value.kind}</Detail>
          {result.isPending && <Detail theme={theme}>Validating directory…</Detail>}
          {result.isError && <>
            <Detail theme={theme} error>Could not validate the directory on this host.</Detail>
            <Action theme={theme} label="Retry validation" onPress={() => void result.refetch()} />
          </>}
          {!result.isError && result.data?.status === "error" &&
            <Detail theme={theme} error>{directoryErrors[result.data.code]}</Detail>}
          {directory && <Detail theme={theme}>Target directory: {directory}</Detail>}
          {directory && approvalScope && <TargetApplyStatus theme={theme} hostId={hostId} directory={directory} />}
        </View>}
      </Section>
      <Section theme={theme} title="Target Providers">
        {directory
          ? <ProviderSelection key={target?.selection} theme={theme} hostId={hostId} cwd={directory}
              selected={providers} onToggle={(id) => {
                setProviderGeneration((value) => value + 1);
                setProviders((current) => current.includes(id)
                  ? current.filter((selected) => selected !== id) : [...current, id]);
              }} />
          : <Detail theme={theme}>Choose a valid target directory to discover providers.</Detail>}
      </Section>
      <Section theme={theme} title="Skill Catalog">
        <CatalogSection theme={theme} hostId={hostId} settings={settings} compact={compact} onBusyChange={setCatalogBusy} />
      </Section>
      <RecommendationRun theme={theme} hostId={hostId} directory={directory}
        generation={target?.selection ?? 0} settings={settings} providers={providers}
        providerGeneration={providerGeneration} catalogBusy={catalogBusy} />
      <ConnectionCheck theme={theme} />
    </>
  );
}

function ConnectionCheck({ theme }: { theme: PluginTheme }) {
  const checkConnection = useRpc(foundationStatusRpc);
  const connection = useMutation({ mutationFn: checkConnection, retry: false });

  return (
    <View style={{ gap: 6, paddingHorizontal: 4 }}>
      <Action theme={theme} label="Check connection" disabled={connection.isPending}
        onPress={() => connection.mutate({})} />
      {connection.isPending && <Detail theme={theme}>Checking the Paseo host…</Detail>}
      {connection.isSuccess && <Detail theme={theme}>Connected to the plugin server.</Detail>}
      {connection.isError && <Detail theme={theme} error>Connection check failed. Try again.</Detail>}
    </View>
  );
}
