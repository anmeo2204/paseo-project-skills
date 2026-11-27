import { z } from "zod";
import { commitShaSchema, skillSlugSchema } from "./catalog";
import { catalogSource } from "./catalog-settings";
import { evidenceRef, projectEvidenceSchema, projectInventory, projectWarning, relativePath } from "./project-evidence";

const metadataDiagnostic = z.enum(["missing_applicability", "invalid_applicability", "unsupported_rule_version"]);
const verdict = z.enum(["recommended", "optional"]);
const reasonRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("project_evidence"), evidenceId: z.string() }),
  z.strictObject({ kind: z.literal("catalog_file"), path: relativePath, blobSha: commitShaSchema }),
  z.strictObject({ kind: z.literal("scan_coverage") }),
]);
const reason = z.strictObject({
  code: z.enum([
    ...metadataDiagnostic.options, "reusable_workflow", "strong_project_match", "project_match",
    "additional_evidence_unobserved", "partial_evidence", "no_supported_evidence",
  ]),
  refs: z.array(reasonRef),
});
const item = z.strictObject({
  skillId: skillSlugSchema,
  applicability: z.enum([...verdict.options, "unknown", "not_applicable"]),
  taskApplicability: z.literal("not_assessed"),
  reasons: z.array(reason),
  matches: z.array(z.strictObject({
    boundaryPath: relativePath,
    verdict,
    reasons: z.array(reason),
  })),
  inventory: z.strictObject({
    state: z.enum(["present", "multiple_occurrences", "not_observed", "unknown"]),
    occurrences: z.array(projectInventory.extend({
      match: z.enum(["confirmed", "candidate"]),
      flags: z.array(z.enum(["metadata_mismatch", "malformed", "unreadable", "possible_customization"])),
    })),
  }),
});

export const recommendationInput = z.strictObject({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/),
  canonicalDirectory: z.string().min(1).max(4096),
  expectedCatalogSha: commitShaSchema.optional(),
  expectedSettingsRevision: z.string().min(1).max(1024).optional(),
});
const result = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.string(),
  target: projectEvidenceSchema.shape.target.pick({ canonicalDirectory: true }),
  catalog: z.strictObject({
    source: z.literal(catalogSource), commitSha: commitShaSchema, settingsRevision: z.string(),
  }),
  scanCoverage: projectEvidenceSchema.shape.coverage,
  warnings: z.array(projectWarning),
  metadataCoverage: z.strictObject({
    valid: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
  diagnostics: z.array(z.strictObject({ skillId: skillSlugSchema, code: metadataDiagnostic })),
  items: z.array(item),
  evidence: z.array(evidenceRef),
});
const errorCode = z.enum([
  "catalog_unavailable", "catalog_revision_mismatch", "catalog_settings_changed", "scan_failed",
  "target_changed", "invalid_evidence", "limit_exceeded", "busy",
]);

export const recommendationEvent = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), result }),
  z.strictObject({ status: z.literal("partial"), result }),
  z.strictObject({ status: z.literal("error"), requestId: z.string(), code: errorCode }),
]);

export type RecommendationInput = z.infer<typeof recommendationInput>;
export type RecommendationEvent = z.infer<typeof recommendationEvent>;
export type RecommendationErrorCode = z.infer<typeof errorCode>;
export type RecommendationItem = z.infer<typeof item>;
export type RecommendationReason = z.infer<typeof reason>;
export type MetadataDiagnostic = z.infer<typeof metadataDiagnostic>;
