import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { catalogSettings } from "../shared/catalog-settings";
import type { catalogLoadRpc } from "../shared/rpc";
import { CatalogError } from "./catalog-error";
import { describeCatalog, type CatalogLoader } from "./catalog-loader";
import { catalogLimits } from "./catalog-limits";

type SettingsHandle = PluginSettings<typeof catalogSettings.schema>;

export async function loadCatalogForHost(
  settings: SettingsHandle,
  loader: CatalogLoader,
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
