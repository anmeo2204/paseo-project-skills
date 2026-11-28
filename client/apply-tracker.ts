import { z } from "zod";
import {
  applyOutputSchema,
  operationIdSchema,
  type ApplyCreateInput,
  type ApplyOperation,
  type ApplyOperationSummary,
} from "../shared/apply";

export type OperationScope = {
  hostId: string; slot: string; target?: string; pinnedSha?: string; installationInstanceId?: string;
};
export type TrackedOperation = {
  scope: OperationScope; operationId: string; planDigest: string;
  state: "sending" | "operation" | "busy" | "rejected" | "outcome_unknown";
  source?: "local" | "discovered" | "lookup";
  operation?: ApplyOperation;
  summary?: ApplyOperationSummary;
  code?: string;
};

type Rpc<Input> = (input: Input) => Promise<unknown>;

const phaseRanks: Record<ApplyOperation["phase"], number> = {
  accepted: 0,
  preflight: 1,
  writing: 2,
  completed: 3,
  failed_before_write: 3,
  partial_failure: 3,
  recovery_required: 3,
};

// Monotonic per-destination ledger state progression: not_attempted -> attempted/incomplete -> verified.
const ledgerStateRanks: Record<ApplyOperation["ledger"][number]["state"], number> = {
  not_attempted: 0,
  created_incomplete: 1,
  observation_changed: 1,
  ownership_unknown: 1,
  unchanged_verified: 2,
  created_verified: 2,
};

function ledgerProgress(ledger: ApplyOperation["ledger"]) {
  let attempted = 0;
  let verified = 0;
  let rankSum = 0;
  for (const row of ledger) {
    const rank = ledgerStateRanks[row.state];
    if (rank > 0) attempted++;
    if (rank === 2) verified++;
    rankSum += rank;
  }
  return { attempted, verified, rankSum };
}

function hasLedgerRegression(existing: ApplyOperation["ledger"], incoming: ApplyOperation["ledger"]): boolean {
  const byDest = new Map<string, number>();
  for (const row of existing) byDest.set(row.destination, ledgerStateRanks[row.state]);
  for (const row of incoming) {
    const prev = byDest.get(row.destination);
    if (prev !== undefined && ledgerStateRanks[row.state] < prev) return true;
  }
  return false;
}

const isTerminalPhase = (phase: ApplyOperation["phase"] | undefined) =>
  phase === "completed" || phase === "failed_before_write" || phase === "partial_failure" || phase === "recovery_required";

const durabilityRank = (durability: ApplyOperation["durability"]) => (durability === "fsync_completed" ? 1 : 0);

/**
 * P7: Shared, deterministic freshness comparison for full ApplyOperation updates.
 * Prevents phase regression, same-phase ledger regression, and conflicting terminal overwrites,
 * while permitting legitimate daemon-restart transitions (e.g. writing -> recovery_required)
 * and lazy ledger hydration when only a summary was held.
 */
export function shouldAcceptOperation(existing: Pick<TrackedOperation, "operation" | "summary">, incoming: ApplyOperation): boolean {
  if (existing.operation) {
    const current = existing.operation;
    const currentRank = phaseRanks[current.phase];
    const incomingRank = phaseRanks[incoming.phase];
    if (isTerminalPhase(current.phase)) {
      if (!isTerminalPhase(incoming.phase) || incoming.phase !== current.phase) return false;
      if (hasLedgerRegression(current.ledger, incoming.ledger)) return false;
      const prevProg = ledgerProgress(current.ledger);
      const nextProg = ledgerProgress(incoming.ledger);
      if (nextProg.verified < prevProg.verified || nextProg.attempted < prevProg.attempted || nextProg.rankSum < prevProg.rankSum) {
        return false;
      }
      if (durabilityRank(incoming.durability) < durabilityRank(current.durability)) return false;
      // Only update an already-settled full operation if it strictly advances metadata.
      return nextProg.verified > prevProg.verified || nextProg.attempted > prevProg.attempted ||
        nextProg.rankSum > prevProg.rankSum || durabilityRank(incoming.durability) > durabilityRank(current.durability);
    }
    if (incomingRank < currentRank) return false;
    if (incomingRank > currentRank) return true;
    // Same non-terminal phase (e.g. writing -> writing): validate monotonic ledger state progression.
    if (hasLedgerRegression(current.ledger, incoming.ledger)) return false;
    const prevProg = ledgerProgress(current.ledger);
    const nextProg = ledgerProgress(incoming.ledger);
    if (nextProg.attempted < prevProg.attempted || nextProg.verified < prevProg.verified || nextProg.rankSum < prevProg.rankSum) {
      return false;
    }
    if (current.targetMutated === true && incoming.targetMutated === false) return false;
    if (durabilityRank(incoming.durability) < durabilityRank(current.durability)) return false;
    return true;
  }
  if (existing.summary) {
    const summaryRank = phaseRanks[existing.summary.phase];
    const incomingRank = phaseRanks[incoming.phase];
    if (incomingRank < summaryRank) return false;
    // If summary is already terminal, require matching terminal phase when hydrating ledger.
    if (isTerminalPhase(existing.summary.phase) && incoming.phase !== existing.summary.phase) return false;
    return true;
  }
  return true;
}

/**
 * P7: Shared, deterministic freshness comparison for discovered ApplyOperationSummary updates.
 * Never overwrites a full ApplyOperation at the same/higher rank and rejects older same-phase summaries.
 */
export function shouldAcceptSummary(existing: Pick<TrackedOperation, "operation" | "summary">, incoming: ApplyOperationSummary): boolean {
  const incomingRank = phaseRanks[incoming.phase];
  if (existing.operation) {
    if (isTerminalPhase(existing.operation.phase)) return false;
    return incomingRank > phaseRanks[existing.operation.phase];
  }
  if (existing.summary) {
    const current = existing.summary;
    const currentRank = phaseRanks[current.phase];
    if (isTerminalPhase(current.phase)) return false;
    if (incomingRank < currentRank) return false;
    if (incomingRank > currentRank) return true;
    // Same non-terminal phase: reject older updatedAt or regressed mutation/durability metadata.
    if (incoming.updatedAt < current.updatedAt) return false;
    if (current.targetMutated === true && incoming.targetMutated === false) return false;
    if (durabilityRank(incoming.durability) < durabilityRank(current.durability)) return false;
    return incoming.updatedAt > current.updatedAt ||
      incoming.targetMutated !== current.targetMutated ||
      incoming.code !== current.code ||
      incoming.durability !== current.durability;
  }
  return true;
}

const terminal = (item: TrackedOperation) => item.state === "busy" || item.state === "rejected" ||
  (item.state === "operation" && isTerminalPhase(item.operation?.phase ?? item.summary?.phase));

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const persistedSchema = z.array(z.strictObject({
  hostId: z.string().min(1).max(256), operationId: operationIdSchema, planDigest: z.string().regex(/^[a-f0-9]{64}$/),
}));

export function createOperationTracker(persistence?: { slot: string; storage: () => Storage }) {
  const key = "project-skills.apply-operations.v1:" + persistence?.slot;
  let storage: Storage | undefined;
  let snapshot: readonly TrackedOperation[] = [];
  function restore() {
    if (!persistence) return;
    try {
      const candidate = persistence.storage();
      const rows = persistedSchema.parse(JSON.parse(candidate.getItem(key) ?? "[]"));
      const known = new Set(snapshot.map(row => row.operationId));
      const restored: TrackedOperation[] = [];
      for (const { hostId, operationId, planDigest } of rows) {
        if (known.has(operationId)) continue;
        known.add(operationId);
        restored.push({ scope: { hostId, slot: persistence.slot }, operationId, planDigest, state: "outcome_unknown", source: "local" });
      }
      storage = candidate;
      if (restored.length) {
        snapshot = [...restored, ...snapshot];
        for (const listener of listeners) listener();
      }
    } catch { storage = undefined; }
  }
  restore();
  function remember(item: TrackedOperation) {
    if (!persistence) return;
    if (!storage || item.scope.slot !== persistence.slot) throw new Error("tracking_unavailable");
    const rows = persistedSchema.parse(JSON.parse(storage.getItem(key) ?? "[]"));
    const { operationId, planDigest, scope: { hostId } } = item;
    storage.setItem(key, JSON.stringify([{ hostId, operationId, planDigest }, ...rows.filter(row => row.operationId !== operationId)]));
  }
  const listeners = new Set<() => void>();
  const statusRequests = new Map<string, object>();
  function put(item: TrackedOperation) {
    const index = snapshot.findIndex(row => row.operationId === item.operationId);
    snapshot = index === -1 ? [item, ...snapshot] : snapshot.map((row, i) => i === index ? item : row);
    for (const listener of listeners) listener();
  }

  async function settle(item: TrackedOperation, request: () => Promise<unknown>, statusToken?: object, allowLedgerHydrate = false) {
    let raw: unknown;
    try { raw = await request(); } catch { /* Transport loss leaves the outcome unknown. */ }
    if (statusToken && statusRequests.get(item.operationId) !== statusToken) return;
    const current = snapshot.find(row => row.operationId === item.operationId);
    if (!current) return;
    if (terminal(current) && !(allowLedgerHydrate && !current.operation)) return;
    const parsed = applyOutputSchema.safeParse(raw);
    if (parsed.success && parsed.data.status === "operation" && parsed.data.operationId === item.operationId &&
        parsed.data.planDigest === item.planDigest) {
      const result = parsed.data;
      // P2 & P7: Shared deterministic freshness check prevents phase and same-phase ledger regression.
      if (!shouldAcceptOperation(current, result)) return;
      put({ ...current, state: "operation", operation: result, code: undefined });
    } else if (!statusToken && parsed.success && parsed.data.status === "error" &&
        parsed.data.code !== "outcome_unknown" && !current.operation && !current.summary) {
      put({ ...current, state: parsed.data.code === "busy" ? "busy" : "rejected", code: parsed.data.code });
    } else if (!current.summary) {
      put({ ...current, state: "outcome_unknown", code: "outcome_unknown" });
    }
  }

  return {
    restore,
    releaseStatus(hostId: string, slot: string) {
      for (const item of snapshot) if (item.scope.hostId === hostId && item.scope.slot === slot)
        statusRequests.delete(item.operationId);
    },
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // P4: Retain synchronous tracking-before-submit and tracking_unavailable fail-closed semantics.
    submit(scope: OperationScope, input: ApplyCreateInput, rpc: Rpc<ApplyCreateInput>) {
      if (snapshot.some(row => row.operationId === input.operationId)) return;
      const item: TrackedOperation = {
        scope, operationId: input.operationId, planDigest: input.planDigest, state: "sending", source: "local",
      };
      try { remember(item); }
      catch {
        put({ ...item, state: "rejected", code: "tracking_unavailable" });
        return;
      }
      put(item);
      void settle(item, () => rpc(input));
    },
    offline(hostId: string, slot: string) {
      for (const item of snapshot) {
        if (item.scope.hostId !== hostId || item.scope.slot !== slot || terminal(item)) continue;
        statusRequests.delete(item.operationId);
        if (item.state !== "outcome_unknown") put({ ...item, state: "outcome_unknown" });
      }
    },
    check(hostId: string, slot: string, rpc: Rpc<{ operationId: string }>, operationId?: string) {
      for (const item of snapshot) {
        if (item.scope.hostId !== hostId || item.scope.slot !== slot) continue;
        if (operationId && operationId !== item.operationId) continue;
        const needsLedger = Boolean(operationId && item.summary && !item.operation);
        if ((terminal(item) && !needsLedger) || statusRequests.has(item.operationId)) continue;
        const token = {};
        statusRequests.set(item.operationId, token);
        void settle(item, () => rpc({ operationId: item.operationId }), token, needsLedger).finally(() => {
          if (statusRequests.get(item.operationId) === token) statusRequests.delete(item.operationId);
        });
      }
    },
    // P2: Deterministic merge of discovered summaries — never regresses terminal phases or overwrites fresher status.
    ingestDiscovered(hostId: string, slot: string, summaries: readonly ApplyOperationSummary[]) {
      let changed = false;
      const next = [...snapshot];
      for (const summary of summaries) {
        const index = next.findIndex((row) => row.operationId === summary.operationId);
        if (index === -1) {
          next.push({
            scope: { hostId, slot },
            operationId: summary.operationId,
            planDigest: summary.planDigest,
            state: "operation",
            source: "discovered",
            summary,
          });
          changed = true;
          continue;
        }
        const existing = next[index];
        if (existing.scope.hostId !== hostId || existing.scope.slot !== slot) continue;
        if (existing.planDigest !== summary.planDigest) continue;
        if (existing.state === "busy" || existing.state === "rejected") continue;
        if (!shouldAcceptSummary(existing, summary)) continue;
        const existingPhase = existing.operation?.phase ?? existing.summary?.phase;
        const existingRank = existingPhase ? phaseRanks[existingPhase] : -1;
        const incomingRank = phaseRanks[summary.phase];
        next[index] = {
          ...existing,
          state: "operation",
          summary,
          ...(incomingRank > existingRank ? { operation: undefined } : {}),
          code: undefined,
        };
        changed = true;
      }
      if (changed) {
        snapshot = next;
        for (const listener of listeners) listener();
      }
    },
    // P1 & P5: Clear discovery-only cached entries on Relay/trust denial without discarding local/unresolved entries.
    clearDiscoveryOnly(hostId: string, slot: string) {
      const filtered = snapshot.filter((item) =>
        !(item.scope.hostId === hostId && item.scope.slot === slot && item.source === "discovered"),
      );
      if (filtered.length !== snapshot.length) {
        snapshot = filtered;
        for (const listener of listeners) listener();
      }
    },
    // Manual known-ID recovery lookup through apply.status.v1 (coordinated with statusRequests & freshness checks).
    async lookup(
      hostId: string,
      slot: string,
      operationId: string,
      rpc: Rpc<{ operationId: string }>,
    ): Promise<{ status: "found"; operation: ApplyOperation } | { status: "unknown" }> {
      const token = {};
      statusRequests.set(operationId, token);
      let raw: unknown;
      let stale = false;
      try {
        raw = await rpc({ operationId });
        stale = statusRequests.get(operationId) !== token;
      } catch {
        return { status: "unknown" };
      } finally {
        if (statusRequests.get(operationId) === token) statusRequests.delete(operationId);
      }
      if (stale) return { status: "unknown" };
      const parsed = applyOutputSchema.safeParse(raw);
      if (!parsed.success || parsed.data.status !== "operation" || parsed.data.operationId !== operationId) {
        return { status: "unknown" };
      }
      const op = parsed.data;
      const existing = snapshot.find((row) => row.operationId === operationId);
      if (existing) {
        if (existing.scope.hostId !== hostId || existing.scope.slot !== slot) return { status: "unknown" };
        if (existing.planDigest !== op.planDigest) return { status: "unknown" };
        const accepted = shouldAcceptOperation(existing, op);
        if (accepted) {
          put({ ...existing, state: "operation", operation: op, code: undefined });
        }
        return { status: "found", operation: !accepted && existing.operation ? existing.operation : op };
      } else {
        put({
          scope: { hostId, slot },
          operationId: op.operationId,
          planDigest: op.planDigest,
          state: "operation",
          source: "lookup",
          operation: op,
        });
      }
      return { status: "found", operation: op };
    },
  };
}
export type OperationTracker = ReturnType<typeof createOperationTracker>;
