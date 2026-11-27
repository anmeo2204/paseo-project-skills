import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import renderer from "react-test-renderer";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { FoundationScreen } from "../client/foundation-screen.tsx";
import { catalogSource } from "../shared/catalog-settings.ts";
import { HostFixture } from "./client-fixture.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const sha = "a".repeat(40);
const ids = ["go-api-change", "go-data-change", "react-ui-change"];
const descriptors = {
  schemaVersion: 1, source: catalogSource, commitSha: sha,
  skills: ids.map((id) => ({
    id, directory: "skills/" + id, metadata: { name: id, description: "Description of " + id },
    entrypoint: { path: "SKILL.md", blobSha: sha, sizeBytes: 1, mode: "100644" }, supportingFiles: [],
  })),
};
const settingsFor = (revision = "r1", catalogRef = "release") => ({
  status: "ready", revision, values: { catalogRef }, reload: async () => {}, save: async () => true,
});
const catalogFor = (settings = settingsFor(), snapshot = descriptors) => ({
  status: "ready", settingsRevision: settings.revision, requestedRef: settings.values.catalogRef, snapshot,
});

function terminal(input, { partial = false, legacy = false } = {}) {
  const ready = ["recommended", "optional", "unknown"];
  return {
    status: partial ? "partial" : "ready",
    result: {
      schemaVersion: 1, requestId: input.requestId, target: { canonicalDirectory: input.canonicalDirectory },
      catalog: { source: catalogSource, commitSha: input.expectedCatalogSha, settingsRevision: input.expectedSettingsRevision },
      scanCoverage: { status: partial ? "partial" : "complete", limits: [], unknown: [] },
      warnings: partial ? [{ code: "malformed_skill", relativePath: ".agents/skills/go-data-change/SKILL.md" }] : [],
      metadataCoverage: { valid: legacy ? 0 : 3, missing: legacy ? 3 : 0, invalid: 0 },
      diagnostics: legacy ? ids.map((skillId) => ({ skillId, code: "missing_applicability" })) : [],
      evidence: [
        { id: "manifest", relativePath: "api/go.mod", kind: "declaration", selector: "go" },
        { id: "existing", relativePath: ".agents/skills/go-data-change/SKILL.md", kind: "presence" },
      ],
      items: ids.map((skillId, i) => ({
        skillId, applicability: legacy ? "unknown" : ready[i], taskApplicability: "not_assessed",
        reasons: legacy || i === 2 ? [{ code: legacy ? "missing_applicability" : "no_supported_evidence", refs: [] }] : [],
        matches: !legacy && i < 2 ? [{
          boundaryPath: "api", verdict: ready[i], reasons: [{
            code: i ? "additional_evidence_unobserved" : "strong_project_match",
            refs: [{ kind: "project_evidence", evidenceId: "manifest" }, {
              kind: "catalog_file", path: "skills/" + skillId + "/applicability.json", blobSha: sha,
            }],
          }],
        }] : [],
        inventory: i === 1 ? {
          state: "unknown", occurrences: [{
            relativePath: ".agents/skills/go-data-change/SKILL.md", boundaryPath: ".", kind: "skill",
            layout: ".agents/skills", match: "candidate", metadataState: "mismatch", directoryId: skillId,
            declaredId: "other", flags: ["metadata_mismatch", "possible_customization"], evidenceIds: ["existing"],
          }],
        } : { state: "not_observed", occurrences: [] },
      })),
    },
  };
}

function harness(t) {
  let tree;
  const calls = [];
  const loads = [];
  const subscriptions = [];
  const client = new QueryClient();
  const provider = {
    projects: { list: async () => ({ projects: [{
      projectId: "demo", projectDisplayName: "Demo", projectKind: "git", projectRootPath: "/root",
    }] }) },
    workspaces: { list: async () => ({ pageInfo: {}, entries: [{
      id: "worktree", name: "Branch", workspaceKind: "worktree", workspaceDirectory: "/worktree",
    }] }) },
    providers: { snapshot: async () => ({ entries: [{ provider: "cursor", enabled: false }] }) },
  };
  const invoke = (method, input) => {
    calls.push(method);
    if (method === "target.validate-directory") return Promise.resolve({ status: "ready", directory: input.path + "-canonical" });
    assert.equal(method, "catalog.load");
    const pending = Promise.withResolvers();
    loads.push(pending);
    return pending.promise;
  };
  const subscribe = (method, input, observer) => {
    calls.push(method);
    assert.equal(method, "recommendation.evaluate");
    const stream = { input, observer, released: 0 };
    subscriptions.push(stream);
    const handle = () => { stream.released++; };
    return Object.assign(handle, { ready: Promise.resolve(), release: async () => handle() });
  };
  async function show({ host = "a", status = "online", settings = settingsFor() } = {}) {
    const view = createElement(QueryClientProvider, { client },
      createElement(HostFixture.Provider, { value: { hosts: [{ serverId: host, status }], settings } },
        createElement(PaseoApiProvider, { paseo: provider },
          createElement(PluginRpcProvider, { invoke, subscribe },
            createElement(FoundationScreen, { host: { id: host, label: host }, theme: { colors: {} },
              layout: { compact: true, platform: "web" }, params: {} })))));
    await act(async () => {
      if (tree) tree.update(view);
      else tree = renderer.create(view);
    });
  }
  async function unmount() {
    if (tree) await act(async () => tree.unmount());
    tree = undefined;
  }
  t.after(async () => { await unmount(); client.clear(); });
  const button = (name) => tree.root.findAllByType("pressable").find((node) =>
    node.props.accessibilityLabel === name || node.findAllByType("text").some((text) => text.children.join("") === name));
  const press = async (name) => {
    const target = button(name);
    assert.ok(target, name);
    assert.ok(!target.props.disabled, name + " is disabled");
    await act(async () => target.props.onPress());
  };
  const target = async (path) => {
    const input = tree.root.findAllByType("input").find((node) => node.props.accessibilityLabel === "Absolute path on the host");
    await act(async () => input.props.onChangeText(path));
    await press("Use directory");
  };
  const emit = async (stream, event = terminal(stream.input)) => act(async () => stream.observer.event(event));
  const load = async (reply = catalogFor(), entry = loads.at(-1)) => act(async () => entry.resolve(reply));
  const scan = async (reply) => {
    await press("Scan & Recommend");
    await load(reply);
    return subscriptions.at(-1);
  };
  const text = () => tree.root.findAllByType("text").map((node) => node.children.join("")).join("\n");
  return { show, button, press, target, emit, load, scan, text, calls, loads, subscriptions, unmount };
}

test("click-only scan uses pinned catalog and one subscription, with no provider or extra scan", async (t) => {
  const h = harness(t);
  await h.show({ settings: settingsFor("r1", "") });
  assert.ok(h.button("Scan & Recommend").props.disabled);
  await h.press("Choose project or workspace");
  await h.press("Demo · Git root");
  assert.match(h.text(), /\/root-canonical/);
  assert.ok(h.button("Scan & Recommend").props.disabled);
  await h.show();
  await h.press("Choose project or workspace");
  await h.press("Branch · Git worktree");
  assert.match(h.text(), /\/worktree-canonical/);
  assert.equal(h.loads.length, 0);
  await h.press("Scan & Recommend");
  assert.match(h.text(), /Loading skill catalog/);
  await h.load();
  const stream = h.subscriptions[0];
  assert.deepEqual(stream.input, {
    requestId: stream.input.requestId, canonicalDirectory: "/worktree-canonical",
    expectedCatalogSha: sha, expectedSettingsRevision: "r1",
  });
  await h.emit(stream);
  assert.equal(stream.released, 1);
  assert.deepEqual(h.calls, [
    "target.validate-directory", "target.validate-directory", "catalog.load", "recommendation.evaluate",
  ]);
  assert.match(h.text(), /Description of go-api-change/);
  assert.ok(h.text().indexOf("Recommended (1)") < h.text().indexOf("Optional (1)"));
  assert.ok(h.text().indexOf("Optional (1)") < h.text().indexOf("Unknown (1)"));
  assert.match(h.text(), /Selected skills: 0/);
  assert.equal(h.button("Select react-ui-change"), undefined);
  await h.emit(stream, terminal(stream.input, { partial: true }));
  assert.doesNotMatch(h.text(), /Partial results/);
});

test("partial details and bulk selection preserve manual choices and provider intent", async (t) => {
  const h = harness(t);
  await h.show();
  await h.target("/a");
  const stream = await h.scan();
  await h.emit(stream, terminal(stream.input, { partial: true }));
  assert.match(h.text(), /Partial results/);
  await h.press("Scan and catalog details");
  assert.match(h.text(), /existing skill has malformed/);
  await h.press("Details for go-data-change");
  assert.match(h.text(), /api\/go.mod/);
  assert.match(h.text(), /api · Optional/);
  assert.match(h.text(), /Catalog rule: skills\/go-data-change\/applicability.json/);
  assert.match(h.text(), /Existing skill inventory/);
  assert.match(h.text(), /Candidate/);
  assert.match(h.text(), /Possible customization/);
  await h.press("Unknown (1)");
  await h.press("Select react-ui-change");
  await h.press("Select go-data-change");
  await h.press("Cursor, unavailable");
  await h.press("Select Recommended");
  assert.match(h.text(), /Selected skills: 3/);
  assert.equal(h.subscriptions.length, 1);
  await h.press("Clear Selection");
  assert.match(h.text(), /Selected skills: 0/);
  assert.equal(h.button("Cursor, unavailable, selected").props.accessibilityState.checked, true);
  await h.press("Select Recommended");
  const another = await h.scan();
  assert.doesNotMatch(h.text(), /Recommendation Results/);
  assert.notEqual(another.input.requestId, stream.input.requestId);
  await h.emit(another, terminal(another.input, { legacy: true }));
  assert.match(h.text(), /No positive matches/);
  assert.match(h.text(), /Selected skills: 0/);
  await h.press("Unknown (3)");
  await h.press("Select go-api-change");
  assert.match(h.text(), /Selected skills: 1/);
});

test("cancel discards preflight and subscription events and supports recovery", async (t) => {
  const h = harness(t);
  await h.show();
  await h.target("/a");
  await h.press("Scan & Recommend");
  const oldLoad = h.loads[0];
  await h.press("Cancel");
  assert.match(h.text(), /Scan cancelled/);
  const stream = await h.scan();
  await h.load(catalogFor(), oldLoad);
  assert.equal(h.subscriptions.length, 1);
  await h.press("Cancel");
  assert.equal(stream.released, 1);
  await h.emit(stream);
  assert.doesNotMatch(h.text(), /Recommendation Results/);
  const recovery = await h.scan();
  await h.emit(recovery);
  assert.match(h.text(), /Recommendation Results/);
});

test("A to B to A ignores old target and host results and releases on offline or unmount", async (t) => {
  const h = harness(t);
  await h.show();
  await h.target("/a");
  const oldA = await h.scan();
  await h.target("/b");
  const b = await h.scan();
  await h.target("/a");
  const newA = await h.scan();
  assert.equal(oldA.released, 1);
  assert.equal(b.released, 1);
  await h.emit(oldA);
  await h.emit(b);
  await h.emit(newA, terminal(oldA.input));
  assert.doesNotMatch(h.text(), /Recommendation Results/);
  await h.emit(newA);
  assert.match(h.text(), /Recommendation Results/);
  const starting = await h.scan();
  await h.show({ host: "b" });
  assert.equal(starting.released, 1);
  await h.emit(starting);
  assert.doesNotMatch(h.text(), /Recommendation Results/);
  await h.target("/a");
  const lost = await h.scan();
  await h.show({ host: "b", status: "offline" });
  assert.equal(lost.released, 1);
  const count = h.subscriptions.length;
  await h.show({ host: "b" });
  await h.emit(lost);
  assert.equal(h.subscriptions.length, count);
  await h.target("/a");
  const pending = await h.scan();
  await h.unmount();
  assert.equal(pending.released, 1);
});

test("saved settings changes invalidate in-flight and completed results without reusing old selection", async (t) => {
  const h = harness(t);
  await h.show();
  await h.target("/a");
  const first = await h.scan();
  await h.emit(first);
  await h.press("Select Recommended");
  assert.match(h.text(), /Selected skills: 1/);
  const nextSettings = settingsFor("r2", "next");
  await h.show({ settings: nextSettings });
  assert.match(h.text(), /out of date/);
  assert.doesNotMatch(h.text(), /Selected skills/);
  await h.show();
  assert.doesNotMatch(h.text(), /Selected skills/);
  const second = await h.scan();
  await h.show({ settings: nextSettings });
  assert.equal(second.released, 1);
  await h.emit(second);
  assert.doesNotMatch(h.text(), /Recommendation Results/);
  const third = await h.scan(catalogFor(nextSettings));
  await h.emit(third);
  assert.match(h.text(), /Selected skills: 0/);
});

test("typed catalog, mismatch and transport errors are safe and retryable", async (t) => {
  const h = harness(t);
  await h.show();
  await h.target("/a");
  await h.press("Scan & Recommend");
  await h.load({ status: "error", code: "auth_failed", diagnostics: [{ code: "invalid_tree", path: "private-stderr" }] });
  assert.match(h.text(), /could not authenticate/);
  assert.doesNotMatch(h.text(), /private-stderr/);
  await h.press("Scan & Recommend");
  await h.load(catalogFor(settingsFor("different")));
  assert.equal(h.subscriptions.length, 0);
  assert.match(h.text(), /saved catalog settings changed/);
  const stream = await h.scan();
  await h.emit(stream, { status: "error", requestId: stream.input.requestId, code: "catalog_revision_mismatch" });
  assert.match(h.text(), /catalog revision changed/);
  const closed = await h.scan();
  await act(async () => closed.observer.closed(new Error("private-stderr")));
  assert.match(h.text(), /connection closed/);
  assert.doesNotMatch(h.text(), /private-stderr/);
  const invalid = await h.scan();
  const event = terminal(invalid.input);
  event.result.catalog.commitSha = "b".repeat(40);
  await h.emit(invalid, event);
  assert.match(h.text(), /result could not be verified/);
  const valid = await h.scan();
  await h.emit(valid);
  assert.match(h.text(), /Recommendation Results/);
});

test("metadata-only partial keeps valid selections and exposes typed diagnostics", async (t) => {
  const h = harness(t);
  await h.show();
  await h.target("/a");
  const busy = await h.scan();
  await h.emit(busy, { status: "error", requestId: busy.input.requestId, code: "busy" });
  assert.match(h.text(), /finishing another request/);
  const stream = await h.scan();
  const event = terminal(stream.input);
  event.status = "partial";
  event.result.metadataCoverage = { valid: 2, missing: 0, invalid: 1 };
  event.result.diagnostics = [{ skillId: "react-ui-change", code: "unsupported_rule_version" }];
  event.result.items[2].reasons = [{ code: "unsupported_rule_version", refs: [] }];
  await h.emit(stream, event);
  assert.match(h.text(), /Partial results/);
  assert.match(h.text(), /invalid or unsupported/);
  assert.doesNotMatch(h.text(), /Some project evidence could not be checked/);
  await h.press("Scan and catalog details");
  assert.match(h.text(), /react-ui-change · The applicability rule version is unsupported/);
  await h.press("Select Recommended");
  assert.equal(h.button("Select go-api-change").props["aria-checked"], true);
  assert.equal(h.button("Unknown (1)").props["aria-expanded"], false);
});
