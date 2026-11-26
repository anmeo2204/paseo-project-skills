import type { PluginServerContext } from "@getpaseo/plugin/server";
import { catalogSettings } from "./shared/catalog-settings";
import { foundationStatusRpc, validateDirectoryRpc } from "./shared/rpc";
import { validateDirectory } from "./server/validate-directory";

export default function contribute(server: PluginServerContext) {
  server.handle(foundationStatusRpc, () => ({ status: "ready" as const }));

  server.handle(validateDirectoryRpc, validateDirectory);
  server.registerSettings(catalogSettings);

  // Paseo releases RPC handlers with the subprocess. This entry owns no other resources.
  return () => {};
}
