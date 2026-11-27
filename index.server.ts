import type { PluginServerContext } from "@getpaseo/plugin/server";
import { catalogSettings } from "./shared/catalog-settings";
import { canonicalPreviewRpc, providerPreviewRpc, providerPreviewV2Rpc, catalogLoadRpc, foundationStatusRpc, recommendationEvaluateSubscription, targetScanSubscription, validateDirectoryRpc } from "./shared/rpc";
import { CatalogLoader } from "./server/catalog-loader";
import { loadCatalogForHost } from "./server/catalog-rpc";
import { ProjectScanner } from "./server/project-scanner";
import { createRecommendationHandler } from "./server/recommendation-rpc";
import { validateDirectory } from "./server/validate-directory";
import { createCanonicalPreviewHandler } from "./server/canonical-preview";

export default function contribute(server: PluginServerContext) {
  server.handle(foundationStatusRpc, () => ({ status: "ready" as const }));
  server.handle(validateDirectoryRpc, validateDirectory);

  const settings = server.registerSettings(catalogSettings);
  const loader = new CatalogLoader();
  server.handle(catalogLoadRpc, () => loadCatalogForHost(settings, loader));

  const scanner = new ProjectScanner();
  server.handle(targetScanSubscription, async (input, { signal, push }) => {
    const result = await scanner.scan(input, signal);
    if (result && !signal.aborted) await push(targetScanSubscription.event.parse(result));
  });

  server.handle(recommendationEvaluateSubscription, createRecommendationHandler(settings, loader, scanner));
  const preview = createCanonicalPreviewHandler(settings, loader);
  server.handle(canonicalPreviewRpc, preview.handle);
  server.handle(providerPreviewRpc, preview.handleProviders);
  server.handle(providerPreviewV2Rpc, preview.handleProvidersV2);

  return async () => { await Promise.all([preview.dispose(), loader.dispose(), scanner.dispose()]); };
}
