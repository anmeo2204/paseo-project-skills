import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import renderer from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { PaseoApiProvider, PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { FoundationScreen } from '../client/foundation-screen.tsx';
import { catalogSource } from '../shared/catalog-settings.ts';
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
function harness(t) {
  let tree, currentSettings = settingsFor();
  const calls = [], previews = [], streams = [];
  const client = new QueryClient();
  const provider = { projects: { list: async () => ({ projects: [] }) }, workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
    providers: { snapshot: async () => ({ entries: [] }) } };
  const invoke = (method, input) => {
    calls.push(method);
    if (method === 'target.validate-directory') return Promise.resolve({ status: 'ready', directory: input.path });
    if (method === 'catalog.load') return Promise.resolve({ status: 'ready', settingsRevision: currentSettings.revision, requestedRef: 'release', snapshot: catalog });
    assert.equal(method, 'preview.providers', 'No extra canonical/scan/agent/model RPC is allowed');
    const pending = { ...Promise.withResolvers(), input: structuredClone(input) }; previews.push(pending); return pending.promise;
  };
  const subscribe = (method, input, observer) => {
    assert.equal(method, 'recommendation.evaluate'); calls.push(method); const stream = { input, observer }; streams.push(stream);
    const release = () => {}; return Object.assign(release, { ready: Promise.resolve(), release: async () => {} });
  };
  const show = async ({ host = 'host-a', status = 'online', settings = settingsFor(), present = true } = {}) => {
    currentSettings = settings;
    const node = createElement(QueryClientProvider, { client }, createElement(HostFixture.Provider, { value: { hosts: present ? [{ serverId: host, status }] : [], settings } },
      createElement(PaseoApiProvider, { paseo: provider }, createElement(PluginRpcProvider, { invoke, subscribe },
        createElement(FoundationScreen, { host: { id: host, label: host }, theme: { colors: {} }, layout: { compact: true, platform: 'web' }, params: {} })))));
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
  return { show, button, press, text, target, scan, resolve, unmount, setup, calls, previews };
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
