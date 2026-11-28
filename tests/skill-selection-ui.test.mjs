import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import renderer from "react-test-renderer";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { FoundationScreen } from "../client/foundation-screen.tsx";
import { RecommendationResults } from "../client/recommendation-results.tsx";
import { filterAndGroupSkills } from "../client/skill-selection.ts";
import { catalogSource } from "../shared/catalog-settings.ts";
import { HostFixture } from "./client-fixture.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const sha = "a".repeat(40);

function buildSyntheticDataset(count) {
  const skills = [];
  const items = [];
  for (let i = 0; i < count; i++) {
    const id = `skill-${String(i).padStart(3, "0")}`;
    const tier = i % 3 === 0 ? "recommended" : i % 3 === 1 ? "optional" : "unknown";
    const invState = i % 5 === 0 ? "present" : i % 7 === 0 ? "multiple_occurrences" : i % 11 === 0 ? "unknown" : "not_observed";
    skills.push({
      id,
      directory: `skills/${id}`,
      metadata: {
        name: id,
        description: `Synthetic engineering workflow ${i} for ${tier} verification.`,
      },
      entrypoint: { path: "SKILL.md", blobSha: sha, sizeBytes: 40, mode: "100644" },
      supportingFiles: [],
    });
    const matches = tier === "unknown"
      ? []
      : i % 6 === 0
        ? [{ boundaryPath: ".", verdict: tier, reasons: [{ code: "reusable_workflow", refs: [] }] }]
        : [
          { boundaryPath: `apps/service-${i % 4}`, verdict: tier, reasons: [{ code: "strong_project_match", refs: [] }] },
          { boundaryPath: `packages/shared-${i % 2}`, verdict: "optional", reasons: [{ code: "project_match", refs: [] }] },
        ];
    items.push({
      skillId: id,
      applicability: tier,
      taskApplicability: "not_assessed",
      reasons: tier === "unknown" ? [{ code: "no_supported_evidence", refs: [] }] : [],
      matches,
      inventory: {
        state: invState,
        occurrences: invState === "not_observed" ? [] : [{
          relativePath: `.agents/skills/${id}/SKILL.md`,
          boundaryPath: ".",
          kind: "skill",
          layout: ".agents/skills",
          match: invState === "unknown" ? "candidate" : "confirmed",
          metadataState: invState === "unknown" ? "mismatch" : "valid",
          directoryId: id,
          declaredId: invState === "unknown" ? "other" : id,
          flags: invState === "unknown" ? ["metadata_mismatch"] : [],
          evidenceIds: ["ev-0"],
        }],
      },
    });
  }
  return {
    catalog: { schemaVersion: 1, source: catalogSource, commitSha: sha, skills },
    result: {
      schemaVersion: 1,
      requestId: "req-synth",
      target: { canonicalDirectory: "/project" },
      catalog: { source: catalogSource, commitSha: sha, settingsRevision: "r1" },
      scanCoverage: { status: "complete", limits: [], unknown: [] },
      warnings: [],
      metadataCoverage: { valid: count, missing: 0, invalid: 0 },
      diagnostics: [],
      evidence: [{ id: "ev-0", relativePath: ".agents/skills/skill-000/SKILL.md", kind: "presence" }],
      items,
    },
  };
}

test("filterAndGroupSkills supports D1 grouping modes, D3 auto-reveal Unknown, P1 bulk count, and P2 hidden selected count", () => {
  const { catalog, result } = buildSyntheticDataset(9);
  const baseFilter = {
    search: "",
    applicability: "all",
    selection: "all",
    inventory: "all",
    groupBy: "applicability",
    showUnknown: false,
  };

  // Default: Unknown collapsed; selecting an Unknown skill counts as hiddenSelected = 1
  const r1 = filterAndGroupSkills(result.items, catalog, ["skill-002"], baseFilter);
  assert.equal(r1.groups.find((g) => g.key === "unknown").expanded, false);
  assert.equal(r1.summary.hiddenSelected, 1);
  assert.equal(r1.summary.unknownSelected, 1);
  assert.equal(r1.summary.additionalRecommendedCount, 3); // 000, 003, 006

  // D3: Searching for skill-002 auto-reveals Unknown without changing showUnknown
  const r2 = filterAndGroupSkills(result.items, catalog, ["skill-002"], { ...baseFilter, search: "skill-002" });
  const unk = r2.groups.find((g) => g.key === "unknown");
  assert.equal(unk.expanded, true);
  assert.equal(unk.autoRevealed, true);
  assert.equal(r2.summary.hiddenSelected, 0);

  // D1: By Boundary renders each skill at most once (even multi-boundary skills)
  const r3 = filterAndGroupSkills(result.items, catalog, [], { ...baseFilter, groupBy: "boundary" });
  const seenIds = r3.groups.flatMap((g) => g.items.map((i) => i.skillId));
  assert.equal(seenIds.length, 9);
  assert.equal(new Set(seenIds).size, 9);
  assert.equal(r3.groups[0].key, "boundary:project-wide");
  assert.equal(r3.groups.at(-1).key, "boundary:unmatched");

  // D1: By Observed Status groups cleanly
  const r4 = filterAndGroupSkills(result.items, catalog, [], { ...baseFilter, groupBy: "inventory" });
  assert.deepEqual(r4.groups.map((g) => g.title), ["Observed in project", "Not observed"]);
});

test("P1, P2, P3 & D2 UI: search/filter/grouping preserve manual selection, Show Selected reveals hidden Unknown, and search does NOT invalidate Preview", async (t) => {
  const { catalog, result } = buildSyntheticDataset(6);
  // skill-000 (rec, present), skill-001 (opt), skill-002 (unk), skill-003 (rec), skill-004 (opt), skill-005 (unk, present)
  let tree;
  const client = new QueryClient();
  const previews = [];
  const streams = [];

  const paseo = {
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "Demo", projectKind: "git", projectRootPath: "/project" }] }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
    providers: { snapshot: async () => ({ entries: [{ provider: "codex", enabled: true, status: "ready" }, { provider: "kiro", enabled: true, status: "ready" }] }) },
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
    if (method === "preview.providers") {
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

  const view = createElement(
    QueryClientProvider,
    { client },
    createElement(
      HostFixture.Provider,
      {
        value: {
          hosts: [{ serverId: "host-a", status: "online" }],
          settings: { status: "ready", revision: "r1", values: { catalogRef: sha }, reload: async () => {}, save: async () => true },
        },
      },
      createElement(
        PaseoApiProvider,
        { paseo },
        createElement(
          PluginRpcProvider,
          { invoke, subscribe },
          createElement(FoundationScreen, {
            host: { id: "host-a", label: "host-a" },
            theme: { colors: {} },
            layout: { compact: false, platform: "web" },
            params: {},
          }),
        ),
      ),
    ),
  );
  await act(async () => { tree = renderer.create(view); });
  t.after(async () => { await act(async () => tree.unmount()); client.clear(); });

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
  const input = (label) => tree.root.findAllByType("input").find((node) => node.props.accessibilityLabel === label);
  const text = () => tree.root.findAllByType("text").map((node) => node.children.join("")).join("\n");

  // Select project, detect providers (Codex + Kiro), and Scan
  await press("Choose project or workspace");
  await press("Demo · Git root");
  await press("Select Detected Providers");
  await press("Scan & Recommend");
  await act(async () => streams[0].observer.event({
    status: "ready",
    result: { ...result, requestId: streams[0].input.requestId },
  }));

  // D2: Observed-file labels & non-activation disclaimer present
  assert.match(text(), /Observed in project/);
  assert.match(text(), /does not confirm provider discovery, activation, or precedence/);

  // P2: Selection summary displays actual provider names
  assert.match(text(), /Target providers: Codex, Kiro/);

  // P1: Filter down to only skill-001 (optional), then click Select Recommended (+2) -> adds ALL recommended (000, 003), not just visible!
  await act(async () => input("Search skills").props.onChangeText("skill-001"));
  assert.match(text(), /Select Recommended \(\+2\)/);
  await press("Select skill-001"); // manual optional selection
  await press("Select Recommended");
  // Now 3 skills selected (000, 001, 003), and 2 of them (000, 003) are hidden by search "skill-001"!
  assert.match(text(), /Selected: 3 \(2 recommended · 1 optional · 0 unknown\)/);
  assert.match(text(), /2 selected skills are hidden by current filters or collapsed groups/);

  // Start Preview Changes and complete it
  await press("Preview Changes");
  assert.equal(previews.length, 1);
  assert.deepEqual(previews[0].input.selectedSkillIds, ["skill-000", "skill-001", "skill-003"]);
  await act(async () => previews[0].resolve({
    status: "ready",
    intent: previews[0].input,
    entries: previews[0].input.selectedSkillIds.map((skillId) => ({
      skillId,
      destination: `.agents/skills/${skillId}/SKILL.md`,
      status: "create",
      proposed: { sizeBytes: 10, sha256: "b".repeat(64), mode: 0o644 },
    })),
    derivedEntries: [],
    providers: [],
    diagnostics: [],
  }));
  assert.match(text(), /Preview Results/);

  // P3: Changing search, filters, Show Selected, and Group-By MUST NOT invalidate completed Preview!
  await press("Show Selected");
  assert.match(text(), /Preview Results/);
  await press("By Boundary");
  assert.match(text(), /Preview Results/);
  await press("By Observed Status");
  assert.match(text(), /Preview Results/);
  await press("By Applicability");
  assert.match(text(), /Preview Results/);

  // P1 + P3: Clear Selection clears all skills, preserves providers (Codex, Kiro), and DOES invalidate Preview!
  await press("Clear Selection");
  assert.doesNotMatch(text(), /Preview Results/);
  assert.match(text(), /Selected: 0/);
  assert.match(text(), /Target providers: Codex, Kiro/);

  // P2: Select an Unknown skill, then clear search so Unknown collapses -> hiddenSelected = 1 -> Show Selected reveals it!
  await press("Reset filters");
  await act(async () => input("Search skills").props.onChangeText("skill-002"));
  await press("Select skill-002");
  await press("Clear search");
  assert.match(text(), /1 selected skill is hidden by current filters or collapsed groups/);
  await press("Show Selected");
  assert.ok(button("Select skill-002"));
  assert.doesNotMatch(text(), /hidden by current filters/);
});

test("P4 scalability check: synthetic catalogs of 19, 100 and 512 skills on Desktop and compact Mobile", async () => {
  const results = [];
  for (const count of [19, 100, 512]) {
    const { catalog, result } = buildSyntheticDataset(count);
    const filterStart = performance.now();
    const out1 = filterAndGroupSkills(result.items, catalog, ["skill-000"], {
      search: "", applicability: "all", selection: "all", inventory: "all", groupBy: "applicability", showUnknown: false,
    });
    const out2 = filterAndGroupSkills(result.items, catalog, ["skill-000"], {
      search: "workflow 5", applicability: "all", selection: "all", inventory: "all", groupBy: "boundary", showUnknown: false,
    });
    const filterMs = performance.now() - filterStart;
    assert.equal(out1.filteredCount, count);
    assert.ok(out2.filteredCount > 0);

    for (const compact of [false, true]) {
      const renderStart = performance.now();
      let tree;
      await act(async () => {
        tree = renderer.create(createElement(RecommendationResults, {
          theme: { colors: {} },
          result,
          partial: false,
          catalog,
          selected: ["skill-000"],
          providers: ["codex"],
          compact,
          onToggle: () => {},
          onSelectRecommended: () => {},
          onClear: () => {},
        }));
      });
      const renderMs = performance.now() - renderStart;
      await act(async () => tree.unmount());
      results.push({ count, compact, filterMs: Number(filterMs.toFixed(2)), renderMs: Number(renderMs.toFixed(2)) });
      assert.ok(filterMs < 250, `Filtering ${count} skills too slow: ${filterMs}ms`);
    }
  }
  console.log("M5.3_SCALABILITY_BENCHMARK=" + JSON.stringify(results));
});
