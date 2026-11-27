import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanonicalPreviewHandler } from '../server/canonical-preview.ts';
import { canonicalSerialize, manifestDigest, PreviewReceiptStore } from '../server/preview-receipts.ts';
import { receiptLimits } from '../shared/preview-receipt.ts';
import { previewLimits } from '../server/preview-limits.ts';
import { canonicalPreviewRpc, providerPreviewRpc, providerPreviewV2Rpc } from '../shared/rpc.ts';
import { catalogSource } from '../shared/catalog-settings.ts';

const exec = promisify(execFile), sha = 'a'.repeat(40);
const file = (path, value, mode = '100644') => {
  const bytes = Buffer.from(value);
  return { path, bytes, mode, sizeBytes: bytes.length,
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
};
const skill = (id = 'demo', extras = [file('nested/raw.bin', [0, 255]), file('run.sh', '#!/bin/sh\n', '100755')]) => ({
  id, directory: 'skills/' + id, metadata: { name: id, description: 'Fixture' },
  entrypoint: file('SKILL.md', `---\nname: ${id}\ndescription: Fixture\n---\nBody\n`), supportingFiles: extras,
});
const snapshot = (skills = [skill()]) => ({ schemaVersion: 1, source: catalogSource, commitSha: sha, skills });
const state = (revision = 'rev', catalogRef = sha) => ({ status: 'ready', revision, values: { catalogRef } });
const context = { paseo: new Proxy({ hosts: { list: async () => ({ self: { serverId: 'host' } }) } }, {
  get(target, key) { assert.equal(key, 'hosts'); return target[key]; },
}) };
const intent = (root, extra = {}) => ({ schemaVersion: 1, hostId: 'host', canonicalDirectory: root, catalogSource,
  catalogCommitSha: sha, settingsRevision: 'rev', selectedSkillIds: ['demo'], targetProviderIds: [], recommendationRequestId: 'scan', ...extra });
const binding = (r) => ({ ...r.receipt, hostId: r.manifest.hostId, installationInstanceId: r.manifest.installationInstanceId });
const ready = (r) => { assert.equal(r.status, 'ready', JSON.stringify(r)); return r; };
async function tree(path, relative = '.') {
  const s = await fs.lstat(path); const rows = [{ path: relative, mode: s.mode & 0o7777,
    type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'link',
    ...(s.isFile() ? { hash: createHash('sha256').update(await fs.readFile(path)).digest('hex') } : {}) }];
  if (s.isDirectory()) for (const name of (await fs.readdir(path)).sort()) rows.push(...await tree(join(path, name), relative + '/' + name));
  return rows;
}
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'receipt-v2-'))); const root = join(base, 'target'); await fs.mkdir(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const store = new PreviewReceiptStore();
  const handler = (options = {}, settings = { read: async () => state() }, loader = { load: async () => snapshot() }) => {
    const h = createCanonicalPreviewHandler(settings, loader, { receiptStore: store, ...options }); t.after(() => h.dispose()); return h;
  };
  const put = async (path, bytes, mode = 0o644) => { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), bytes); await fs.chmod(join(root, path), mode); };
  const request = (extra = {}, viewNonce = 'view-one') => ({ intent: intent(root, extra), viewNonce });
  return { base, root, store, handler, put, request, run: (h, req = request()) => h.handleProvidersV2(req, context) };
}
const git = async (root, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args])).stdout.trim();

test('v2 is strict and additive, retains exact M3 projection, directory effects and read-only bytes/modes', async (t) => {
  const f = await fixture(t), h = f.handler(), before = await tree(f.root);
  const old = await h.handleProviders(f.request().intent, context); const r = ready(await f.run(h));
  assert.deepEqual(r.manifest.plan, old); assert.equal(providerPreviewV2Rpc.output.safeParse(r).success, true);
  assert.equal(providerPreviewRpc.output.safeParse(r).success, false); assert.equal(canonicalPreviewRpc.output.safeParse(r).success, false);
  for (const req of [{ ...f.request(), extra: true }, { ...f.request(), viewNonce: '' }, { ...f.request(), viewNonce: 'bad nonce' }, { intent: f.request().intent },
    { ...f.request(), intent: { ...f.request().intent, extra: true } }]) {
    assert.equal(providerPreviewV2Rpc.input.safeParse(req).success, false); assert.equal((await f.run(h, req)).code, 'invalid_selection');
  }
  assert.deepEqual(r.manifest.directoryEffects.map(e => e.destination), ['.agents', '.agents/skills', '.agents/skills/demo', '.agents/skills/demo/nested']);
  assert.ok(r.manifest.directoryEffects.every(e => e.mode === 0o755 && e.absentAncestor === '.agents'));
  assert.equal(r.applyEligibility.status, 'ineligible'); assert.deepEqual(r.applyEligibility.reasons, ['write_capability_unavailable']);
  assert.equal(r.manifest.policy.writeCapability, 'unavailable_m4_2');
  assert.deepEqual(await tree(f.root), before);
});

test('canonical serialization is independent of property insertion, rejects ambiguous non-JSON values', () => {
  assert.equal(canonicalSerialize({ z: [1, 'x'], a: { y: true, b: null } }), '{"a":{"b":null,"y":true},"z":[1,"x"]}');
  assert.equal(canonicalSerialize({ z: 2, a: 1 }), canonicalSerialize({ a: 1, z: 2 }));
  for (const value of [undefined, NaN, Infinity, -0, 1.5, 1n, { x: undefined }, new Date(), new Array(2), Buffer.from('x')]) assert.throws(() => canonicalSerialize(value));
});

test('manifest digest binds nonce, SHA, intent, plan, sources, directory effects, read-set and policy', async (t) => {
  const f = await fixture(t), r = ready(await f.run(f.handler())); assert.equal(manifestDigest(r.manifest), r.receipt.planDigest);
  for (const mutate of [
    m => m.viewNonce = 'other', m => m.plan.intent.catalogCommitSha = 'b'.repeat(40), m => m.plan.intent.selectedSkillIds = [],
    m => m.plan.entries[0].proposed.mode = 0o755, m => m.plan.providers.push({ arbitrary: true }),
    m => m.sources[0].sha256 = 'b'.repeat(64), m => m.directoryEffects.pop(), m => m.readSet.pop(),
    m => m.policy.writerPolicyVersion = 'other',
  ]) { const m = structuredClone(r.manifest); mutate(m); assert.notEqual(manifestDigest(m), r.receipt.planDigest); }
  for (const tamper of [{ planDigest: 'b'.repeat(64) }, { viewNonce: 'other' }, { hostId: 'other' }, { installationInstanceId: 'b'.repeat(64) }, { issuedAt: 1 }]) {
    assert.equal(f.store.inspect({ ...binding(r), ...tamper }).status, 'error');
  }
  r.manifest.plan.entries.length = 0;
  assert.equal(f.store.inspect(binding(r)).manifest.plan.entries.length, 3, 'caller mutation cannot alter daemon manifest');
});

test('source buffers have immutable ownership and read-outs are copies, including executable/binary', async (t) => {
  const f = await fixture(t), data = snapshot(), h = f.handler({}, undefined, { load: async () => data });
  const r = ready(await f.run(h)); const first = f.store.inspect(binding(r)); assert.equal(first.status, 'ready');
  const original = Buffer.from(first.sources[0].bytes);
  for (const file of [data.skills[0].entrypoint, ...data.skills[0].supportingFiles]) file.bytes.fill(42);
  first.sources[0].bytes.fill(11); first.sources.length = 0;
  const second = f.store.inspect(binding(r)); assert.deepEqual(second.sources[0].bytes, original);
  assert.equal(r.manifest.sources.find(s => s.destination.endsWith('run.sh')).mode, 0o755);
  assert.ok(r.manifest.sources.every(s => !('bytes' in s)));
});

test('same scope and reordered selections/catalog produce same manifest digest, new Preview gets new opaque ID', async (t) => {
  const f = await fixture(t); let data = snapshot([skill('alpha'), skill('beta')]);
  const h = f.handler({}, undefined, { load: async () => data });
  const one = ready(await f.run(h, f.request({ selectedSkillIds: ['beta', 'alpha'], targetProviderIds: ['cursor', 'codex'] })));
  data = snapshot([skill('beta'), skill('alpha')]);
  const two = ready(await f.run(h, f.request({ selectedSkillIds: ['alpha', 'beta'], targetProviderIds: ['codex', 'cursor'] })));
  assert.equal(one.receipt.planDigest, two.receipt.planDigest); assert.notEqual(one.receipt.previewId, two.receipt.previewId);
  const nonce = ready(await f.run(h, f.request({ selectedSkillIds: ['alpha', 'beta'], targetProviderIds: ['codex', 'cursor'] }, 'view-two')));
  assert.notEqual(nonce.receipt.planDigest, two.receipt.planDigest);
});

test('v2 destination/source arrays use deterministic UTF-8 byte order for non-ASCII package names', async (t) => {
  const f = await fixture(t); const s = skill('demo', [file('\u{1f600}.txt', 'astral'), file('\ue000.txt', 'private')]);
  const h = f.handler({}, undefined, { load: async () => snapshot([s]) });
  const r = ready(await f.run(h));
  const expected = [...r.manifest.sources.map(x => x.destination)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.deepEqual(r.manifest.sources.map(x => x.destination), expected);
  assert.deepEqual(r.manifest.plan.entries.map(x => x.destination), expected);
  s.supportingFiles.reverse(); assert.equal(ready(await f.run(h)).receipt.planDigest, r.receipt.planDigest);
});

test('TTL uses monotonic time, not wall-clock changes or lookup; restart epoch and dispose invalidate', async (t) => {
  const f = await fixture(t); let now = 0, wall = 1000; const store = new PreviewReceiptStore({ now: () => now, wallNow: () => wall });
  const r = ready(await f.run(f.handler({ receiptStore: store })));
  assert.equal(r.receipt.expiresAt - r.receipt.issuedAt, receiptLimits.ttlMs);
  now = receiptLimits.ttlMs - 1; wall = 0; assert.equal(store.inspect(binding(r)).status, 'ready');
  now++; assert.equal(store.inspect(binding(r)).code, 'expired');
  const next = new PreviewReceiptStore(); assert.equal(next.inspect(binding(r)).code, 'epoch_mismatch');
  const other = ready(await f.run(f.handler({ receiptStore: store }))); store.dispose(); assert.equal(store.inspect(binding(other)).code, 'unknown_receipt');
});

test('count eviction is FIFO and lookups do not refresh TTL/order', async (t) => {
  const f = await fixture(t), h = f.handler(), records = [];
  for (let n = 0; n < 8; n++) records.push(ready(await f.run(h, f.request({}, 'view-' + n))));
  assert.equal(f.store.inspect(binding(records[0])).status, 'ready');
  const ninth = ready(await f.run(h));
  assert.equal(f.store.inspect(binding(records[0])).code, 'unknown_receipt');
  assert.equal(f.store.inspect(binding(records[1])).status, 'ready'); assert.equal(f.store.inspect(binding(ninth)).status, 'ready');
});

test('root, anchor and descendant identities use exact bigint decimals and file version ns', async (t) => {
  const f = await fixture(t); await f.put('.agents/skills/demo/SKILL.md', skill().entrypoint.bytes);
  const r = ready(await f.run(f.handler())); const root = r.manifest.readSet.find(x => x.path === f.root);
  const actual = await fs.lstat(f.root, { bigint: true }); assert.equal(root.observation.ino, String(actual.ino));
  assert.ok(r.manifest.readSet.some(x => x.scope === 'anchor'));
  const entry = r.manifest.readSet.find(x => x.path.endsWith('/demo/SKILL.md'));
  assert.equal(entry.observation.fileVersion.mtimeNs, String((await fs.lstat(entry.path, { bigint: true })).mtimeNs));
  assert.equal(root.observation.fileVersion, undefined);
  assert.equal(r.manifest.plan.entries.find(e => e.destination.endsWith('SKILL.md')).status, 'unchanged');
});

test('conflict and symlink-blocked plans have receipts with whole-plan ineligible reasons, no writes', async (t) => {
  const f = await fixture(t); await f.put('.agents/skills/demo/SKILL.md', 'foreign');
  let before = await tree(f.root), r = ready(await f.run(f.handler()));
  assert.ok(r.applyEligibility.reasons.includes('plan_conflict')); assert.equal(r.plannedEffect, 'not_applicable'); assert.deepEqual(await tree(f.root), before);
  await fs.symlink(f.base, join(f.root, '.agents/skills/demo/nested')); before = await tree(f.root);
  r = ready(await f.run(f.handler())); assert.ok(r.applyEligibility.reasons.includes('plan_blocked'));
  assert.ok(r.applyEligibility.reasons.includes('observations_unverified')); assert.deepEqual(await tree(f.root), before);
});

test('Kiro Git root records full derived sources, directory effects and metadata proof; nested/non-Git stay canonical', async (t) => {
  const f = await fixture(t); await git(f.root, 'init', '-b', 'main');
  let before = await tree(f.root), r = ready(await f.run(f.handler(), f.request({ targetProviderIds: ['kiro'] })));
  assert.equal(r.manifest.plan.derivedEntries.length, 3); assert.equal(r.manifest.sources.length, 6);
  assert.equal(r.manifest.gitProof.status, 'confirmed'); assert.equal(r.manifest.gitProof.rootStatus, 'git_root');
  assert.ok(r.manifest.directoryEffects.some(x => x.destination.startsWith('.kiro/')));
  assert.deepEqual(await tree(f.root), before);
  for (const entry of r.manifest.plan.derivedEntries) assert.deepEqual(entry.proposed, r.manifest.plan.entries.find(e => e.destination === entry.canonicalDestination).proposed);
  const nested = join(f.root, 'nested'); await fs.mkdir(nested);
  const plain = join(f.base, 'plain'); await fs.mkdir(plain);
  for (const root of [nested, plain]) {
    r = ready(await f.run(f.handler(), f.request({ canonicalDirectory: root, targetProviderIds: ['kiro'] })));
    assert.equal(r.manifest.plan.providers[0].status, 'limited'); assert.equal(r.manifest.gitProof.status, 'unconfirmed');
    assert.deepEqual(r.manifest.plan.derivedEntries, []);
  }
});

test('Kiro linked worktree records gitfile content hash and external directory identities without touching metadata', async (t) => {
  const f = await fixture(t); await git(f.root, 'init', '-b', 'main'); const linked = join(f.base, 'linked');
  await git(f.root, 'worktree', 'add', '--orphan', '-b', 'fixture-linked', linked);
  const before = await tree(f.base), r = ready(await f.run(f.handler(), f.request({ canonicalDirectory: linked, targetProviderIds: ['kiro'] })));
  assert.equal(r.manifest.gitProof.rootStatus, 'gitfile_root'); assert.match(r.manifest.gitProof.markerSha256, /^[0-9a-f]{64}$/);
  assert.ok(r.manifest.readSet.some(x => x.scope === 'git_metadata')); assert.deepEqual(await tree(f.base), before);
});

test('all unchanged reports no_changes without touching modes and all writes remain unavailable', async (t) => {
  const f = await fixture(t); const s = skill(); for (const x of [s.entrypoint, ...s.supportingFiles]) await f.put('.agents/skills/demo/' + x.path, x.bytes, x.mode === '100755' ? 0o755 : 0o644);
  const before = await tree(f.root), r = ready(await f.run(f.handler()));
  assert.equal(r.plannedEffect, 'no_changes'); assert.deepEqual(r.manifest.directoryEffects, []);
  assert.deepEqual(r.applyEligibility.reasons, ['write_capability_unavailable']); assert.deepEqual(await tree(f.root), before);
});

test('stale host/settings/SHA and source integrity are rejected without publishing receipts', async (t) => {
  const f = await fixture(t), h = f.handler();
  for (const [extra, code] of [[{ hostId: 'other' }, 'host_mismatch'], [{ settingsRevision: 'other' }, 'settings_changed'], [{ catalogCommitSha: 'b'.repeat(40) }, 'catalog_mismatch']]) {
    assert.deepEqual(await f.run(h, f.request(extra)), { status: 'error', code });
  }
  const bad = snapshot(); bad.skills[0].entrypoint.bytes[0] ^= 1;
  assert.equal((await f.run(f.handler({}, undefined, { load: async () => bad }))).code, 'invalid_catalog');
  let calls = 0; const moved = { load: async () => ({ ...snapshot(), commitSha: ++calls === 1 ? sha : 'b'.repeat(40) }) };
  assert.equal((await f.run(f.handler({}, { read: async () => state('rev', 'v1') }, moved))).code, 'catalog_mismatch');
});

test('settings changes or root/ancestor/absent destination changes during final settings yield prevent receipt publication', async (t) => {
  for (const action of ['settings', 'root', 'ancestor', 'absent', 'file']) await t.test(action, async (t) => {
    const f = await fixture(t); if (['ancestor', 'file'].includes(action)) await f.put('.agents/skills/demo/SKILL.md', skill().entrypoint.bytes);
    let calls = 0;
    const h = f.handler({}, { read: async () => {
      if (++calls === 2) {
        if (action === 'settings') return state('changed');
        if (action === 'root') { await fs.rename(f.root, f.root + '-old'); await fs.mkdir(f.root); }
        if (action === 'ancestor') { await fs.rename(join(f.root, '.agents'), join(f.root, '.old')); await fs.mkdir(join(f.root, '.agents')); }
        if (action === 'absent') await f.put('.agents/skills/demo/SKILL.md', 'appeared');
        if (action === 'file') await f.put('.agents/skills/demo/SKILL.md', 'changed');
      }
      return state();
    } });
    const result = await f.run(h); assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.code, action === 'settings' ? 'settings_changed' : 'target_changed');
  });
});

test('response/read/check/deadline budgets fail closed and preserve target', async (t) => {
  const f = await fixture(t), before = await tree(f.root);
  for (const limits of [{ responseBytes: 100 }, { filesystemChecks: 2 }, { files: 1 }]) {
    const r = await f.run(f.handler({ limits: { ...previewLimits, ...limits } })); assert.equal(r.code, 'limit_exceeded');
  }
  let time = 0; const r = await f.run(f.handler({ now: () => time += 10000 })); assert.equal(r.code, 'limit_exceeded');
  assert.deepEqual(await tree(f.root), before);
  await f.put('.agents/skills/demo/SKILL.md', 'existing body');
  const limited = ready(await f.run(f.handler({ limits: { ...previewLimits, readBytes: 1 } })));
  assert.ok(limited.manifest.plan.entries.some(e => e.reason === 'read_limit'));
  assert.ok(limited.applyEligibility.reasons.includes('plan_blocked'));
  assert.equal(limited.manifest.policy.previewBudgets.readBytes, 1);
});

test('source budget counts canonical plus derived, retained-byte eviction and failed issue does not evict valid receipt', async (t) => {
  const f = await fixture(t), r = ready(await f.run(f.handler()));
  const data = f.store.inspect(binding(r)); const oneBytes = data.sources.reduce((n, x) => n + x.bytes.length, 0);
  const store = new PreviewReceiptStore({ limits: { ...receiptLimits, retainedSourceBytes: oneBytes * 2, sourceBytes: oneBytes } });
  const manifest = { ...r.manifest, epoch: store.epoch, installationInstanceId: store.installationInstanceId };
  const a = store.issue(manifest, data.sources), b = store.issue(manifest, data.sources), c = store.issue(manifest, data.sources);
  assert.equal(store.inspect(binding(a)).code, 'unknown_receipt'); assert.equal(store.inspect(binding(b)).status, 'ready');
  assert.throws(() => store.issue(manifest, [...data.sources, ...data.sources]));
  assert.equal(store.inspect(binding(c)).status, 'ready');
  const large = skill('demo', [file('large.bin', Buffer.alloc(5 * 1024 * 1024))]); await git(f.root, 'init', '-b', 'main');
  const h = f.handler({}, undefined, { load: async () => snapshot([large]) });
  assert.equal((await f.run(h, f.request({ targetProviderIds: ['kiro'] }))).code, 'limit_exceeded');
  assert.equal((await f.run(h)).status, 'ready', 'same canonical source is under 8 MiB without derived');
  const oversized = snapshot([skill('demo', [file('large.bin', Buffer.alloc(9 * 1024 * 1024))])]);
  assert.equal((await f.run(f.handler({}, undefined, { load: async () => oversized }))).code, 'limit_exceeded');
});

test('read-only I/O seam refuses writable opens and source retention survives loader-buffer mutation during final yield', async (t) => {
  const f = await fixture(t), data = snapshot(); await f.put('.agents/skills/demo/SKILL.md', data.skills[0].entrypoint.bytes);
  const original = Buffer.from(data.skills[0].entrypoint.bytes); let calls = 0, opens = 0;
  const h = f.handler({ io: { ...fs, open: async (path, flags, ...args) => {
    assert.equal(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC), 0); opens++;
    return fs.open(path, flags, ...args);
  } } }, { read: async () => { if (++calls === 2) data.skills[0].entrypoint.bytes.fill(0); return state(); } }, { load: async () => data });
  const before = await tree(f.root), r = ready(await f.run(h)); assert.ok(opens > 0);
  const retained = f.store.inspect(binding(r));
  assert.deepEqual(retained.sources.find(x => x.destination.endsWith('SKILL.md')).bytes, original);
  assert.deepEqual(await tree(f.root), before);
});

test('Git root proof lost during final yield invalidates v2 instead of silently approving a smaller provider plan', async (t) => {
  const f = await fixture(t); await git(f.root, 'init', '-b', 'main'); let calls = 0;
  const h = f.handler({}, { read: async () => { if (++calls === 2) await fs.rename(join(f.root, '.git'), join(f.root, '.old-git')); return state(); } });
  assert.deepEqual(await f.run(h, f.request({ targetProviderIds: ['kiro'] })), { status: 'error', code: 'target_changed' });
});

test('unrelated directory membership changes do not invalidate v2 named observations or digest', async (t) => {
  const f = await fixture(t); await f.put('.agents/skills/demo/SKILL.md', skill().entrypoint.bytes);
  let reads = 0;
  const h = f.handler({}, { read: async () => { if (++reads === 2) await f.put('.agents/skills/unrelated/notes.txt', 'foreign'); return state(); } });
  const r = ready(await f.run(h));
  assert.ok(r.manifest.plan.entries.every(e => e.status === 'create' || e.status === 'unchanged'));
  const again = ready(await f.run(h)); assert.equal(r.receipt.planDigest, again.receipt.planDigest);
});

test('v2 and M3 endpoints share busy/dispose and never expose writer/status methods', async (t) => {
  const f = await fixture(t); const entered = Promise.withResolvers(), wait = Promise.withResolvers();
  const store = new PreviewReceiptStore(); const h = f.handler({ receiptStore: store }, undefined, { load: async () => { entered.resolve(); return wait.promise; } });
  const running = f.run(h); await entered.promise;
  assert.equal((await h.handle(f.request().intent, context)).code, 'busy'); assert.equal((await f.run(h)).code, 'busy');
  const closing = h.dispose(); wait.resolve(snapshot()); assert.equal((await running).code, 'cancelled'); await closing;
  assert.equal((await f.run(h)).code, 'cancelled');
});
