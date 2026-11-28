import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import renderer from "react-test-renderer";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { FoundationScreen } from "../client/foundation-screen.tsx";
import { FixtureApprovalScope } from "../client/fixture-approval.tsx";
import { createOperationTracker } from "../client/apply-tracker.ts";
import { catalogSource } from "../shared/catalog-settings.ts";
import { receiptPolicy } from "../shared/preview-receipt.ts";
import { HostFixture } from "./client-fixture.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const sha1 = "1".repeat(40);
const sha2 = "2".repeat(40);
const sha3 = "3".repeat(40);

const makeCatalog = (commitSha) => ({
  schemaVersion: 1,
  source: catalogSource,
  commitSha,
  skills: [{
    id: "demo",
    directory: "skills/demo",
    metadata: { name: "demo", description: "Demo skill" },
    entrypoint: { path: "SKILL.md", blobSha: commitSha, sizeBytes: 20, mode: "100644" },
    supportingFiles: [],
  }],
});

const makeTerminal = (input, commitSha) => ({
  status: "ready",
  result: {
    schemaVersion: 1,
    requestId: input.requestId,
    target: { canonicalDirectory: input.canonicalDirectory },
    catalog: { source: catalogSource, commitSha, settingsRevision: input.expectedSettingsRevision },
    scanCoverage: { status: "complete", limits: [], unknown: [] },
    warnings: [],
    metadataCoverage: { valid: 1, missing: 0, invalid: 0 },
    diagnostics: [],
    evidence: [],
    items: [{
      skillId: "demo",
      applicability: "recommended",
      taskApplicability: "not_assessed",
      reasons: [],
      matches: [],
      inventory: { state: "not_observed", occurrences: [] },
    }],
  },
});

function createHarness(t, { fixture = false, compact = false } = {}) {
  let tree;
  const client = new QueryClient();
  const tracker = createOperationTracker();
  const releaseQueue = [];
  const resolveQueue = [];
  const loadQueue = [];
  const previewQueue = [];
  const streams = [];
  const saves = [];
  let autoResolveReleases = null;
  let currentSettings;

  const provider = {
    projects: { list: async () => ({ projects: [] }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
    providers: { snapshot: async () => ({ entries: [] }) },
  };

  const invoke = (method, input) => {
    if (method === "target.validate-directory") {
      return Promise.resolve({ status: "ready", directory: input.path });
    }
    if (method === "catalog.releases") {
      if (autoResolveReleases) return Promise.resolve(autoResolveReleases(input, currentSettings));
      const pending = { ...Promise.withResolvers(), input };
      releaseQueue.push(pending);
      return pending.promise;
    }
    if (method === "catalog.resolve") {
      const pending = { ...Promise.withResolvers(), input };
      resolveQueue.push(pending);
      return pending.promise;
    }
    if (method === "catalog.load") {
      const pending = { ...Promise.withResolvers(), input };
      loadQueue.push(pending);
      return pending.promise;
    }
    if (method === "apply.list.v1") {
      return Promise.resolve({ status: "ready", items: [], unreadableCount: 0, truncated: false });
    }
    if (method === "preview.providers.v2" || method === "preview.providers") {
      const pending = { ...Promise.withResolvers(), input };
      previewQueue.push(pending);
      return pending.promise;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };

  const subscribe = (method, input, observer) => {
    assert.equal(method, "recommendation.evaluate");
    const stream = { input, observer };
    streams.push(stream);
    const release = () => {};
    return Object.assign(release, { ready: Promise.resolve(), release: async () => {} });
  };

  const show = async ({
    host = "host-a",
    status = "online",
    revision = "r1",
    values = { catalogRef: "" },
    saving = false,
    saveImpl,
  } = {}) => {
    currentSettings = {
      status: "ready",
      revision,
      saving,
      values,
      reload: async () => {},
      save: async (nextValues, expectedRevision) => {
        saves.push({ host, values: nextValues, revision: expectedRevision });
        if (saveImpl) return saveImpl(nextValues, expectedRevision);
        return true;
      },
    };
    const screen = createElement(FoundationScreen, {
      host: { id: host, label: host },
      theme: { colors: {} },
      layout: { compact, platform: compact ? "ios" : "web" },
      params: {},
    });
    const surface = fixture
      ? createElement(FixtureApprovalScope, { tracker, slot: "fixture-slot" }, screen)
      : screen;
    const node = createElement(
      QueryClientProvider,
      { client },
      createElement(
        HostFixture.Provider,
        { value: { hosts: [{ serverId: host, status }], settings: currentSettings } },
        createElement(
          PaseoApiProvider,
          { paseo: provider },
          createElement(PluginRpcProvider, { invoke, subscribe }, surface),
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
    node.findAllByType("text").some((nodeText) => nodeText.children.join("") === label),
  );
  const press = async (label) => {
    const target = button(label);
    assert.ok(target, `Button not found: ${label}`);
    assert.ok(!target.props.disabled, `Button disabled: ${label}`);
    await act(async () => target.props.onPress());
  };
  const input = (label) => tree?.root.findAllByType("input").find((node) => node.props.accessibilityLabel === label);
  const text = () => tree?.root.findAllByType("text").map((node) => node.children.join("")).join("\n") ?? "";
  const setTarget = async (path) => {
    if (!input("Absolute path on the host")) await press("Advanced: Enter path manually");
    await act(async () => input("Absolute path on the host").props.onChangeText(path));
    await press("Use directory");
  };

  return {
    show,
    unmount,
    button,
    press,
    input,
    text,
    setTarget,
    saves,
    releaseQueue,
    resolveQueue,
    loadQueue,
    previewQueue,
    streams,
    setAutoReleases: (fn) => { autoResolveReleases = fn; },
  };
}

test("Latest Stable, Specific Version (stable-only modal) and update banner never auto-replace pinned SHA (P1, P2, D3)", async (t) => {
  const h = createHarness(t);
  h.setAutoReleases((_, settings) => ({
    status: "ready",
    source: catalogSource,
    settingsRevision: settings.revision,
    active: { ...settings.values, isPinnedSha: /^[a-f0-9]{40}$/.test(settings.values.catalogRef) },
    releases: [
      { tag: "v0.2.0", commitSha: sha2, relation: settings.values.selectedTag === "v0.1.0" ? "newer" : "active" },
      { tag: "v0.1.0", commitSha: sha1, relation: settings.values.selectedTag === "v0.1.0" ? "active" : "older" },
    ],
    latestStable: { tag: "v0.2.0", commitSha: sha2 },
    updateStatus: settings.values.selectedTag === "v0.1.0" ? "update_available" : "up_to_date",
    updateAvailable: settings.values.selectedTag === "v0.1.0",
    checkedAt: 1,
    cached: false,
  }));

  await h.show({ revision: "r1", values: { catalogRef: sha1, selectionMode: "specific_version", selectedTag: "v0.1.0" } });
  // P1: Update available banner is shown, but saves is empty (no auto-replacement)
  assert.match(h.text(), /Update available: v0\.2\.0/);
  assert.equal(h.saves.length, 0);

  // Switch to Specific Version and pick v0.2.0 from Modal
  await h.press("Specific Version");
  await h.press("Choose release version");
  assert.match(h.text(), /v0\.2\.0 · Newer/);
  assert.match(h.text(), /v0\.1\.0 · Pinned/);
  await h.press("v0.2.0 · Newer");

  // P2: Pin sends expectedCommitSha bound to displayed v0.2.0
  await h.press("Pin Selected Version (v0.2.0)");
  assert.equal(h.resolveQueue.length, 1);
  assert.deepEqual(h.resolveQueue[0].input, {
    mode: "specific_version",
    tag: "v0.2.0",
    expectedCommitSha: sha2,
  });

  // Simulate stale_selection (tag moved on remote): settings must NOT be saved
  await act(async () => h.resolveQueue[0].resolve({ status: "error", code: "stale_selection" }));
  assert.equal(h.saves.length, 0);
  assert.match(h.text(), /changed on the remote before it could be pinned/);
});

test("P1 moved_tag is displayed as a warning and NOT as a normal update", async (t) => {
  const h = createHarness(t);
  h.setAutoReleases((_, settings) => ({
    status: "ready",
    source: catalogSource,
    settingsRevision: settings.revision,
    active: { ...settings.values, isPinnedSha: true },
    releases: [{ tag: "v0.1.0", commitSha: sha3, relation: "uncompared" }],
    latestStable: { tag: "v0.1.0", commitSha: sha3 },
    updateStatus: "moved_tag",
    updateAvailable: false,
    movedTag: { tag: "v0.1.0", pinnedCommitSha: sha1, remoteCommitSha: sha3 },
    checkedAt: 1,
    cached: false,
  }));

  await h.show({ revision: "r1", values: { catalogRef: sha1, selectionMode: "latest_stable", selectedTag: "v0.1.0" } });
  assert.match(h.text(), /Tag v0\.1\.0 moved on the remote/);
  assert.doesNotMatch(h.text(), /Update available:/);
  assert.equal(h.saves.length, 0);
});

test("P3 A -> B -> A draft changes and host switch reject delayed catalog.resolve responses", async (t) => {
  const h = createHarness(t);
  h.setAutoReleases((_, settings) => ({
    status: "ready",
    source: catalogSource,
    settingsRevision: settings.revision,
    active: { ...settings.values, isPinnedSha: false },
    releases: [{ tag: "v0.1.0", commitSha: sha1, relation: "uncompared" }],
    latestStable: { tag: "v0.1.0", commitSha: sha1 },
    updateStatus: "unconfigured",
    updateAvailable: false,
    checkedAt: 1,
    cached: false,
  }));

  await h.show({ host: "host-a", revision: "r1", values: { catalogRef: "" } });
  await h.press("Advanced Custom");
  await act(async () => h.input("Catalog revision").props.onChangeText("v0.1.0"));
  await h.press("Resolve & Pin Revision");
  assert.equal(h.resolveQueue.length, 1);

  // While resolve #1 is in flight, mutate draft A -> B -> A!
  await act(async () => h.input("Catalog revision").props.onChangeText("v0.2.0"));
  await act(async () => h.input("Catalog revision").props.onChangeText("v0.1.0"));

  // Late response from resolve #1 MUST be ignored (no save!)
  await act(async () => h.resolveQueue[0].resolve({
    status: "ready",
    source: catalogSource,
    mode: "custom",
    requestedRef: "v0.1.0",
    resolvedTag: "v0.1.0",
    commitSha: sha1,
    skillCount: 1,
  }));
  assert.equal(h.saves.length, 0);

  // Start resolve #2 and switch host before it settles -> must also be ignored
  await h.press("Resolve & Pin Revision");
  assert.equal(h.resolveQueue.length, 2);
  await h.show({ host: "host-b", revision: "r1", values: { catalogRef: "" } });
  await act(async () => h.resolveQueue[1].resolve({
    status: "ready",
    source: catalogSource,
    mode: "custom",
    requestedRef: "v0.1.0",
    resolvedTag: "v0.1.0",
    commitSha: sha1,
    skillCount: 1,
  }));
  assert.equal(h.saves.length, 0);
});

test("P3 active catalog resolution disables Preview and clears pending FixtureApproval review", async (t) => {
  const h = createHarness(t, { fixture: true });
  h.setAutoReleases((_, settings) => ({
    status: "ready",
    source: catalogSource,
    settingsRevision: settings.revision,
    active: { ...settings.values, isPinnedSha: true },
    releases: [
      { tag: "v0.2.0", commitSha: sha2, relation: "newer" },
      { tag: "v0.1.0", commitSha: sha1, relation: "active" },
    ],
    latestStable: { tag: "v0.2.0", commitSha: sha2 },
    updateStatus: "update_available",
    updateAvailable: true,
    checkedAt: 1,
    cached: false,
  }));

  await h.show({ revision: "r1", values: { catalogRef: sha1, selectionMode: "specific_version", selectedTag: "v0.1.0" } });
  await h.setTarget("/fixture");
  await h.press("Scan & Recommend");
  await act(async () => h.loadQueue[0].resolve({
    status: "ready", settingsRevision: "r1", requestedRef: sha1, snapshot: makeCatalog(sha1),
  }));
  await act(async () => h.streams[0].observer.event(makeTerminal(h.streams[0].input, sha1)));
  await h.press("Select demo");
  await h.press("Preview Changes");

  const req = h.previewQueue[0].input;
  const now = Date.now();
  await act(async () => h.previewQueue[0].resolve({
    status: "ready",
    schemaVersion: 2,
    plannedEffect: "create_only",
    applyEligibility: { status: "eligible" },
    receipt: {
      previewId: "a".repeat(64),
      planDigest: "b".repeat(64),
      epoch: "c".repeat(64),
      viewNonce: req.viewNonce,
      issuedAt: now,
      expiresAt: now + 600_000,
    },
    manifest: {
      schemaVersion: 1,
      hostId: "host-a",
      installationInstanceId: "d".repeat(64),
      epoch: "c".repeat(64),
      viewNonce: req.viewNonce,
      savedCatalogRef: sha1,
      plan: {
        status: "ready",
        intent: req.intent,
        entries: [{
          skillId: "demo",
          destination: ".agents/skills/demo/SKILL.md",
          status: "create",
          proposed: { sizeBytes: 20, sha256: "e".repeat(64), mode: 0o644 },
        }],
        derivedEntries: [],
        providers: [],
        diagnostics: [],
      },
      directoryEffects: [],
      readSet: [],
      sources: [{
        destination: ".agents/skills/demo/SKILL.md",
        canonicalDestination: ".agents/skills/demo/SKILL.md",
        blobSha: sha1,
        sizeBytes: 20,
        sha256: "e".repeat(64),
        mode: 0o644,
      }],
      gitProof: { status: "not_selected" },
      policy: { ...receiptPolicy, writeCapability: "multi_root_v1" },
    },
  }));
  // Approval button is visible after Preview
  assert.ok(h.button("Review create-only approval"));

  // Start pinning v0.2.0 -> catalogBusy becomes true -> Preview & Approval are immediately cleared/disabled!
  await h.press("Pin v0.2.0");
  assert.equal(h.button("Review create-only approval"), undefined);
  assert.ok(h.button("Preview Changes").props.disabled);
});

test("P4 first-use UX: unconfigured host resolves and pins Latest Stable on Scan & Recommend without auto-Apply", async (t) => {
  const h = createHarness(t, { compact: true });
  h.setAutoReleases((_, settings) => ({
    status: "ready",
    source: catalogSource,
    settingsRevision: settings.revision,
    active: { ...settings.values, isPinnedSha: /^[a-f0-9]{40}$/.test(settings.values.catalogRef) },
    releases: [{ tag: "v0.1.0", commitSha: sha1, relation: "uncompared" }],
    latestStable: { tag: "v0.1.0", commitSha: sha1 },
    updateStatus: settings.values.catalogRef === "" ? "unconfigured" : "up_to_date",
    updateAvailable: false,
    checkedAt: 1,
    cached: false,
  }));

  let saveNext = true;
  await h.show({
    revision: "r1",
    values: { catalogRef: "" },
    saveImpl: async () => saveNext,
  });
  await h.setTarget("/project");

  // Scan & Recommend is enabled for unconfigured host
  await h.press("Scan & Recommend");
  assert.equal(h.resolveQueue.length, 1);
  assert.deepEqual(h.resolveQueue[0].input, { mode: "latest_stable" });

  await act(async () => h.resolveQueue[0].resolve({
    status: "ready",
    source: catalogSource,
    mode: "latest_stable",
    requestedRef: "v0.1.0",
    resolvedTag: "v0.1.0",
    commitSha: sha1,
    skillCount: 1,
  }));

  // Saved with optimistic concurrency revision r1
  assert.deepEqual(h.saves, [{
    host: "host-a",
    values: { catalogRef: sha1, selectionMode: "latest_stable", selectedTag: "v0.1.0" },
    revision: "r1",
  }]);

  // Simulate host settings updating to r2 + pinned SHA
  await h.show({
    revision: "r2",
    values: { catalogRef: sha1, selectionMode: "latest_stable", selectedTag: "v0.1.0" },
  });

  // Compact/Mobile layout hides full SHA behind disclosure
  assert.ok(h.button("Show full commit SHA"));

  // Daemon catalog.load returns r2 + pinned SHA -> proceeds to recommendation.evaluate
  assert.equal(h.loadQueue.length, 1);
  await act(async () => h.loadQueue[0].resolve({
    status: "ready",
    settingsRevision: "r2",
    requestedRef: sha1,
    snapshot: makeCatalog(sha1),
  }));
  assert.equal(h.streams.length, 1);
  assert.equal(h.streams[0].input.expectedCatalogSha, sha1);
  assert.equal(h.streams[0].input.expectedSettingsRevision, "r2");

  await act(async () => h.streams[0].observer.event(makeTerminal(h.streams[0].input, sha1)));
  assert.match(h.text(), /Pinned catalog: v0\.1\.0/);
  assert.equal(h.previewQueue.length, 0); // Never auto-previews or auto-applies!

  // Second check: optimistic concurrency failure on unconfigured host fails closed without scanning
  saveNext = false;
  await h.show({ revision: "r3", values: { catalogRef: "" }, saveImpl: async () => false });
  await h.press("Scan & Recommend");
  await act(async () => h.resolveQueue[1].resolve({
    status: "ready",
    source: catalogSource,
    mode: "latest_stable",
    requestedRef: "v0.1.0",
    resolvedTag: "v0.1.0",
    commitSha: sha1,
    skillCount: 1,
  }));
  assert.equal(h.loadQueue.length, 1); // Did NOT proceed to catalog.load or scan!
  assert.match(h.text(), /saved catalog settings changed/);
});

test("D4 legacy unpinned tag blocks Scan until resolved & pinned, and zero-tag first-use fails closed", async (t) => {
  const h = createHarness(t);
  h.setAutoReleases((_, settings) => ({
    status: "ready",
    source: catalogSource,
    settingsRevision: settings.revision,
    active: { ...settings.values, isPinnedSha: false },
    releases: [],
    latestStable: null,
    updateStatus: "no_stable_releases",
    updateAvailable: false,
    checkedAt: 1,
    cached: false,
  }));

  await h.show({ revision: "r1", values: { catalogRef: "legacy-tag" } });
  await h.setTarget("/project");
  assert.ok(h.button("Scan & Recommend").props.disabled);
  assert.match(h.text(), /Legacy unpinned tag saved/);
  assert.ok(h.button("Resolve & Pin legacy-tag"));

  // Zero-tag first-use Scan fails closed with no_stable_releases
  await h.show({ revision: "r2", values: { catalogRef: "" } });
  await h.press("Scan & Recommend");
  await act(async () => h.resolveQueue[0].resolve({ status: "error", code: "no_stable_releases" }));
  assert.equal(h.saves.length, 0);
  assert.equal(h.loadQueue.length, 0);
  assert.match(h.text(), /No stable release tags are published/);
});
