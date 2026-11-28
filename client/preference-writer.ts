import {
  applyWorkspacePreferenceMutations,
  type WorkspacePreferenceMutation,
  type WorkspacePreferencesValues,
} from "../shared/workspace-preferences";

export type PreferenceSettingsSnapshot =
  | { status: "loading" | "error" | "invalid"; reload(): Promise<void> }
  | {
    status: "ready";
    revision: string;
    values: WorkspacePreferencesValues;
    save(values: WorkspacePreferencesValues, revision: string): Promise<boolean>;
    reload(): Promise<void>;
  };

/**
 * Coalesces a batch of pending mutations so rapid toggles for the same root keep
 * only the latest selection while preserving chronological ordering across roots.
 */
export function coalesceMutations(
  mutations: readonly WorkspacePreferenceMutation[],
): WorkspacePreferenceMutation[] {
  const result: WorkspacePreferenceMutation[] = [];
  for (const mutation of mutations) {
    if (mutation.type === "set_providers") {
      const idx = result.findIndex(
        (item) => item.type === "set_providers" && item.canonicalDirectory === mutation.canonicalDirectory,
      );
      if (idx !== -1) result.splice(idx, 1);
      result.push(mutation);
    } else if (mutation.type === "record_recent" || mutation.type === "remove_recent") {
      const idx = result.findIndex(
        (item) =>
          (item.type === "record_recent" || item.type === "remove_recent") &&
          item.canonicalDirectory === mutation.canonicalDirectory,
      );
      if (idx !== -1) result.splice(idx, 1);
      result.push(mutation);
    }
  }
  return result;
}

/**
 * P1: Serialized, coalescing preference writer with at-most-once optimistic concurrency retry.
 * Convenience persistence only: failures never throw or block Scan, Preview, or Apply.
 */
export function createPreferenceWriter(options: {
  getState: () => PreferenceSettingsSnapshot;
  waitForRefresh?: () => Promise<void>;
}) {
  const waitForRefresh = options.waitForRefresh ?? (() => Promise.resolve());
  let pending: WorkspacePreferenceMutation[] = [];
  let running: Promise<void> | null = null;
  let disposed = false;

  async function flushLoop() {
    try {
      while (!disposed && pending.length > 0) {
        const batch = coalesceMutations(pending);
        pending = [];

        const initial = options.getState();
        if (disposed || initial.status !== "ready") continue;

        const merged = applyWorkspacePreferenceMutations(initial.values, batch);
        let saved = false;
        try {
          saved = await initial.save(merged, initial.revision);
        } catch {
          saved = false;
        }
        if (disposed || saved) continue;

        // Optimistic concurrency conflict: reload latest settings, merge only this batch, and retry at most once.
        try {
          await initial.reload();
          await waitForRefresh();
        } catch {
          continue;
        }
        if (disposed) return;

        const refreshed = options.getState();
        if (refreshed.status !== "ready") continue;

        // Include any newer mutations queued while reloading so an obsolete write never overwrites them.
        const combined = pending.length > 0 ? coalesceMutations([...batch, ...pending]) : batch;
        pending = [];
        const remerged = applyWorkspacePreferenceMutations(refreshed.values, combined);
        try {
          await refreshed.save(remerged, refreshed.revision);
        } catch {
          // Convenience persistence fails silently and never blocks Scan, Preview, or Apply.
        }
      }
    } finally {
      running = null;
      if (!disposed && pending.length > 0) {
        running = flushLoop();
      }
    }
  }

  return {
    enqueue(mutation: WorkspacePreferenceMutation): Promise<void> {
      if (disposed) return Promise.resolve();
      pending.push(mutation);
      if (!running) running = flushLoop();
      return running;
    },
    dispose() {
      disposed = true;
      pending = [];
    },
    isDisposed() {
      return disposed;
    },
  };
}
