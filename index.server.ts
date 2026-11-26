import type { PluginServerContext } from "@getpaseo/plugin/server";
import { catalogSettings } from "./shared/catalog-settings";
import { catalogLoadRpc, foundationStatusRpc, targetScanSubscription, validateDirectoryRpc } from "./shared/rpc";
import { CatalogLoader } from "./server/catalog-loader";
import { loadCatalogForHost } from "./server/catalog-rpc";
import { ProjectScanner } from "./server/project-scanner";
import { validateDirectory } from "./server/validate-directory";

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

  return async () => { await Promise.all([loader.dispose(), scanner.dispose()]); };
}
