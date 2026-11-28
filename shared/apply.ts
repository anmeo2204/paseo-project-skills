import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { relativePath } from "./project-evidence";
import { viewNonceSchema } from "./preview-receipt";

export const operationIdSchema = z.string().regex(/^[a-f0-9]{32,64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const applyCreateInputSchema = z.strictObject({
  previewId: digest, planDigest: digest, viewNonce: viewNonceSchema,
  operationId: operationIdSchema, approval: z.literal("create_only_v1"),
});
export const applyStatusInputSchema = z.strictObject({ operationId: operationIdSchema });

export const applyLedgerRowSchema = z.strictObject({
  destination: relativePath,
  kind: z.enum(["file", "directory"]),
  state: z.enum(["not_attempted", "unchanged_verified", "created_verified", "created_incomplete",
    "observation_changed", "ownership_unknown"]),
  bytesWritten: z.number().int().nonnegative().optional(),
  identity: z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).optional(),
  expected: z.strictObject({ sha256: digest, mode: z.union([z.literal(420), z.literal(493)]), sizeBytes: z.number().int().nonnegative() }).optional(),
  canonicalDestination: relativePath.optional(),
});
export const applyOperationSchema = z.strictObject({
  status: z.literal("operation"), operationId: operationIdSchema, planDigest: digest,
  phase: z.enum(["accepted", "preflight", "writing", "completed", "failed_before_write", "partial_failure", "recovery_required"]),
  code: z.string().min(1).max(64), targetMutated: z.union([z.boolean(), z.literal("unknown")]),
  requiresPreview: z.boolean(), durability: z.enum(["not_confirmed", "fsync_completed"]),
  ledger: z.array(applyLedgerRowSchema).max(3072),
});
export const applyOutputSchema = z.discriminatedUnion("status", [
  applyOperationSchema,
  z.strictObject({ status: z.literal("error"), code: z.enum([
    "busy", "cancelled", "invalid_request", "outcome_unknown", "operation_mismatch", "receipt_invalid",
    "receipt_consumed", "plan_not_applicable", "journal_unavailable", "journal_full", "unsupported_environment",
  ]) }),
]);
export type ApplyCreateInput = z.infer<typeof applyCreateInputSchema>;
export type ApplyOperation = z.infer<typeof applyOperationSchema>;
export type ApplyOutput = z.infer<typeof applyOutputSchema>;
export const applyListInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().regex(/^[01]:[0-9]{1,16}:[a-f0-9]{32,64}$/).optional(),
});
export const applyOperationSummarySchema = z.strictObject({
  operationId: operationIdSchema,
  planDigest: digest,
  phase: applyOperationSchema.shape.phase,
  code: z.string().min(1).max(64),
  targetMutated: applyOperationSchema.shape.targetMutated,
  requiresPreview: z.boolean(),
  durability: applyOperationSchema.shape.durability,
  ledgerCount: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export const applyListOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    items: z.array(applyOperationSummarySchema).max(50),
    nextCursor: z.string().regex(/^[01]:[0-9]{1,16}:[a-f0-9]{32,64}$/).optional(),
    unreadableCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("error"),
    code: z.enum(["busy", "invalid_request", "journal_unavailable", "unsupported_environment"]),
  }),
]);
export type ApplyListInput = z.infer<typeof applyListInputSchema>;
export type ApplyOperationSummary = z.infer<typeof applyOperationSummarySchema>;
export type ApplyListOutput = z.infer<typeof applyListOutputSchema>;

export const applyCreateRpc = defineRpc({ name: "apply.create.v1", input: applyCreateInputSchema, output: applyOutputSchema });
export const applyStatusRpc = defineRpc({ name: "apply.status.v1", input: applyStatusInputSchema, output: applyOutputSchema });
export const applyListRpc = defineRpc({ name: "apply.list.v1", input: applyListInputSchema, output: applyListOutputSchema });

export const localApplyCapabilityRpc = defineRpc({
  name: "apply.local-capability.v1", input: z.strictObject({}), output: z.strictObject({ enabled: z.boolean() }),
});

export const applyTargetStatusOutputSchema = z.strictObject({
  hostCompatible: z.boolean(),
  trustBoundaryOk: z.boolean(),
  reasons: z.array(z.string().min(1).max(64)).max(16),
  enrolledCount: z.number().int().nonnegative(),
  targetState: z.enum([
    "none",
    "enrolled_enabled",
    "enrolled_disabled",
    "not_enrolled",
    "root_identity_mismatch",
    "host_unavailable",
  ]),
  policyRevision: digest.optional(),
});
export type ApplyTargetStatusOutput = z.infer<typeof applyTargetStatusOutputSchema>;

export const applyTargetStatusRpc = defineRpc({
  name: "apply.target-status.v1",
  input: z.strictObject({ canonicalDirectory: z.string().min(1).max(4096).optional() }),
  output: applyTargetStatusOutputSchema,
});
