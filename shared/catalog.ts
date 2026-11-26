import { z } from "zod";
import { catalogSource } from "./catalog-settings";

export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const skillSlugSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const skillMetadataSchema = z.object({
  name: skillSlugSchema,
  description: z.string().max(1024).refine((value) => value.trim().length > 0),
});

const fileSchema = z.object({
  path: z.string(),
  blobSha: commitShaSchema,
  sizeBytes: z.number().int().nonnegative(),
  mode: z.enum(["100644", "100755"]),
});

const skillSchema = z.object({
  id: skillSlugSchema,
  directory: z.string(),
  metadata: skillMetadataSchema,
  entrypoint: fileSchema,
  supportingFiles: z.array(fileSchema),
});

export const catalogSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal(catalogSource),
  commitSha: commitShaSchema,
  skills: z.array(skillSchema),
});

export const catalogErrorCodeSchema = z.enum([
  "not_configured", "invalid_settings", "invalid_revision", "revision_unavailable",
  "git_unavailable", "auth_failed", "network_error", "timeout", "git_error",
  "invalid_catalog", "limit_exceeded", "host_io_error",
]);

export const catalogDiagnosticSchema = z.object({
  code: z.enum(["duplicate_skill_id", "malformed_metadata", "unsafe_entry", "missing_entrypoint", "invalid_tree"]),
  path: z.string().optional(),
});

export const catalogResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    settingsRevision: z.string(),
    requestedRef: z.string(),
    snapshot: catalogSnapshotSchema,
  }),
  z.object({
    status: z.literal("error"),
    code: catalogErrorCodeSchema,
    settingsRevision: z.string().optional(),
    requestedRef: z.string().optional(),
    diagnostics: z.array(catalogDiagnosticSchema).optional(),
  }),
]);

export type CatalogDescriptor = z.infer<typeof fileSchema>;
export type CatalogSnapshotDescriptor = z.infer<typeof catalogSnapshotSchema>;
export type CatalogDiagnostic = z.infer<typeof catalogDiagnosticSchema>;
export type CatalogErrorCode = z.infer<typeof catalogErrorCodeSchema>;
