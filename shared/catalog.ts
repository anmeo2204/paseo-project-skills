import { z } from "zod";
import {
  catalogRefSchema,
  catalogSelectionModeSchema,
  catalogSource,
  stableSemverTagSchema,
} from "./catalog-settings";

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
  "no_stable_releases", "stale_selection",
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

export const catalogReleaseRelationSchema = z.enum([
  "active", "newer", "older", "same_commit", "uncompared",
]);

export const catalogReleaseSchema = z.strictObject({
  tag: stableSemverTagSchema,
  commitSha: commitShaSchema,
  relation: catalogReleaseRelationSchema,
});

export const catalogUpdateStatusSchema = z.enum([
  "no_stable_releases",
  "unconfigured",
  "up_to_date",
  "update_available",
  "newer_than_latest",
  "moved_tag",
  "custom_revision",
  "legacy_unpinned",
]);

export const catalogMovedTagSchema = z.strictObject({
  tag: catalogRefSchema,
  pinnedCommitSha: commitShaSchema,
  remoteCommitSha: commitShaSchema.nullable(),
});

export const catalogActiveStateSchema = z.strictObject({
  catalogRef: catalogRefSchema,
  selectionMode: catalogSelectionModeSchema.optional(),
  selectedTag: catalogRefSchema.optional(),
  isPinnedSha: z.boolean(),
});

export const catalogReleasesInputSchema = z.strictObject({
  refresh: z.boolean().optional(),
});

export const catalogReleasesResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    source: z.literal(catalogSource),
    settingsRevision: z.string(),
    active: catalogActiveStateSchema,
    releases: z.array(catalogReleaseSchema).max(100),
    latestStable: z.strictObject({
      tag: stableSemverTagSchema,
      commitSha: commitShaSchema,
    }).nullable(),
    updateStatus: catalogUpdateStatusSchema,
    updateAvailable: z.boolean(),
    movedTag: catalogMovedTagSchema.optional(),
    checkedAt: z.number().int().nonnegative(),
    cached: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("error"),
    code: catalogErrorCodeSchema,
    settingsRevision: z.string().optional(),
  }),
]);

export const catalogResolveInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("latest_stable"),
    expectedTag: stableSemverTagSchema.optional(),
    expectedCommitSha: commitShaSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal("specific_version"),
    tag: stableSemverTagSchema,
    expectedCommitSha: commitShaSchema,
  }),
  z.strictObject({
    mode: z.literal("custom"),
    ref: catalogRefSchema.refine((value) => value.length > 0, "Enter a tag name or a full 40-character commit SHA."),
  }),
]);

export const catalogResolveResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    source: z.literal(catalogSource),
    mode: catalogSelectionModeSchema,
    requestedRef: z.string(),
    resolvedTag: catalogRefSchema.optional(),
    commitSha: commitShaSchema,
    skillCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("error"),
    code: catalogErrorCodeSchema,
    diagnostics: z.array(catalogDiagnosticSchema).optional(),
  }),
]);

export type CatalogDescriptor = z.infer<typeof fileSchema>;
export type CatalogSnapshotDescriptor = z.infer<typeof catalogSnapshotSchema>;
export type CatalogDiagnostic = z.infer<typeof catalogDiagnosticSchema>;
export type CatalogErrorCode = z.infer<typeof catalogErrorCodeSchema>;
export type CatalogReleaseRelation = z.infer<typeof catalogReleaseRelationSchema>;
export type CatalogRelease = z.infer<typeof catalogReleaseSchema>;
export type CatalogUpdateStatus = z.infer<typeof catalogUpdateStatusSchema>;
export type CatalogMovedTag = z.infer<typeof catalogMovedTagSchema>;
export type CatalogActiveState = z.infer<typeof catalogActiveStateSchema>;
export type CatalogReleasesInput = z.infer<typeof catalogReleasesInputSchema>;
export type CatalogReleasesResult = z.infer<typeof catalogReleasesResultSchema>;
export type CatalogResolveInput = z.infer<typeof catalogResolveInputSchema>;
export type CatalogResolveResult = z.infer<typeof catalogResolveResultSchema>;
