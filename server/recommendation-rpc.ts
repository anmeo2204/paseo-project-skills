import type { PluginSettings } from "@getpaseo/plugin/server";
import type { catalogSettings } from "../shared/catalog-settings";
import type { RecommendationErrorCode, RecommendationEvent, RecommendationInput } from "../shared/recommendation";
import { CatalogError } from "./catalog-error";
import type { CatalogLoader } from "./catalog-loader";
import type { ProjectScanner } from "./project-scanner";
import { evaluateRecommendation } from "./recommendation-engine";

export function createRecommendationHandler(
  settings: Pick<PluginSettings<typeof catalogSettings.schema>, "read">,
  loader: Pick<CatalogLoader, "load">,
  scanner: Pick<ProjectScanner, "scan">,
) {
  let active = false;
  return async (input: RecommendationInput, context: {
    signal: AbortSignal;
    push: (event: RecommendationEvent) => unknown;
  }) => {
    const { signal, push } = context;
    const error = (code: RecommendationErrorCode): RecommendationEvent => ({ status: "error", requestId: input.requestId, code });
    const publish = async (event: RecommendationEvent) => {
      if (!signal.aborted) await push(event);
    };
    if (signal.aborted) return;
    if (active) return publish(error("busy"));
    active = true;
    const resolve = async (): Promise<RecommendationEvent | undefined> => {
      let result: RecommendationEvent;
      let failure: RecommendationErrorCode = "catalog_unavailable";
      try {
        const state = await settings.read();
        if (signal.aborted) return;
        if (input.expectedSettingsRevision !== undefined && state.revision !== input.expectedSettingsRevision) {
          return error("catalog_settings_changed");
        }
        if (state.status !== "ready") return error("catalog_unavailable");

        const snapshot = await loader.load(state.values.catalogRef);
        if (signal.aborted) return;
        if (input.expectedCatalogSha !== undefined && snapshot.commitSha !== input.expectedCatalogSha) {
          return error("catalog_revision_mismatch");
        }

        failure = "scan_failed";
        const scan = await scanner.scan(input, signal);
        if (signal.aborted) return;
        if (!scan || scan.status === "error") {
          result = error(scan?.code === "target_changed" || scan?.code === "busy" ? scan.code : "scan_failed");
        } else {
          failure = "invalid_evidence";
          result = evaluateRecommendation(input, snapshot, scan.evidence, state.revision);
        }
        if (signal.aborted) return;
        failure = "catalog_settings_changed";
        const latest = await settings.read();
        if (latest.status !== "ready" || latest.revision !== state.revision) result = error(failure);
      } catch (cause) {
        result = error(cause instanceof CatalogError && cause.code === "limit_exceeded" ? "limit_exceeded" : failure);
      }
      return result;
    };
    try {
      const result = await resolve();
      if (result) await publish(result);
    } finally {
      active = false;
    }
  };
}
