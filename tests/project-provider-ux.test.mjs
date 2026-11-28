import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import renderer from "react-test-renderer";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { FoundationScreen } from "../client/foundation-screen.tsx";
import { coalesceMutations, createPreferenceWriter } from "../client/preference-writer.ts";
import { catalogSource } from "../shared/catalog-settings.ts";
import {
  applyWorkspacePreferenceMutation,
  lookupProviderPreference,
  workspacePreferenceLimits,
  workspacePreferencesSchema,
} from "../shared/workspace-preferences.ts";
import { HostFixture } from "./client-fixture.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const sha = "a".repeat(40);

test("workspacePreferencesSchema enforces 8 recent projects, 32 root LRU cap, and explicit empty providers (D4, P3)", () => {
  let state = workspacePreferencesSchema.parse({});
  assert.deepEqual(state, { recentProjects: [], providerPreferencesByRoot: {} });

  // Add 10 recent projects -> capped at 8, newest first
  for (let i = 1; i <= 10; i++) {
    state = applyWorkspacePreferenceMutation(state, {
      type: "record_recent",
      canonicalDirectory: `/repo-${i}`,
      label: `Repo ${i}`,
      kind: "Git root",
      now: i * 100,
    });
  }
  assert.equal(state.recentProjects.length, workspacePreferenceLimits.maxRecentProjects);
  assert.equal(state.recentProjects[0].canonicalDirectory, "/repo-10");
  assert.equal(state.recentProjects.at(-1).canonicalDirectory, "/repo-3");

  // P3: Explicit empty provider array is stored and distinguished from missing
  assert.deepEqual(lookupProviderPreference(state, "/repo-10"), { found: false });
  state = applyWorkspacePreferenceMutation(state, {
    type: "set_providers",
    canonicalDirectory: "/repo-10",
    providers: [],
    now: 5000,
  });
  assert.deepEqual(lookupProviderPreference(state, "/repo-10"), { found: true, providers: [] });

  // Add 34 roots -> capped at 32 by updatedAt LRU
  for (let i = 1; i <= 34; i++) {
    state = applyWorkspacePreferenceMutation(state, {
      type: "set_providers",
      canonicalDirectory: `/root-${i}`,
      providers: ["codex"],
      now: 10_000 + i,
    });
  }
  assert.equal(Object.keys(state.providerPreferencesByRoot).length, workspacePreferenceLimits.maxProviderPreferenceRoots);
  assert.equal(lookupProviderPreference(state, "/root-1").found, false);
  assert.equal(lookupProviderPreference(state, "/root-34").found, true);
  assert.deepEqual(workspacePreferencesSchema.parse(state), state);
});

test("P1 createPreferenceWriter serializes writes, coalesces rapid toggles, and retries once on conflict", async () => {
  const coalesced = coalesceMutations([
    { type: "set_providers", canonicalDirectory: "/a", providers: ["codex"], now: 1 },
    { type: "set_providers", canonicalDirectory: "/a", providers: ["codex", "kiro"], now: 2 },
    { type: "set_providers", canonicalDirectory: "/a", providers: [], now: 3 },
  ]);
  assert.equal(coalesced.length, 1);
  assert.deepEqual(coalesced[0].providers, []);

  // Simulate optimistic concurrency conflict on first save, followed by reload + merge + single retry
  let remoteValues = workspacePreferencesSchema.parse({
    recentProjects: [{ canonicalDirectory: "/other", label: "Other", kind: "Git root", lastUsedAt: 10 }],
    providerPreferencesByRoot: {},
  });
  let localValues = workspacePreferencesSchema.parse({});
  let localRevision = "r1";
  let remoteRevision = "r2";
  const saveCalls = [];
  let reloadCalls = 0;

  const firstSave = Promise.withResolvers();
  const writer = createPreferenceWriter({
    getState: () => ({
      status: "ready",
      revision: localRevision,
      values: localValues,
      save: async (values, revision) => {
        saveCalls.push({ values, revision });
        if (saveCalls.length === 1) return firstSave.promise;
        if (revision !== remoteRevision) return false;
        remoteValues = values;
        localValues = values;
        remoteRevision = "r3";
        localRevision = "r3";
        return true;
      },
      reload: async () => {
        reloadCalls++;
        localValues = remoteValues;
        localRevision = remoteRevision;
      },
    }),
  });

  // Enqueue first mutation, then enqueue a newer toggle while first save is in flight
  const p1 = writer.enqueue({ type: "set_providers", canonicalDirectory: "/a", providers: ["codex"], now: 100 });
  const p2 = writer.enqueue({ type: "set_providers", canonicalDirectory: "/a", providers: ["codex", "kiro"], now: 200 });
  // First save conflicts (returns false)
  firstSave.resolve(false);
  await Promise.all([p1, p2]);

  // Reloaded once, merged /other from remote + latest ["codex", "kiro"] (NOT obsolete ["codex"]!)
  assert.equal(reloadCalls, 1);
  assert.equal(saveCalls.length, 2);
  assert.equal(remoteValues.recentProjects[0].canonicalDirectory, "/other");
  assert.deepEqual(remoteValues.providerPreferencesByRoot["/a"].providers, ["codex", "kiro"]);

  // Persistent failure never throws
  const failingWriter = createPreferenceWriter({
    getState: () => ({
      status: "ready",
      revision: "r1",
      values: workspacePreferencesSchema.parse({}),
      save: async () => false,
      reload: async () => { throw new Error("network"); },
    }),
  });
  await failingWriter.enqueue({ type: "set_providers", canonicalDirectory: "/b", providers: ["cursor"], now: 300 });
});

function createUxHarness(t, {
  projects = [],
  workspacePages = [{ entries: [], pageInfo: {} }],
  providerSnapshots = {},
  initialPreferences = { recentProjects: [], providerPreferencesByRoot: {} },
  validateImpl,
  compact = false,
} = {}) {
  let tree;
  const client = new QueryClient();
  let prefValues = workspacePreferencesSchema.parse(initialPreferences);
  let prefRevision = "p1";
  const prefSaves = [];
  const validatedPaths = [];
  let currentHost = "host-a";

  const paseo = {
    projects: { list: async () => ({ projects }) },
    workspaces: {
      list: async ({ page } = {}) => {
        const idx = page?.cursor ? Number(page.cursor) : 0;
        return workspacePages[idx] ?? { entries: [], pageInfo: {} };
      },
    },
    providers: {
      snapshot: async ({ cwd }) => {
        const handler = providerSnapshots[cwd];
        return typeof handler === "function" ? handler() : (handler ?? { entries: [] });
      },
    },
  };

  const invoke = (method, input) => {
    if (method === "target.validate-directory") {
      validatedPaths.push(input.path);
      if (validateImpl) return Promise.resolve(validateImpl(input.path));
      return Promise.resolve({ status: "ready", directory: input.path });
    }
    if (method === "catalog.releases") {
      return Promise.resolve({
        status: "ready", source: catalogSource, settingsRevision: "c1",
        active: { catalogRef: sha, isPinnedSha: true },
        releases: [], latestStable: null, updateStatus: "no_stable_releases", updateAvailable: false, checkedAt: 1, cached: false,
      });
    }
    if (method === "catalog.load") {
      return Promise.resolve({
        status: "ready", settingsRevision: "c1", requestedRef: sha,
        snapshot: {
          schemaVersion: 1, source: catalogSource, commitSha: sha,
          skills: [{ id: "demo", directory: "skills/demo", metadata: { name: "demo", description: "Demo" }, entrypoint: { path: "SKILL.md", blobSha: sha, sizeBytes: 10, mode: "100644" }, supportingFiles: [] }],
        },
      });
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };

  const show = async ({ host = currentHost, status = "online", preferencesOverride } = {}) => {
    currentHost = host;
    const prefState = preferencesOverride ?? {
      status: "ready",
      revision: prefRevision,
      saving: false,
      saveError: null,
      values: prefValues,
      reload: async () => {},
      save: async (nextValues, rev) => {
        prefSaves.push({ host, values: nextValues, revision: rev });
        prefValues = nextValues;
        prefRevision = `p${prefSaves.length + 1}`;
        return true;
      },
    };
    const node = createElement(
      QueryClientProvider,
      { client },
      createElement(
        HostFixture.Provider,
        {
          value: {
            hosts: [{ serverId: host, status }],
            settings: { status: "ready", revision: "c1", values: { catalogRef: sha }, reload: async () => {}, save: async () => true },
            preferences: prefState,
          },
        },
        createElement(
          PaseoApiProvider,
          { paseo },
          createElement(
            PluginRpcProvider,
            { invoke },
            createElement(FoundationScreen, {
              host: { id: host, label: host },
              theme: { colors: {} },
              layout: { compact, platform: compact ? "ios" : "web" },
              params: {},
            }),
          ),
        ),
      ),
    );
    await act(async () => {
      if (tree) tree.update(node);
      else tree = renderer.create(node);
    });
  };

  const unmount = async () => {
    if (tree) await act(async () => tree.unmount());
    tree = undefined;
  };
  t.after(async () => { await unmount(); client.clear(); });

  const button = (label) => tree?.root.findAllByType("pressable").find((node) =>
    node.props.accessibilityLabel === label ||
    node.findAllByType("text").some((tNode) => tNode.children.join("") === label),
  );
  const press = async (label) => {
    const target = button(label);
    assert.ok(target, `Missing button: ${label}`);
    assert.ok(!target.props.disabled, `Disabled button: ${label}`);
    await act(async () => target.props.onPress());
  };
  const input = (label) => tree?.root.findAllByType("input").find((node) => node.props.accessibilityLabel === label);
  const text = () => tree?.root.findAllByType("text").map((node) => node.children.join("")).join("\n") ?? "";

  return { show, unmount, button, press, input, text, prefSaves, validatedPaths };
}

test("P2 searchable picker covers paginated workspaces, preserves exact workspace path, and collapses manual entry", async (t) => {
  const h = createUxHarness(t, {
    projects: [{ projectId: "p1", projectDisplayName: "Alpha Root", projectKind: "git", projectRootPath: "/projects/alpha" }],
    workspacePages: [
      {
        entries: [{ id: "w1", name: "page1-ws", title: "Page One WS", workspaceKind: "worktree", workspaceDirectory: "/worktrees/page1" }],
        pageInfo: { nextCursor: "1" },
      },
      {
        entries: [{ id: "w2", name: "deep-match", title: "Deep Feature Branch", workspaceKind: "worktree", workspaceDirectory: "/worktrees/deep-feature" }],
        pageInfo: {},
      },
    ],
  });

  await h.show();
  // Manual path entry starts collapsed
  assert.equal(h.input("Absolute path on the host"), undefined);
  assert.ok(h.button("Advanced: Enter path manually"));

  await h.press("Choose project or workspace");
  assert.match(h.text(), /Page One WS/);
  assert.match(h.text(), /Deep Feature Branch/);

  // Filter for page-2 workspace
  await act(async () => h.input("Search projects and workspaces").props.onChangeText("deep feature"));
  assert.doesNotMatch(h.text(), /Page One WS/);
  assert.match(h.text(), /Deep Feature Branch/);

  // Selecting workspace passes exact workspaceDirectory (never substituted with projectRootPath)
  await h.press("Deep Feature Branch · Git worktree");
  assert.deepEqual(h.validatedPaths, ["/worktrees/deep-feature"]);
  assert.match(h.text(), /Target directory: \/worktrees\/deep-feature/);
});

test("D2 recent projects do not auto-select, revalidate on click, and offer Remove when deleted", async (t) => {
  const h = createUxHarness(t, {
    initialPreferences: {
      recentProjects: [{ canonicalDirectory: "/deleted-repo", label: "Old Repo", kind: "Git root", lastUsedAt: 100 }],
      providerPreferencesByRoot: {},
    },
    validateImpl: (p) => (p === "/deleted-repo" ? { status: "error", code: "missing" } : { status: "ready", directory: p }),
  });

  await h.show();
  // D2: No automatic selection or validation on mount
  assert.deepEqual(h.validatedPaths, []);
  assert.match(h.text(), /No target directory selected/);

  // Explicit click on Recent Project triggers daemon revalidation and fails closed
  await h.press("Recent project Old Repo");
  assert.deepEqual(h.validatedPaths, ["/deleted-repo"]);
  assert.match(h.text(), /The directory does not exist on this host/);
  assert.ok(h.button("Remove from recent"));

  await h.press("Remove from recent");
  assert.equal(h.prefSaves.at(-1).values.recentProjects.length, 0);
});

test("D3, P3 & P4 Select Detected Providers waits for loading, Clear providers persists [], and empty preference is never overwritten", async (t) => {
  let snapshotMode = "loading";
  const h = createUxHarness(t, {
    compact: true,
    projects: [{ projectId: "p1", projectDisplayName: "App", projectKind: "git", projectRootPath: "/app" }],
    providerSnapshots: {
      "/app": () => snapshotMode === "loading"
        ? { entries: [{ provider: "codex", enabled: true, status: "loading" }, { provider: "kiro", enabled: true, status: "ready" }] }
        : { entries: [{ provider: "codex", enabled: true, status: "ready" }, { provider: "kiro", enabled: true, status: "ready" }, { provider: "cursor", enabled: false, status: "ready" }] },
    },
  });

  await h.show();
  await h.press("Choose project or workspace");
  await h.press("App · Git root");

  // D3: While codex is still loading, Select Detected Providers is disabled
  assert.ok(h.button("Detecting providers…").props.disabled);

  // Switch snapshot to ready and select /app again (new selection generation)
  snapshotMode = "ready";
  await h.press("Choose project or workspace");
  await h.press("App · Git root");

  // Provider status updates NEVER auto-select providers
  assert.ok(!h.button("Select Detected Providers").props.disabled);
  assert.ok(h.button("Codex, ready").props.accessibilityState.checked === false);

  // Explicit Select Detected Providers selects only enabled+ready (codex + kiro, NOT disabled cursor)
  await h.press("Select Detected Providers");
  assert.equal(h.button("Codex, ready, selected").props.accessibilityState.checked, true);
  assert.equal(h.button("Kiro, ready, selected").props.accessibilityState.checked, true);
  assert.equal(h.button("Cursor, unavailable").props.accessibilityState.checked, false);
  assert.deepEqual(h.prefSaves.at(-1).values.providerPreferencesByRoot["/app"].providers, ["codex", "kiro"]);

  // P3: Clear providers persists explicit []
  await h.press("Clear providers");
  assert.deepEqual(h.prefSaves.at(-1).values.providerPreferencesByRoot["/app"].providers, []);

  // Re-selecting /app restores explicit empty preference (never replaced with detected providers)
  await h.show();
  await h.press("Choose project or workspace");
  await h.press("App · Git root");
  assert.match(h.text(), /Saved provider preference for this project is empty/);
  assert.equal(h.button("Codex, ready").props.accessibilityState.checked, false);
});

test("D4 M5.2 follow-up: mid-refetch and delayed target-A provider snapshots cannot be consumed by Select Detected Providers", async (t) => {
  const pendingA = Promise.withResolvers();
  const pendingB = Promise.withResolvers();
  let callCountA = 0;
  let retryDeferred = null;

  const h = createUxHarness(t, {
    projects: [
      { projectId: "pa", projectDisplayName: "Target A", projectKind: "git", projectRootPath: "/target-a" },
      { projectId: "pb", projectDisplayName: "Target B", projectKind: "git", projectRootPath: "/target-b" },
    ],
    providerSnapshots: {
      "/target-a": () => {
        callCountA++;
        if (callCountA === 1) return pendingA.promise;
        return retryDeferred ? retryDeferred.promise : Promise.resolve({ entries: [] });
      },
      "/target-b": () => pendingB.promise,
    },
  });

  await h.show();
  // Select Target A (snapshot stays pending)
  await h.press("Choose project or workspace");
  await h.press("Target A · Git root");
  assert.ok(h.button("Detecting providers…").props.disabled);

  // Switch to Target B before Target A's snapshot resolves
  await h.press("Choose project or workspace");
  await h.press("Target B · Git root");
  assert.ok(h.button("Detecting providers…").props.disabled);

  // Delayed Target A snapshot resolves with Codex ready — MUST NOT leak into Target B!
  await act(async () => pendingA.resolve({
    entries: [{ provider: "codex", enabled: true, status: "ready" }],
  }));
  assert.ok(h.button("Detecting providers…").props.disabled);
  assert.equal(h.button("Codex, ready"), undefined);

  // Target B resolves with Kiro ready -> Select Detected Providers selects ONLY Kiro (never Codex from A)
  await act(async () => pendingB.resolve({
    entries: [{ provider: "kiro", enabled: true, status: "ready" }],
  }));
  assert.ok(!h.button("Select Detected Providers").props.disabled);
  await h.press("Select Detected Providers");
  assert.equal(h.button("Kiro, ready, selected").props.accessibilityState.checked, true);
  assert.equal(h.button("Codex, unavailable").props.accessibilityState.checked, false);

  // Mid-refetch check: when a provider snapshot fails and user clicks Retry discovery, Select Detected Providers stays disabled during refetch
  let targetCFail = true;
  let targetCRetry = Promise.withResolvers();
  const h2 = createUxHarness(t, {
    projects: [{ projectId: "pc", projectDisplayName: "Target C", projectKind: "git", projectRootPath: "/target-c" }],
    providerSnapshots: {
      "/target-c": () => {
        if (targetCFail) {
          targetCFail = false;
          return Promise.reject(new Error("transient"));
        }
        return targetCRetry.promise;
      },
    },
  });
  await h2.show();
  await h2.press("Choose project or workspace");
  await h2.press("Target C · Git root");
  assert.ok(h2.button("Select Detected Providers").props.disabled);
  await h2.press("Retry discovery");
  // While refetch is in flight, button is disabled and shows Detecting providers…
  assert.ok(h2.button("Detecting providers…").props.disabled);
  await act(async () => targetCRetry.resolve({
    entries: [{ provider: "cursor", enabled: true, status: "ready" }],
  }));
  assert.ok(!h2.button("Select Detected Providers").props.disabled);
});
