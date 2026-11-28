import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  catalogResolveResultSchema,
  commitShaSchema,
  type CatalogErrorCode,
  type CatalogSnapshotDescriptor,
} from "../shared/catalog";
import type { RecommendationErrorCode, RecommendationEvent, RecommendationInput } from "../shared/recommendation";
import { catalogLoadRpc, catalogResolveRpc, recommendationEvaluateSubscription } from "../shared/rpc";
import { selectionIntentV1Schema } from "../shared/selection-intent";
import type { CatalogSettingsState } from "./catalog-section";
import { Action, Detail, Section } from "./controls";
import type { ProviderId } from "./provider-selection";
import { RecommendationResults } from "./recommendation-results";
import { PreviewRun } from "./preview-run";
export type { SelectionIntentV1 } from "../shared/selection-intent";

type TerminalResult = Extract<RecommendationEvent, { status: "ready" | "partial" }>;
type Attempt = {
  scope: string;
  requestId: string;
  directory: string;
  revision: string;
  ref: string;
  firstUsePinnedSha?: string;
  firstUseInitialRevision?: string;
};
type Run =
  | { phase: "loading" | "cancelled"; attempt: Attempt }
  | { phase: "error" | "stale"; attempt: Attempt; message: string }
  | { phase: "scanning"; attempt: Attempt; catalog: CatalogSnapshotDescriptor }
  | { phase: "complete"; attempt: Attempt; catalog: CatalogSnapshotDescriptor; event: TerminalResult; selected: string[] };

const catalogErrors: Record<CatalogErrorCode, string> = {
  not_configured: "Pin a catalog revision first.",
  invalid_settings: "Reload and correct the host catalog settings.",
  invalid_revision: "Save a valid tag or full commit SHA.",
  revision_unavailable: "That catalog revision is unavailable. Check the saved tag or SHA.",
  no_stable_releases: "No stable release tags are published in this catalog yet. Use Advanced Custom Revision to pin a commit SHA.",
  stale_selection: "The latest stable release changed on the remote. Try again.",
  git_unavailable: "Git is unavailable on this host.",
  auth_failed: "The host could not authenticate to the catalog. Check its SSH access.",
  network_error: "The host could not reach the catalog. Check its connection and try again.",
  timeout: "Catalog loading timed out. Try again.",
  git_error: "The host could not load the catalog. Check the saved revision and try again.",
  invalid_catalog: "The selected catalog could not be validated.",
  limit_exceeded: "The catalog exceeds the supported size limits.",
  host_io_error: "The host could not read the catalog. Try again.",
};
const recommendationErrors: Record<RecommendationErrorCode, string> = {
  catalog_unavailable: "The catalog became unavailable. Check the saved revision and try again.",
  catalog_revision_mismatch: "The catalog revision changed. Run Scan & Recommend again.",
  catalog_settings_changed: "The saved catalog settings changed. Run Scan & Recommend again.",
  scan_failed: "The host could not scan this project. Check the target and try again.",
  target_changed: "The target changed on the host. Select and validate the directory again.",
  invalid_evidence: "The scan returned data that could not be verified.",
  limit_exceeded: "The scan or recommendation exceeded the supported limits.",
  busy: "The host is finishing another request. Wait a moment and try again.",
};
const invalidResult = "The recommendation result could not be verified. Try again.";

export function RecommendationRun({
  theme,
  hostId,
  directory,
  generation,
  settings,
  providers,
  providerGeneration = 0,
  catalogBusy = false,
}: {
  theme: PluginTheme;
  hostId: string;
  directory: string | null;
  generation: number;
  settings: CatalogSettingsState;
  providers: readonly ProviderId[];
  providerGeneration?: number;
  catalogBusy?: boolean;
}) {
  const loadCatalog = useRpc(catalogLoadRpc);
  const resolveCatalog = useRpc(catalogResolveRpc);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const sequence = useRef(0);
  const active = useRef<Attempt | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [selectionGeneration, setSelectionGeneration] = useState(0);
  const revision = settings.status === "ready" ? settings.revision : null;
  const ref = settings.status === "ready" ? settings.values.catalogRef : "";
  const selectedTag = settings.status === "ready" ? settings.values.selectedTag : undefined;
  const isPinnedSha = commitShaSchema.safeParse(ref.toLowerCase()).success;
  const isUnconfigured = settings.status === "ready" && ref === "";
  const isLegacyTag = settings.status === "ready" && ref !== "" && !isPinnedSha;
  const scope = JSON.stringify([hostId, generation, directory, revision, ref]);
  const visible = run?.attempt.scope === scope ? run : null;
  const pending = visible?.phase === "loading" || visible?.phase === "scanning";

  useLayoutEffect(() => {
    const currentActive = active.current;
    // Allow the authorized P4 first-use transition ("" -> resolved pinned SHA) without cancelling the active Scan.
    if (
      currentActive &&
      currentActive.firstUsePinnedSha &&
      currentActive.directory === directory &&
      ref.toLowerCase() === currentActive.firstUsePinnedSha &&
      revision !== null &&
      revision !== currentActive.firstUseInitialRevision
    ) {
      currentActive.revision = revision;
      currentActive.ref = ref;
      currentActive.scope = scope;
      setRun((previous) => previous && previous.attempt === currentActive
        ? { ...previous, attempt: currentActive } : previous);
      return;
    }

    setRun((previous) => {
      if (!previous || previous.attempt.scope === scope) return previous;
      if (!directory || !ref || previous.attempt.directory !== directory) return null;
      return { phase: "stale", attempt: { ...previous.attempt, scope },
        message: "The previous result is out of date. Run Scan & Recommend again." };
    });
    return () => {
      // Do not clear active if this cleanup is caused only by an authorized P4 first-use settings transition.
      if (!active.current?.firstUsePinnedSha) active.current = null;
    };
  }, [scope, directory, ref, revision]);

  // Always release active attempt on unmount.
  useEffect(() => () => { active.current = null; }, []);

  async function start() {
    if (!directory || !revision || settings.saving || catalogBusy || active.current) return;
    if (!isPinnedSha && !isUnconfigured) return;

    const attempt: Attempt = { scope, requestId: `scan-${id}-${++sequence.current}`, directory, revision, ref };
    active.current = attempt;
    setRun({ phase: "loading", attempt });

    try {
      let expectedRevision = attempt.revision;
      let expectedRef = attempt.ref;

      // P4: For an unconfigured host, resolve, validate, and pin Latest Stable as part of initial Scan.
      if (isUnconfigured && settings.status === "ready") {
        attempt.firstUseInitialRevision = attempt.revision;
        const rawResolved = await resolveCatalog({ mode: "latest_stable" });
        if (active.current !== attempt) return;
        const parsedResolved = catalogResolveResultSchema.safeParse(rawResolved);
        if (!parsedResolved.success) {
          return finish(attempt, "error", "Could not resolve the latest stable catalog on this host. Try again.");
        }
        if (parsedResolved.data.status === "error") {
          return finish(attempt, "error", catalogErrors[parsedResolved.data.code]);
        }
        attempt.firstUsePinnedSha = parsedResolved.data.commitSha;
        const saved = await settings.save(
          {
            catalogRef: parsedResolved.data.commitSha,
            selectionMode: "latest_stable",
            ...(parsedResolved.data.resolvedTag ? { selectedTag: parsedResolved.data.resolvedTag } : {}),
          },
          attempt.revision,
        );
        if (active.current !== attempt) return;
        if (!saved) {
          attempt.firstUsePinnedSha = undefined;
          return finish(attempt, "stale", recommendationErrors.catalog_settings_changed);
        }
        expectedRef = parsedResolved.data.commitSha;
      }

      const reply = await loadCatalog({});
      if (active.current !== attempt) return;
      if (reply.status === "error") return finish(attempt, "error", catalogErrors[reply.code]);

      if (attempt.firstUsePinnedSha) {
        if (
          reply.requestedRef.toLowerCase() !== attempt.firstUsePinnedSha ||
          reply.snapshot.commitSha !== attempt.firstUsePinnedSha ||
          reply.settingsRevision === attempt.firstUseInitialRevision
        ) {
          return finish(attempt, "stale", recommendationErrors.catalog_settings_changed);
        }
        attempt.revision = reply.settingsRevision;
        attempt.ref = reply.requestedRef;
        attempt.scope = JSON.stringify([hostId, generation, directory, reply.settingsRevision, reply.requestedRef]);
        attempt.firstUsePinnedSha = undefined;
      } else if (reply.settingsRevision !== expectedRevision || reply.requestedRef !== expectedRef) {
        return finish(attempt, "stale", recommendationErrors.catalog_settings_changed);
      }

      setRun({ phase: "scanning", attempt, catalog: reply.snapshot });
    } catch {
      finish(attempt, "error", "Could not load the catalog from this host. Try again.");
    }
  }

  function finish(attempt: Attempt, phase: "error" | "stale", message: string) {
    if (active.current !== attempt) return;
    attempt.firstUsePinnedSha = undefined;
    active.current = null;
    setRun({ phase, attempt, message });
  }

  function accept(current: Extract<Run, { phase: "scanning" }>, event: RecommendationEvent) {
    const { attempt, catalog } = current;
    if (active.current !== attempt || attempt.scope !== scope) return;
    if (event.status === "error") {
      if (event.requestId !== attempt.requestId) return;
      const changed = event.code === "catalog_revision_mismatch" || event.code === "catalog_settings_changed";
      return finish(attempt, changed ? "stale" : "error", recommendationErrors[event.code]);
    }
    const { result } = event;
    if (result.requestId !== attempt.requestId) return;
    if (result.target.canonicalDirectory !== attempt.directory || result.catalog.commitSha !== catalog.commitSha ||
        result.catalog.source !== catalog.source || result.catalog.settingsRevision !== attempt.revision ||
        !validItems(event, catalog)) return finish(attempt, "error", invalidResult);
    active.current = null;
    setRun({ phase: "complete", attempt, catalog, event, selected: [] });
  }

  const completed = visible?.phase === "complete" ? visible : null;
  const intent = completed && selectionIntentV1Schema.parse({
    schemaVersion: 1,
    hostId,
    canonicalDirectory: completed.attempt.directory,
    catalogSource: completed.catalog.source,
    catalogCommitSha: completed.catalog.commitSha,
    settingsRevision: completed.attempt.revision,
    selectedSkillIds: completed.selected,
    targetProviderIds: [...providers].sort(),
    recommendationRequestId: completed.attempt.requestId,
  });

  function select(update: (previous: string[]) => string[]) {
    setSelectionGeneration((value) => value + 1);
    setRun((current) => current?.phase === "complete" && current.attempt === completed?.attempt
      ? { ...current, selected: update(current.selected).sort() } : current);
  }

  const canScan = Boolean(directory && revision && (isPinnedSha || isUnconfigured) && !settings.saving && !catalogBusy);
  const previewDisabled = Boolean(settings.saving || catalogBusy);

  return (
    <>
      <Section theme={theme} title="Scan & Recommend">
        <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
          {!directory && <Detail theme={theme}>Choose a valid project directory to scan.</Detail>}
          {directory && isUnconfigured && (
            <Detail theme={theme}>No catalog revision pinned yet. Scan & Recommend will resolve and pin Latest Stable automatically.</Detail>
          )}
          {directory && isLegacyTag && (
            <Detail theme={theme} error>Resolve and pin the saved legacy tag to an immutable commit SHA before scanning.</Detail>
          )}
          {directory && settings.status !== "ready" && <Detail theme={theme}>Waiting for valid host catalog settings.</Detail>}
          {visible?.phase === "loading" && (
            <Detail theme={theme}>
              {isUnconfigured ? "Resolving and pinning latest stable catalog…" : "Loading skill catalog…"}
            </Detail>
          )}
          {visible?.phase === "scanning" && <Detail theme={theme}>Scanning project and evaluating skills…</Detail>}
          {visible?.phase === "cancelled" && <Detail theme={theme}>Scan cancelled.</Detail>}
          {(visible?.phase === "error" || visible?.phase === "stale") && <Detail theme={theme} error>{visible.message}</Detail>}
          {(visible?.phase === "scanning" || completed) && (
            <Text selectable style={{ color: theme.colors.foregroundMuted }}>
              {selectedTag
                ? `Pinned catalog: ${selectedTag} (${(visible?.phase === "scanning" ? visible : completed)?.catalog.commitSha})`
                : `Pinned catalog: ${(visible?.phase === "scanning" ? visible : completed)?.catalog.commitSha}`}
            </Text>
          )}
        </View>
        {pending ? <Action theme={theme} label="Cancel" onPress={() => {
          if (!active.current) return;
          const attempt = active.current;
          attempt.firstUsePinnedSha = undefined;
          active.current = null;
          setRun({ phase: "cancelled", attempt });
        }} /> : <Action theme={theme} primary label="Scan & Recommend" disabled={!canScan}
          onPress={() => void start()} />}
      </Section>
      {visible?.phase === "scanning" && <RecommendationSubscription key={visible.attempt.requestId}
        input={{ requestId: visible.attempt.requestId, canonicalDirectory: visible.attempt.directory,
          expectedCatalogSha: visible.catalog.commitSha, expectedSettingsRevision: visible.attempt.revision }}
        onEvent={(event) => accept(visible, event)}
        onFailure={() => finish(visible.attempt, "error", "The recommendation connection closed before a result arrived. Try again.")} />}
      {completed && intent && <RecommendationResults key={intent.recommendationRequestId} theme={theme}
        result={completed.event.result} partial={completed.event.status === "partial"} catalog={completed.catalog}
        selected={intent.selectedSkillIds}
        onToggle={(id) => select((previous) => previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id])}
        onSelectRecommended={() => select((previous) => [...new Set([
          ...previous, ...completed.event.result.items.filter(({ applicability }) => applicability === "recommended").map(({ skillId }) => skillId),
        ])])}
        onClear={() => select(() => [])} />}
      {completed && intent && <PreviewRun key={"preview-" + intent.recommendationRequestId} theme={theme} intent={intent}
        generation={JSON.stringify([scope, selectionGeneration, providerGeneration, previewDisabled])}
        disabled={previewDisabled} />}
    </>
  );
}

function validItems(event: TerminalResult, catalog: CatalogSnapshotDescriptor) {
  const ids = new Set(catalog.skills.map(({ id }) => id));
  return event.result.items.every(({ skillId, applicability }) => applicability !== "not_applicable" && ids.delete(skillId)) &&
    ids.size === 0;
}

function RecommendationSubscription({ input, onEvent, onFailure }: {
  input: RecommendationInput;
  onEvent: (event: RecommendationEvent) => void;
  onFailure: () => void;
}) {
  const subscription = useSubscription(recommendationEvaluateSubscription, input, onEvent);
  useEffect(() => {
    if (subscription.status === "closed" || subscription.status === "error") onFailure();
  }, [subscription.status, onFailure]);
  return null;
}
