import type { PluginTheme } from "@getpaseo/plugin";
import { useHosts, useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { catalogSettings } from "../shared/catalog-settings";
import { applyTargetStatusRpc, type ApplyTargetStatusOutput } from "../shared/apply";
import { foundationStatusRpc, validateDirectoryRpc } from "../shared/rpc";
import {
  lookupProviderPreference,
  normalizeProviders,
  workspacePreferencesSettings,
} from "../shared/workspace-preferences";
import { CatalogSection } from "./catalog-section";
import { Action, Detail, Section } from "./controls";
import { FixtureOperations, summarizeHostOperations, useFixtureApproval } from "./fixture-approval";
import { createPreferenceWriter } from "./preference-writer";
import { ProviderSelection, type ProviderId, type ProviderSnapshotBinding } from "./provider-selection";
import { RecommendationRun } from "./recommendation-run";
import { TargetPicker, type Target } from "./target-picker";
import { ContextBar, MobileStepBar, StepFooter, type MobileStep } from "./workflow-layout";

const directoryErrors = {
  invalid_path: "Enter an absolute path on this host.",
  missing: "The directory does not exist on this host.",
  not_directory: "The path does not point to a directory.",
  permission_denied: "The Paseo daemon does not have permission to access this directory.",
  unreadable: "The Paseo daemon could not read this path.",
};

const emptyOperations: readonly [] = [];
const noopSubscribe = () => () => {};

function blurActiveWebElement() {
  const doc = (globalThis as unknown as { document?: { activeElement?: { blur?: () => void } } }).document;
  if (doc?.activeElement && typeof doc.activeElement.blur === "function") {
    doc.activeElement.blur();
  }
}

export function FoundationScreen({ theme, layout, host }: PluginScreenProps) {
  const status = useHosts().find((entry) => entry.serverId === host.id)?.status;
  const disconnected = status !== "online";
  const fixture = useFixtureApproval();
  const scrollRef = useRef<{ scrollTo?: (options: { y?: number; animated?: boolean }) => void } | null>(null);
  const [mobileStep, setMobileStep] = useState<MobileStep>("setup");

  // Reset mobile step cleanly when switching hosts or disconnecting.
  useEffect(() => {
    setMobileStep("setup");
  }, [host.id, disconnected]);

  // P2: Dismiss open focus/keyboard and scroll to top on Mobile step transitions.
  const navigateMobileStep = useCallback((next: MobileStep) => {
    blurActiveWebElement();
    scrollRef.current?.scrollTo?.({ y: 0, animated: false });
    setMobileStep(next);
  }, []);

  // P4: Read live operation state from outside HostScreen so active/recovery notices survive disconnects & step changes.
  const operations = useSyncExternalStore(
    fixture ? fixture.tracker.subscribe : noopSubscribe,
    fixture ? fixture.tracker.snapshot : () => emptyOperations,
  );
  const activeOpBanner = fixture ? summarizeHostOperations(operations, host.id, fixture.slot) : null;
  const showOperations = !layout.compact || disconnected || mobileStep === "preview";

  return (
    <ScrollView
      ref={scrollRef as never}
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 20 }}
    >
      <View style={{ width: "100%", maxWidth: layout.compact ? 880 : 1240, alignSelf: "center", gap: 12 }}>
        {disconnected ? <>
          <Section theme={theme} title="Target Project">
            <Detail theme={theme} error>{host.label} is {status ?? "unavailable"}. Connect to this host to choose a directory.</Detail>
          </Section>
          <Section theme={theme} title="Target Providers"><Detail theme={theme}>Connect to the host to discover providers.</Detail></Section>
          <Section theme={theme} title="Skill Catalog"><Detail theme={theme}>Host settings are unavailable.</Detail></Section>
        </> : (
          <HostScreen
            key={host.id}
            theme={theme}
            hostId={host.id}
            hostLabel={host.label}
            compact={layout.compact}
            mobileStep={mobileStep}
            onNavigateStep={navigateMobileStep}
            activeOpBanner={activeOpBanner}
          />
        )}
        {/* P4: FixtureOperations remains mounted outside HostScreen across disconnects, host switches, and layout transitions. */}
        {fixture && (
          <View
            style={{ display: showOperations ? "flex" : "none" }}
            aria-hidden={!showOperations}
            importantForAccessibility={!showOperations ? "no-hide-descendants" : "auto"}
            pointerEvents={!showOperations ? "none" : "auto"}
          >
            <FixtureOperations theme={theme} host={host} online={!disconnected} />
          </View>
        )}
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

function HostScreen({
  theme,
  hostId,
  hostLabel,
  compact,
  mobileStep,
  onNavigateStep,
  activeOpBanner,
}: {
  theme: PluginTheme;
  hostId: string;
  hostLabel: string;
  compact: boolean;
  mobileStep: MobileStep;
  onNavigateStep: (next: MobileStep) => void;
  activeOpBanner: { label: string; isRecovery: boolean } | null;
}) {
  const approvalScope = useFixtureApproval();
  const [target, setTarget] = useState<{ value: Target; selection: number } | null>(null);
  const [selectedSkillCount, setSelectedSkillCount] = useState(0);

  const settings = useSettings(catalogSettings);
  const preferences = useSettings(workspacePreferencesSettings);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const writerRef = useRef<ReturnType<typeof createPreferenceWriter> | null>(null);
  if (!writerRef.current) {
    writerRef.current = createPreferenceWriter({
      getState: () => preferencesRef.current,
    });
  }
  useEffect(() => {
    const writer = writerRef.current;
    return () => {
      writer?.dispose();
      writerRef.current = null;
    };
  }, [hostId]);

  const [catalogBusy, setCatalogBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderId[]>([]);
  const providersRef = useRef<ProviderId[]>(providers);
  providersRef.current = providers;
  const [providerGeneration, setProviderGeneration] = useState(0);
  const [preferenceHint, setPreferenceHint] = useState<"none" | "restored" | "empty">("none");
  const recordedRecentSelectionRef = useRef<number>(0);
  const restoredPreferenceKeyRef = useRef<string | null>(null);
  const userTouchedProvidersRef = useRef<boolean>(false);

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

  useEffect(() => {
    if (!directory || !target || recordedRecentSelectionRef.current === target.selection) return;
    recordedRecentSelectionRef.current = target.selection;
    void writerRef.current?.enqueue({
      type: "record_recent",
      canonicalDirectory: directory,
      label: target.value.label,
      kind: target.value.kind,
      now: Date.now(),
    });
  }, [directory, target]);

  useEffect(() => {
    if (!directory || !target || userTouchedProvidersRef.current) return;
    if (preferences.status !== "ready") return;
    const key = `${hostId}:${target.selection}:${directory}`;
    if (restoredPreferenceKeyRef.current === key) return;
    restoredPreferenceKeyRef.current = key;
    const found = lookupProviderPreference(preferences.values, directory);
    if (!found.found) {
      setPreferenceHint("none");
      return;
    }
    if (found.providers.length === 0) {
      setProviders([]);
      setPreferenceHint("empty");
      return;
    }
    setProviders(found.providers);
    setProviderGeneration((value) => value + 1);
    setPreferenceHint("restored");
  }, [directory, target, hostId, preferences]);

  function selectTarget(value: Target) {
    userTouchedProvidersRef.current = false;
    restoredPreferenceKeyRef.current = null;
    setPreferenceHint("none");
    setProviders([]);
    setTarget((current) => ({ value, selection: (current?.selection ?? 0) + 1 }));
  }

  function applyProviders(next: readonly ProviderId[]) {
    if (!directory) return;
    const normalized = normalizeProviders(next);
    userTouchedProvidersRef.current = true;
    providersRef.current = normalized;
    setPreferenceHint("none");
    setProviderGeneration((value) => value + 1);
    setProviders(normalized);
    void writerRef.current?.enqueue({
      type: "set_providers",
      canonicalDirectory: directory,
      providers: normalized,
      now: Date.now(),
    });
  }

  function toggleProvider(id: ProviderId) {
    if (!directory) return;
    const current = providersRef.current;
    const next = current.includes(id)
      ? current.filter((selected) => selected !== id)
      : [...current, id];
    applyProviders(next);
  }

  function replaceProviders(next: readonly ProviderId[], binding: ProviderSnapshotBinding) {
    if (binding.hostId !== hostId || binding.cwd !== directory || binding.selectionGeneration !== target?.selection) {
      return;
    }
    applyProviders(next);
  }

  function removeRecent(canonicalDirectory: string) {
    void writerRef.current?.enqueue({ type: "remove_recent", canonicalDirectory });
    if (target?.value.fromRecent && target.value.path === canonicalDirectory) {
      setTarget(null);
      setProviders([]);
      setPreferenceHint("none");
    }
  }

  const recentProjects = preferences.status === "ready" ? preferences.values.recentProjects : [];
  const catalogRef = settings.status === "ready" ? settings.values.catalogRef : "";
  const selectedTag = settings.status === "ready" ? settings.values.selectedTag : undefined;

  // D1 & D3: One mounted tree across Desktop two-pane and Mobile 3-step layouts.
  const hideConfigPane = compact && mobileStep !== "setup";
  const hideWorkPane = compact && mobileStep === "setup";

  return (
    <View style={{ gap: 12 }}>
      {compact && (
        <MobileStepBar
          theme={theme}
          step={mobileStep}
          onSelectStep={onNavigateStep}
          hasTarget={Boolean(directory)}
          selectedCount={selectedSkillCount}
          activeOpBanner={activeOpBanner}
        />
      )}

      <View
        style={{
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "stretch" : "flex-start",
          gap: 16,
        }}
      >
        {/* Left Pane (Desktop) / Step 1: Setup (Mobile) */}
        <View
          style={{
            width: compact ? "100%" : 340,
            flexShrink: 0,
            gap: 12,
            display: hideConfigPane ? "none" : "flex",
          }}
          aria-hidden={hideConfigPane}
          importantForAccessibility={hideConfigPane ? "no-hide-descendants" : "auto"}
          pointerEvents={hideConfigPane ? "none" : "auto"}
        >
          <Section theme={theme} title="Target Project">
            <Detail theme={theme}>Paseo host: {hostLabel}</Detail>
            <TargetPicker
              theme={theme}
              hostId={hostId}
              recentProjects={recentProjects}
              onSelect={selectTarget}
              onRemoveRecent={removeRecent}
            />
            {!target && <Detail theme={theme}>No target directory selected.</Detail>}
            {target && <View style={{ gap: 4 }} accessibilityLiveRegion="polite">
              <Detail theme={theme}>{target.value.label} · {target.value.kind}</Detail>
              {result.isPending && <Detail theme={theme}>Validating directory…</Detail>}
              {result.isError && <>
                <Detail theme={theme} error>Could not validate the directory on this host.</Detail>
                <Action theme={theme} label="Retry validation" onPress={() => void result.refetch()} />
              </>}
              {!result.isError && result.data?.status === "error" && (
                <View style={{ gap: 6 }}>
                  <Detail theme={theme} error>{directoryErrors[result.data.code]}</Detail>
                  {target.value.fromRecent && (
                    <Action
                      theme={theme}
                      label="Remove from recent"
                      onPress={() => removeRecent(target.value.path)}
                    />
                  )}
                </View>
              )}
              {directory && <Detail theme={theme}>Target directory: {directory}</Detail>}
              {directory && approvalScope && <TargetApplyStatus theme={theme} hostId={hostId} directory={directory} />}
            </View>}
          </Section>
          <Section theme={theme} title="Target Providers">
            {directory && target
              ? <ProviderSelection
                  key={target.selection}
                  theme={theme}
                  hostId={hostId}
                  cwd={directory}
                  selectionGeneration={target.selection}
                  selected={providers}
                  preferenceHint={preferenceHint}
                  onToggle={toggleProvider}
                  onReplace={replaceProviders}
                />
              : <Detail theme={theme}>Choose a valid target directory to discover providers.</Detail>}
          </Section>
          <Section theme={theme} title="Skill Catalog">
            <CatalogSection theme={theme} hostId={hostId} settings={settings} compact={compact} onBusyChange={setCatalogBusy} />
          </Section>
          <ConnectionCheck theme={theme} />
          {compact && (
            <StepFooter
              theme={theme}
              nextLabel="Continue to Skills"
              onNext={() => onNavigateStep("skills")}
              hint={!directory ? "Choose a valid target directory above before scanning." : undefined}
            />
          )}
        </View>

        {/* Right Pane (Desktop) / Step 2 & Step 3 (Mobile) */}
        <View
          style={{
            flex: compact ? undefined : 1,
            width: compact ? "100%" : undefined,
            minWidth: 0,
            gap: 12,
            display: hideWorkPane ? "none" : "flex",
          }}
          aria-hidden={hideWorkPane}
          importantForAccessibility={hideWorkPane ? "no-hide-descendants" : "auto"}
          pointerEvents={hideWorkPane ? "none" : "auto"}
        >
          <ContextBar
            theme={theme}
            directory={directory}
            catalogRef={catalogRef}
            selectedTag={selectedTag}
            providers={providers}
          />
          <RecommendationRun
            theme={theme}
            hostId={hostId}
            directory={directory}
            generation={target?.selection ?? 0}
            settings={settings}
            providers={providers}
            providerGeneration={providerGeneration}
            catalogBusy={catalogBusy}
            compact={compact}
            mobileStep={compact ? mobileStep : undefined}
            onNavigateStep={compact ? onNavigateStep : undefined}
            onSelectedCountChange={setSelectedSkillCount}
          />
        </View>
      </View>
    </View>
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
