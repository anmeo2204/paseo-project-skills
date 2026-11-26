import type { PluginServerContext } from "@getpaseo/plugin/server";
import { catalogSettings } from "./shared/catalog-settings";
import { catalogLoadRpc, foundationStatusRpc, validateDirectoryRpc } from "./shared/rpc";
import { CatalogLoader } from "./server/catalog-loader";
import { loadCatalogForHost } from "./server/catalog-rpc";
import { validateDirectory } from "./server/validate-directory";

export default function contribute(server: PluginServerContext) {
  server.handle(foundationStatusRpc, () => ({ status: "ready" as const }));
  server.handle(validateDirectoryRpc, validateDirectory);

  const settings = server.registerSettings(catalogSettings);
  const loader = new CatalogLoader();
  server.handle(catalogLoadRpc, () => loadCatalogForHost(settings, loader));

  return () => loader.dispose();
}
