import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readApplicability } from "../server/applicability-reader.ts";
import { ProjectScanner } from "../server/project-scanner.ts";
import { evaluateRecommendation } from "../server/recommendation-engine.ts";
import { createRecommendationHandler } from "../server/recommendation-rpc.ts";
import { catalogSource } from "../shared/catalog-settings.ts";
import { recommendationEvaluateSubscription as subscription } from "../shared/rpc.ts";

const snapshot = (skills) => ({ schemaVersion: 1, source: catalogSource, commitSha: "a".repeat(40), skills });
const input = (canonicalDirectory = "/project") => ({ requestId: "fixture", canonicalDirectory });
const descriptor = (path, content) => {
  const bytes = Buffer.from(content);
  const blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { path, bytes, blobSha, sizeBytes: bytes.length, mode: "100644" };
};
const skill = (id, rule) => ({
  id, directory: "skills/" + id,
  metadata: { name: id, description: "Fixture workflow." },
  entrypoint: descriptor("SKILL.md", `---\nname: ${id}\ndescription: Fixture workflow.\n---\n`),
  supportingFiles: rule === undefined ? [] : [descriptor("applicability.json", rule)],
});
const evidence = () => ({
  schemaVersion: 1, target: { canonicalDirectory: "/project", marker: "unknown" },
  boundaries: [{ rootRelativePath: ".", roles: ["root"], memberships: [], evidenceIds: [] }],
  facts: [], evidence: [], inventory: [], warnings: [], coverage: { status: "complete", limits: [], unknown: [] },
});
const project = (level) => JSON.stringify({ schemaVersion: 1, scope: "project", level });
const evaluate = (skills, data = evidence()) =>
  evaluateRecommendation(input(data.target.canonicalDirectory), snapshot(skills), data, "revision");

test("all 19 authoring rules evaluate against scanner evidence with traceable provenance", async (t) => {
  const contract = await readFile(new URL("../docs/reports/M2.4-applicability-contract.md", import.meta.url), "utf8");
  const examples = contract.split("## 5.")[1].split("## 6.")[0];
  const rules = [...examples.matchAll(/^### ([a-z-]+)\n\n```json\n([\s\S]*?)```/gm)].map(([, id, rule]) => skill(id, rule));
  assert.equal(rules.length, 19);

  const temporary = await mkdtemp(join(tmpdir(), "recommendation-engine-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const put = async (relative, value = "") => {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  const react = { react: "^19" };
  await put("web/package.json", { dependencies: {
    ...react, next: "^15", "react-hook-form": "^7", formik: "^2", "@tanstack/react-query": "^5", swr: "^2",
  } });
  await put("web/src/app/page.tsx");
  await put("web/pages/legacy.tsx");
  await put("sibling/package.json", { dependencies: react });
  await put("go/go.mod", "module example.test/api\ngo 1.24\nrequire (\n github.com/go-chi/chi/v5 v5.0.0\n github.com/jackc/pgx/v5 v5.0.0\n github.com/hibiken/asynq v0.1.0\n)\n");
  await put("stdlib/go.mod", "module example.test/stdlib\ngo 1.24\n");
  await put("stdlib/package.json", { dependencies: { pg: "^8", bullmq: "^5" } });
  await put("angular/angular.json", { projects: { portal: { root: "apps/portal" } } });
  await put("angular/package.json", { dependencies: { "@angular/core": "^20", "@angular/forms": "^20" } });
  await put("angular/apps/portal/src/main.ts");
  await put("laravel/composer.json", { require: { "laravel/framework": "^12", "illuminate/queue": "^12", "ext-pdo": "*" } });
  await put("laravel/config/queue.php");
  await put("laravel/config/database.php");
  await put("plugins/example/plugin.php", "<?php\n/*\nPlugin Name: Example\n*/\n");
  await put("themes/example/style.css", "/*\nTheme Name: Example\n*/\n");
  await put(".cursor/skills/react-ui-change/SKILL.md", skill("react-ui-change").entrypoint.bytes.toString());
  await put(".agents/skills/go-api-change/SKILL.md", skill("go-data-change").entrypoint.bytes.toString());
  await put(".kiro/skills/nextjs-route-change/SKILL.md", "malformed");

  const scanner = new ProjectScanner();
  t.after(() => scanner.dispose());
  const scan = await scanner.scan(input(root), new AbortController().signal);
  assert.notEqual(scan.status, "error");
  const event = evaluate(rules, scan.evidence);
  assert.equal(event.status, "partial", JSON.stringify(event));
  const { items, evidence: refs, metadataCoverage } = event.result;
  assert.deepEqual(metadataCoverage, { valid: 19, missing: 0, invalid: 0 });
  assert.equal(items.length, 19);
  const byId = Object.fromEntries(items.map((item) => [item.skillId, item]));
  for (const item of items) {
    assert.equal(item.taskApplicability, "not_assessed");
    assert.equal(item.applicability, item.skillId === "nextjs-data-fetching" ? "optional" : "recommended", item.skillId);
    for (const match of item.matches) for (const reason of match.reasons) for (const ref of reason.refs) {
      if (ref.kind === "project_evidence") assert.ok(refs.some(({ id }) => id === ref.evidenceId));
      if (ref.kind === "catalog_file") assert.equal(ref.blobSha, rules.find(({ id }) => id === item.skillId).supportingFiles[0].blobSha);
    }
  }
  for (const id of ["implement-change", "debug-regression", "review-change", "verify-change"]) {
    assert.equal(byId[id].matches[0].boundaryPath, ".");
    assert.equal(byId[id].matches[0].reasons[0].code, "reusable_workflow");
  }
  const verdicts = (id) => byId[id].matches.map(({ boundaryPath, verdict }) => [boundaryPath, verdict]);
  assert.deepEqual(verdicts("react-form-change"), [["sibling", "optional"], ["web", "recommended"]]);
  for (const id of ["go-api-change", "go-background-job", "go-data-change"]) {
    assert.deepEqual(verdicts(id), [["go", "recommended"], ["stdlib", "optional"]]);
  }
  assert.ok(verdicts("angular-form-change").some(([path, verdict]) => path === "angular/apps/portal" && verdict === "recommended"));
  const reasonPaths = (id, boundary) => byId[id].matches.find(({ boundaryPath }) => boundaryPath === boundary)
    .reasons[0].refs.filter(({ kind }) => kind === "project_evidence")
    .map(({ evidenceId }) => refs.find(({ id }) => id === evidenceId).relativePath);
  assert.ok(reasonPaths("angular-form-change", "angular/apps/portal").includes("angular/package.json"));
  assert.ok(reasonPaths("nextjs-route-change", "web").includes("web/pages/legacy.tsx"));
  assert.ok(reasonPaths("nextjs-route-change", "web").includes("web/src/app/page.tsx"));
  assert.ok(reasonPaths("laravel-background-job", "laravel").includes("laravel/config/queue.php"));
  assert.ok(reasonPaths("laravel-data-change", "laravel").includes("laravel/config/database.php"));
  assert.equal(byId["react-ui-change"].inventory.state, "present");
  assert.deepEqual(byId["go-api-change"].inventory.occurrences[0].flags, ["metadata_mismatch", "possible_customization"]);
  assert.equal(byId["go-data-change"].inventory.state, "unknown");
  assert.equal(byId["nextjs-route-change"].inventory.occurrences[0].match, "candidate");
  assert.equal(byId["wordpress-theme-change"].inventory.state, "unknown");

  for (const values of Object.values(scan.evidence)) if (Array.isArray(values)) values.reverse();
  assert.deepEqual(evaluate(rules.reverse(), scan.evidence), event);
});

test("strict ingestion isolates malformed, missing and future sidecars", () => {
  const invalid = [
    "{", "{}", "[]", '{ "schemaVersion": 1, "scope": "project" }',
    '{"schemaVersion":1,"scope":"project","level":"optional","extra":true}',
    '{"schemaVersion":1,"scope":"project","level":"optional","le\\u0076el":"recommended"}',
    '{"schemaVersion":2,"nested":[{"duplicate":1,"duplicate":2}]}',
    '{"schemaVersion":1,"scope":"boundary","appliesWhen":[[]]}',
    '\ufeff' + project("optional"), " ".repeat(8193), Buffer.from([0xff]),
  ];
  for (const rule of invalid) assert.deepEqual(readApplicability(Buffer.from(rule)), { code: "invalid_applicability" });
  const valid = skill("valid", project("optional"));
  const missing = skill("legacy");
  missing.supportingFiles.push(descriptor("nested/applicability.json", project("recommended")));
  const invalidRule = skill("broken", invalid[0]);
  const future = skill("future", '{"schemaVersion":2,"arbitrary":true}');
  const event = evaluate([valid, missing, invalidRule, future]);
  assert.equal(event.status, "partial");
  assert.deepEqual(event.result.diagnostics, [
    { skillId: "broken", code: "invalid_applicability" },
    { skillId: "future", code: "unsupported_rule_version" },
    { skillId: "legacy", code: "missing_applicability" },
  ]);
  assert.deepEqual(event.result.items.map(({ applicability }) => applicability), ["unknown", "unknown", "unknown", "optional"]);
  assert.equal(evaluate([missing]).status, "ready");
  assert.equal(evaluate([missing]).result.items[0].inventory.state, "not_observed");
  valid.supportingFiles[0].bytes[0] = 0;
  assert.equal(evaluate([valid]).code, "catalog_unavailable");
});

test("AND groups and source selectors cannot borrow facts across boundaries", () => {
  const data = evidence();
  data.boundaries.push({ rootRelativePath: "app", roles: ["application"], memberships: [], evidenceIds: [] });
  data.evidence.push(
    { id: "go", relativePath: "go.mod", kind: "declaration" },
    { id: "php", relativePath: "composer.json", kind: "declaration" },
    { id: "app", relativePath: "app/go.mod", kind: "declaration" },
  );
  data.facts.push(
    { boundaryPath: ".", kind: "language", key: "go", basis: "direct", evidenceIds: ["go"] },
    { boundaryPath: ".", kind: "router", key: "router", basis: "direct", evidenceIds: ["php"] },
    { boundaryPath: "app", kind: "router", key: "router", basis: "direct", evidenceIds: ["app"] },
  );
  const selector = { kind: "router", basis: "direct", sourceFile: "go.mod" };
  const language = { kind: "language", key: "go", basis: "direct" };
  const boundarySkill = (id, fields) => skill(id, JSON.stringify({ schemaVersion: 1, scope: "boundary", ...fields }));
  const skills = [
    boundarySkill("and", { appliesWhen: [[language, selector]], recommendWhen: "on_match" }),
    boundarySkill("promote", { appliesWhen: [[language]], recommendWhen: [[selector]] }),
    boundarySkill("inferred", { appliesWhen: [[{ ...language, basis: "inferred" }]] }),
  ];
  for (const status of ["complete", "partial"]) {
    data.coverage.status = status;
    const { result } = evaluate(skills, data);
    assert.deepEqual(result.items.map(({ applicability }) => applicability), ["unknown", "unknown", "optional"]);
    assert.equal(result.items[0].reasons[0].code, status === "partial" ? "partial_evidence" : "no_supported_evidence");
    assert.deepEqual(result.evidence.map(({ id }) => id), ["go"]);
  }
  for (const corrupt of [
    (v) => v.evidence.push(v.evidence[0]),
    (v) => v.boundaries.push(v.boundaries[0]),
    (v) => { v.facts[0].evidenceIds = ["missing"]; },
    (v) => { v.facts[0].evidenceIds = ["app"]; },
    (v) => { v.evidence[0].relativePath = "../go.mod"; },
    (v) => { v.boundaries[1].memberships = [{ workspaceRoot: ".", evidenceId: "go" }]; },
  ]) {
    const malformed = structuredClone(data);
    corrupt(malformed);
    assert.equal(evaluate(skills, malformed).code, "invalid_evidence");
  }
});

test("response and input budgets return typed errors without shortening the result", () => {
  const data = evidence();
  data.evidence = Array.from({ length: 120 }, (_, i) => ({
    id: String(i).padStart(3, "0") + "x".repeat(80), relativePath: "go.mod", kind: "declaration",
  }));
  data.facts.push({ boundaryPath: ".", kind: "language", key: "go", basis: "direct",
    evidenceIds: data.evidence.map(({ id }) => id) });
  const rule = JSON.stringify({ schemaVersion: 1, scope: "boundary",
    appliesWhen: [[{ kind: "language", key: "go", basis: "direct" }]] });
  assert.equal(evaluate(Array.from({ length: 80 }, (_, i) => skill("go-" + i, rule)), data).code, "limit_exceeded");
  assert.equal(evaluate(Array.from({ length: 513 }, (_, i) => skill("go-" + i, rule))).code, "limit_exceeded");
  const withTooManyBoundaries = evidence();
  for (let i = 0; i < 64; i++) {
    withTooManyBoundaries.boundaries.push({ rootRelativePath: "app-" + i, roles: ["application"], memberships: [], evidenceIds: [] });
  }
  assert.equal(evaluate([skill("go", rule)], withTooManyBoundaries).code, "limit_exceeded");
  const scannerProjection = evidence();
  scannerProjection.coverage = { status: "partial", limits: ["response_budget"], unknown: [] };
  assert.equal(evaluate([skill("go", rule)], scannerProjection).code, "limit_exceeded");
  data.evidence[0].id = "x".repeat(256 * 1024);
  assert.equal(evaluate([skill("go", rule)], data).code, "limit_exceeded");
});

const readySettings = (revision = "revision") => ({ status: "ready", revision, values: { catalogRef: "fixture" } });
const readyScan = (request) => ({ status: "ready", requestId: request.requestId, evidence: {
  ...evidence(), target: { ...evidence().target, canonicalDirectory: request.canonicalDirectory },
} });
const subscribe = (handler, request = input(), controller = new AbortController()) => {
  const events = [];
  const done = handler(subscription.input.parse(request), {
    signal: controller.signal, push: (event) => events.push(subscription.event.parse(event)),
  });
  return { done, events };
};

test("RPC validates input and pins catalog and settings through a fresh host scan", async () => {
  for (const extra of [{ evidence: {} }, { catalogRef: "x" }, { model: "x" }, { expectedCatalogSha: "short" }]) {
    assert.equal(subscription.input.safeParse({ ...input(), ...extra }).success, false);
  }
  let scans = 0;
  let loads = 0;
  let revision = "revision";
  let changeDuringScan = false;
  const handler = createRecommendationHandler(
    { read: async () => readySettings(revision) },
    { load: async (ref) => {
      assert.equal(ref, "fixture");
      loads++;
      return snapshot([skill("new-skill", project("optional"))]);
    } },
    { scan: async (request) => {
      scans++;
      if (changeDuringScan) revision = "changed";
      return readyScan(request);
    } },
  );
  const assertError = async (request, code) => {
    const call = subscribe(handler, request);
    await call.done;
    assert.deepEqual(call.events, [{ status: "error", requestId: request.requestId, code }]);
  };
  await assertError({ ...input(), expectedSettingsRevision: "stale" }, "catalog_settings_changed");
  assert.equal(loads, 0);
  await assertError({ ...input(), expectedCatalogSha: "b".repeat(40) }, "catalog_revision_mismatch");
  assert.equal(scans, 0);
  for (const [index, path] of ["/a", "/b", "/a"].entries()) {
    const request = { ...input(path), requestId: "selection-" + index, expectedCatalogSha: "a".repeat(40) };
    const call = subscribe(handler, request);
    await call.done;
    assert.equal(call.events.length, 1);
    assert.equal(call.events[0].status, "ready");
    assert.equal(call.events[0].result.requestId, request.requestId);
    assert.equal(call.events[0].result.target.canonicalDirectory, path);
  }
  assert.equal(scans, 3);
  changeDuringScan = true;
  await assertError(input(), "catalog_settings_changed");
});

test("RPC cancellation suppresses terminal events and holds the slot until work settles", async () => {
  for (const waitAt of ["load", "scan"]) {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const afterGate = async (step, value) => {
      if (step === waitAt) {
        entered.resolve();
        await gate.promise;
      }
      return value;
    };
    const makeHandler = () => createRecommendationHandler(
      { read: async () => readySettings() },
      { load: () => afterGate("load", snapshot([])) },
      { scan: (request, signal) => {
        if (waitAt === "scan" && request.requestId === "fixture") assert.equal(signal, controller.signal);
        return afterGate("scan", readyScan(request));
      } },
    );
    const controller = new AbortController();
    const handler = makeHandler();
    const first = subscribe(handler, input(), controller);
    await entered.promise;
    controller.abort();
    const busy = subscribe(handler, { ...input(), requestId: "overlap" });
    await busy.done;
    assert.equal(busy.events[0].code, "busy");
    const otherHost = subscribe(makeHandler(), { ...input("/other-host"), requestId: "other-host" });
    gate.resolve();
    await Promise.all([first.done, otherHost.done]);
    assert.deepEqual(first.events, []);
    assert.equal(otherHost.events[0].status, "ready");
    const next = subscribe(handler, { ...input(), requestId: "next" });
    await next.done;
    assert.equal(next.events[0].status, "ready");
  }
});

test("RPC attempts a terminal event once even when push rejects", async () => {
  const handler = createRecommendationHandler({ read: async () => readySettings() },
    { load: async () => assert.fail("unexpected load") }, { scan: async () => assert.fail("unexpected scan") });
  let attempts = 0;
  await assert.rejects(handler({ ...input(), expectedSettingsRevision: "old" }, {
    signal: new AbortController().signal, push: async () => {
      attempts++;
      throw new Error("disconnected");
    },
  }), /disconnected/);
  assert.equal(attempts, 1);
});

test("selector and file limits are inclusive and dependency filters remain exact", () => {
  const selector = { kind: "dependency", basis: "direct", key: "@example/tool",
    ecosystem: "npm", scope: "dev", sourceFile: "package.json" };
  const rule = (groups) => JSON.stringify({ schemaVersion: 1, scope: "boundary", appliesWhen: groups });
  for (const groups of [
    Array.from({ length: 5 }, () => [selector]),
    [Array.from({ length: 5 }, () => selector)],
    [[{ ...selector, sourceFile: "../package.json" }]],
    [[{ ...selector, key: "x\n" }]],
    [[{ ...selector, kind: "framework" }]],
  ]) assert.deepEqual(readApplicability(Buffer.from(rule(groups))), { code: "invalid_applicability" });
  const maximalGroups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => selector));
  assert.ok(readApplicability(Buffer.from(rule(maximalGroups).padEnd(8192))).rule);
  const data = evidence();
  data.evidence.push({ id: "tool", kind: "declaration", relativePath: "package.json" });
  data.facts.push({ boundaryPath: ".", kind: "dependency", basis: "direct", key: selector.key,
    ecosystem: "npm", scope: "dev", evidenceIds: ["tool"] });
  const cases = [
    ["exact", selector], ["literal-star", { ...selector, key: "*" }],
    ["case", { ...selector, key: "@Example/tool" }], ["scope", { ...selector, scope: "production" }],
    ["ecosystem", { ...selector, ecosystem: "go" }],
  ];
  const { result } = evaluate(cases.map(([id, candidate]) => skill(id, rule([[candidate]]))), data);
  assert.deepEqual(result.items.filter((item) => item.applicability === "optional").map(({ skillId }) => skillId), ["exact"]);
});

test("inventory preserves multiple layouts and unreadable candidates without changing applicability", () => {
  const data = evidence();
  const addOccurrence = (directoryId, layout, metadataState) => {
    const relativePath = `${layout}/${directoryId}/SKILL.md`;
    data.evidence.push({ id: relativePath, kind: "presence", relativePath });
    data.inventory.push({ relativePath, boundaryPath: ".", kind: "skill", layout, directoryId, metadataState,
      ...(metadataState === "valid" ? { declaredId: directoryId } : {}), evidenceIds: [relativePath] });
  };
  addOccurrence("reusable", ".agents/skills", "valid");
  addOccurrence("reusable", ".cursor/skills", "valid");
  addOccurrence("unreadable", ".kiro/skills", "unreadable");
  const { result } = evaluate([skill("reusable", project("recommended")), skill("unreadable")], data);
  const [reusable, unreadable] = result.items;
  assert.equal(reusable.applicability, "recommended");
  assert.equal(reusable.inventory.state, "multiple_occurrences");
  assert.deepEqual(reusable.inventory.occurrences.map(({ layout, match }) => [layout, match]),
    [[".agents/skills", "confirmed"], [".cursor/skills", "confirmed"]]);
  assert.equal(unreadable.inventory.state, "unknown");
  assert.deepEqual(unreadable.inventory.occurrences[0].flags, ["unreadable"]);
});
