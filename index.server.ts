import type { PluginServerContext } from "@getpaseo/plugin/server";
import { foundationStatusRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(foundationStatusRpc, () => ({ status: "ready" as const }));

  // Paseo releases the handler with the subprocess. This entry owns no other resources.
  return () => {};
}
