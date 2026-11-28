import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type useSettings } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  catalogReleasesResultSchema,
  catalogResolveResultSchema,
  commitShaSchema,
  type CatalogErrorCode,
  type CatalogRelease,
  type CatalogReleasesResult,
} from "../shared/catalog";
import {
  catalogRefSchema,
  catalogSettings,
  catalogSource,
  type CatalogSelectionMode,
} from "../shared/catalog-settings";
import { catalogReleasesRpc, catalogResolveRpc } from "../shared/rpc";
import { Action, Detail, Disclosure, Input } from "./controls";

export type CatalogSettingsState = ReturnType<typeof useSettings<typeof catalogSettings.schema>>;

type ReadyReleases = Extract<CatalogReleasesResult, { status: "ready" }>;

const shortSha = (sha: string) => sha.slice(0, 8);

const resolveErrorMessages: Record<CatalogErrorCode, string> = {
  not_configured: "Select a catalog version or enter a revision first.",
  invalid_settings: "Reload and correct the host catalog settings.",
  invalid_revision: "Enter a valid tag name or a full 40-character commit SHA.",
  revision_unavailable: "That catalog revision is unavailable on the remote. Check the tag or SHA.",
  no_stable_releases: "No stable release tags are published in this catalog yet. Use Advanced Custom Revision to pin a commit SHA.",
  stale_selection: "The selected release changed on the remote before it could be pinned. Refresh releases and confirm again.",
  git_unavailable: "Git is unavailable on this host.",
  auth_failed: "The host could not authenticate to the catalog. Check its SSH access.",
  network_error: "The host could not reach the catalog. Check its connection and try again.",
  timeout: "Catalog resolution timed out. Try again.",
  git_error: "The host could not resolve the catalog revision. Try again.",
  invalid_catalog: "The selected catalog revision failed validation and was not pinned.",
  limit_exceeded: "The catalog exceeds the supported size limits.",
  host_io_error: "The host could not read the catalog. Try again.",
};

const relationLabels: Record<CatalogRelease["relation"], string | null> = {
  active: "Pinned",
  newer: "Newer",
  older: "Older",
  same_commit: "Same SHA",
  uncompared: null,
};

function initialModeFor(settings: Extract<CatalogSettingsState, { status: "ready" }>): CatalogSelectionMode {
  if (settings.values.selectionMode) return settings.values.selectionMode;
  if (settings.values.catalogRef === "") return "latest_stable";
  return "custom";
}

export function CatalogSection({
  theme,
  hostId,
  settings,
  compact = false,
  onBusyChange,
}: {
  theme: PluginTheme;
  hostId: string;
  settings: CatalogSettingsState;
  compact?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  useEffect(() => {
    if (settings.status !== "ready") onBusyChange?.(false);
  }, [settings.status, onBusyChange]);

  return (
    <>
      <Detail theme={theme}>Source repository</Detail>
      <Text selectable style={{ color: theme.colors.foreground }}>{catalogSource}</Text>
      {settings.status === "loading" && <Detail theme={theme}>Loading host settings…</Detail>}
      {(settings.status === "error" || settings.status === "invalid") && <>
        <Detail theme={theme} error>Could not read a valid catalog setting from this host.</Detail>
        <Action theme={theme} label="Reload settings" onPress={() => void settings.reload()} />
      </>}
      {settings.status === "ready" && (
        <CatalogEditor
          key={`${hostId}:${settings.revision}`}
          theme={theme}
          hostId={hostId}
          settings={settings}
          compact={compact}
          onBusyChange={onBusyChange}
        />
      )}
    </>
  );
}

function ModeButton({
  theme,
  label,
  active,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 36,
        justifyContent: "center",
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: active ? theme.colors.accent : theme.colors.border,
        backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Text style={{ color: active ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

function CatalogEditor({
  theme,
  hostId,
  settings,
  compact,
  onBusyChange,
}: {
  theme: PluginTheme;
  hostId: string;
  settings: Extract<CatalogSettingsState, { status: "ready" }>;
  compact: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const fetchReleases = useRpc(catalogReleasesRpc);
  const resolveCatalog = useRpc(catalogResolveRpc);

  const savedRef = settings.values.catalogRef;
  const savedMode = settings.values.selectionMode;
  const savedTag = settings.values.selectedTag;
  const isPinnedSha = commitShaSchema.safeParse(savedRef.toLowerCase()).success;
  const isLegacyTag = savedRef !== "" && !isPinnedSha;

  const [mode, setMode] = useState<CatalogSelectionMode>(() => initialModeFor(settings));
  const [customDraft, setCustomDraft] = useState(() => (savedMode === "custom" || !savedMode ? savedRef : ""));
  const [selectedRelease, setSelectedRelease] = useState<CatalogRelease | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showFullSha, setShowFullSha] = useState(false);
  const [draftGeneration, setDraftGeneration] = useState(0);

  const [releasesState, setReleasesState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; data: ReadyReleases }
    | { phase: "error"; message: string }
  >({ phase: "loading" });

  const [resolving, setResolving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ error: boolean; text: string } | null>(null);

  const listAttemptRef = useRef<object | null>(null);
  const resolveAttemptRef = useRef<object | null>(null);
  const draftScope = JSON.stringify([hostId, settings.revision, savedRef, mode, selectedRelease?.tag, selectedRelease?.commitSha, customDraft, draftGeneration]);

  // P3: Invalidate any in-flight resolve when draft, mode, host, or settings revision changes (including A -> B -> A).
  useLayoutEffect(() => {
    resolveAttemptRef.current = null;
    setResolving(false);
    return () => {
      resolveAttemptRef.current = null;
    };
  }, [draftScope]);

  // Notify parent so Scan/Preview/Approval stay disabled during resolve or save.
  useEffect(() => {
    onBusyChange?.(resolving || Boolean(settings.saving));
    return () => {
      onBusyChange?.(false);
    };
  }, [resolving, settings.saving, onBusyChange]);

  async function loadReleases(refresh: boolean) {
    const attempt = {};
    listAttemptRef.current = attempt;
    setReleasesState({ phase: "loading" });
    try {
      const raw = await fetchReleases(refresh ? { refresh: true } : {});
      if (listAttemptRef.current !== attempt) return;
      const parsed = catalogReleasesResultSchema.safeParse(raw);
      if (!parsed.success) {
        setReleasesState({ phase: "error", message: "Could not read catalog releases from this host." });
        return;
      }
      if (parsed.data.status === "error") {
        setReleasesState({ phase: "error", message: resolveErrorMessages[parsed.data.code] });
        return;
      }
      if (parsed.data.settingsRevision !== settings.revision) return;
      setReleasesState({ phase: "ready", data: parsed.data });
      if (selectedRelease) {
        const refreshed = parsed.data.releases.find((item) => item.tag === selectedRelease.tag) ?? null;
        if (!refreshed || refreshed.commitSha !== selectedRelease.commitSha) {
          setSelectedRelease(null);
        }
      }
    } catch {
      if (listAttemptRef.current !== attempt) return;
      setReleasesState({ phase: "error", message: "Could not list catalog releases from this host." });
    }
  }

  useEffect(() => {
    void loadReleases(false);
    return () => {
      listAttemptRef.current = null;
    };
  }, [hostId, settings.revision]);

  function bumpDraft() {
    setDraftGeneration((value) => value + 1);
    setStatusMessage(null);
  }

  async function resolveAndPin(
    input: Parameters<typeof resolveCatalog>[0],
    nextMode: CatalogSelectionMode,
  ) {
    if (resolving || settings.saving) return;
    const attempt = {};
    resolveAttemptRef.current = attempt;
    setResolving(true);
    setStatusMessage(null);
    try {
      const raw = await resolveCatalog(input);
      if (resolveAttemptRef.current !== attempt) return;
      const parsed = catalogResolveResultSchema.safeParse(raw);
      if (!parsed.success) {
        setStatusMessage({ error: true, text: "The daemon returned an unreadable resolution response." });
        return;
      }
      if (parsed.data.status === "error") {
        setStatusMessage({ error: true, text: resolveErrorMessages[parsed.data.code] });
        if (parsed.data.code === "stale_selection") {
          void loadReleases(true);
        }
        return;
      }
      const nextValues = {
        catalogRef: parsed.data.commitSha,
        selectionMode: nextMode,
        ...(parsed.data.resolvedTag ? { selectedTag: parsed.data.resolvedTag } : {}),
      };
      const saved = await settings.save(nextValues, settings.revision);
      if (resolveAttemptRef.current !== attempt) return;
      if (!saved) {
        setStatusMessage({ error: true, text: "Catalog settings changed concurrently. Reload settings and try again." });
      }
    } catch {
      if (resolveAttemptRef.current !== attempt) return;
      setStatusMessage({ error: true, text: "Could not resolve the catalog revision on this host. Try again." });
    } finally {
      if (resolveAttemptRef.current === attempt) {
        resolveAttemptRef.current = null;
        setResolving(false);
      }
    }
  }

  const readyData = releasesState.phase === "ready" ? releasesState.data : null;
  const latestStable = readyData?.latestStable ?? null;
  const releases = readyData?.releases ?? [];
  const busy = resolving || Boolean(settings.saving);
  const customValid = customDraft.length > 0 && catalogRefSchema.safeParse(customDraft).success;
  const latestAlreadyPinned = Boolean(
    latestStable &&
    isPinnedSha &&
    savedMode === "latest_stable" &&
    savedTag === latestStable.tag &&
    savedRef.toLowerCase() === latestStable.commitSha,
  );
  const specificAlreadyPinned = Boolean(
    selectedRelease &&
    isPinnedSha &&
    savedMode === "specific_version" &&
    savedTag === selectedRelease.tag &&
    savedRef.toLowerCase() === selectedRelease.commitSha,
  );

  return (
    <View style={{ gap: 8 }}>
      {/* Active pinned revision summary */}
      <View style={{ gap: 4 }}>
        {savedRef === "" && <Detail theme={theme}>No catalog revision pinned on this host.</Detail>}
        {isPinnedSha && (
          <>
            <Detail theme={theme}>
              {savedTag
                ? `Pinned on this host: ${savedTag} (${shortSha(savedRef)})`
                : `Pinned on this host (custom): ${shortSha(savedRef)}`}
            </Detail>
            {compact ? (
              <>
                <Disclosure
                  theme={theme}
                  label={showFullSha ? "Hide full commit SHA" : "Show full commit SHA"}
                  expanded={showFullSha}
                  onPress={() => setShowFullSha((value) => !value)}
                />
                {showFullSha && <Text selectable style={{ color: theme.colors.foregroundMuted }}>{savedRef}</Text>}
              </>
            ) : (
              <Text selectable style={{ color: theme.colors.foregroundMuted }}>Commit SHA: {savedRef}</Text>
            )}
          </>
        )}
        {isLegacyTag && (
          <View style={{ gap: 6 }}>
            <Detail theme={theme} error>
              Legacy unpinned tag saved on this host: {savedRef}. Resolve and pin an immutable commit SHA before scanning.
            </Detail>
            <Action
              theme={theme}
              primary
              label={busy ? "Resolving…" : `Resolve & Pin ${savedRef}`}
              disabled={busy}
              onPress={() => void resolveAndPin({ mode: "custom", ref: savedRef }, "custom")}
            />
          </View>
        )}
      </View>

      {/* P1: Typed update detection status (never auto-replaces pinned revision) */}
      {releasesState.phase === "loading" && <Detail theme={theme}>Checking available catalog releases…</Detail>}
      {releasesState.phase === "error" && (
        <View style={{ gap: 6 }}>
          <Detail theme={theme} error>{releasesState.message}</Detail>
          <Action theme={theme} label="Retry release check" disabled={busy} onPress={() => void loadReleases(true)} />
        </View>
      )}
      {readyData && (
        <View style={{ gap: 6 }}>
          {readyData.updateStatus === "update_available" && latestStable && (
            <View style={{ gap: 6, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
              <Detail theme={theme}>
                Update available: {latestStable.tag} ({shortSha(latestStable.commitSha)}). Active pinned revision ({savedTag ?? shortSha(savedRef)}) is unchanged. Pinning resets current scan and preview results.
              </Detail>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Action
                  theme={theme}
                  primary
                  label={busy ? "Pinning…" : `Pin ${latestStable.tag}`}
                  disabled={busy}
                  onPress={() => void resolveAndPin(
                    { mode: "latest_stable", expectedTag: latestStable.tag, expectedCommitSha: latestStable.commitSha },
                    "latest_stable",
                  )}
                />
                <Action theme={theme} label="Check for updates" disabled={busy} onPress={() => void loadReleases(true)} />
              </View>
            </View>
          )}
          {readyData.updateStatus === "moved_tag" && readyData.movedTag && (
            <Detail theme={theme} error>
              {readyData.movedTag.remoteCommitSha
                ? `Tag ${readyData.movedTag.tag} moved on the remote (pinned ${shortSha(readyData.movedTag.pinnedCommitSha)}, remote ${shortSha(readyData.movedTag.remoteCommitSha)}). Your pinned revision is unchanged; inspect and re-pin explicitly if intended.`
                : `Tag ${readyData.movedTag.tag} was removed from the remote. Your pinned commit ${shortSha(readyData.movedTag.pinnedCommitSha)} remains locked.`}
            </Detail>
          )}
          {readyData.updateStatus === "up_to_date" && latestStable && (
            <Detail theme={theme}>Up to date with latest stable ({latestStable.tag}).</Detail>
          )}
          {readyData.updateStatus === "newer_than_latest" && (
            <Detail theme={theme}>Pinned version ({savedTag}) is newer than the current latest stable release.</Detail>
          )}
          {readyData.updateStatus === "custom_revision" && (
            <Detail theme={theme}>Using custom pinned revision. Updates are not automatically suggested for custom revisions.</Detail>
          )}
          {readyData.updateStatus === "no_stable_releases" && (
            <Detail theme={theme} error>{resolveErrorMessages.no_stable_releases}</Detail>
          )}
          {readyData.updateStatus !== "update_available" && (
            <Action theme={theme} label="Check for updates" disabled={busy} onPress={() => void loadReleases(true)} />
          )}
        </View>
      )}

      {/* Selection mode selector */}
      <Text style={{ color: theme.colors.foreground }}>Catalog selection mode</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ModeButton
          theme={theme}
          label="Latest Stable"
          active={mode === "latest_stable"}
          disabled={busy}
          onPress={() => { setMode("latest_stable"); bumpDraft(); }}
        />
        <ModeButton
          theme={theme}
          label="Specific Version"
          active={mode === "specific_version"}
          disabled={busy}
          onPress={() => { setMode("specific_version"); bumpDraft(); }}
        />
        <ModeButton
          theme={theme}
          label="Advanced Custom"
          active={mode === "custom"}
          disabled={busy}
          onPress={() => { setMode("custom"); bumpDraft(); }}
        />
      </View>

      {/* Mode 1: Latest Stable */}
      {mode === "latest_stable" && (
        <View style={{ gap: 6 }}>
          {latestStable ? (
            <>
              <Detail theme={theme}>
                Latest stable release: {latestStable.tag} ({shortSha(latestStable.commitSha)})
              </Detail>
              <Action
                theme={theme}
                primary
                label={busy ? "Pinning…" : latestAlreadyPinned ? "Latest Stable Pinned" : `Pin Latest Stable (${latestStable.tag})`}
                disabled={busy || latestAlreadyPinned}
                onPress={() => void resolveAndPin(
                  { mode: "latest_stable", expectedTag: latestStable.tag, expectedCommitSha: latestStable.commitSha },
                  "latest_stable",
                )}
              />
            </>
          ) : (
            <Detail theme={theme}>
              {releasesState.phase === "loading"
                ? "Waiting for release list…"
                : "No stable release is available to pin. Switch to Advanced Custom to pin a commit SHA."}
            </Detail>
          )}
        </View>
      )}

      {/* Mode 2: Specific Version (stable SemVer tags only) */}
      {mode === "specific_version" && (
        <View style={{ gap: 6 }}>
          <Action
            theme={theme}
            label={selectedRelease ? `Selected version: ${selectedRelease.tag}` : "Choose release version"}
            disabled={busy || releases.length === 0}
            onPress={() => setPickerOpen(true)}
          />
          {releases.length === 0 && releasesState.phase === "ready" && (
            <Detail theme={theme}>No stable SemVer releases are available.</Detail>
          )}
          {selectedRelease && (
            <>
              <Detail theme={theme}>
                Selected: {selectedRelease.tag} ({shortSha(selectedRelease.commitSha)})
              </Detail>
              <Action
                theme={theme}
                primary
                label={busy ? "Pinning…" : specificAlreadyPinned ? "Version Pinned" : `Pin Selected Version (${selectedRelease.tag})`}
                disabled={busy || specificAlreadyPinned}
                onPress={() => void resolveAndPin(
                  { mode: "specific_version", tag: selectedRelease.tag, expectedCommitSha: selectedRelease.commitSha },
                  "specific_version",
                )}
              />
            </>
          )}
          <Modal open={pickerOpen} onOpenChange={setPickerOpen} title="Choose stable catalog version">
            <Modal.Content>
              <View style={{ gap: 6 }}>
                {releases.map((item) => {
                  const badge = relationLabels[item.relation];
                  return (
                    <Pressable
                      key={item.tag}
                      accessibilityRole="button"
                      onPress={() => {
                        setSelectedRelease(item);
                        setPickerOpen(false);
                        bumpDraft();
                      }}
                      style={{ padding: 10, gap: 3, borderRadius: 6, backgroundColor: theme.colors.surface2 }}
                    >
                      <Text style={{ color: theme.colors.foreground }}>
                        {badge ? `${item.tag} · ${badge}` : item.tag}
                      </Text>
                      <Detail theme={theme}>{item.commitSha}</Detail>
                    </Pressable>
                  );
                })}
              </View>
            </Modal.Content>
          </Modal>
        </View>
      )}

      {/* Mode 3: Advanced Custom Revision */}
      {mode === "custom" && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foreground }}>Custom tag or full commit SHA</Text>
          <Input
            theme={theme}
            accessibilityLabel="Catalog revision"
            placeholder="Tag or full 40-character commit SHA"
            value={customDraft}
            onChangeText={(text) => { setCustomDraft(text); bumpDraft(); }}
            editable={!busy}
          />
          <Detail theme={theme}>
            Resolves tags strictly under refs/tags/ or exact 40-character commit SHAs on the daemon before pinning. Branches and main HEAD are never used.
          </Detail>
          {customDraft.length > 0 && !customValid && (
            <Detail theme={theme} error>Enter a valid tag name or a full 40-character commit SHA.</Detail>
          )}
          <Action
            theme={theme}
            primary
            label={busy ? "Resolving…" : "Resolve & Pin Revision"}
            disabled={busy || !customValid}
            onPress={() => void resolveAndPin({ mode: "custom", ref: customDraft }, "custom")}
          />
        </View>
      )}

      {statusMessage && <Detail theme={theme} error={statusMessage.error}>{statusMessage.text}</Detail>}
      {settings.saveError && (
        <Detail theme={theme} error>Could not save the catalog revision. Reload settings and try again.</Detail>
      )}
    </View>
  );
}
