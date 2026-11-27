import type { CatalogLoader } from "./catalog-loader";
import type { createFixtureApply } from "./fixture-apply";

export type LocalProfile = {
  base: string;
  targetRoot: string;
  cli: string;
  sdkVersions: readonly string[];
  catalog?: Pick<CatalogLoader, "load">;
  test?: Parameters<typeof createFixtureApply>[0]["test"];
  trace?: (method: "apply" | "status", operationId: string) => void;
  afterStatus?: (operationId: string, phase: string) => Promise<void>;
};

// Filled only in the staged directory. The source checkout has no writable profile.
export const profile: LocalProfile | undefined = undefined;
