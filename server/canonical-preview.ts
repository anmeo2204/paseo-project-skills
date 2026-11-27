import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import type { PluginHandlerContext, PluginSettings } from "@getpaseo/plugin/server";
import { catalogSnapshotSchema } from "../shared/catalog";
import { catalogSource, type catalogSettings } from "../shared/catalog-settings";
import { previewResultSchema, providerPreviewResultSchema, type PreviewEntry, type PreviewResult, type ProviderPreviewResult } from "../shared/preview";
import { selectionIntentV1Schema, type SelectionIntentV1 } from "../shared/selection-intent";
import { hasBlobIntegrity } from "./applicability-reader";
import { CatalogError } from "./catalog-error";
import type { CatalogLoader, CatalogSnapshot } from "./catalog-loader";
import { previewDiff } from "./preview-diff";
import { previewLimits } from "./preview-limits";
import { PreviewError, PreviewReader, type PreviewFs } from "./preview-reader";
import { compare } from "./project-reader";
import { validateDirectory } from "./validate-directory";
import { prepareProviderPreview } from "./provider-adapters";
import { providerPreviewV2InputSchema, providerPreviewV2ResultSchema, receiptLimits,
  type ProviderPreviewV2Result, type PreviewManifest } from "../shared/preview-receipt";
import { PreviewReceiptStore, canonicalSerialize } from "./preview-receipts";
import { ReceiptObservations } from "./receipt-observations";
import { receiptGitProof } from "./receipt-git-proof";

type Options = { io?: PreviewFs; limits?: typeof previewLimits; now?: () => number; receiptStore?: PreviewReceiptStore; receiptMode?: boolean };
type File = CatalogSnapshot["skills"][number]["entrypoint"];
export type PlannedFile = { skillId: string; destination: string; file: File };
const fingerprint = (bytes: Buffer, mode: number) => ({
  sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mode,
});
const portablePath = (path: string) => path.split("/").every((part) => part && part !== "." && part !== ".." &&
  !/[\\:\u0000-\u001f\u007f]/u.test(part) && !/[. ]$/.test(part) && !/^\.git$/i.test(part) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));

function selectedFiles(intent: SelectionIntentV1, snapshot: CatalogSnapshot, limits: typeof previewLimits, copySourceBytes = false) {
  if (!catalogSnapshotSchema.safeParse(snapshot).success ||
      new Set(snapshot.skills.map(({ id }) => id)).size !== snapshot.skills.length) throw new PreviewError("invalid_catalog");
  if (snapshot.commitSha !== intent.catalogCommitSha || snapshot.source !== intent.catalogSource) throw new PreviewError("catalog_mismatch");
  const wanted = new Set(intent.selectedSkillIds);
  const files: PlannedFile[] = [];
  let copiedBytes = 0;
  const paths = new Map<string, { kind: "file" | "directory"; spelling: string }>();
  for (const skill of [...snapshot.skills].sort((a, b) => compare(a.id, b.id))) {
    if (!wanted.delete(skill.id)) continue;
    if (skill.directory !== "skills/" + skill.id || skill.metadata.name !== skill.id || skill.entrypoint.path !== "SKILL.md") {
      throw new PreviewError("invalid_catalog");
    }
    for (const file of [skill.entrypoint, ...skill.supportingFiles]) {
      const destination = ".agents/skills/" + skill.id + "/" + file.path;
      if (!portablePath(file.path) || Buffer.byteLength(destination) > limits.pathBytes ||
          destination.split("/").length > limits.pathDepth || !hasBlobIntegrity(file)) throw new PreviewError("invalid_catalog");
      if (copySourceBytes && (copiedBytes += file.bytes.length) > receiptLimits.sourceBytes) throw new PreviewError("limit_exceeded");
      const originalParts = destination.split("/");
      const parts = destination.normalize("NFC").toLowerCase().split("/");
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join("/");
        const kind = i === parts.length ? "file" : "directory";
        const spelling = originalParts.slice(0, i).join("/");
        const known = paths.get(path);
        if (known && (known.kind !== kind || known.spelling !== spelling || kind === "file")) throw new PreviewError("invalid_catalog");
        paths.set(path, { kind, spelling });
      }
      files.push({ skillId: skill.id, destination, file: copySourceBytes ? { ...file, bytes: Buffer.from(file.bytes) } : file });
      if (files.length > limits.files) throw new PreviewError("limit_exceeded");
    }
  }
  if (wanted.size) throw new PreviewError("invalid_selection");
  return files.sort((a, b) => compare(a.destination, b.destination));
}

async function plan(intent: SelectionIntentV1, snapshot: CatalogSnapshot, identity: Stats, signal: AbortSignal,
  options: Options) {
  const limits = options.limits ?? previewLimits;
  const files = selectedFiles(intent, snapshot, limits, options.receiptMode);
  const reader = new PreviewReader(intent.canonicalDirectory, identity, signal, options.io, limits, options.now, options.receiptMode === true);
  const entries: PreviewEntry[] = [];
  let responseBytes = 0;
  let comparedFiles = 0;
  const compareFile = async ({ skillId, file }: PlannedFile, destination: string): Promise<PreviewEntry> => {
    reader.checkpoint();
    if (++comparedFiles > limits.files || Buffer.byteLength(destination) > limits.pathBytes ||
        destination.split("/").length > limits.pathDepth) throw new PreviewError("limit_exceeded");
    const proposed = fingerprint(file.bytes, file.mode === "100755" ? 0o755 : 0o644);
    const observed = await reader.read(destination);
    let entry: PreviewEntry;
    if (observed.reason) entry = { skillId, destination, proposed, status: "blocked", reason: observed.reason };
    else {
      const existing = observed.bytes && observed.state ? fingerprint(observed.bytes, observed.state.mode & 0o7777) : undefined;
      const status = !existing ? "create" : existing.sha256 === proposed.sha256 && existing.mode === proposed.mode ? "unchanged" : "conflict";
      const change = status === "unchanged" ? undefined : previewDiff(destination, observed.bytes, file.bytes, existing?.mode, proposed.mode);
      entry = { skillId, destination, proposed, ...(existing ? { existing } : {}), status, ...(change ? { change } : {}) };
      if (change?.kind === "text" && Buffer.byteLength(change.unifiedDiff) > limits.diffBytes) {
        entry = { skillId, destination, proposed, ...(existing ? { existing } : {}), status: "blocked", reason: "diff_limit" };
      }
    }
    responseBytes += Buffer.byteLength(JSON.stringify(entry));
    if (responseBytes > limits.responseBytes) throw new PreviewError("limit_exceeded");
    return entry;
  };
  for (const file of files) {
    entries.push(await compareFile(file, file.destination));
  }
  return { files, entries, reader, compareFile, async verify() {
    const changed = await reader.changedPaths();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (changed.some((path) => entry.destination === path || entry.destination.startsWith(path + "/"))) {
        entries[i] = { skillId: entry.skillId, destination: entry.destination, proposed: entry.proposed,
          status: "blocked", reason: "entry_changed" };
      }
    }
    const result: Extract<PreviewResult, { status: "ready" }> = { status: "ready",
      intent: { ...intent, selectedSkillIds: [...intent.selectedSkillIds].sort(compare),
        targetProviderIds: [...intent.targetProviderIds].sort(compare) }, entries };
    return { result, changed };
  } };
}

export type CanonicalPlan = Awaited<ReturnType<typeof plan>>;

export function createCanonicalPreviewHandler(
  settings: Pick<PluginSettings<typeof catalogSettings.schema>, "read">,
  loader: Pick<CatalogLoader, "load">,
  options: Options = {},
) {
  let disposed = false;
  const receipts = options.receiptStore ?? new PreviewReceiptStore({ responseBytes: options.limits?.responseBytes });
  type Result = PreviewResult | ProviderPreviewResult | ProviderPreviewV2Result;
  let active: { stop: AbortController; done: Promise<Result> } | undefined;
  const run = async (raw: unknown, { paseo }: Pick<PluginHandlerContext, "paseo">, withProviders: boolean, v2 = false): Promise<Result> => {
    const request = v2 ? providerPreviewV2InputSchema.safeParse(raw) : undefined;
    if (request && !request.success) return { status: "error", code: "invalid_selection" };
    const parsed = selectionIntentV1Schema.safeParse(request?.data?.intent ?? raw);
    if (!parsed.success) return { status: "error", code: "invalid_selection" };
    if (disposed) return { status: "error", code: "cancelled" };
    if (active) return { status: "error", code: "busy" };
    const stop = new AbortController();
    const execute = async (): Promise<Result> => {
      const intent = parsed.data;
      const io = options.io ?? fs;
      const checkpoint = () => { if (stop.signal.aborted) throw new PreviewError("cancelled"); };
      try {
        if ((await paseo.hosts.list()).self.serverId !== intent.hostId) throw new PreviewError("host_mismatch");
        checkpoint();
        const state = await settings.read();
        if (state.status !== "ready" || state.revision !== intent.settingsRevision) throw new PreviewError("settings_changed");
        if (intent.catalogSource !== catalogSource) throw new PreviewError("catalog_mismatch");
        const target = await validateDirectory({ path: intent.canonicalDirectory });
        if (target.status !== "ready") throw new PreviewError("invalid_target");
        if (target.directory !== intent.canonicalDirectory) throw new PreviewError("target_changed");
        const identity = await io.lstat(target.directory);
        if (!identity.isDirectory() || await io.realpath(target.directory) !== target.directory) throw new PreviewError("target_changed");
        const snapshot = await loader.load(state.values.catalogRef);
        checkpoint();
        const observations = v2 ? new ReceiptObservations(target.directory, io, stop.signal, options.limits, options.now) : undefined;
        await observations?.initialize();
        const result = await plan(intent, snapshot, identity, stop.signal,
          observations ? { ...options, io: observations.io, receiptMode: true } : options);
        const adapters = withProviders ? await prepareProviderPreview(intent, result, stop.signal) : undefined;
        const kiroRootStatus = () => adapters?.finish({ status: "ready", intent, entries: result.entries }, [])
          .providers.find((provider) => provider.providerId === "kiro")?.rootStatus;
        const gitProof = observations && intent.targetProviderIds.includes("kiro")
          ? await receiptGitProof(target.directory, result.reader, observations, stop.signal, kiroRootStatus()) : { status: "not_selected" as const };
        if (observations) {
          const pinned = await loader.load(state.values.catalogRef);
          if (pinned.source !== intent.catalogSource || pinned.commitSha !== intent.catalogCommitSha) throw new PreviewError("catalog_mismatch");
        }
        const latest = await settings.read();
        checkpoint();
        if (latest.status !== "ready" || latest.revision !== state.revision || latest.values.catalogRef !== state.values.catalogRef) {
          throw new PreviewError("settings_changed");
        }
        // Recheck all observed destinations after the final settings await.
        await adapters?.revalidateRoot();
        const verified = await result.verify();
        const validated = adapters ? providerPreviewResultSchema.parse(adapters.finish(verified.result, verified.changed)) :
          previewResultSchema.parse(verified.result);
        if (Buffer.byteLength(JSON.stringify(validated)) > (options.limits ?? previewLimits).responseBytes) throw new PreviewError("limit_exceeded");
        if (observations && request?.success) {
          const providerPlan = providerPreviewResultSchema.options[0].parse(validated);
          const byDestination = (a: PreviewEntry, b: PreviewEntry) => Buffer.compare(Buffer.from(a.destination), Buffer.from(b.destination));
          providerPlan.entries.sort(byDestination);
          providerPlan.derivedEntries.sort(byDestination);
          const finalProof = intent.targetProviderIds.includes("kiro")
            ? await receiptGitProof(target.directory, result.reader, observations, stop.signal,
              providerPlan.providers.find((provider) => provider.providerId === "kiro")?.rootStatus) : gitProof;
          if (canonicalSerialize(gitProof) !== canonicalSerialize(finalProof)) throw new PreviewError("target_changed");
          await observations.verify();
          const allEntries = [...providerPlan.entries, ...providerPlan.derivedEntries].sort(byDestination);
          const sources = allEntries.map((entry) => {
            const canonicalDestination = "canonicalDestination" in entry && typeof entry.canonicalDestination === "string"
              ? entry.canonicalDestination : entry.destination;
            const source = result.files.find((file) => file.destination === canonicalDestination);
            if (!source) throw new PreviewError("invalid_catalog");
            return { destination: entry.destination, canonicalDestination, file: source.file };
          });
          const manifest: PreviewManifest = {
            schemaVersion: 1, hostId: intent.hostId, installationInstanceId: receipts.installationInstanceId, epoch: receipts.epoch,
            viewNonce: request.data.viewNonce, savedCatalogRef: state.values.catalogRef, plan: providerPlan,
            directoryEffects: observations.directoryEffects(allEntries.filter((entry) => entry.status === "create").map((entry) => entry.destination)),
            readSet: observations.snapshot(), sources: sources.map(({ destination, canonicalDestination, file }) => ({
              destination, canonicalDestination, blobSha: file.blobSha, ...fingerprint(file.bytes, file.mode === "100755" ? 0o755 : 0o644),
              mode: file.mode === "100755" ? 0o755 as const : 0o644 as const,
            })), gitProof: finalProof, policy: { ...receipts.policyFor(target.directory), previewBudgets: options.limits ?? previewLimits },
          };
          result.reader.checkpoint();
          return receipts.issue(JSON.parse(JSON.stringify(manifest)), sources.map(({ destination, file }) => ({ destination, bytes: file.bytes })));
        }
        return validated;
      } catch (error) {
        return { status: "error", code: stop.signal.aborted ? "cancelled" : error instanceof PreviewError ? error.code :
          error instanceof CatalogError ? error.code === "limit_exceeded" ? "limit_exceeded" : "catalog_unavailable" : "host_io_error" };
      }
    };
    // Reserve the slot before any host/settings/catalog await, including reentrant callers.
    const done = Promise.resolve().then(execute);
    active = { stop, done };
    try { return await done; } finally { active = undefined; }
  };
  return {
    handle: async (input: unknown, context: Pick<PluginHandlerContext, "paseo">) => previewResultSchema.parse(await run(input, context, false)),
    handleProviders: async (input: unknown, context: Pick<PluginHandlerContext, "paseo">) => providerPreviewResultSchema.parse(await run(input, context, true)),
    handleProvidersV2: async (input: unknown, context: Pick<PluginHandlerContext, "paseo">) => providerPreviewV2ResultSchema.parse(await run(input, context, true, true)),
    async dispose() {
    disposed = true;
    active?.stop.abort();
    await active?.done;
    receipts.dispose();
  } };
}
