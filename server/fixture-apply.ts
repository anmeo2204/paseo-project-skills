import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import {
  applyCreateInputSchema,
  applyListInputSchema,
  applyListOutputSchema,
  applyOperationSummarySchema,
  applyStatusInputSchema,
  type ApplyCreateInput,
  type ApplyListOutput,
  type ApplyOperation,
  type ApplyOperationSummary,
  type ApplyOutput,
} from "../shared/apply";
import { createCanonicalPreviewHandler } from "./canonical-preview";
import { ApplyJournal, journalListLimits, type ApplyJournalRecord } from "./apply-journal";
import { canonicalSerialize, manifestDigest, PreviewReceiptStore } from "./preview-receipts";
import { fixtureWriterRequest, singleProjectWriterRequest, type NativeControls, type NativeWriterRequest, type NativeWriterResult } from "./native-writer-contract";
import { runFixtureWriter, runSingleProjectWriter, type FixtureWriterOptions } from "./native-writer";
import { pilotRuntimeDirectory, toEnrollmentBinding, type ActiveSingleProjectPolicy } from "./single-project-policy";
import { multiRootRuntimeDirectory } from "./multi-root-policy";
import { checkDaemonTrustBoundary, resolveSafeDaemonHome } from "./compatibility-policy";

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

const priorityOf = (phase: ApplyOperation["phase"]): 0 | 1 =>
  phase === "completed" || phase === "failed_before_write" ? 1 : 0;

function parseCursor(cursor: string): { priority: 0 | 1; updatedAt: number; operationId: string } {
  const [p, ts, id] = cursor.split(":");
  return { priority: p === "0" ? 0 : 1, updatedAt: Number(ts), operationId: id };
}

function afterCursor(
  item: { priority: 0 | 1; updatedAt: number; operationId: string },
  cursor: { priority: 0 | 1; updatedAt: number; operationId: string },
): boolean {
  if (item.priority !== cursor.priority) return item.priority > cursor.priority;
  if (item.updatedAt !== cursor.updatedAt) return item.updatedAt < cursor.updatedAt;
  return item.operationId > cursor.operationId;
}

export function listJournalSummaries(options: {
  journal: Pick<ApplyJournal, "list">;
  hostId: string;
  installation: string;
  rawInput: unknown;
  reportOperation: (record: ApplyJournalRecord) => ApplyOperation;
  limits?: Partial<typeof journalListLimits>;
}): ApplyListOutput {
  const parsed = applyListInputSchema.safeParse(options.rawInput);
  if (!parsed.success) return { status: "error", code: "invalid_request" };
  const limit = parsed.data.limit ?? journalListLimits.defaultLimit;
  const cursor = parsed.data.cursor ? parseCursor(parsed.data.cursor) : undefined;
  const maxResponseBytes = options.limits?.maxResponseBytes ?? journalListLimits.maxResponseBytes;

  let listed: ReturnType<ApplyJournal["list"]>;
  try {
    listed = options.journal.list({
      hostId: options.hostId,
      installation: options.installation,
      limits: options.limits,
    });
  } catch {
    return { status: "error", code: "journal_unavailable" };
  }

  const ranked = listed.entries.map(({ record, updatedAt }) => {
    const op = options.reportOperation(record);
    const summary: ApplyOperationSummary = applyOperationSummarySchema.parse({
      operationId: op.operationId,
      planDigest: op.planDigest,
      phase: op.phase,
      code: op.code,
      targetMutated: op.targetMutated,
      requiresPreview: op.requiresPreview,
      durability: op.durability,
      ledgerCount: op.ledger.length,
      updatedAt,
    });
    return { summary, priority: priorityOf(op.phase), updatedAt, operationId: op.operationId };
  });

  // P3: Deterministic priority ordering (recovery/active first, then newest updatedAt, then operationId).
  ranked.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0;
  });

  const filtered = cursor ? ranked.filter((item) => afterCursor(item, cursor)) : ranked;
  const items: ApplyOperationSummary[] = [];
  let bytes = 256;
  let lastIncluded: (typeof filtered)[number] | undefined;

  for (const row of filtered) {
    if (items.length >= limit) break;
    const rowBytes = Buffer.byteLength(JSON.stringify(row.summary)) + 1;
    if (items.length > 0 && bytes + rowBytes > maxResponseBytes) break;
    bytes += rowBytes;
    items.push(row.summary);
    lastIncluded = row;
  }

  const hasMore = filtered.length > items.length;
  const nextCursor = hasMore && lastIncluded
    ? `${lastIncluded.priority}:${lastIncluded.updatedAt}:${lastIncluded.operationId}`
    : undefined;

  return applyListOutputSchema.parse({
    status: "ready",
    items,
    ...(nextCursor ? { nextCursor } : {}),
    unreadableCount: listed.unreadableCount,
    truncated: listed.truncated,
  });
}

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

type SingleProjectConfiguration = {
  daemonHome: string;
  installation: string;
  readPolicy: () => ActiveSingleProjectPolicy | undefined;
  receipts: PreviewReceiptStore;
  settings: Parameters<typeof createCanonicalPreviewHandler>[0];
  catalog: Parameters<typeof createCanonicalPreviewHandler>[1];
  environment: NativeWriterRequest["environment"];
  test?: FixtureConfiguration["test"];
};

export function createFixtureApply(config: FixtureConfiguration) {
  const base = realpathSync(config.fixtureBase);
  const home = process.env.PASEO_HOME;
  if (!home || !beneath(base, home) || realpathSync(home) !== home || !lstatSync(home).isDirectory())
    throw new Error("fixture_daemon_home_required");
  const coordinator = join(home, "runtime", "project-skills-m44");
  const allowsTarget = (target: string) => isFixtureApplyTarget(base, target, home) && (config.targetAllowed?.(target) ?? true);
  return createApplyEngine({
    coordinator,
    installation: config.installation,
    receipts: config.receipts,
    settings: config.settings,
    catalog: config.catalog,
    environment: config.environment,
    test: config.test,
    revalidationStore: () => new PreviewReceiptStore(config.receipts.policy.writeCapability === "fixture_m4_5" ? { fixtureApply: allowsTarget } : {}),
    prepareWrite(manifest, planDigest, sources, controls) {
      if (!allowsTarget(manifest.plan.intent.canonicalDirectory)) return { ok: false, code: "unsupported_environment" };
      const request = { ...fixtureWriterRequest({ fixtureBase: base, manifest, planDigest, sources,
        environment: config.environment, coordinator, controls }), durableAdmission: true as const };
      return {
        ok: true,
        directories: request.directories,
        files: request.files,
        checkBeforeAdmit: () => undefined,
        run: (options) => runFixtureWriter(request, options),
      };
    },
  });
}

export function createSingleProjectApply(config: SingleProjectConfiguration) {
  const home = realpathSync(config.daemonHome);
  if (process.env.PASEO_HOME !== home || !lstatSync(home).isDirectory())
    throw new Error("pilot_daemon_home_required");
  const runtime = join(home, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const pilotDir = pilotRuntimeDirectory(home);
  mkdirSync(pilotDir, { recursive: true, mode: 0o700 });
  const coordinator = join(pilotDir, "coordinator");
  mkdirSync(coordinator, { recursive: true, mode: 0o700 });
  return createApplyEngine({
    coordinator,
    installation: config.installation,
    receipts: config.receipts,
    settings: config.settings,
    catalog: config.catalog,
    environment: config.environment,
    test: config.test,
    requireCreateEntries: true,
    revalidationStore: () => new PreviewReceiptStore({
      singleProject: () => {
        const policy = config.readPolicy();
        return policy ? toEnrollmentBinding(policy) : undefined;
      },
    }),
    prepareWrite(manifest, planDigest, sources, controls) {
      const policy = config.readPolicy();
      if (!policy) return { ok: false, code: "receipt_invalid" };
      if (manifest.plan.intent.canonicalDirectory !== policy.canonicalRoot) return { ok: false, code: "unsupported_environment" };
      const request = { ...singleProjectWriterRequest({ enrollment: policy, manifest, planDigest, sources,
        environment: config.environment, coordinator, controls }), durableAdmission: true as const };
      return {
        ok: true,
        directories: request.directories,
        files: request.files,
        checkBeforeAdmit: () => {
          const live = config.readPolicy();
          if (!live || live.policyRevision !== policy.policyRevision || live.canonicalRoot !== policy.canonicalRoot) {
            return "receipt_invalid";
          }
          return undefined;
        },
        run: (options) => runSingleProjectWriter(request, options),
      };
    },
  });
}

type MultiRootConfiguration = {
  daemonHome?: string;
  installation: string;
  readPolicy: (canonicalRoot: string) => ActiveSingleProjectPolicy | undefined;
  checkTrustBoundary?: (daemonHome: string) => { ok: true } | { ok: false; reason: string };
  receipts: PreviewReceiptStore;
  settings: Parameters<typeof createCanonicalPreviewHandler>[0];
  catalog: Parameters<typeof createCanonicalPreviewHandler>[1];
  environment: NativeWriterRequest["environment"];
  test?: FixtureConfiguration["test"];
};

export function createMultiRootApply(config: MultiRootConfiguration) {
  const resolved = resolveSafeDaemonHome(config.daemonHome);
  if (!resolved.ok) throw new Error(resolved.reason);
  const home = resolved.daemonHome;
  const verifyTrust = () => (config.checkTrustBoundary ?? checkDaemonTrustBoundary)(home);
  const initialTrust = verifyTrust();
  if (!initialTrust.ok) throw new Error(initialTrust.reason);

  const runtime = join(home, "runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const baseDir = multiRootRuntimeDirectory(home);
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const coordinator = join(baseDir, "coordinator");
  mkdirSync(coordinator, { recursive: true, mode: 0o700 });

  return createApplyEngine({
    coordinator,
    installation: config.installation,
    receipts: config.receipts,
    settings: config.settings,
    catalog: config.catalog,
    environment: config.environment,
    test: config.test,
    requireCreateEntries: true,
    revalidationStore: () => new PreviewReceiptStore({
      multiRoot: (target) => {
        if (!verifyTrust().ok) return undefined;
        const policy = config.readPolicy(target);
        return policy ? toEnrollmentBinding(policy) : undefined;
      },
    }),
    prepareWrite(manifest, planDigest, sources, controls) {
      if (!verifyTrust().ok) return { ok: false, code: "unsupported_environment" };
      const target = manifest.plan.intent.canonicalDirectory;
      const policy = config.readPolicy(target);
      if (!policy) return { ok: false, code: "receipt_invalid" };
      if (target !== policy.canonicalRoot) return { ok: false, code: "unsupported_environment" };
      const request = { ...singleProjectWriterRequest({ enrollment: policy, manifest, planDigest, sources,
        environment: config.environment, coordinator, controls }), durableAdmission: true as const };
      return {
        ok: true,
        directories: request.directories,
        files: request.files,
        checkBeforeAdmit: () => {
          if (!verifyTrust().ok) return "unsupported_environment";
          const live = config.readPolicy(target);
          if (!live || live.policyRevision !== policy.policyRevision || live.canonicalRoot !== policy.canonicalRoot) {
            return "receipt_invalid";
          }
          return undefined;
        },
        run: (options) => runSingleProjectWriter(request, options),
      };
    },
  });
}

type PreparedWrite =
  | { ok: false; code: ErrorCode }
  | {
      ok: true;
      directories: { destination: string; mode: 493 }[];
      files: { destination: string }[];
      checkBeforeAdmit: () => ErrorCode | undefined;
      run: (options: FixtureWriterOptions) => ReturnType<typeof runFixtureWriter>;
    };

type EngineConfiguration = {
  coordinator: string;
  installation: string;
  receipts: PreviewReceiptStore;
  settings: Parameters<typeof createCanonicalPreviewHandler>[0];
  catalog: Parameters<typeof createCanonicalPreviewHandler>[1];
  environment: NativeWriterRequest["environment"];
  test?: FixtureConfiguration["test"];
  requireCreateEntries?: boolean;
  revalidationStore: () => PreviewReceiptStore;
  prepareWrite: (
    manifest: Parameters<typeof fixtureWriterRequest>[0]["manifest"],
    planDigest: string,
    sources: Parameters<typeof fixtureWriterRequest>[0]["sources"],
    controls: NativeControls | undefined,
  ) => PreparedWrite;
};

function createApplyEngine(config: EngineConfiguration) {
  const journal = new ApplyJournal(config.coordinator);
  const active = new Map<string, { requestHash: string; done: Promise<ApplyOutput> }>();
  const stop = new AbortController();
  const revalidation = createCanonicalPreviewHandler(config.settings, config.catalog, {
    receiptStore: config.revalidationStore(),
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
    const entries = [...manifest.plan.entries, ...manifest.plan.derivedEntries];
    if (entries.some(item => item.status === "conflict" || item.status === "blocked") ||
        (config.requireCreateEntries && !entries.some(item => item.status === "create")) ||
        manifest.readSet.some(item => item.observation.state === "unverified" ||
          item.observation.state === "present" && item.observation.kind === "unsafe"))
      return error("plan_not_applicable");
    if (stop.signal.aborted) return error("cancelled");
    const controls = config.test?.controls?.(input);
    const prepared = config.prepareWrite(manifest, input.planDigest, sources, controls);
    if (!prepared.ok) return error(prepared.code);

    const byDestination = new Map(manifest.sources.map(source => [source.destination, source]));
    const record: ApplyJournalRecord = {
      hostId, installation: config.installation, instance: config.receipts.installationInstanceId,
      requestHash, receiptHash: hash("apply-receipt-v1", input.previewId),
      operation: {
        status: "operation", operationId: input.operationId, planDigest: input.planDigest,
        phase: "accepted", code: "none", targetMutated: "unknown", requiresPreview: false, durability: "not_confirmed",
        ledger: [
          ...prepared.directories.map(item => ({ destination: item.destination, kind: "directory" as const, state: "not_attempted" as const })),
          ...prepared.files.map(item => {
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

    const outcome = await prepared.run({
      testing: Boolean(controls), onEvent: config.test?.onEvent, onExtracted: config.test?.onExtracted, signal: stop.signal,
      onAdmission: async () => {
        if (stop.signal.aborted) { denied = error("cancelled"); return false; }
        try {
          denied = lookup();
          if (denied) return false;
          const policyErr = prepared.checkBeforeAdmit();
          if (policyErr) { denied = error(policyErr); return false; }
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
    async list(raw: unknown, context: Context): Promise<ApplyListOutput> {
      try {
        const hostId = await host(context);
        return listJournalSummaries({
          journal,
          hostId,
          installation: config.installation,
          rawInput: raw,
          reportOperation: report,
        });
      } catch {
        return { status: "error", code: "journal_unavailable" };
      }
    },
    async dispose() {
      stop.abort();
      await revalidation.dispose();
      await Promise.allSettled([...active.values()].map(item => item.done));
    },
  };
}
