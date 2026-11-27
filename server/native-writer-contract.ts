import { z } from "zod";
import { observationSchema, type PreviewManifest } from "../shared/preview-receipt";
import { manifestDigest } from "./preview-receipts";

export const nativeWriterVersion = "m4.4-fixture.1";
export const nativeWriterLimits = Object.freeze({ files: 2048, directories: 1024, observations: 32768,
  sourceBytes: 8 * 1024 * 1024, requestBytes: 24 * 1024 * 1024, responseBytes: 4 * 1024 * 1024, deadlineMs: 30000 });
const path = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
const relative = z.string().min(1).max(1024).refine(value => value.split("/").length <= 32 && value.split("/").every(part =>
  part && part !== "." && part !== ".." && !/[\\:\u0000-\u001f\u007f]/u.test(part) && !/[. ]$/.test(part) &&
  !/^\.git$/i.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) &&
  /^\.(?:agents|kiro)(?:\/skills(?:\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/.*)?)?)?$/.test(value));
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const barrierPoint = z.enum(["after_preflight", "before_create", "after_create_check", "after_create", "after_write", "before_mkdir", "after_mkdir_check", "after_mkdir"]);
export const nativeControlsSchema = z.strictObject({
  barriers: z.array(z.strictObject({ point: barrierPoint, destination: relative.optional() })).max(16),
  faults: z.array(z.strictObject({ point: z.enum(["write", "zero_write", "short_write", "sync", "directory_sync", "chmod", "close", "readback"]),
    destination: relative, afterBytes: z.number().int().nonnegative().max(nativeWriterLimits.sourceBytes).optional(),
    error: z.enum(["EIO", "ENOSPC", "EACCES"]).optional(), shortBytes: z.number().int().min(1).max(8192).optional() })).max(16),
});
export const nativeWriterRequestSchema = z.strictObject({
  protocol: z.literal(1), helperVersion: z.literal(nativeWriterVersion), fixtureBase: path, root: path,
  expectedParentPid: z.number().int().positive(),
  environment: z.strictObject({ paseoVersion: z.string().max(32), sdkVersion: z.string().max(32) }),
  observations: z.array(observationSchema).max(nativeWriterLimits.observations),
  directories: z.array(z.strictObject({ destination: relative, mode: z.literal(0o755) })).max(nativeWriterLimits.directories),
  files: z.array(z.strictObject({ destination: relative, status: z.enum(["create", "unchanged", "conflict", "blocked"]),
    mode: z.union([z.literal(0o644), z.literal(0o755)]), sizeBytes: z.number().int().nonnegative().max(nativeWriterLimits.sourceBytes),
    sha256: sha, bytesBase64: z.string().max(Math.ceil(nativeWriterLimits.sourceBytes / 3) * 4) })).max(nativeWriterLimits.files),
  durableAdmission: z.literal(true).optional(), coordinator: z.strictObject({ directory: path }).optional(), controls: nativeControlsSchema.optional(),
});
const identity = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });
export const nativeLedgerSchema = z.array(z.strictObject({ destination: relative, kind: z.enum(["file", "directory"]),
  state: z.enum(["not_attempted", "unchanged_verified", "created_verified", "created_incomplete", "observation_changed", "ownership_unknown"]),
  bytesWritten: z.number().int().nonnegative().optional(), writeCalls: z.number().int().nonnegative().optional(),
  shortWriteResults: z.number().int().nonnegative().optional(), systemErrno: z.number().int().nonnegative().optional(), identity: identity.optional() })).max(nativeWriterLimits.files + nativeWriterLimits.directories);
export const nativeWriterResultSchema = z.strictObject({
  event: z.literal("result"), protocol: z.literal(1), version: z.literal(nativeWriterVersion),
  phase: z.enum(["completed", "failed_before_write", "partial_failure", "uncertain"]), code: z.string().min(1).max(64),
  targetMutated: z.union([z.boolean(), z.literal("unknown")]), ledger: nativeLedgerSchema, checkpoints: z.number().int().nonnegative(),
  durability: z.enum(["not_confirmed", "fsync_completed"]),
});
export const nativeVersionSchema = z.strictObject({ protocol: z.literal(1), version: z.literal(nativeWriterVersion),
  fixtureOnly: z.literal(true), testing: z.union([z.literal(0), z.literal(1)]), arch: z.literal("arm64") });
export const nativeEventSchema = z.discriminatedUnion("event", [
  nativeWriterResultSchema,
  z.strictObject({ event: z.literal("ready_to_admit") }),
  z.strictObject({ event: z.literal("directory_verified"), destination: relative, identity }),
  z.strictObject({ event: z.literal("ready_to_finalize"), result: nativeWriterResultSchema, lockHeld: z.literal(true) }),
  z.strictObject({ event: z.literal("barrier"), point: barrierPoint, destination: z.string().max(1024), sequence: z.number().int().positive(), pid: z.number().int().positive() }),
  z.strictObject({ event: z.literal("environment"), filesystem: z.literal("apfs"), local: z.literal(true), caseMode: z.literal("insensitive"),
    macOS: z.literal("27.2.1"), arch: z.literal("arm64"), fixtureOnly: z.literal(true), pid: z.number().int().positive() }),
  z.strictObject({ event: z.literal("lock_acquired"), pid: z.number().int().positive(), identity }),
  z.strictObject({ event: z.literal("mutation_intent"), operation: z.enum(["mkdirat", "openat_exclusive"]), destination: relative }),
  z.strictObject({ event: z.literal("file_verified"), destination: relative, identity }),
]);
export type NativeWriterRequest = z.infer<typeof nativeWriterRequestSchema>;
export type NativeWriterResult = z.infer<typeof nativeWriterResultSchema>;
export type NativeWriterEvent = z.infer<typeof nativeEventSchema>;
export type NativeControls = z.infer<typeof nativeControlsSchema>;

// Explicit fixture bridge only. No receipt lookup/claim and no production authorization.
export function fixtureWriterRequest(input: { fixtureBase: string; manifest: PreviewManifest; planDigest: string;
  sources: { destination: string; bytes: Buffer }[]; environment: NativeWriterRequest["environment"]; coordinator?: string; controls?: NativeControls }): NativeWriterRequest {
  if (manifestDigest(input.manifest) !== input.planDigest) throw new Error("manifest_digest_mismatch");
  const sources = new Map(input.sources.map(source => [source.destination, source.bytes]));
  const entries = [...input.manifest.plan.entries, ...input.manifest.plan.derivedEntries];
  // Supporting files before each SKILL.md, canonical before derived.
  entries.sort((a, b) => Number(a.destination.startsWith(".kiro/")) - Number(b.destination.startsWith(".kiro/")) ||
    Buffer.compare(Buffer.from(a.skillId), Buffer.from(b.skillId)) || Number(a.destination.endsWith("/SKILL.md")) - Number(b.destination.endsWith("/SKILL.md")) ||
    Buffer.compare(Buffer.from(a.destination), Buffer.from(b.destination)));
  return nativeWriterRequestSchema.parse({ protocol: 1, helperVersion: nativeWriterVersion, fixtureBase: input.fixtureBase,
    root: input.manifest.plan.intent.canonicalDirectory, expectedParentPid: process.pid, environment: input.environment,
    observations: input.manifest.readSet, directories: input.manifest.directoryEffects.map(({ destination, mode }) => ({ destination, mode })),
    files: entries.map(entry => {
      const bytes = sources.get(entry.destination); if (!bytes) throw new Error("missing_source");
      return { destination: entry.destination, status: entry.status, ...entry.proposed, bytesBase64: bytes.toString("base64") };
    }), ...(input.coordinator ? { coordinator: { directory: input.coordinator } } : {}), ...(input.controls ? { controls: input.controls } : {}),
  });
}
