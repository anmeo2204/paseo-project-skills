import { z } from "zod";
import { selectionIntentV1Schema } from "./selection-intent";
import { providerPreviewResultSchema } from "./preview";
import { catalogRefSchema } from "./catalog-settings";
import { relativePath } from "./project-evidence";

const token = z.string().regex(/^[a-f0-9]{64}$/);
export const viewNonceSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,96}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const signedDecimal = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const absolutePath = z.string().min(1).max(4096)
  .refine((path) => !path.includes("\0") && /^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(path));
export const receiptLimits = Object.freeze({
  ttlMs: 10 * 60 * 1000, receipts: 8, sourceBytes: 8 * 1024 * 1024,
  retainedSourceBytes: 32 * 1024 * 1024,
});
export const receiptPolicy = Object.freeze({
  manifestVersion: 1, plannerVersion: "m4.2-v1", adapterVersion: "m3.3-v1",
  writerPolicyVersion: "create-only-v1-unavailable", serializationVersion: "sorted-json-utf8-v1",
  observationVersion: "bigint-lstat-v1", ttlMs: receiptLimits.ttlMs,
  maxReceipts: receiptLimits.receipts, maxSourceBytes: receiptLimits.sourceBytes,
  maxRetainedSourceBytes: receiptLimits.retainedSourceBytes,
  callerBinding: "host-installation-instance-only", writeCapability: "unavailable_m4_2",
  previewBudgets: Object.freeze({ files: 2048, pathBytes: 1024, pathDepth: 32,
    fileBytes: 1024 * 1024, readBytes: 8 * 1024 * 1024, filesystemChecks: 32768,
    diffBytes: 128 * 1024, responseBytes: 1024 * 1024, deadlineMs: 8000 }),
} as const);
export const enrollmentBindingSchema = z.strictObject({
  policyRevision: token,
  canonicalRoot: absolutePath,
  volume: z.strictObject({
    fsid: z.tuple([signedDecimal, signedDecimal]),
    fstype: z.literal("apfs"),
    mountPoint: absolutePath,
    caseMode: z.literal("insensitive"),
  }),
  rootIdentity: z.strictObject({
    dev: decimal,
    ino: decimal,
    mode: decimal,
    uid: decimal,
    gid: decimal,
  }),
  ancestorsDigest: token,
});
export type EnrollmentBinding = z.infer<typeof enrollmentBindingSchema>;
const policySchema = z.strictObject({
  manifestVersion: z.literal(1), plannerVersion: z.literal(receiptPolicy.plannerVersion),
  adapterVersion: z.literal(receiptPolicy.adapterVersion), writerPolicyVersion: z.literal(receiptPolicy.writerPolicyVersion),
  serializationVersion: z.literal(receiptPolicy.serializationVersion), observationVersion: z.literal(receiptPolicy.observationVersion),
  ttlMs: z.literal(receiptLimits.ttlMs), maxReceipts: z.literal(receiptLimits.receipts),
  maxSourceBytes: z.literal(receiptLimits.sourceBytes), maxRetainedSourceBytes: z.literal(receiptLimits.retainedSourceBytes),
  callerBinding: z.literal(receiptPolicy.callerBinding), writeCapability: z.enum(["unavailable_m4_2", "fixture_m4_5", "single_project_v1", "multi_root_v1"]),
  enrollment: enrollmentBindingSchema.optional(),
  previewBudgets: z.strictObject({
    files: z.number().int().nonnegative().max(2048), pathBytes: z.number().int().nonnegative().max(1024),
    pathDepth: z.number().int().nonnegative().max(32), fileBytes: z.number().int().nonnegative().max(1024 * 1024),
    readBytes: z.number().int().nonnegative().max(8 * 1024 * 1024), filesystemChecks: z.number().int().nonnegative().max(32768),
    diffBytes: z.number().int().nonnegative().max(128 * 1024), responseBytes: z.number().int().nonnegative().max(1024 * 1024),
    deadlineMs: z.number().int().nonnegative().max(8000),
  }),
});
export const observationSchema = z.strictObject({
  scope: z.enum(["anchor", "target", "git_metadata"]), path: absolutePath,
  observation: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("absent") }),
    z.strictObject({ state: z.literal("unverified"), reason: z.enum(["unreadable", "unsafe_entry"]) }),
    z.strictObject({ state: z.literal("present"), kind: z.enum(["directory", "file", "unsafe"]),
      dev: decimal, ino: decimal, mode: decimal, uid: decimal, gid: decimal,
      // Directory membership timestamps/link counts are intentionally not versions.
      fileVersion: z.strictObject({ sizeBytes: decimal, nlink: decimal, mtimeNs: signedDecimal, ctimeNs: signedDecimal }).optional(),
    }),
  ]),
});
export const directoryEffectSchema = z.strictObject({
  destination: relativePath, status: z.literal("create"), mode: z.literal(0o755),
  absentAncestor: relativePath,
});
const sourceSchema = z.strictObject({
  destination: relativePath, canonicalDestination: relativePath, blobSha: z.string().regex(/^[a-f0-9]{40}$/),
  sizeBytes: z.number().int().nonnegative(), sha256: token, mode: z.union([z.literal(0o644), z.literal(0o755)]),
});
const gitProofSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_selected") }),
  z.strictObject({ status: z.literal("unconfirmed") }),
  z.strictObject({ status: z.literal("confirmed"), rootStatus: z.enum(["git_root", "gitfile_root"]),
    gitDirectory: absolutePath, commonDirectory: absolutePath, markerSha256: token.optional() }),
]);
export const previewManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), hostId: z.string().min(1).max(256), installationInstanceId: token, epoch: token,
  viewNonce: viewNonceSchema, savedCatalogRef: catalogRefSchema,
  plan: providerPreviewResultSchema.options[0], directoryEffects: z.array(directoryEffectSchema).max(32768),
  readSet: z.array(observationSchema).max(32768), sources: z.array(sourceSchema).max(2048),
  gitProof: gitProofSchema, policy: policySchema,
});
export const previewReceiptSchema = z.strictObject({
  previewId: token, planDigest: token, epoch: token, viewNonce: viewNonceSchema,
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
});
export const providerPreviewV2InputSchema = z.strictObject({ intent: selectionIntentV1Schema, viewNonce: viewNonceSchema });
export const providerPreviewV2ResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"), schemaVersion: z.literal(2), manifest: previewManifestSchema, receipt: previewReceiptSchema,
    applyEligibility: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("eligible") }),
      z.strictObject({ status: z.literal("no_changes") }),
      z.strictObject({ status: z.literal("ineligible"), reasons: z.array(z.enum([
        "write_capability_unavailable", "plan_conflict", "plan_blocked", "observations_unverified",
      ])).min(1).max(4) }),
    ]),
    plannedEffect: z.enum(["create_only", "no_changes", "not_applicable"]),
  }),
  providerPreviewResultSchema.options[1],
]);
export type ReceiptObservation = z.infer<typeof observationSchema>;
export type PreviewManifest = z.infer<typeof previewManifestSchema>;
export type PreviewReceipt = z.infer<typeof previewReceiptSchema>;
export type ProviderPreviewV2Result = z.infer<typeof providerPreviewV2ResultSchema>;
