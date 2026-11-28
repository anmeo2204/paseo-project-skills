import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { act, createElement } from "react";
import renderer from "react-test-renderer";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { createMainPluginServer } from "../index.server.ts";
import { ApplyJournal, terminalRetentionMs } from "../server/apply-journal.ts";
import { createDiscoveryConcurrencyGate, listJournalSummaries } from "../server/fixture-apply.ts";
import { applyListRpc, applyStatusRpc } from "../shared/apply.ts";
import { catalogSource } from "../shared/catalog-settings.ts";
import { createOperationTracker, shouldAcceptOperation, shouldAcceptSummary } from "../client/apply-tracker.ts";
import { FixtureApprovalScope } from "../client/fixture-approval.tsx";
import { FoundationScreen } from "../client/foundation-screen.tsx";
import { HostFixture } from "./client-fixture.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const hash = (ch) => ch.repeat(64);
const opId = (n) => String(n).padStart(32, "0");

function makeRecord({
  id,
  hostId = "host-a",
  installation = "paseo-project-skills",
  phase = "completed",
  settledAt,
  ledger = [{ destination: ".agents/skills/demo/SKILL.md", kind: "file", state: "created_verified" }],
}) {
  return {
    hostId,
    installation,
    instance: hash("1"),
    requestHash: hash("2"),
    receiptHash: hash("3"),
    ...(settledAt !== undefined ? { settledAt } : {}),
    operation: {
      status: "operation",
      operationId: id,
      planDigest: hash("4"),
      phase,
      code: phase === "completed" ? "none" : "partial_failure",
      targetMutated: phase === "failed_before_write" ? false : phase === "recovery_required" ? "unknown" : true,
      requiresPreview: phase !== "completed",
      durability: phase === "completed" ? "fsync_completed" : "not_confirmed",
      ledger,
    },
  };
}

test("P3 ApplyJournal.list is strictly read-only, bounded, prioritizes recovery/active over completed, isolates host/installation, and omits paths/ledger", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pps-m55-journal-")));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));

  let wall = 1_700_000_000_000;
  const journal = new ApplyJournal(dir, () => wall);

  // Publish: 1 expired completed, 2 valid completed, 1 recovery_required, 1 other host, 1 other installation
  journal.publish(makeRecord({ id: opId(1), phase: "completed" }), true);
  wall += terminalRetentionMs + 1000; // opId(1) is now expired!
  journal.publish(makeRecord({ id: opId(2), phase: "completed" }), true);
  wall += 1000;
  journal.publish(makeRecord({ id: opId(3), phase: "completed" }), true);
  wall += 1000;
  journal.publish(makeRecord({ id: opId(4), phase: "recovery_required" }), true);
  journal.publish(makeRecord({ id: opId(5), hostId: "host-other", phase: "recovery_required" }), true);
  journal.publish(makeRecord({ id: opId(6), installation: "other-plugin", phase: "recovery_required" }), true);

  // Add corrupted JSON, wrong-mode file (0644), and symlink inside journal dir
  await writeFile(join(dir, `${opId(7)}.json`), "{corrupt", { mode: 0o600 });
  await writeFile(join(dir, `${opId(8)}.json`), JSON.stringify(makeRecord({ id: opId(8) })), { mode: 0o644 });
  await symlink("/etc/hosts", join(dir, `${opId(9)}.json`));

  const filesBefore = (await readdir(dir)).sort();
  const expiredStatBefore = await stat(join(dir, `${opId(1)}.json`));

  // Page 1 (limit 2): recovery_required MUST appear first (never obscured by completed history!)
  const page1 = await listJournalSummaries({
    journal,
    hostId: "host-a",
    installation: "paseo-project-skills",
    rawInput: { limit: 2 },
    reportOperation: (r) => r.operation,
  });
  assert.equal(page1.status, "ready");
  assert.equal(page1.unreadableCount, 3); // corrupt + 0644 + symlink
  assert.equal(page1.items.length, 2);
  assert.equal(page1.items[0].operationId, opId(4)); // recovery_required first!
  assert.equal(page1.items[0].phase, "recovery_required");
  assert.equal(page1.items[1].operationId, opId(3)); // newest completed second
  assert.ok(page1.nextCursor);

  // Verify summaries NEVER expose paths, ledger rows, requestHash, receiptHash, or instance
  const serialized = JSON.stringify(page1);
  assert.doesNotMatch(serialized, /\.agents\/skills/);
  assert.doesNotMatch(serialized, /"ledger":/);
  assert.doesNotMatch(serialized, /requestHash|receiptHash/);

  // Page 2: deterministic cursor with zero duplicate operationIds
  const page2 = await listJournalSummaries({
    journal,
    hostId: "host-a",
    installation: "paseo-project-skills",
    rawInput: { limit: 2, cursor: page1.nextCursor },
    reportOperation: (r) => r.operation,
  });
  assert.equal(page2.status, "ready");
  assert.deepEqual(page2.items.map((i) => i.operationId), [opId(2)]);
  assert.equal(page2.nextCursor, undefined);

  // Strictly read-only: expired file opId(1) was NOT unlinked or modified!
  assert.deepEqual((await readdir(dir)).sort(), filesBefore);
  assert.equal((await stat(join(dir, `${opId(1)}.json`))).mtimeMs, expiredStatBefore.mtimeMs);

  // Bounded directory enumeration sets truncated: true
  const bounded = await journal.list({ hostId: "host-a", installation: "paseo-project-skills", limits: { maxRecordsRead: 1 } });
  assert.equal(bounded.truncated, true);

  // Unsafe directory mode fails closed with journal_unavailable
  await chmod(dir, 0o755);
  try {
    const unsafe = await listJournalSummaries({
      journal,
      hostId: "host-a",
      installation: "paseo-project-skills",
      rawInput: {},
      reportOperation: (r) => r.operation,
    });
    assert.deepEqual(unsafe, { status: "error", code: "journal_unavailable" });
  } finally {
    await chmod(dir, 0o700);
  }
});

test("P1 Relay opt-in, deny and live revocation gate apply.list.v1 while preserving apply.status.v1 known-ID recovery", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pps-m55-relay-")));
  await chmod(home, 0o700);
  t.after(() => rm(home, { recursive: true, force: true }));

  const coordDir = join(home, "runtime", "project-skills", "coordinator");
  await mkdir(coordDir, { recursive: true, mode: 0o700 });
  const journal = new ApplyJournal(coordDir);
  journal.publish(makeRecord({ id: opId(11), hostId: "srv-1", phase: "completed" }), true);

  // Relay ON, allowRelay OFF -> apply.list.v1 MUST fail closed
  await writeFile(join(home, "config.json"), JSON.stringify({
    version: 1,
    daemon: { listen: "127.0.0.1:18765", relay: { enabled: true } },
  }), { mode: 0o600 });

  const handlers = new Map();
  const cleanup = createMainPluginServer(
    {
      handle: (contract, handler) => handlers.set(contract, handler),
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "r1", values: { catalogRef: "" } }) }),
    },
    { daemonHome: home, env: { ...process.env, PASEO_HOME: home } },
  );
  t.after(() => cleanup());

  const ctx = { paseo: { hosts: { list: async () => ({ self: { serverId: "srv-1" } }) } } };
  const denied = await handlers.get(applyListRpc)({}, ctx);
  assert.deepEqual(denied, { status: "error", code: "unsupported_environment" });

  // Known-ID apply.status.v1 STILL works for recovery even when Relay is ON and allowRelay is OFF!
  const knownStatus = await handlers.get(applyStatusRpc)({ operationId: opId(11) }, ctx);
  assert.equal(knownStatus.status, "operation");
  assert.equal(knownStatus.operationId, opId(11));

  // Enable host Relay opt-in -> apply.list.v1 succeeds on next request without restart!
  await writeFile(join(home, "runtime", "project-skills", "enrollments.json"), JSON.stringify({
    schemaVersion: 1,
    allowRelay: true,
    roots: {},
  }), { mode: 0o600 });
  const allowed = await handlers.get(applyListRpc)({}, ctx);
  assert.equal(allowed.status, "ready");
  assert.deepEqual(allowed.items.map((i) => i.operationId), [opId(11)]);

  // Revoke host Relay opt-in -> apply.list.v1 immediately fails closed again!
  await writeFile(join(home, "runtime", "project-skills", "enrollments.json"), JSON.stringify({
    schemaVersion: 1,
    allowRelay: false,
    roots: {},
  }), { mode: 0o600 });
  const revoked = await handlers.get(applyListRpc)({}, ctx);
  assert.deepEqual(revoked, { status: "error", code: "unsupported_environment" });
});

test("P2, P4 & P5 tracker merge prevents terminal regression, preserves tracking-before-submit & localStorage, and clears only discovery entries on denial", async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } };
  const tracker = createOperationTracker({ slot: "slot-1", storage: () => storage });

  // P4: Tracking-before-submit fails closed when storage throws
  const brokenTracker = createOperationTracker({
    slot: "slot-1",
    storage: () => ({ getItem: () => { throw new Error("quota"); }, setItem: () => { throw new Error("quota"); } }),
  });
  let sent = 0;
  brokenTracker.submit(
    { hostId: "host-a", slot: "slot-1" },
    { previewId: hash("a"), planDigest: hash("4"), viewNonce: "n1", operationId: opId(20), approval: "create_only_v1" },
    async () => { sent++; return { status: "error", code: "busy" }; },
  );
  assert.equal(sent, 0);
  assert.equal(brokenTracker.snapshot()[0].code, "tracking_unavailable");

  // Submit local operation -> completes -> delayed list summary with pending phase MUST NOT regress it!
  tracker.submit(
    { hostId: "host-a", slot: "slot-1" },
    { previewId: hash("a"), planDigest: hash("4"), viewNonce: "n1", operationId: opId(21), approval: "create_only_v1" },
    async () => makeRecord({ id: opId(21), phase: "completed" }).operation,
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tracker.snapshot()[0].operation.phase, "completed");

  tracker.ingestDiscovered("host-a", "slot-1", [
    {
      operationId: opId(21),
      planDigest: hash("4"),
      phase: "writing",
      code: "none",
      targetMutated: "unknown",
      requiresPreview: true,
      durability: "not_confirmed",
      ledgerCount: 1,
      updatedAt: 100,
    },
    {
      operationId: opId(22),
      planDigest: hash("4"),
      phase: "recovery_required",
      code: "terminal_record_missing",
      targetMutated: "unknown",
      requiresPreview: true,
      durability: "not_confirmed",
      ledgerCount: 2,
      updatedAt: 200,
    },
  ]);
  // opId(21) stayed completed with full ledger; opId(22) was ingested as discovered
  const row21 = tracker.snapshot().find((r) => r.operationId === opId(21));
  assert.equal(row21.operation.phase, "completed");
  assert.equal(row21.operation.ledger.length, 1);
  assert.equal(tracker.snapshot().find((r) => r.operationId === opId(22)).summary.phase, "recovery_required");

  // P1 & P5: clearDiscoveryOnly removes opId(22) (discovered) but NEVER removes opId(21) (local)!
  tracker.clearDiscoveryOnly("host-a", "slot-1");
  assert.equal(tracker.snapshot().some((r) => r.operationId === opId(22)), false);
  assert.equal(tracker.snapshot().some((r) => r.operationId === opId(21)), true);
});

test("Mobile restart recovery (empty memory storage), lazy ledger fetch, stale list rejection on host switch, and manual ID lookup", async (t) => {
  const sha = "a".repeat(40);
  const client = new QueryClient();
  const listQueue = [];
  const statusQueue = [];
  // Fresh memory-only tracker simulates Mobile force-kill / cold restart!
  const tracker = createOperationTracker();
  let tree;

  const paseo = {
    projects: { list: async () => ({ projects: [] }) },
    workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
  const invoke = (method, input) => {
    if (method === "catalog.releases") {
      return Promise.resolve({
        status: "ready", source: catalogSource, settingsRevision: "r1",
        active: { catalogRef: sha, isPinnedSha: true },
        releases: [], latestStable: null, updateStatus: "no_stable_releases", updateAvailable: false, checkedAt: 1, cached: false,
      });
    }
    if (method === "apply.list.v1") {
      const p = { ...Promise.withResolvers(), input };
      listQueue.push(p);
      return p.promise;
    }
    if (method === "apply.status.v1") {
      const p = { ...Promise.withResolvers(), input };
      statusQueue.push(p);
      return p.promise;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };

  const render = async (host = "host-a", status = "online") => {
    const screen = createElement(FoundationScreen, {
      host: { id: host, label: host },
      theme: { colors: {} },
      layout: { compact: true, platform: "ios" },
      params: {},
    });
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
        createElement(
          PaseoApiProvider,
          { paseo },
          createElement(PluginRpcProvider, { invoke }, createElement(FixtureApprovalScope, { tracker, slot: "slot-m" }, screen)),
        ),
      ),
    );
    await act(async () => {
      if (tree) tree.update(node);
      else tree = renderer.create(node);
    });
  };
  t.after(async () => { if (tree) await act(async () => tree.unmount()); client.clear(); });

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
  const text = () => tree.root.findAllByType("text").map((n) => n.children.join("")).join("\n");

  await render("host-a", "online");
  assert.equal(listQueue.length, 1);

  // Switch host A -> B -> A before listQueue[0] settles -> delayed listQueue[0] MUST be ignored!
  await render("host-b", "online");
  await render("host-a", "online");
  await act(async () => listQueue[0].resolve({
    status: "ready",
    items: [{
      operationId: opId(99),
      planDigest: hash("4"),
      phase: "completed",
      code: "none",
      targetMutated: true,
      requiresPreview: false,
      durability: "fsync_completed",
      ledgerCount: 1,
      updatedAt: 100,
    }],
    unreadableCount: 0,
    truncated: false,
  }));
  assert.equal(tracker.snapshot().some((r) => r.operationId === opId(99)), false);

  // Resolve current host-a discovery with a recovery_required operation -> Mobile banner appears on Step 1!
  await act(async () => listQueue.at(-1).resolve({
    status: "ready",
    items: [{
      operationId: opId(31),
      planDigest: hash("4"),
      phase: "recovery_required",
      code: "terminal_record_missing",
      targetMutated: "unknown",
      requiresPreview: true,
      durability: "not_confirmed",
      ledgerCount: 1,
      updatedAt: 500,
    }],
    unreadableCount: 1,
    truncated: false,
  }));
  assert.match(text(), /requires review or recovery/);
  await press("View Apply Operations");
  assert.match(text(), /1 journal record could not be read/);

  // Expanding Operation ledger lazily fetches full ledger via apply.status.v1
  await press("Operation ledger");
  assert.equal(statusQueue.length, 1);
  assert.equal(statusQueue[0].input.operationId, opId(31));
  await act(async () => statusQueue[0].resolve(makeRecord({ id: opId(31), phase: "recovery_required" }).operation));
  assert.match(text(), /\.agents\/skills\/demo\/SKILL\.md/);

  // Simulate Relay revocation on refresh -> clears discovery-only items, shows notice, manual ID lookup still works!
  await press("Refresh operations");
  await act(async () => listQueue.at(-1).resolve({ status: "error", code: "unsupported_environment" }));
  assert.match(text(), /Operation discovery is unavailable under the current Relay or trust policy/);
  assert.equal(tracker.snapshot().some((r) => r.operationId === opId(31)), false);

  await press("Look up operation by ID");
  const idInput = tree.root.findAllByType("input").find((n) => n.props.accessibilityLabel === "Operation ID");
  await act(async () => idInput.props.onChangeText(opId(31)));
  await press("Check by ID");
  await act(async () => statusQueue.at(-1).resolve(makeRecord({ id: opId(31), phase: "completed" }).operation));
  assert.match(text(), /Completed/);
  assert.match(text(), new RegExp(opId(31)));
});

test("P7-A & P7-B shared freshness rejects older same-phase summaries/ledgers, coordinates lookup/check/submit/discovery, and allows restart recovery", async () => {
  const tracker = createOperationTracker();
  const id = opId(41);

  // Same-phase writing summary with older updatedAt MUST be rejected (P7-A)
  tracker.ingestDiscovered("host-a", "slot-1", [{
    operationId: id, planDigest: hash("4"), phase: "writing", code: "none",
    targetMutated: true, requiresPreview: true, durability: "not_confirmed", ledgerCount: 2, updatedAt: 2000,
  }]);
  tracker.ingestDiscovered("host-a", "slot-1", [{
    operationId: id, planDigest: hash("4"), phase: "writing", code: "none",
    targetMutated: false, requiresPreview: true, durability: "not_confirmed", ledgerCount: 2, updatedAt: 1000,
  }]);
  assert.equal(tracker.snapshot()[0].summary.updatedAt, 2000);
  assert.equal(tracker.snapshot()[0].summary.targetMutated, true);

  // Same-phase writing full operation: ledger state progression governs over byte counts alone (P7-B)
  const writingLater = makeRecord({
    id,
    phase: "writing",
    ledger: [
      { destination: ".agents/skills/demo/SKILL.md", kind: "file", state: "created_verified", bytesWritten: 10 },
      { destination: ".agents/skills/demo/extra.txt", kind: "file", state: "created_incomplete", bytesWritten: 5 },
    ],
  }).operation;
  const writingEarlierHighBytes = makeRecord({
    id,
    phase: "writing",
    ledger: [
      { destination: ".agents/skills/demo/SKILL.md", kind: "file", state: "created_incomplete", bytesWritten: 9999 },
      { destination: ".agents/skills/demo/extra.txt", kind: "file", state: "not_attempted" },
    ],
  }).operation;

  assert.equal(shouldAcceptOperation({ operation: writingLater }, writingEarlierHighBytes), false);
  assert.equal(shouldAcceptOperation({ operation: writingEarlierHighBytes }, writingLater), true);
  assert.equal(shouldAcceptSummary({ operation: writingLater }, {
    operationId: id, planDigest: hash("4"), phase: "writing", code: "none",
    targetMutated: true, requiresPreview: true, durability: "not_confirmed", ledgerCount: 2, updatedAt: 9999,
  }), false);

  // Race: lookup #1 starts (slow, returns stale writingEarlierHighBytes), check #2 starts (fast, returns writingLater)
  let resolveLookup1;
  const lookup1Promise = tracker.lookup("host-a", "slot-1", id, () => new Promise((r) => { resolveLookup1 = r; }));
  // Supersede with a newer lookup #2 returning writingLater
  const lookup2Result = await tracker.lookup("host-a", "slot-1", id, async () => writingLater);
  assert.equal(lookup2Result.status, "found");
  assert.equal(tracker.snapshot()[0].operation.ledger[0].state, "created_verified");

  // Slow lookup #1 settles late -> MUST be discarded by token AND freshness check
  resolveLookup1(writingEarlierHighBytes);
  const lookup1Result = await lookup1Promise;
  assert.equal(lookup1Result.status, "unknown");
  assert.equal(tracker.snapshot()[0].operation.ledger[0].state, "created_verified");

  // Legitimate daemon restart recovery transition: writing -> recovery_required MUST be accepted!
  const restartRecovery = makeRecord({
    id,
    phase: "recovery_required",
    ledger: writingLater.ledger,
  }).operation;
  restartRecovery.code = "terminal_record_missing";
  restartRecovery.targetMutated = "unknown";
  const recLookup = await tracker.lookup("host-a", "slot-1", id, async () => restartRecovery);
  assert.equal(recLookup.status, "found");
  assert.equal(tracker.snapshot()[0].operation.phase, "recovery_required");

  // Once terminal (recovery_required), a conflicting terminal phase (completed) MUST NOT overwrite it!
  const conflictingCompleted = makeRecord({ id, phase: "completed", ledger: writingLater.ledger }).operation;
  assert.equal(shouldAcceptOperation({ operation: restartRecovery }, conflictingCompleted), false);
  await tracker.lookup("host-a", "slot-1", id, async () => conflictingCompleted);
  assert.equal(tracker.snapshot()[0].operation.phase, "recovery_required");
});

test("P8-A & P8-B bounded opendir iterator, concurrent discovery gate, atomic rename safety, and mid-scan trust revocation", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pps-m56-p8-")));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const journal = new ApplyJournal(dir);
  for (let i = 1; i <= 6; i++) {
    journal.publish(makeRecord({ id: opId(100 + i), phase: "completed" }), true);
  }
  // Add 10 non-journal stray files so total directory entries (16) exceed small maxDirectoryEntries cap (5)
  for (let i = 1; i <= 10; i++) {
    await writeFile(join(dir, `stray-${i}.tmp`), "x", { mode: 0o600 });
  }

  const capped = await journal.list({
    hostId: "host-a",
    installation: "paseo-project-skills",
    limits: { maxDirectoryEntries: 5 },
  });
  assert.equal(capped.truncated, true);
  assert.ok(capped.entries.length <= 5);

  // Concurrent discovery gate bounds active scans and returns busy when exceeded
  const gate = createDiscoveryConcurrencyGate(1);
  let releaseFirst;
  const firstScan = listJournalSummaries({
    journal,
    hostId: "host-a",
    installation: "paseo-project-skills",
    rawInput: {},
    gate,
    reportOperation: (r) => r.operation,
    onEntryProcessed: () => new Promise((r) => { if (!releaseFirst) releaseFirst = r; else r(); }),
  });
  // Wait one tick so firstScan acquires the gate and pauses inside async scan
  await new Promise((r) => setTimeout(r, 15));
  const secondScan = await listJournalSummaries({
    journal,
    hostId: "host-a",
    installation: "paseo-project-skills",
    rawInput: {},
    gate,
    reportOperation: (r) => r.operation,
  });
  assert.deepEqual(secondScan, { status: "error", code: "busy" });

  // Atomic journal replacement mid-scan: publish terminal replacement for opId(101) while firstScan is paused
  journal.publish(makeRecord({ id: opId(101), phase: "partial_failure" }), false);
  releaseFirst();
  const firstResult = await firstScan;
  assert.equal(firstResult.status, "ready");
  assert.equal(firstResult.items.length, 6);

  // Trust-policy revocation DURING asynchronous discovery fails closed with unsupported_environment!
  let trustAllowed = true;
  const revokedMidScan = await listJournalSummaries({
    journal,
    hostId: "host-a",
    installation: "paseo-project-skills",
    rawInput: {},
    verifyTrust: () => trustAllowed,
    reportOperation: (r) => r.operation,
    onEntryProcessed: () => { trustAllowed = false; },
  });
  assert.deepEqual(revokedMidScan, { status: "error", code: "unsupported_environment" });
});

test("P8-B daemon event-loop responsiveness measurement during 64-record async journal discovery", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pps-m56-resp-")));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const journal = new ApplyJournal(dir);
  const bigLedger = Array.from({ length: 40 }, (_, i) => ({
    destination: `.agents/skills/skill-${i}/SKILL.md`,
    kind: "file",
    state: "created_verified",
    bytesWritten: 2048,
  }));
  for (let i = 1; i <= 64; i++) {
    journal.publish(makeRecord({ id: opId(200 + i), phase: "completed", ledger: bigLedger }), true);
  }

  let ticks = 0;
  let maxLagMs = 0;
  let lastTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - lastTick - 5);
    if (lag > maxLagMs) maxLagMs = lag;
    lastTick = now;
    ticks++;
  }, 5);

  const start = performance.now();
  const listed = await journal.list({ hostId: "host-a", installation: "paseo-project-skills" });
  const scanMs = performance.now() - start;
  clearInterval(timer);

  assert.equal(listed.entries.length, 64);
  assert.equal(listed.truncated, false);
  console.log(`M5.6_DISCOVERY_RESPONSIVENESS=${JSON.stringify({
    records: listed.entries.length,
    scanMs: Number(scanMs.toFixed(2)),
    timerTicks: ticks,
    maxLagMs: Number(maxLagMs.toFixed(2)),
  })}`);
});

test("P6 pagination with > 20 priority-0 records deduplicates deterministically and warns about additional unresolved pages", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pps-m56-p6-")));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));

  let wall = 1_700_000_000_000;
  const journal = new ApplyJournal(dir, () => wall);
  // Publish 25 priority-0 records (recovery_required & partial_failure) + 3 completed records
  for (let i = 1; i <= 25; i++) {
    wall += 1000;
    journal.publish(makeRecord({
      id: opId(300 + i),
      phase: i % 2 === 0 ? "partial_failure" : "recovery_required",
    }), true);
  }
  for (let i = 1; i <= 3; i++) {
    wall += 1000;
    journal.publish(makeRecord({ id: opId(400 + i), phase: "completed" }), true);
  }

  const page1 = await listJournalSummaries({
    journal,
    hostId: "host-a",
    installation: "paseo-project-skills",
    rawInput: { limit: 20 },
    reportOperation: (r) => r.operation,
  });
  assert.equal(page1.status, "ready");
  assert.equal(page1.items.length, 20);
  assert.ok(page1.nextCursor?.startsWith("0:"), `Expected priority-0 nextCursor, got ${page1.nextCursor}`);

  const page2 = await listJournalSummaries({
    journal,
    hostId: "host-a",
    installation: "paseo-project-skills",
    rawInput: { limit: 20, cursor: page1.nextCursor },
    reportOperation: (r) => r.operation,
  });
  assert.equal(page2.status, "ready");
  assert.equal(page2.items.length, 8); // remaining 5 priority-0 + 3 completed
  assert.equal(page2.nextCursor, undefined);

  // Zero duplicate operationIds across pages; all 25 priority-0 precede the 3 completed
  const all = [...page1.items, ...page2.items];
  assert.equal(new Set(all.map((i) => i.operationId)).size, 28);
  assert.ok(all.slice(0, 25).every((i) => i.phase === "recovery_required" || i.phase === "partial_failure"));
  assert.ok(all.slice(25).every((i) => i.phase === "completed"));

  // UI verifies explicit notice when nextCursor starts with "0:" and deduplicates after Load more
  const tracker = createOperationTracker();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const paseo = {
    hosts: { list: async () => ({ self: { serverId: "host-a" } }) },
    projects: { list: async () => ({ projects: [] }) },
    workspaces: { list: async () => ({ workspaces: [], hasMore: false }) },
    providers: { list: async () => ({ providers: [] }) },
  };
  const invoke = async (name, input) => {
    if (name === applyListRpc.name) return input?.cursor ? page2 : page1;
    return { status: "ready" };
  };
  let tree;
  await act(async () => {
    tree = renderer.create(createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        HostFixture.Provider,
        {
          value: {
            hosts: [{ serverId: "host-a", status: "online" }],
            settings: { status: "ready", revision: "r1", values: { catalogRef: hash("a") }, reload: async () => {}, save: async () => true },
          },
        },
        createElement(
          PaseoApiProvider,
          { paseo },
          createElement(
            PluginRpcProvider,
            { invoke },
            createElement(
              FixtureApprovalScope,
              { tracker, slot: "slot-p6" },
              createElement(FoundationScreen, {
                theme: { colors: {} },
                host: { id: "host-a", label: "Host A" },
                layout: { compact: false, platform: "desktop" },
                params: {},
              }),
            ),
          ),
        ),
      ),
    ));
  });
  t.after(async () => { await act(async () => { tree.unmount(); }); queryClient.clear(); });

  const text = () => tree.root.findAllByType("text").map((n) => n.children.join("")).join("\n");
  assert.match(text(), /Additional active or recovery-required operations exist on later pages/);
  assert.equal(tracker.snapshot().length, 20);

  const loadMore = tree.root.findAllByType("pressable").find((n) =>
    n.props.accessibilityLabel === "Load more" ||
    n.findAllByType("text").some((tNode) => tNode.children.join("") === "Load more"),
  );
  assert.ok(loadMore);
  await act(async () => { loadMore.props.onPress(); });
  assert.equal(tracker.snapshot().length, 28);
  assert.doesNotMatch(text(), /Additional active or recovery-required operations exist on later pages/);
});
