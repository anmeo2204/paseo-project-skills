import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import type { ProviderId } from "./provider-selection";
import { Action, Detail } from "./controls";

export type MobileStep = "setup" | "skills" | "preview";

const providerLabels: Record<ProviderId, string> = {
  codex: "Codex",
  cursor: "Cursor",
  kiro: "Kiro",
  antigravity: "Antigravity",
};

const shortSha = (sha: string) => (sha.length >= 8 ? sha.slice(0, 8) : sha);

export function ContextBar({
  theme,
  directory,
  catalogRef,
  selectedTag,
  providers,
}: {
  theme: PluginTheme;
  directory: string | null;
  catalogRef: string;
  selectedTag?: string;
  providers: readonly ProviderId[];
}) {
  const catalogLabel = !catalogRef
    ? "Unpinned (Latest Stable on first Scan)"
    : selectedTag
      ? `${selectedTag} (${shortSha(catalogRef)})`
      : shortSha(catalogRef);
  const providerLabel = providers.length > 0
    ? providers.map((id) => providerLabels[id]).join(", ")
    : "Canonical only";

  return (
    <View
      style={{
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text selectable style={{ color: theme.colors.foreground, fontWeight: "600" }}>
        {directory ? `Target: ${directory}` : "Target: No directory selected"}
      </Text>
      <Detail theme={theme}>
        Catalog: {catalogLabel} · Providers: {providerLabel}
      </Detail>
    </View>
  );
}

export function MobileStepBar({
  theme,
  step,
  onSelectStep,
  hasTarget,
  selectedCount,
  activeOpBanner,
}: {
  theme: PluginTheme;
  step: MobileStep;
  onSelectStep: (next: MobileStep) => void;
  hasTarget: boolean;
  selectedCount: number;
  activeOpBanner?: { label: string; isRecovery: boolean } | null;
}) {
  const steps: ReadonlyArray<{ id: MobileStep; label: string; accessibilityLabel: string }> = [
    {
      id: "setup",
      label: hasTarget ? "1. Setup ✓" : "1. Setup",
      accessibilityLabel: "Step 1: Setup",
    },
    {
      id: "skills",
      label: selectedCount > 0 ? `2. Skills (${selectedCount})` : "2. Skills",
      accessibilityLabel: "Step 2: Skills",
    },
    {
      id: "preview",
      label: "3. Preview & Apply",
      accessibilityLabel: "Step 3: Preview & Apply",
    },
  ];

  return (
    <View style={{ gap: 8 }}>
      <View
        accessibilityRole="tablist"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
      >
        {steps.map((item) => {
          const active = step === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityLabel={item.accessibilityLabel}
              accessibilityState={{ selected: active }}
              hitSlop={4}
              onPress={() => onSelectStep(item.id)}
              style={{
                flexGrow: 1,
                minHeight: 44,
                minWidth: 44,
                justifyContent: "center",
                alignItems: "center",
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: active ? theme.colors.accent : theme.colors.border,
                backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
              }}
            >
              <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontWeight: active ? "600" : "400" }}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* P4: Keep active and recovery-required operation notices accessible from every Mobile step. */}
      {activeOpBanner && step !== "preview" && (
        <View
          style={{
            gap: 6,
            padding: 10,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: activeOpBanner.isRecovery ? theme.colors.statusDanger : theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Detail theme={theme} error={activeOpBanner.isRecovery}>{activeOpBanner.label}</Detail>
          <Action theme={theme} label="View Apply Operations" onPress={() => onSelectStep("preview")} />
        </View>
      )}
    </View>
  );
}

export function StepFooter({
  theme,
  backLabel,
  onBack,
  nextLabel,
  onNext,
  nextPrimary = true,
  hint,
}: {
  theme: PluginTheme;
  backLabel?: string;
  onBack?: () => void;
  nextLabel?: string;
  onNext?: () => void;
  nextPrimary?: boolean;
  hint?: string;
}) {
  return (
    <View style={{ gap: 6, paddingTop: 4 }}>
      {hint && <Detail theme={theme}>{hint}</Detail>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
        {backLabel && onBack ? <Action theme={theme} label={backLabel} onPress={onBack} /> : <View />}
        {nextLabel && onNext && <Action theme={theme} primary={nextPrimary} label={nextLabel} onPress={onNext} />}
      </View>
    </View>
  );
}
