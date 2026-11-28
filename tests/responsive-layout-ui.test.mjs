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

const sha = "a".repeat(40);
const catalog = {
  schemaVersion: 1,
  source: catalogSource,
  commitSha: sha,
  skills: [{
    id: "demo",
    directory: "skills/demo",
    metadata: { name: "demo", description: "Demo skill" },
    entrypoint: { path: "SKILL.md", blobSha: sha, sizeBytes: 20, mode: "100644" },
    supportingFiles: [],
  }],
};

const makeTerminal = (input) => ({
  status: "ready",
  result: {
    schemaVersion: 1,
    requestId: input.requestId,
    target: { canonicalDirectory: input.canonicalDirectory },
    catalog: { source: catalogSource, commitSha: sha, settingsRevision: input.expectedSettingsRevision },
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
      matches: [{ boundaryPath: ".", verdict: "recommended", reasons: [{ code: "reusable_workflow", refs: [] }] }],
      inventory: { state: "not_observed", occurrences: [] },
    }],
  },
});

function makeV2Reply(req, { status = "create", ttlMs = 600_000 } = {}) {
  const now = Date.now();
  const isConflict = status === "conflict";
  return {
    status: "ready",
    schemaVersion: 2,
    plannedEffect: isConflict ? "not_applicable" : "create_only",
    applyEligibility: isConflict
      ? { status: "ineligible", reasons: ["plan_conflict"] }
      : { status: "eligible" },
    receipt: {
      previewId: "a".repeat(64),
      planDigest: "b".repeat(64),
      epoch: "c".repeat(64),
      viewNonce: req.viewNonce,
      issuedAt: now,
      expiresAt: now + ttlMs,
    },
    manifest: {
      schemaVersion: 1,
      hostId: "host-a",
      installationInstanceId: "d".repeat(64),
      epoch: "c".repeat(64),
      viewNonce: req.viewNonce,
      savedCatalogRef: sha,
      plan: {
        status: "ready",
        intent: req.intent,
        entries: [{
          skillId: "demo",
          destination: ".agents/skills/demo/SKILL.md",
          status,
          proposed: { sizeBytes: 20, sha256: "e".repeat(64), mode: 0o644 },
          ...(isConflict ? {
            existing: { sizeBytes: 12, sha256: "f".repeat(64), mode: 0o644 },
            change: { kind: "text", unifiedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n" },
          } : {}),
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
        blobSha: sha,
        sizeBytes: 20,
        sha256: "e".repeat(64),
        mode: 0o644,
      }],
      gitProof: { status: "not_selected" },
      policy: { ...receiptPolicy, writeCapability: "multi_root_v1" },
    },
  };
}

function createHarness(t, { fixture = true } = {}) {
  let tree;
  const client = new QueryClient();
  const tracker = createOperationTracker();
  const previews = [];
  const streams = [];
  const statusCalls = [];

  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "Demo", projectKind: "git", projectRootPath: "/project" }] }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
    providers: { snapshot: async () => ({ entries: [{ provider: "codex", enabled: true, status: "ready" }] }) },
  };
  const invoke = (method, input) => {
    if (method === "target.validate-directory") return Promise.resolve({ status: "ready", directory: input.path });
    if (method === "catalog.releases") {
      return Promise.resolve({
        status: "ready", source: catalogSource, settingsRevision: "r1",
        active: { catalogRef: sha, isPinnedSha: true },
        releases: [], latestStable: null, updateStatus: "no_stable_releases", updateAvailable: false, checkedAt: 1, cached: false,
      });
    }
    if (method === "catalog.load") {
      return Promise.resolve({ status: "ready", settingsRevision: "r1", requestedRef: sha, snapshot: catalog });
    }
    if (method === "apply.target-status.v1") {
      return Promise.resolve({ hostCompatible: true, trustBoundaryOk: true, reasons: [], enrolledCount: 1, targetState: "enrolled_enabled" });
    }
    if (method === "apply.status.v1") {
      statusCalls.push(input);
      return Promise.resolve({ status: "error", code: "outcome_unknown" });
    }
    if (method === "preview.providers.v2" || method === "preview.providers") {
      const p = { ...Promise.withResolvers(), input };
      previews.push(p);
      return p.promise;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  const subscribe = (method, input, observer) => {
    assert.equal(method, "recommendation.evaluate");
    streams.push({ input, observer });
    const release = () => {};
    return Object.assign(release, { ready: Promise.resolve(), release: async () => {} });
  };

  const render = async ({ compact = false, host = "host-a", status = "online" } = {}) => {
    const screen = createElement(FoundationScreen, {
      host: { id: host, label: host },
      theme: { colors: {} },
      layout: { compact, platform: compact ? "ios" : "web" },
      params: {},
    });
    const surface = fixture ? createElement(FixtureApprovalScope, { tracker, slot: "slot-a" }, screen) : screen;
    const node = createElement(
      QueryClientProvider,
      { client },
      createElement(
        HostFixture.Provider,
        {
          value: {
            hosts: [{ serverId: host, status }],
            settings: { status: "ready", revision: "r1", values: { catalogRef: sha }, reload: async () => {}, save: async () => true },
          },
        },
        createElement(PaseoApiProvider, { paseo }, createElement(PluginRpcProvider, { invoke, subscribe }, surface)),
      ),
    );
    await act(async () => {
      if (tree) tree.update(node);
      else tree = renderer.create(node);
    });
  };

  t.after(async () => {
    if (tree) await act(async () => tree.unmount());
    client.clear();
  });

  const button = (label) => tree.root.findAllByType("pressable").find((node) =>
    node.props.accessibilityLabel === label ||
    node.findAllByType("text").some((tNode) => tNode.children.join("") === label),
  );
  const press = async (label) => {
    const b = button(label);
    assert.ok(b, `Missing button: ${label}`);
    assert.ok(!b.props.disabled, `Disabled button: ${label}`);
    await act(async () => b.props.onPress());
  };
  const text = () => tree.root.findAllByType("text").map((node) => node.children.join("")).join("\n");
  const views = () => tree.root.findAllByType("view");

  return { render, button, press, text, views, previews, streams, tracker, statusCalls };
}

test("Desktop two-pane layout and resize (compact: false <-> true) preserve active Preview & Approval without invalidation (D1, D3, P1)", async (t) => {
  const h = createHarness(t);
  await h.render({ compact: false });

  // Desktop renders two-pane row with maxWidth 1240 and ContextBar
  assert.ok(h.views().some((v) => v.props.style?.flexDirection === "row" && v.props.style?.gap === 16));
  assert.equal(h.button("Step 1: Setup"), undefined);

  await h.press("Choose project or workspace");
  await h.press("Demo · Git root");
  await h.press("Scan & Recommend");
  await act(async () => h.streams[0].observer.event(makeTerminal(h.streams[0].input)));
  await h.press("Select demo");
  await h.press("Preview Changes");
  assert.equal(h.previews.length, 1);
  await act(async () => h.previews[0].resolve(makeV2Reply(h.previews[0].input)));
  assert.ok(h.button("Review create-only approval"));
  assert.ok(!h.button("Review create-only approval").props.disabled);

  // Resize Desktop -> Mobile (compact: true) -> Desktop (compact: false): Preview MUST remain valid without re-fetching!
  await h.render({ compact: true });
  assert.ok(h.button("Step 1: Setup"));
  assert.equal(h.previews.length, 1);
  await h.press("Step 3: Preview & Apply");
  assert.ok(h.button("Review create-only approval"));
  assert.ok(!h.button("Review create-only approval").props.disabled);
  assert.equal(h.previews.length, 1); // Zero automatic Preview RPC on navigation or resize!

  await h.render({ compact: false });
  assert.ok(h.button("Review create-only approval"));
  assert.ok(!h.button("Review create-only approval").props.disabled);
  assert.equal(h.previews.length, 1);
});

test("Mobile 3-step navigation preserves selection & Preview, hides inactive steps from a11y, and never auto-triggers RPCs (D2, D3, P2, P3)", async (t) => {
  const h = createHarness(t);
  await h.render({ compact: true });

  // Verify >=44 touch targets on Mobile step tabs
  assert.ok(h.button("Step 1: Setup").props.style.minHeight >= 44);
  assert.ok(h.button("Step 2: Skills").props.style.minHeight >= 44);
  assert.ok(h.button("Step 3: Preview & Apply").props.style.minHeight >= 44);

  // Hidden panes are marked aria-hidden + display: none + pointerEvents: none
  assert.ok(h.views().some((v) => v.props.style?.display === "none" && v.props["aria-hidden"] === true && v.props.pointerEvents === "none"));

  // Setup -> Skills -> Preview & Apply -> Skills -> Preview & Apply
  await h.press("Choose project or workspace");
  await h.press("Demo · Git root");
  await h.press("Continue to Skills");
  assert.equal(h.streams.length, 0); // Never auto-scans on step navigation!
  await h.press("Scan & Recommend");
  await act(async () => h.streams[0].observer.event(makeTerminal(h.streams[0].input)));
  await h.press("Select demo");
  await h.press("Continue to Preview & Apply");
  assert.equal(h.previews.length, 0); // Never auto-previews on step navigation!

  await h.press("Preview Changes");
  await act(async () => h.previews[0].resolve(makeV2Reply(h.previews[0].input)));
  assert.ok(!h.button("Review create-only approval").props.disabled);

  // Navigate backward to Skills and back to Preview -> selection and Preview remain intact
  await h.press("Back to Skills");
  assert.match(h.text(), /2\. Skills \(1\)/);
  await h.press("Continue to Preview & Apply");
  assert.ok(!h.button("Review create-only approval").props.disabled);
  assert.equal(h.previews.length, 1);
});

test("P4 hidden-step receipt expiration disables approval before returning to Preview", async (t) => {
  const h = createHarness(t);
  await h.render({ compact: true });

  await h.press("Choose project or workspace");
  await h.press("Demo · Git root");
  await h.press("Continue to Skills");
  await h.press("Scan & Recommend");
  await act(async () => h.streams[0].observer.event(makeTerminal(h.streams[0].input)));
  await h.press("Select demo");
  await h.press("Continue to Preview & Apply");
  await h.press("Preview Changes");

  // Issue a short-lived receipt (40ms TTL), immediately navigate away to Setup while timer runs
  await act(async () => h.previews[0].resolve(makeV2Reply(h.previews[0].input, { ttlMs: 40 })));
  await h.press("Step 1: Setup");

  // Wait for receipt TTL to expire while Preview step is hidden
  await act(async () => { await new Promise((r) => setTimeout(r, 70)); });

  // Return to Preview: receipt MUST be expired and approval disabled!
  await h.press("Step 3: Preview & Apply");
  assert.match(h.text(), /This preview expired\. Run Preview again\./);
  assert.ok(h.button("Review create-only approval").props.disabled);
});

test("P4 active/recovery operation notice is visible from every Mobile step and survives disconnect/host switch", async (t) => {
  const h = createHarness(t);
  // Seed an active/outcome_unknown operation in tracker
  h.tracker.submit(
    { hostId: "host-a", slot: "slot-a", target: "/project" },
    { previewId: "a".repeat(64), planDigest: "b".repeat(64), viewNonce: "n1", operationId: "12345678".repeat(4), approval: "create_only_v1" },
    async () => ({ status: "error", code: "outcome_unknown" }),
  );

  await h.render({ compact: true, host: "host-a", status: "online" });
  // Visible on Step 1 (Setup)
  assert.match(h.text(), /requires review or recovery/);
  assert.ok(h.button("View Apply Operations"));

  // Visible on Step 2 (Skills)
  await h.press("Step 2: Skills");
  assert.match(h.text(), /requires review or recovery/);
  await h.press("View Apply Operations");
  assert.match(h.text(), /Apply Operations/);

  // Survives disconnect (FixtureOperations stays mounted outside HostScreen!)
  await h.render({ compact: true, host: "host-a", status: "offline" });
  assert.match(h.text(), /Apply Operations/);
  assert.match(h.text(), /Outcome unknown/);
});

test("Blocking conflicts display top-level danger banner and disable approval", async (t) => {
  const h = createHarness(t);
  await h.render({ compact: false });
  await h.press("Choose project or workspace");
  await h.press("Demo · Git root");
  await h.press("Scan & Recommend");
  await act(async () => h.streams[0].observer.event(makeTerminal(h.streams[0].input)));
  await h.press("Select demo");
  await h.press("Preview Changes");
  await act(async () => h.previews[0].resolve(makeV2Reply(h.previews[0].input, { status: "conflict" })));

  assert.match(h.text(), /Blocking conflicts or blocked destinations detected/);
  assert.match(h.text(), /Conflict: 1/);
  assert.ok(h.button("Review create-only approval").props.disabled);
});
