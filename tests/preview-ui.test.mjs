import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import renderer from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { PaseoApiProvider, PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { FoundationScreen } from '../client/foundation-screen.tsx';
import { catalogSource } from '../shared/catalog-settings.ts';
import { receiptPolicy } from '../shared/preview-receipt.ts';
import { createOperationTracker } from '../client/apply-tracker.ts';
import { FixtureApprovalScope } from '../client/fixture-approval.tsx';
import { HostFixture } from './client-fixture.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);
const sha = 'a'.repeat(40);
const settingsFor = (revision = 'r1', saving = false) => ({ status: 'ready', revision, saving, values: { catalogRef: 'release' }, reload: async () => {}, save: async () => true });
const catalog = { schemaVersion: 1, source: catalogSource, commitSha: sha, skills: ['demo', 'other'].map((id) => ({
  id, directory: 'skills/' + id, metadata: { name: id, description: 'Fixture skill ' + id },
  entrypoint: { path: 'SKILL.md', blobSha: sha, sizeBytes: 40, mode: '100644' }, supportingFiles: [],
})) };
const terminal = (input) => ({ status: 'ready', result: {
  schemaVersion: 1, requestId: input.requestId, target: { canonicalDirectory: input.canonicalDirectory },
  catalog: { source: catalogSource, commitSha: sha, settingsRevision: input.expectedSettingsRevision },
  scanCoverage: { status: 'complete', limits: [], unknown: [] }, warnings: [], metadataCoverage: { valid: 2, missing: 0, invalid: 0 }, diagnostics: [], evidence: [],
  items: ['demo', 'other'].map((skillId) => ({ skillId, applicability: skillId === 'demo' ? 'recommended' : 'optional', taskApplicability: 'not_assessed',
    reasons: [], matches: [], inventory: { state: 'not_observed', occurrences: [] } })),
} });
const fingerprint = { sizeBytes: 40, sha256: 'a'.repeat(64), mode: 0o644 };
const verification = (id) => ({ basis: 'historical_m3_1', report: 'M3.1-completion-report.md', paseoVersion: '0.17.5',
  binaryVersion: { codex: '0.167.0', cursor: '2026.10.22-27dcf5f', antigravity: '1.5.18', kiro: '2.34.2' }[id],
  transport: id === 'cursor' ? 'cursor-agent acp' : id === 'codex' ? 'app-server' : id + ' acp',
  loadMode: id === 'kiro' ? 'kiro_default' : id === 'cursor' ? 'ask' : id === 'antigravity' ? 'plan' : 'auto',
  cwdScope: id === 'kiro' ? 'git_root' : 'root_and_nested', note: id === 'antigravity' ? 'Nested CWD retains ancestor read permission flow.' : 'Historical fixture evidence.',
});
function ready(input, { status = 'create', kiro = 'ready' } = {}) {
  const entries = input.selectedSkillIds.map((skillId) => ({ skillId, destination: `.agents/skills/${skillId}/SKILL.md`, status, proposed: { ...fingerprint },
    ...(status === 'unchanged' ? { existing: { ...fingerprint } } : { change: { kind: 'text', unifiedDiff: '--- /dev/null\n+++ b/fixture\n@@ -0,0 +1,1 @@\n+Fixture body\n' } }),
  }));
  const result = { status: 'ready', intent: structuredClone(input), entries, derivedEntries: [], providers: [], diagnostics: [] };
  for (const providerId of input.targetProviderIds) {
    if (providerId !== 'kiro') result.providers.push({ providerId, strategy: 'canonical_only', status: 'canonical_only', verification: verification(providerId), skills: [] });
    else {
      result.providers.push({ providerId, strategy: 'kiro_derived', status: kiro, rootStatus: kiro === 'limited' ? 'unconfirmed' : 'gitfile_root', verification: verification(providerId),
        skills: input.selectedSkillIds.map((skillId) => ({ skillId, status: kiro === 'deferred' || kiro === 'limited' ? 'deferred' : 'planned',
          ...(kiro === 'deferred' ? { reason: 'canonical_conflict' } : kiro === 'limited' ? { reason: 'kiro_root_unconfirmed' } : {}) })) });
      if (!['deferred', 'limited'].includes(kiro)) result.derivedEntries = entries.map((entry) => ({ ...entry, providerId: 'kiro', canonicalDestination: entry.destination, destination: entry.destination.replace('.agents/', '.kiro/') }));
    }
  }
  return result;
}
function harness(t, { fixture = false } = {}) {
  let tree, currentSettings = settingsFor();
  const calls = [], previews = [], streams = [], operations = [];
  const tracker = createOperationTracker();
  let currentHost;
  const client = new QueryClient();
  const provider = { projects: { list: async () => ({ projects: [] }) }, workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
    providers: { snapshot: async () => ({ entries: [] }) } };
  const invoke = (method, input) => {
    calls.push(method);
    if (method === 'target.validate-directory') return Promise.resolve({ status: 'ready', directory: input.path });
    if (method === 'catalog.load') return Promise.resolve({ status: 'ready', settingsRevision: currentSettings.revision, requestedRef: 'release', snapshot: catalog });
    if (fixture && (method === 'apply.create.v1' || method === 'apply.status.v1')) {
      const pending = { ...Promise.withResolvers(), method, host: currentHost, input: structuredClone(input),
        trackedBeforeTransport: tracker.snapshot().some(row => row.operationId === input.operationId) };
      operations.push(pending); return pending.promise;
    }
    assert.equal(method, fixture ? 'preview.providers.v2' : 'preview.providers', 'No extra canonical/scan/agent/model RPC is allowed');
    const pending = { ...Promise.withResolvers(), input: structuredClone(input) }; previews.push(pending); return pending.promise;
  };
  const subscribe = (method, input, observer) => {
    assert.equal(method, 'recommendation.evaluate'); calls.push(method); const stream = { input, observer }; streams.push(stream);
    const release = () => {}; return Object.assign(release, { ready: Promise.resolve(), release: async () => {} });
  };
  const show = async ({ host = 'host-a', status = 'online', settings = settingsFor(), present = true } = {}) => {
    currentSettings = settings;
    currentHost = host;
    const screen = createElement(FoundationScreen, { host: { id: host, label: host }, theme: { colors: {} }, layout: { compact: true, platform: 'web' }, params: {} });
    const surface = fixture ? createElement(FixtureApprovalScope, { tracker, slot: 'fixture-slot' }, screen) : screen;
    const node = createElement(QueryClientProvider, { client }, createElement(HostFixture.Provider, { value: { hosts: present ? [{ serverId: host, status }] : [], settings } },
      createElement(PaseoApiProvider, { paseo: provider }, createElement(PluginRpcProvider, { invoke, subscribe },
        surface))));
    await act(async () => { if (tree) tree.update(node); else tree = renderer.create(node); });
  };
  const button = (name) => tree?.root.findAllByType('pressable').find((n) => n.props.accessibilityLabel === name || n.findAllByType('text').some((text) => text.children.join('') === name));
  const press = async (name) => { const b = button(name); assert.ok(b, name); assert.ok(!b.props.disabled, name + ' disabled'); await act(async () => b.props.onPress()); };
  const text = () => tree?.root.findAllByType('text').map((n) => n.children.join('')).join('\n') ?? '';
  const target = async (path) => { const input = tree.root.findAllByType('input').find((n) => n.props.accessibilityLabel === 'Absolute path on the host'); await act(async () => input.props.onChangeText(path)); await press('Use directory'); };
  const scan = async () => { await press('Scan & Recommend'); const stream = streams.at(-1); await act(async () => stream.observer.event(terminal(stream.input))); };
  const resolve = async (index = previews.length - 1, reply = ready(previews[index].input)) => act(async () => previews[index].resolve(reply));
  const unmount = async () => { if (tree) await act(async () => tree.unmount()); tree = undefined; };
  t.after(async () => { await unmount(); client.clear(); });
  const setup = async () => { await show(); await target('/fixture'); await scan(); };
  return { show, button, press, text, target, scan, resolve, unmount, setup, calls, previews, operations, tracker };
}

test('Preview requires a current nonempty intent; one click sends exactly one provider RPC and an empty provider selection works', async (t) => {
  const h = harness(t); await h.setup(); assert.ok(h.button('Preview Changes').props.disabled); assert.equal(h.previews.length, 0);
  await h.press('Select demo'); const before = h.calls.length; await h.press('Preview Changes');
  assert.deepEqual(h.calls.slice(before), ['preview.providers']); assert.ok(h.button('Preview Changes').props.disabled);
  const { input } = h.previews[0]; assert.equal(input.canonicalDirectory, '/fixture'); assert.equal(input.hostId, 'host-a'); assert.equal(input.catalogCommitSha, sha);
  assert.deepEqual(input.selectedSkillIds, ['demo']); assert.deepEqual(input.targetProviderIds, []);
  await h.resolve(); assert.match(h.text(), /Preview Results/); assert.match(h.text(), /Canonical files \(1\)/); assert.match(h.text(), /No target providers selected/);
  assert.equal(h.button('Apply'), undefined); assert.equal(h.previews.length, 1);
});

test('Preview renders canonical/derived provenance, text diff, binary metadata, conflicts, blocked paths and historical provider evidence', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo');
  for (const name of ['Codex', 'Cursor', 'Kiro', 'Antigravity']) await h.press(name + ', unavailable');
  await h.press('Preview Changes'); const r = ready(h.previews[0].input); r.entries[0].status = 'conflict';
  r.entries.push({ skillId: 'demo', destination: '.agents/skills/demo/asset.bin', status: 'conflict', proposed: fingerprint,
    existing: { ...fingerprint, sizeBytes: 20, sha256: 'b'.repeat(64), mode: 0o755 }, change: { kind: 'binary' } });
  r.entries.push({ skillId: 'demo', destination: '.agents/skills/demo/blocked.txt', status: 'blocked', proposed: fingerprint, reason: 'unsafe_entry' });
  r.diagnostics.push({ code: 'duplicate_skill_id', skillId: 'demo', basis: 'directory_id', paths: ['.agents/skills/demo/SKILL.md', '.kiro/skills/demo/SKILL.md'] });
  await h.resolve(0, r); assert.match(h.text(), /Canonical source: \.agents\/skills\/demo\/SKILL.md/);
  assert.match(h.text(), /Conflict · \.agents/); assert.match(h.text(), /Blocked · \.agents/); assert.match(h.text(), /Precedence and activation have not been verified/);
  await h.press('Preview details for .agents/skills/demo/SKILL.md'); assert.match(h.text(), /\+Fixture body/);
  await h.press('Preview details for .agents/skills/demo/asset.bin'); assert.match(h.text(), /Existing: 20 bytes · mode 0755/); assert.match(h.text(), new RegExp('b'.repeat(64)));
  await h.press('M3.1 historical verification for Cursor ACP'); assert.match(h.text(), /Historical M3.1 evidence; this is not verification of the current session/);
  assert.match(h.text(), /2026.10.22-27dcf5f · cursor-agent acp/); assert.match(h.text(), /Mode: ask · CWD: root and nested/);
  assert.match(h.text(), /Codex · Canonical only · 0 additional files/); assert.match(h.text(), /Antigravity · Canonical only · 0 additional files/);
  assert.match(h.text(), /Git root confirmed \(gitfile\/worktree\)/);
});

test('no-op is explicit and Kiro limitations/deferred packages remain visible', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo'); await h.press('Kiro, unavailable'); await h.press('Preview Changes');
  await h.resolve(0, ready(h.previews[0].input, { status: 'unchanged', kiro: 'limited' }));
  assert.match(h.text(), /No file changes: all planned files already match in bytes and mode/); assert.match(h.text(), /Some provider packages are limited or deferred/);
  assert.match(h.text(), /nested workspace, non-Git directory/); assert.match(h.text(), /session CWD at root and mode kiro_default/); assert.match(h.text(), /Kiro derived files \(0\)/);
  await h.press('Preview Changes'); const r = ready(h.previews[1].input, { status: 'conflict', kiro: 'deferred' });
  r.providers[0].skills[0].reason = 'canonical_blocked'; await h.resolve(1, r);
  assert.match(h.text(), /Kiro package deferred because a canonical file is blocked/); assert.doesNotMatch(h.text(), /No file changes/);
});

test('skill A to B to A invalidates pending/completed Preview even when the final intent equals the original', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo'); await h.press('Preview Changes');
  const original = structuredClone(h.previews[0].input);
  await h.press('Select other'); await h.press('Select other'); assert.equal(h.previews.length, 1); assert.equal(h.button('Cancel Preview'), undefined);
  await h.resolve(); assert.doesNotMatch(h.text(), /Preview Results/);
  await h.press('Preview Changes'); assert.deepEqual(h.previews[1].input, original); await h.resolve(); assert.match(h.text(), /Preview Results/);
  await h.press('Select other'); assert.doesNotMatch(h.text(), /Preview Results/);
  await h.press('Select other'); assert.doesNotMatch(h.text(), /Preview Results/);
});

test('provider A to B to A discards old replies without rescanning or reusing the old preview', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo'); await h.press('Preview Changes');
  await h.press('Kiro, unavailable'); await h.press('Kiro, unavailable, selected'); await h.resolve();
  assert.doesNotMatch(h.text(), /Preview Results/); assert.equal(h.previews.length, 1);
  await h.press('Preview Changes'); assert.deepEqual(h.previews[1].input.targetProviderIds, []); await h.resolve(); assert.match(h.text(), /Preview Results/);
  await h.press('Cursor, unavailable'); assert.doesNotMatch(h.text(), /Preview Results/);
  assert.equal(h.calls.filter((name) => name === 'recommendation.evaluate').length, 1);
});

test('Cancel stops UI waiting only, suppresses late replies and lets the current scope retry', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo'); await h.press('Preview Changes');
  assert.match(h.text(), /daemon may finish; its late reply will be ignored/); await h.press('Cancel Preview');
  assert.match(h.text(), /daemon request was not cancelled/); await h.press('Preview Changes');
  await h.resolve(0); assert.doesNotMatch(h.text(), /Preview Results/);
  await h.resolve(1, { status: 'error', code: 'busy' }); assert.match(h.text(), /finishing another preview/);
  await h.press('Preview Changes'); await h.resolve(); assert.match(h.text(), /Preview Results/);
});

test('all typed errors and transport/invalid-result errors are safe and retry uses only the current scope', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo');
  for (const code of ['invalid_selection', 'host_mismatch', 'settings_changed', 'catalog_mismatch', 'catalog_unavailable', 'invalid_catalog',
    'invalid_target', 'target_changed', 'limit_exceeded', 'busy', 'cancelled', 'host_io_error']) {
    await h.press('Preview Changes'); await h.resolve(undefined, { status: 'error', code }); assert.doesNotMatch(h.text(), /Preview Results/);
  }
  await h.press('Preview Changes'); await act(async () => h.previews.at(-1).reject(Error('private-stderr-secret')));
  assert.match(h.text(), /Could not receive a preview/); assert.doesNotMatch(h.text(), /private-stderr-secret/);
  for (const mutation of [{ hostId: 'host-b' }, { canonicalDirectory: '/other' }, { catalogCommitSha: 'b'.repeat(40) },
    { settingsRevision: 'other' }, { selectedSkillIds: ['other'] }, { targetProviderIds: ['kiro'] }, { recommendationRequestId: 'other-scan' }]) {
    await h.press('Preview Changes'); const r = ready(h.previews.at(-1).input); Object.assign(r.intent, mutation); await h.resolve(undefined, r);
    assert.match(h.text(), /preview result could not be verified/);
  }
  await h.press('Preview Changes'); await h.resolve(); assert.match(h.text(), /Preview Results/);
});

test('rescan, target and saved settings changes invalidate Preview; saving and empty selection disable it', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo'); await h.press('Preview Changes');
  await h.scan(); await h.resolve(0); assert.doesNotMatch(h.text(), /Preview Results/); assert.ok(h.button('Preview Changes').props.disabled);
  await h.press('Select demo'); await h.press('Preview Changes'); await h.show({ settings: settingsFor('r2') });
  await h.resolve(1); assert.equal(h.button('Preview Changes'), undefined);
  await h.scan(); await h.press('Select demo'); await h.show({ settings: settingsFor('r2', true) }); assert.ok(h.button('Preview Changes').props.disabled);
  await h.show({ settings: settingsFor('r2') }); await h.press('Preview Changes'); await h.target('/other'); await h.resolve(2);
  assert.equal(h.button('Preview Changes'), undefined); assert.doesNotMatch(h.text(), /Preview Results/);
});

test('host switch, offline/reconnect and unmount suppress outstanding Preview and never auto-retry', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo'); await h.press('Preview Changes');
  await h.show({ host: 'host-b' }); await h.resolve(0); assert.doesNotMatch(h.text(), /Preview Results/);
  await h.target('/fixture'); await h.scan(); await h.press('Select demo'); await h.press('Preview Changes');
  await h.show({ host: 'host-b', status: 'offline' }); await h.resolve(1); assert.equal(h.button('Preview Changes'), undefined);
  await h.show({ host: 'host-b' }); assert.equal(h.previews.length, 2); assert.equal(h.button('Preview Changes'), undefined);
  await h.target('/fixture'); await h.scan(); await h.press('Select demo'); await h.press('Preview Changes');
  await h.unmount(); await h.resolve(2); await h.show(); assert.doesNotMatch(h.text(), /Preview Results/); assert.equal(h.previews.length, 3);
});

test('batched selection/provider A to B to A changes still advance scope generations', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo'); await h.press('Preview Changes');
  const skill = h.button('Select other'); await act(async () => { skill.props.onPress(); skill.props.onPress(); });
  assert.deepEqual(h.previews[0].input.selectedSkillIds, ['demo']); await h.resolve(0); assert.doesNotMatch(h.text(), /Preview Results/);
  await h.press('Preview Changes'); const provider = h.button('Kiro, unavailable');
  await act(async () => { provider.props.onPress(); provider.props.onPress(); });
  await h.resolve(1); assert.doesNotMatch(h.text(), /Preview Results/); assert.equal(h.previews.length, 2);
  await h.press('Preview Changes'); assert.deepEqual(h.previews[2].input.targetProviderIds, []); await h.resolve(2); assert.match(h.text(), /Preview Results/);
});

test('a host missing from the directory is unavailable and cannot retain a pending preview', async (t) => {
  const h = harness(t); await h.setup(); await h.press('Select demo'); await h.press('Preview Changes');
  await h.show({ present: false }); await h.resolve(0); assert.equal(h.button('Preview Changes'), undefined);
  assert.match(h.text(), /unavailable/); await h.show(); assert.doesNotMatch(h.text(), /Preview Results/); assert.equal(h.previews.length, 1);
});

function receiptReply(input, { entries, eligibility = { status: 'eligible' }, validFor = 600000, kiro } = {}) {
  const plan = ready(input.intent, { kiro });
  if (entries) plan.entries = entries;
  const now = Date.now();
  const epoch = 'e'.repeat(64);
  return { status: 'ready', schemaVersion: 2, manifest: {
    schemaVersion: 1, hostId: input.intent.hostId, installationInstanceId: 'b'.repeat(64),
    epoch, viewNonce: input.viewNonce, savedCatalogRef: 'release', plan, readSet: [], sources: [],
    directoryEffects: [{ destination: '.agents', status: 'create', mode: 0o755, absentAncestor: '.agents' }],
    gitProof: { status: kiro === 'limited' ? 'unconfirmed' : 'not_selected' },
    policy: { ...receiptPolicy, writeCapability: 'fixture_m4_5' },
  }, receipt: { previewId: 'c'.repeat(64), planDigest: 'd'.repeat(64), viewNonce: input.viewNonce, epoch,
    issuedAt: now - Math.max(1, -validFor + 1), expiresAt: now + Math.min(599999, validFor),
  }, applyEligibility: eligibility, plannedEffect: eligibility.status === 'eligible' ? 'create_only' :
    eligibility.status === 'no_changes' ? 'no_changes' : 'not_applicable' };
}
async function openFixtureReview(h, options) {
  await h.press('Preview Changes');
  const index = h.previews.length - 1;
  const response = receiptReply(h.previews[index].input, options);
  await h.resolve(index, response);
  return response;
}
function operationReply(input, phase, ledger = []) {
  return { status: 'operation', operationId: input.operationId, planDigest: 'd'.repeat(64), phase,
    code: phase === 'completed' ? 'none' : 'fixture_failure', requiresPreview: phase !== 'completed',
    durability: phase === 'completed' ? 'fsync_completed' : 'not_confirmed',
    targetMutated: phase === 'failed_before_write' ? false : phase === 'recovery_required' ? 'unknown' : true, ledger };
}

test('fixture review renders the exact plan and invalidates captured confirm across selection A → B → A', async t => {
  const h = harness(t, { fixture: true });
  await h.setup(); await h.press('Select demo'); await h.press('Kiro, unavailable');
  const first = await openFixtureReview(h, { kiro: 'limited' });
  assert.match(h.text(), /Eligible for create-only approval/);
  assert.match(h.text(), /Create directory · \.agents · mode 0755/);
  assert.match(h.text(), new RegExp('Pinned SHA: ' + sha));
  assert.match(h.text(), /Host: host-a/);
  assert.match(h.text(), /Target: \/fixture/);
  await h.press('Review create-only approval');
  assert.match(h.text(), /Kiro files are excluded/);
  const stale = h.button('Confirm create-only').props.onPress;
  await h.press('Select demo'); await h.press('Select demo');
  assert.equal(h.button('Confirm create-only'), undefined);
  await act(async () => stale());
  assert.equal(h.operations.length, 0);

  const second = await openFixtureReview(h);
  assert.notEqual(second.receipt.viewNonce, first.receipt.viewNonce);
  await h.press('Review create-only approval');
  const confirm = h.button('Confirm create-only').props.onPress;
  await act(async () => { confirm(); confirm(); stale(); });
  assert.equal(h.operations.length, 1);
  const sent = h.operations[0];
  assert.match(sent.input.operationId, /^[0-9a-f]{32}$/);
  assert.equal(sent.trackedBeforeTransport, true);
  assert.deepEqual(sent.input, { previewId: second.receipt.previewId, planDigest: second.receipt.planDigest,
    viewNonce: second.receipt.viewNonce, approval: 'create_only_v1', operationId: sent.input.operationId });
  assert.equal(h.tracker.snapshot()[0].scope.installationInstanceId, second.manifest.installationInstanceId);
  await act(async () => sent.resolve({ status: 'error', code: 'busy' }));
  assert.match(h.text(), /Busy before admission/);
  assert.match(h.text(), /No operation was admitted/);
});

test('fixture denies expired, mismatched and blocked v2 receipts and paginates a large compact review', async t => {
  const h = harness(t, { fixture: true });
  await h.setup(); await h.press('Select demo');
  await openFixtureReview(h, { validFor: -1 });
  assert.match(h.text(), /preview expired/);
  assert.ok(h.button('Review create-only approval').props.disabled);
  await h.press('Preview Changes');
  let i = h.previews.length - 1;
  const mismatch = receiptReply(h.previews[i].input);
  mismatch.receipt.viewNonce = 'other';
  await h.resolve(i, mismatch);
  assert.equal(h.button('Review create-only approval'), undefined);
  assert.match(h.text(), /result could not be verified/);
  await h.press('Preview Changes'); i = h.previews.length - 1;
  const conflict = receiptReply(h.previews[i].input);
  conflict.manifest.plan.entries[0].status = 'conflict';
  await h.resolve(i, conflict);
  assert.match(h.text(), /ineligible for approval/);
  assert.ok(h.button('Review create-only approval').props.disabled);
  await h.press('Preview Changes'); i = h.previews.length - 1;
  const blocked = receiptReply(h.previews[i].input, { eligibility: { status: 'ineligible', reasons: ['plan_blocked'] } });
  blocked.manifest.plan.entries[0].status = 'blocked';
  blocked.manifest.plan.entries[0].reason = 'unsafe_entry';
  await h.resolve(i, blocked);
  assert.match(h.text(), /A blocked file prevents applying the entire plan/);
  assert.ok(h.button('Review create-only approval').props.disabled);
  await h.press('Preview Changes'); i = h.previews.length - 1;
  const large = receiptReply(h.previews[i].input);
  const row = large.manifest.plan.entries[0];
  large.manifest.plan.entries = Array.from({ length: 600 }, (_, n) => ({ ...row, destination: '.agents/skills/demo/file-' + n }));
  await h.resolve(i, large);
  assert.match(h.text(), /Canonical files \(600\)/);
  assert.match(h.text(), /1–25 of 600/);
  assert.equal(h.button('Next canonical files').props.accessibilityRole, 'button');
  await h.press('Next canonical files');
  assert.match(h.text(), /26–50 of 600/);
  assert.match(h.text(), /demo\/file-49/);
  assert.doesNotMatch(h.text(), /demo\/file-50/);
  assert.equal(h.operations.length, 0);
});

test('tracker survives host switch and unmount, reconnect checks original scope only and renders partial and recovery ledgers', async t => {
  const h = harness(t, { fixture: true });
  await h.setup(); await h.press('Select demo'); await openFixtureReview(h);
  await h.press('Review create-only approval'); await h.press('Confirm create-only');
  const sent = h.operations[0];
  await h.show({ host: 'host-b' });
  await act(async () => sent.reject(Error('lost reply')));
  assert.match(h.text(), /Outcome unknown/);
  assert.ok(h.button('Check operation status').props.disabled);
  await h.unmount();
  await h.show({ status: 'offline' });
  assert.equal(h.operations.length, 1);
  await h.show();
  assert.equal(h.operations.length, 2);
  const status = h.operations[1];
  assert.deepEqual({ method: status.method, host: status.host, input: status.input },
    { method: 'apply.status.v1', host: 'host-a', input: { operationId: sent.input.operationId } });
  await act(async () => status.resolve({ status: 'error', code: 'outcome_unknown' }));
  assert.match(h.text(), /Writes may have occurred/);
  await h.press('Check operation status');
  const ledger = ['created_verified','created_incomplete','not_attempted','ownership_unknown'].map((state,i) => ({
    destination: '.agents/skills/demo/file-' + i, kind: 'file', state,
  }));
  await act(async () => h.operations[2].resolve(operationReply(sent.input,'partial_failure',ledger)));
  assert.match(h.text(), /Stopped after a partial write/);
  await h.press('Operation ledger');
  for (const label of ['Created and verified', 'Created, incomplete', 'Not attempted', 'Ownership unverified'])
    assert.match(h.text(), new RegExp(label));
  assert.match(h.text(), /then run Preview again/);

  for (const phase of ['completed','failed_before_write','recovery_required']) {
    const next = { ...sent.input, operationId: globalThis.crypto.randomUUID().replaceAll('-', '') };
    await act(async () => h.tracker.submit(h.tracker.snapshot()[0].scope, next, async () => operationReply(next, phase, ledger)));
  }
  assert.match(h.text(), /Completed/);
  assert.match(h.text(), /Failed before writing/);
  assert.match(h.text(), /Recovery required/);
  assert.match(h.text(), /Target mutation is unknown/);
  assert.deepEqual(h.operations.map(call => call.method), ['apply.create.v1','apply.status.v1','apply.status.v1']);
});

test('reconnect invalidates a previous status request that has not settled', async t => {
  const h = harness(t, { fixture: true });
  await h.setup(); await h.press('Select demo'); await openFixtureReview(h);
  await h.press('Review create-only approval'); await h.press('Confirm create-only');
  const sent = h.operations[0];
  await act(async () => sent.reject(Error('lost reply')));
  await h.press('Check operation status');
  const outdated = h.operations[1];
  await h.show({ status: 'offline' });
  await h.show();
  const current = h.operations[2];
  assert.deepEqual(current.input, outdated.input);
  await act(async () => current.resolve(operationReply(sent.input, 'completed')));
  await act(async () => outdated.resolve({ status: 'error', code: 'outcome_unknown' }));
  assert.match(h.text(), /Completed/);
  assert.doesNotMatch(h.text(), /Outcome unknown/);
  assert.deepEqual(h.operations.map(call => call.method), ['apply.create.v1','apply.status.v1','apply.status.v1']);
});

test('tracker reload persists only status lookup metadata and rejects a wrong route', async () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const slot = 'fixture-slot';
  const open = () => createOperationTracker({slot, storage: () => storage});
  const tracker = open();
  const peerAlreadyMounted = open();
  const operationId = 'd'.repeat(32);
  const scope = {hostId:'host-a', slot, target:'/private/fixture', pinnedSha:sha, installationInstanceId:'b'.repeat(64)};
  const input = {operationId, planDigest:'d'.repeat(64), previewId:'c'.repeat(64), viewNonce:'never-store', approval:'create_only_v1'};
  let sends = 0;
  tracker.submit(scope, input, async () => {
    sends++;
    assert.deepEqual(JSON.parse([...data.values()][0]), [{hostId:'host-a', operationId, planDigest:input.planDigest}]);
    throw Error('lost reply');
  });
  assert.equal(peerAlreadyMounted.snapshot().length,0);
  peerAlreadyMounted.restore();
  assert.equal(peerAlreadyMounted.snapshot()[0].operationId,operationId);
  const reopened = open();
  assert.equal(reopened.snapshot()[0].state,'outcome_unknown');
  const calls = [];
  const status = async args => { calls.push(args); return operationReply(input,'completed'); };
  reopened.check('host-b',slot,status); reopened.check('host-a','wrong-slot',status);
  assert.deepEqual(calls,[]);
  reopened.check('host-a',slot,status);
  await Promise.resolve();
  assert.deepEqual(calls,[{operationId}]);
  assert.equal(reopened.snapshot()[0].operation.phase,'completed');
  assert.equal(sends,1);
  const failed = createOperationTracker({slot, storage: () => ({...storage,setItem(){ throw Error('quota'); }})});
  failed.submit(scope,{...input,operationId:'e'.repeat(32)},async()=>{ sends++; });
  assert.equal(failed.snapshot()[0].code,'tracking_unavailable');
  assert.equal(sends,1);
});
