import { z } from "zod";
import { applyOutputSchema, operationIdSchema, type ApplyCreateInput, type ApplyOperation } from "../shared/apply";

export type OperationScope = {
  hostId: string; slot: string; target?: string; pinnedSha?: string; installationInstanceId?: string;
};
export type TrackedOperation = {
  scope: OperationScope; operationId: string; planDigest: string;
  state: "sending" | "operation" | "busy" | "rejected" | "outcome_unknown";
  operation?: ApplyOperation; code?: string;
};

type Rpc<Input> = (input: Input) => Promise<unknown>;
const terminal = (item: TrackedOperation) => item.state === "busy" || item.state === "rejected" ||
  (item.state === "operation" && item.operation &&
    ["completed", "failed_before_write", "partial_failure", "recovery_required"].includes(item.operation.phase));

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
        restored.push({ scope: { hostId, slot: persistence.slot }, operationId, planDigest, state: "outcome_unknown" });
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

  async function settle(item: TrackedOperation, request: () => Promise<unknown>, statusToken?: object) {
    let raw: unknown;
    try { raw = await request(); } catch { /* Transport loss leaves the outcome unknown. */ }
    if (statusToken && statusRequests.get(item.operationId) !== statusToken) return;
    const current = snapshot.find(row => row.operationId === item.operationId);
    if (!current || terminal(current)) return;
    const parsed = applyOutputSchema.safeParse(raw);
    if (parsed.success && parsed.data.status === "operation" && parsed.data.operationId === item.operationId &&
        parsed.data.planDigest === item.planDigest) {
      const result = parsed.data;
      // An older status request may arrive after a newer create reply.
      const ranks = { accepted: 0, preflight: 1, writing: 2 };
      if (current.operation && result.phase in ranks &&
          ranks[result.phase as keyof typeof ranks] < (ranks[current.operation.phase as keyof typeof ranks] ?? 3)) return;
      put({ ...current, state: "operation", operation: result, code: undefined });
    } else if (!statusToken && parsed.success && parsed.data.status === "error" &&
        parsed.data.code !== "outcome_unknown" && !current.operation) {
      put({ ...current, state: parsed.data.code === "busy" ? "busy" : "rejected", code: parsed.data.code });
    } else put({ ...current, state: "outcome_unknown", code: "outcome_unknown" });
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
    submit(scope: OperationScope, input: ApplyCreateInput, rpc: Rpc<ApplyCreateInput>) {
      if (snapshot.some(row => row.operationId === input.operationId)) return;
      const item = { scope, operationId: input.operationId, planDigest: input.planDigest, state: "sending" as const };
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
        if (item.scope.hostId !== hostId || item.scope.slot !== slot || terminal(item) ||
            (operationId && operationId !== item.operationId) || statusRequests.has(item.operationId)) continue;
        const token = {};
        statusRequests.set(item.operationId, token);
        void settle(item, () => rpc({ operationId: item.operationId }), token).finally(() => {
          if (statusRequests.get(item.operationId) === token) statusRequests.delete(item.operationId);
        });
      }
    },
  };
}
export type OperationTracker = ReturnType<typeof createOperationTracker>;
