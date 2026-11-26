import type { CatalogDiagnostic, CatalogErrorCode } from "../shared/catalog";

export class CatalogError extends Error {
  constructor(readonly code: CatalogErrorCode, readonly diagnostics?: CatalogDiagnostic[]) {
    super(code);
  }
}
