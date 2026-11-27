import { z } from "zod";
import { skillSlugSchema } from "./catalog";
import { relativePath } from "./project-evidence";
import { selectionIntentV1Schema } from "./selection-intent";
import { agentProviderSchema } from "./agent-capability";

const fingerprint = z.strictObject({
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.number().int().min(0).max(0o7777),
});
export const previewEntrySchema = z.strictObject({
  skillId: skillSlugSchema,
  destination: relativePath,
  status: z.enum(["create", "unchanged", "conflict", "blocked"]),
  proposed: fingerprint,
  existing: fingerprint.optional(),
  reason: z.enum(["unsafe_entry", "unreadable", "entry_changed", "read_limit", "diff_limit"]).optional(),
  change: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text"), unifiedDiff: z.string() }),
    z.strictObject({ kind: z.literal("binary") }),
  ]).optional(),
});
export const previewResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    intent: selectionIntentV1Schema,
    entries: z.array(previewEntrySchema),
  }),
  z.strictObject({
    status: z.literal("error"),
    code: z.enum([
      "invalid_selection", "host_mismatch", "settings_changed", "catalog_mismatch", "catalog_unavailable",
      "invalid_catalog", "invalid_target", "target_changed", "limit_exceeded", "busy", "cancelled", "host_io_error",
    ]),
  }),
]);
export type PreviewEntry = z.infer<typeof previewEntrySchema>;
export type PreviewResult = z.infer<typeof previewResultSchema>;
export type PreviewErrorCode = Extract<PreviewResult, { status: "error" }>["code"];

// Separate endpoint: the strict M3.2 response above stays unchanged.
export const derivedPreviewEntrySchema = previewEntrySchema.extend({
  providerId: z.literal("kiro"),
  canonicalDestination: relativePath,
});
export const previewDiagnosticSchema = z.strictObject({
  code: z.enum(["kiro_root_unconfirmed", "canonical_conflict", "canonical_blocked", "duplicate_skill_id", "inventory_unverified"]),
  providerId: agentProviderSchema.optional(),
  skillId: skillSlugSchema.optional(),
  basis: z.literal("directory_id").optional(),
  paths: z.array(relativePath),
});
export const providerPreviewStatusSchema = z.strictObject({
  providerId: agentProviderSchema,
  strategy: z.enum(["canonical_only", "kiro_derived"]),
  status: z.enum(["canonical_only", "ready", "partial", "deferred", "limited"]),
  rootStatus: z.enum(["git_root", "gitfile_root", "unconfirmed"]).optional(),
  verification: z.strictObject({
    basis: z.literal("historical_m3_1"),
    report: z.literal("M3.1-completion-report.md"),
    paseoVersion: z.literal("0.17.5"),
    binaryVersion: z.string(),
    transport: z.string(),
    loadMode: z.string(),
    cwdScope: z.enum(["root_and_nested", "git_root"]),
    note: z.string(),
  }),
  skills: z.array(z.strictObject({
    skillId: skillSlugSchema,
    status: z.enum(["planned", "deferred"]),
    reason: z.enum(["canonical_conflict", "canonical_blocked", "kiro_root_unconfirmed"]).optional(),
  })),
});
export const providerPreviewResultSchema = z.discriminatedUnion("status", [
  previewResultSchema.options[0].extend({
    providers: z.array(providerPreviewStatusSchema),
    derivedEntries: z.array(derivedPreviewEntrySchema),
    diagnostics: z.array(previewDiagnosticSchema),
  }),
  previewResultSchema.options[1],
]);
export type DerivedPreviewEntry = z.infer<typeof derivedPreviewEntrySchema>;
export type PreviewDiagnostic = z.infer<typeof previewDiagnosticSchema>;
export type ProviderPreviewStatus = z.infer<typeof providerPreviewStatusSchema>;
export type ProviderPreviewResult = z.infer<typeof providerPreviewResultSchema>;
