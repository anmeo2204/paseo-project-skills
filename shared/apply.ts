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
export const applyCreateRpc = defineRpc({ name: "apply.create.v1", input: applyCreateInputSchema, output: applyOutputSchema });
export const applyStatusRpc = defineRpc({ name: "apply.status.v1", input: applyStatusInputSchema, output: applyOutputSchema });
