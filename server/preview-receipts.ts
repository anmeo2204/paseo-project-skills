import { createHash, randomBytes } from "node:crypto";
import { previewManifestSchema, providerPreviewV2ResultSchema, receiptLimits, receiptPolicy,
  type EnrollmentBinding, type PreviewManifest, type PreviewReceipt, type ProviderPreviewV2Result } from "../shared/preview-receipt";
import { PreviewError } from "./preview-reader";
import { previewLimits } from "./preview-limits";

// UTF-8 JSON, lexically sorted object keys, preserved array order, finite safe
// integers only. No undefined, sparse arrays, classes, toJSON or custom coercion.
export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (Array.isArray(value) && Object.keys(value).length === value.length) return "[" + value.map(canonicalSerialize).join(",") + "]";
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalSerialize((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  throw new TypeError("Non-canonical manifest value");
}
// Zod removes omitted optional properties; the digest covers the exact wire manifest.
export const manifestDigest = (manifest: PreviewManifest) => createHash("sha256")
  .update("paseo-project-skills/preview-manifest/v1\0").update(canonicalSerialize(manifest)).digest("hex");
const randomToken = () => randomBytes(32).toString("hex");
type Source = { destination: string; bytes: Buffer };
type RecordValue = { receipt: PreviewReceipt; manifestJson: string; sources: Map<string, Buffer>; bytes: number; expires: number };
type Options = {
  now?: () => number; wallNow?: () => number; limits?: typeof receiptLimits; responseBytes?: number;
  fixtureApply?: (target: string) => boolean;
  singleProject?: () => EnrollmentBinding | undefined;
  multiRoot?: (target: string) => EnrollmentBinding | undefined;
};

// Installation-process lifetime, not a cross-process coordinator or caller identity.
// Durable fixture claims live in the operation journal.
export class PreviewReceiptStore {
  readonly epoch = randomToken();
  readonly installationInstanceId = randomToken();
  private readonly records = new Map<string, RecordValue>();
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly limits: typeof receiptLimits;
  private retainedBytes = 0;
  constructor(private readonly options: Options = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
    this.limits = options.limits ?? receiptLimits;
  }
  private remove(id: string) {
    const record = this.records.get(id);
    if (record) this.retainedBytes -= record.bytes;
    this.records.delete(id);
  }
  private prune() {
    for (const [id, record] of this.records) if (this.now() >= record.expires) this.remove(id);
  }
  get policy() {
    return { ...receiptPolicy, writeCapability: this.options.fixtureApply ? "fixture_m4_5" as const : receiptPolicy.writeCapability };
  }
  policyFor(target: string): PreviewManifest["policy"] {
    if (this.options.multiRoot) {
      const binding = this.options.multiRoot(target);
      if (binding && binding.canonicalRoot === target) {
        return { ...receiptPolicy, writeCapability: "multi_root_v1" as const, enrollment: binding };
      }
      return { ...receiptPolicy, writeCapability: receiptPolicy.writeCapability };
    }
    if (this.options.singleProject) {
      const binding = this.options.singleProject();
      if (binding && binding.canonicalRoot === target) {
        return { ...receiptPolicy, writeCapability: "single_project_v1" as const, enrollment: binding };
      }
      return { ...receiptPolicy, writeCapability: receiptPolicy.writeCapability };
    }
    return this.policy;
  }
  issue(raw: PreviewManifest, sourceFiles: Source[]): Extract<ProviderPreviewV2Result, { status: "ready" }> {
    const manifest = previewManifestSchema.parse(raw);
    if (manifest.epoch !== this.epoch || manifest.installationInstanceId !== this.installationInstanceId) throw new PreviewError("host_io_error");
    let bytes = 0;
    const sources = new Map<string, Buffer>();
    if (sourceFiles.length !== manifest.sources.length) throw new PreviewError("invalid_catalog");
    for (const source of sourceFiles) {
      const expected = manifest.sources.find((item) => item.destination === source.destination);
      bytes += source.bytes.length;
      if (bytes > this.limits.sourceBytes) throw new PreviewError("limit_exceeded");
      if (!expected || sources.has(source.destination) || expected.sizeBytes !== source.bytes.length ||
        createHash("sha256").update(source.bytes).digest("hex") !== expected.sha256) throw new PreviewError("invalid_catalog");
      sources.set(source.destination, Buffer.from(source.bytes));
    }
    if (bytes > this.limits.retainedSourceBytes || this.limits.receipts < 1) throw new PreviewError("limit_exceeded");
    const manifestJson = canonicalSerialize(manifest);
    const issuedMono = this.now();
    const issuedAt = this.wallNow();
    const receipt = { previewId: randomToken(), planDigest: manifestDigest(manifest), epoch: this.epoch,
      viewNonce: manifest.viewNonce, issuedAt, expiresAt: issuedAt + this.limits.ttlMs };
    const entries = [...manifest.plan.entries, ...manifest.plan.derivedEntries];
    const reasons: Extract<Extract<ProviderPreviewV2Result, { status: "ready" }>["applyEligibility"], { status: "ineligible" }>["reasons"] = [];
    const target = manifest.plan.intent.canonicalDirectory;
    const expectedPolicy = this.policyFor(target);
    const scopeEligible = this.options.multiRoot
      ? expectedPolicy.writeCapability === "multi_root_v1"
      : this.options.singleProject
      ? expectedPolicy.writeCapability === "single_project_v1"
      : Boolean(this.options.fixtureApply?.(target));
    if (!scopeEligible) reasons.push("write_capability_unavailable");
    if (manifest.policy.writeCapability !== expectedPolicy.writeCapability ||
      canonicalSerialize(manifest.policy.enrollment ?? null) !== canonicalSerialize(expectedPolicy.enrollment ?? null)) {
      throw new PreviewError("host_io_error");
    }
    if (entries.some((entry) => entry.status === "conflict")) reasons.push("plan_conflict");
    if (entries.some((entry) => entry.status === "blocked")) reasons.push("plan_blocked");
    if (manifest.readSet.some((item) => item.observation.state === "unverified" ||
      item.observation.state === "present" && item.observation.kind === "unsafe")) reasons.push("observations_unverified");
    const blocked = reasons.some(reason => reason !== "write_capability_unavailable");
    const plannedEffect = blocked ? "not_applicable" : entries.some(entry => entry.status === "create") ? "create_only" : "no_changes";
    const result = providerPreviewV2ResultSchema.options[0].parse({ status: "ready", schemaVersion: 2, manifest, receipt,
      applyEligibility: reasons.length ? { status: "ineligible", reasons } : { status: plannedEffect === "create_only" ? "eligible" : "no_changes" },
      plannedEffect });
    if (Buffer.byteLength(JSON.stringify(result)) > (this.options.responseBytes ?? previewLimits.responseBytes)) throw new PreviewError("limit_exceeded");
    // Only a fully validated, bounded response may evict or publish a receipt.
    this.prune();
    while (this.records.size >= this.limits.receipts || this.retainedBytes + bytes > this.limits.retainedSourceBytes) {
      this.remove(this.records.keys().next().value!);
    }
    this.records.set(receipt.previewId, { receipt: { ...receipt }, manifestJson, sources, bytes, expires: issuedMono + this.limits.ttlMs });
    this.retainedBytes += bytes;
    return result;
  }
  // Lifetime/binding/integrity only: DOES NOT revalidate settings, catalog or
  // filesystem and never authorizes writes. Future Apply needs full preflight.
  // Internal only; never exposed as RPC.
  inspect(binding: PreviewReceipt & { hostId: string; installationInstanceId: string }) {
    if (binding.epoch !== this.epoch) return { status: "error" as const, code: "epoch_mismatch" as const };
    if (binding.issuedAt === undefined || binding.expiresAt === undefined)
      return { status: "error" as const, code: "digest_mismatch" as const };
    return this.inspectApply(binding);
  }

  inspectApply(binding: Pick<PreviewReceipt, "previewId" | "planDigest" | "viewNonce"> &
    Partial<Pick<PreviewReceipt, "issuedAt" | "expiresAt">> & { hostId: string; installationInstanceId: string }) {
    const record = this.records.get(binding.previewId);
    if (!record) return { status: "error" as const, code: "unknown_receipt" as const };
    if (this.now() >= record.expires) { this.remove(binding.previewId); return { status: "error" as const, code: "expired" as const }; }
    const manifest: PreviewManifest = JSON.parse(record.manifestJson);
    if (binding.hostId !== manifest.hostId || binding.installationInstanceId !== manifest.installationInstanceId ||
      binding.viewNonce !== record.receipt.viewNonce) return { status: "error" as const, code: "binding_mismatch" as const };
    if (binding.planDigest !== record.receipt.planDigest || manifestDigest(manifest) !== binding.planDigest ||
      (binding.issuedAt !== undefined && binding.issuedAt !== record.receipt.issuedAt) ||
      (binding.expiresAt !== undefined && binding.expiresAt !== record.receipt.expiresAt)) {
      return { status: "error" as const, code: "digest_mismatch" as const };
    }
    if (this.options.multiRoot) {
      const target = manifest.plan.intent.canonicalDirectory;
      const current = this.options.multiRoot(target);
      if (!current || manifest.policy.writeCapability !== "multi_root_v1" || !manifest.policy.enrollment ||
        current.canonicalRoot !== target ||
        canonicalSerialize(manifest.policy.enrollment) !== canonicalSerialize(current)) {
        return { status: "error" as const, code: "binding_mismatch" as const };
      }
    } else if (this.options.singleProject) {
      const current = this.options.singleProject();
      if (!current || manifest.policy.writeCapability !== "single_project_v1" || !manifest.policy.enrollment ||
        canonicalSerialize(manifest.policy.enrollment) !== canonicalSerialize(current)) {
        return { status: "error" as const, code: "binding_mismatch" as const };
      }
    }
    return { status: "ready" as const, manifest,
      sources: [...record.sources].map(([destination, bytes]) => ({ destination, bytes: Buffer.from(bytes) })) };
  }
  dispose() { this.records.clear(); this.retainedBytes = 0; }
}
