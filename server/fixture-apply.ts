import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { applyCreateInputSchema, applyStatusInputSchema, type ApplyOutput, type ApplyOperation, type ApplyCreateInput } from "../shared/apply";
import { createCanonicalPreviewHandler } from "./canonical-preview";
import { ApplyJournal, type ApplyJournalRecord } from "./apply-journal";
import { canonicalSerialize, manifestDigest, PreviewReceiptStore } from "./preview-receipts";
import { fixtureWriterRequest, type NativeControls, type NativeWriterRequest, type NativeWriterResult } from "./native-writer-contract";
import { runFixtureWriter, type FixtureWriterOptions } from "./native-writer";

type Context = Pick<PluginHandlerContext, "paseo">;
type ErrorCode = Extract<ApplyOutput, { status: "error" }>["code"];
const error = (code: ErrorCode): ApplyOutput => ({ status: "error", code });
const hash = (domain: string, data: string) => createHash("sha256").update(domain + "\0").update(data).digest("hex");
const beneath = (base: string, path: string) => {
  const name = relative(base, path);
  return name !== "" && name !== ".." && !name.startsWith("../") && !isAbsolute(name);
};
export function isFixtureApplyTarget(base: string, target: string, home = process.env.PASEO_HOME) {
  return Boolean(home && beneath(base, home) && beneath(base, target) && target !== home &&
    !beneath(home, target) && !beneath(target, home));
}
const pending = (operation: ApplyOperation) =>
  operation.phase === "accepted" || operation.phase === "preflight" || operation.phase === "writing";
const recovery = (operation: ApplyOperation): ApplyOperation => ({
  ...operation, phase: "recovery_required", code: "terminal_record_missing",
  targetMutated: "unknown", durability: "not_confirmed", requiresPreview: true,
});

type FixtureConfiguration = {
  fixtureBase: string;
  installation: string;
  targetAllowed?: (target: string) => boolean;
  receipts: PreviewReceiptStore;
  settings: Parameters<typeof createCanonicalPreviewHandler>[0];
  catalog: Parameters<typeof createCanonicalPreviewHandler>[1];
  environment: NativeWriterRequest["environment"];
  // Available only to a locally assembled fixture plugin, outside the typed RPC.
  test?: {
    controls?: (input: ApplyCreateInput) => NativeControls | undefined;
    onEvent?: FixtureWriterOptions["onEvent"];
    onExtracted?: FixtureWriterOptions["onExtracted"];
    beforeAdmission?: (input: ApplyCreateInput) => void;
    afterTerminal?: (operation: ApplyOperation) => Promise<void>;
  };
};

export function createFixtureApply(config: FixtureConfiguration) {
  const base = realpathSync(config.fixtureBase);
  const home = process.env.PASEO_HOME;
  if (!home || !beneath(base, home) || realpathSync(home) !== home || !lstatSync(home).isDirectory())
    throw new Error("fixture_daemon_home_required");
  const coordinator = join(home, "runtime", "project-skills-m44");
  const journal = new ApplyJournal(coordinator);
  const active = new Map<string, { requestHash: string; done: Promise<ApplyOutput> }>();
  const stop = new AbortController();
  const allowsTarget = (target: string) => isFixtureApplyTarget(base, target, home) && (config.targetAllowed?.(target) ?? true);
  const revalidation = createCanonicalPreviewHandler(config.settings, config.catalog, {
    receiptStore: new PreviewReceiptStore(config.receipts.policy.writeCapability === "fixture_m4_5" ? { fixtureApply: allowsTarget } : {}),
  });
  const host = async (context: Context) => (await context.paseo.hosts.list()).self.serverId;

  const visible = (record: ApplyJournalRecord | undefined, hostId: string) =>
    record?.hostId === hostId && record.installation === config.installation;
  const report = (record: ApplyJournalRecord): ApplyOperation => {
    if (!pending(record.operation) ||
        (record.instance === config.receipts.installationInstanceId && active.has(record.operation.operationId)))
      return record.operation;
    return recovery(record.operation);
  };

  async function execute(input: ApplyCreateInput, requestHash: string, context: Context): Promise<ApplyOutput> {
    const hostId = await host(context);
    const lookup = () => {
      const previous = journal.read(input.operationId);
      if (!previous) return undefined;
      if (!visible(previous, hostId)) return error("outcome_unknown");
      return previous.requestHash === requestHash ? report(previous) : error("operation_mismatch");
    };
    const previous = lookup();
    if (previous) return previous;
    const binding = { ...input, hostId, installationInstanceId: config.receipts.installationInstanceId };
    const receipt = config.receipts.inspectApply(binding);
    if (receipt.status !== "ready") return error("receipt_invalid");
    const { manifest, sources } = receipt;
    if (!allowsTarget(manifest.plan.intent.canonicalDirectory)) return error("unsupported_environment");
    const entries = [...manifest.plan.entries, ...manifest.plan.derivedEntries];
    if (entries.some(item => item.status === "conflict" || item.status === "blocked") ||
        manifest.readSet.some(item => item.observation.state === "unverified" ||
          item.observation.state === "present" && item.observation.kind === "unsafe"))
      return error("plan_not_applicable");
    if (stop.signal.aborted) return error("cancelled");
    const controls = config.test?.controls?.(input);
    const request = { ...fixtureWriterRequest({ fixtureBase: base, manifest, planDigest: input.planDigest, sources,
      environment: config.environment, coordinator, controls }), durableAdmission: true as const };

    const byDestination = new Map(manifest.sources.map(source => [source.destination, source]));
    const record: ApplyJournalRecord = {
      hostId, installation: config.installation, instance: config.receipts.installationInstanceId,
      requestHash, receiptHash: hash("apply-receipt-v1", input.previewId),
      operation: {
        status: "operation", operationId: input.operationId, planDigest: input.planDigest,
        phase: "accepted", code: "none", targetMutated: "unknown", requiresPreview: false, durability: "not_confirmed",
        ledger: [
          ...request.directories.map(item => ({ destination: item.destination, kind: "directory" as const, state: "not_attempted" as const })),
          ...request.files.map(item => {
            const source = byDestination.get(item.destination)!;
            return { destination: item.destination, kind: "file" as const, state: "not_attempted" as const, bytesWritten: 0,
              canonicalDestination: source.canonicalDestination,
              expected: { sha256: source.sha256, mode: source.mode, sizeBytes: source.sizeBytes } };
          }),
        ],
      },
    };
    let admitted = false;
    let denied: ApplyOutput | undefined;
    let stale = false;
    let terminal: ApplyOperation | undefined;
    const settle = (result: NativeWriterResult) => {
      const nativeRows = new Map(result.ledger.map(row => [row.destination, row]));
      const phase = result.phase === "uncertain" ? "recovery_required" : result.phase;
      const operation: ApplyOperation = {
        ...record.operation, phase, code: stale ? "stale_plan" : result.code, targetMutated: result.targetMutated,
        requiresPreview: phase !== "completed", durability: result.durability,
        ledger: record.operation.ledger.map(row => {
          const updated = nativeRows.get(row.destination);
          return updated ? { ...row, state: updated.state,
            ...(updated.bytesWritten !== undefined && { bytesWritten: updated.bytesWritten }),
            ...(updated.identity && { identity: updated.identity }) } : row;
        }),
      };
      journal.publish({ ...record, operation });
      terminal = operation;
    };

    const outcome = await runFixtureWriter(request, {
      testing: Boolean(controls), onEvent: config.test?.onEvent, onExtracted: config.test?.onExtracted, signal: stop.signal,
      onAdmission: async () => {
        if (stop.signal.aborted) { denied = error("cancelled"); return false; }
        try {
          denied = lookup();
          if (denied) return false;
          if (config.receipts.inspectApply(binding).status !== "ready") { denied = error("receipt_invalid"); return false; }
          const refusal = journal.checkAdmission(record);
          if (refusal) { denied = error(refusal); return false; }
          config.test?.beforeAdmission?.(input);
          journal.publish(record, true);
          admitted = true;
        } catch {
          denied = error("journal_unavailable");
          return false;
        }

        record.operation.phase = "preflight";
        journal.publish(record);
        const fresh = await revalidation.handleProvidersV2({ intent: manifest.plan.intent, viewNonce: input.viewNonce }, context);
        stale = fresh.status !== "ready" || manifestDigest({
          ...fresh.manifest, installationInstanceId: manifest.installationInstanceId, epoch: manifest.epoch,
        }) !== input.planDigest;
        return !stale && !stop.signal.aborted;
      },
      onProgress: event => {
        if (!admitted) throw new Error("journal_not_admitted");
        const row = record.operation.ledger.find(item => item.destination === event.destination);
        if (!row) throw new Error("unknown_ledger_destination");
        record.operation.phase = "writing";
        if (event.event === "mutation_intent") row.state = "ownership_unknown";
        else {
          row.state = "created_verified";
          row.identity = event.identity;
          if (row.expected) row.bytesWritten = row.expected.sizeBytes;
        }
        journal.publish(record);
      },
      onFinalize: result => { if (admitted) settle(result); },
    });

    if (terminal) {
      await config.test?.afterTerminal?.(terminal);
      return terminal;
    }
    if (admitted) {
      try {
        const durable = journal.read(input.operationId);
        if (durable && visible(durable, hostId)) return pending(durable.operation) ? recovery(durable.operation) : durable.operation;
      } catch { /* A lost journal is also an unknown outcome. */ }
      return error("outcome_unknown");
    }
    if (denied) return denied;
    if (outcome.result.code === "busy") return error("busy");
    return error(stop.signal.aborted ? "cancelled" : "unsupported_environment");
  }

  return {
    create(raw: unknown, context: Context): Promise<ApplyOutput> {
      const parsed = applyCreateInputSchema.safeParse(raw);
      if (!parsed.success) return Promise.resolve(error("invalid_request"));
      const input = parsed.data;
      const requestHash = hash("apply-request-v1", canonicalSerialize(input));
      const running = active.get(input.operationId);
      if (running) return running.requestHash === requestHash ? running.done : Promise.resolve(error("operation_mismatch"));
      if (stop.signal.aborted) return Promise.resolve(error("cancelled"));
      if (active.size) return host(context).then(hostId => {
        const previous = journal.read(input.operationId);
        if (!previous) return error("busy");
        if (!visible(previous, hostId)) return error("outcome_unknown");
        return previous.requestHash === requestHash ? report(previous) : error("operation_mismatch");
      }).catch(() => error("journal_unavailable"));
      const done = Promise.resolve().then(() => execute(input, requestHash, context))
        .catch(() => error("journal_unavailable")).finally(() => active.delete(input.operationId));
      active.set(input.operationId, { requestHash, done });
      return done;
    },
    async status(raw: unknown, context: Context): Promise<ApplyOutput> {
      const parsed = applyStatusInputSchema.safeParse(raw);
      if (!parsed.success) return error("invalid_request");
      try {
        const hostId = await host(context);
        const record = journal.read(parsed.data.operationId);
        return record && visible(record, hostId) ? report(record) : error("outcome_unknown");
      } catch { return error("outcome_unknown"); }
    },
    async dispose() {
      stop.abort();
      await revalidation.dispose();
      await Promise.allSettled([...active.values()].map(item => item.done));
    },
  };
}
