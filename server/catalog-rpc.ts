import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginSettings } from "@getpaseo/plugin/server";
import {
  catalogReleasesInputSchema,
  catalogReleasesResultSchema,
  catalogResolveInputSchema,
  catalogResolveResultSchema,
  commitShaSchema,
  type CatalogReleasesInput,
  type CatalogResolveInput,
} from "../shared/catalog";
import { catalogSource, type catalogSettings } from "../shared/catalog-settings";
import type { catalogLoadRpc, catalogReleasesRpc, catalogResolveRpc } from "../shared/rpc";
import { CatalogError } from "./catalog-error";
import { describeCatalog, type CatalogLoader } from "./catalog-loader";
import { catalogLimits } from "./catalog-limits";
import { classifyCatalogUpdates, type CatalogReleaseCache } from "./catalog-releases";

type SettingsHandle = Pick<PluginSettings<typeof catalogSettings.schema>, "read">;

export async function loadCatalogForHost(
  settings: SettingsHandle,
  loader: Pick<CatalogLoader, "load">,
): Promise<RpcOutput<typeof catalogLoadRpc>> {
  let settingsRevision: string | undefined;
  let requestedRef: string | undefined;
  try {
    const state = await settings.read();
    settingsRevision = state.revision;
    if (state.status !== "ready") return { status: "error", code: "invalid_settings", settingsRevision };
    const ref = state.values.catalogRef;
    if (Buffer.byteLength(ref) <= catalogLimits.refBytes) requestedRef = ref;
    const snapshot = describeCatalog(await loader.load(ref));
    return { status: "ready", settingsRevision, requestedRef: ref, snapshot };
  } catch (error) {
    const known = error instanceof CatalogError ? error : undefined;
    return {
      status: "error",
      code: known?.code ?? "host_io_error",
      ...(settingsRevision === undefined ? {} : { settingsRevision }),
      ...(requestedRef === undefined ? {} : { requestedRef }),
      ...(known?.diagnostics ? { diagnostics: known.diagnostics } : {}),
    };
  }
}

export async function listCatalogReleasesForHost(
  settings: SettingsHandle,
  releaseCache: Pick<CatalogReleaseCache, "get">,
  rawInput: CatalogReleasesInput = {},
): Promise<RpcOutput<typeof catalogReleasesRpc>> {
  const parsed = catalogReleasesInputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: "error", code: "invalid_revision" };
  let settingsRevision: string | undefined;
  try {
    const state = await settings.read();
    settingsRevision = state.revision;
    if (state.status !== "ready") return { status: "error", code: "invalid_settings", settingsRevision };
    const listed = await releaseCache.get({ refresh: parsed.data.refresh === true });
    const classified = classifyCatalogUpdates(listed.tags, listed.stableReleases, state.values);
    return catalogReleasesResultSchema.parse({
      status: "ready",
      source: catalogSource,
      settingsRevision,
      ...classified,
      checkedAt: listed.checkedAt,
      cached: listed.cached,
    });
  } catch (error) {
    const known = error instanceof CatalogError ? error : undefined;
    return {
      status: "error",
      code: known?.code ?? "host_io_error",
      ...(settingsRevision === undefined ? {} : { settingsRevision }),
    };
  }
}

export async function resolveCatalogForHost(
  loader: Pick<CatalogLoader, "load">,
  releaseCache: Pick<CatalogReleaseCache, "get">,
  rawInput: CatalogResolveInput,
): Promise<RpcOutput<typeof catalogResolveRpc>> {
  const parsed = catalogResolveInputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: "error", code: "invalid_revision" };
  const input = parsed.data;
  try {
    if (input.mode === "latest_stable") {
      const listed = await releaseCache.get({ refresh: true, bypassCooldown: true });
      const latest = listed.stableReleases[0];
      if (!latest) return { status: "error", code: "no_stable_releases" };
      if (
        (input.expectedTag !== undefined && latest.tag !== input.expectedTag) ||
        (input.expectedCommitSha !== undefined && latest.commitSha !== input.expectedCommitSha)
      ) {
        return { status: "error", code: "stale_selection" };
      }
      const snapshot = await loader.load(latest.tag);
      if (
        snapshot.commitSha !== latest.commitSha ||
        (input.expectedCommitSha !== undefined && snapshot.commitSha !== input.expectedCommitSha)
      ) {
        return { status: "error", code: "stale_selection" };
      }
      return catalogResolveResultSchema.parse({
        status: "ready",
        source: snapshot.source,
        mode: "latest_stable",
        requestedRef: latest.tag,
        resolvedTag: latest.tag,
        commitSha: snapshot.commitSha,
        skillCount: snapshot.skills.length,
      });
    }

    if (input.mode === "specific_version") {
      const snapshot = await loader.load(input.tag);
      if (snapshot.commitSha !== input.expectedCommitSha) {
        return { status: "error", code: "stale_selection" };
      }
      return catalogResolveResultSchema.parse({
        status: "ready",
        source: snapshot.source,
        mode: "specific_version",
        requestedRef: input.tag,
        resolvedTag: input.tag,
        commitSha: snapshot.commitSha,
        skillCount: snapshot.skills.length,
      });
    }

    const snapshot = await loader.load(input.ref);
    const isSha = commitShaSchema.safeParse(input.ref.toLowerCase()).success;
    return catalogResolveResultSchema.parse({
      status: "ready",
      source: snapshot.source,
      mode: "custom",
      requestedRef: input.ref,
      ...(isSha ? {} : { resolvedTag: input.ref }),
      commitSha: snapshot.commitSha,
      skillCount: snapshot.skills.length,
    });
  } catch (error) {
    const known = error instanceof CatalogError ? error : undefined;
    return {
      status: "error",
      code: known?.code ?? "host_io_error",
      ...(known?.diagnostics ? { diagnostics: known.diagnostics } : {}),
    };
  }
}
