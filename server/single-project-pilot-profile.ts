import type { CatalogLoader } from "./catalog-loader";
import type { createSingleProjectApply } from "./fixture-apply";

export type SingleProjectPilotProfile = {
  daemonHome: string;
  cli: string;
  sdkVersions: readonly string[];
  catalog?: Pick<CatalogLoader, "load">;
  test?: Parameters<typeof createSingleProjectApply>[0]["test"];
  trace?: (method: "apply" | "status", operationId: string) => void;
  afterStatus?: (operationId: string, phase: string) => Promise<void>;
};

// Filled only in the staged directory. The source checkout has no writable profile.
export const pilotProfile: SingleProjectPilotProfile | undefined = undefined;
