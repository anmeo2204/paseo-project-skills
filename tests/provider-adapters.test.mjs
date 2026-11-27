import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createCanonicalPreviewHandler } from '../server/canonical-preview.ts';
import { previewLimits } from '../server/preview-limits.ts';
import { providerPreviewRpc, canonicalPreviewRpc } from '../shared/rpc.ts';
import { catalogSource } from '../shared/catalog-settings.ts';

const exec = promisify(execFile);
const sha = 'a'.repeat(40);
const descriptor = (path, value, mode = '100644') => {
  const bytes = Buffer.from(value);
  return { path, bytes, mode, sizeBytes: bytes.length,
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
};
const skill = (id = 'demo') => ({ id, directory: 'skills/' + id, metadata: { name: id, description: 'Fixture' },
  entrypoint: descriptor('SKILL.md', `---\nname: ${id}\ndescription: Fixture\n---\nBody\n`),
  supportingFiles: [descriptor('LICENSE', 'License\n'), descriptor('nested/raw.bin', [0, 255, 1]), descriptor('scripts/check.sh', '#!/bin/sh\necho fixture\n', '100755')] });
const snapshot = (skills = [skill()]) => ({ schemaVersion: 1, source: catalogSource, commitSha: sha, skills });
const state = () => ({ status: 'ready', revision: 'rev', values: { catalogRef: sha } });
const intent = (root, providers = [], ids = ['demo']) => ({ schemaVersion: 1, hostId: 'fixture-host', canonicalDirectory: root,
  catalogSource, catalogCommitSha: sha, settingsRevision: 'rev', selectedSkillIds: ids,
  targetProviderIds: providers, recommendationRequestId: 'scan-fixture' });
const context = { paseo: new Proxy({ hosts: { list: async () => ({ self: { serverId: 'fixture-host' }, hosts: [] }) } }, {
  get(target, name) { assert.equal(name, 'hosts', 'No agent/model/provider configuration API may be called'); return target[name]; },
}) };
const git = async (cwd, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
  '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', cwd, ...args])).stdout.trim();
async function tree(root) {
  const rows = [];
  async function visit(path, relative = '.') {
    const s = await fs.lstat(path);
    rows.push({ path: relative, mode: s.mode & 0o7777, kind: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : 'file',
      ...(s.isSymbolicLink() ? { link: await fs.readlink(path) } : s.isFile() ? { hash: createHash('sha256').update(await fs.readFile(path)).digest('hex') } : {}) });
    if (s.isDirectory()) for (const name of (await fs.readdir(path)).sort()) await visit(join(path, name), relative + '/' + name);
  }
  await visit(root); return rows;
}
async function fixture(t, initializeGit = true) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'provider-preview-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, 'target'); await fs.mkdir(root);
  if (initializeGit) await git(root, 'init', '-b', 'main');
  const put = async (path, value, mode = 0o644) => { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), value); await fs.chmod(join(root, path), mode); };
  const handler = (skills = [skill()], options = {}, settings = { read: async () => state() }) => {
    const h = createCanonicalPreviewHandler(settings, { load: async () => snapshot(skills) }, options);
    t.after(() => h.dispose()); return h;
  };
  return { base, root, put, handler, run: (value = intent(root), skills = [skill()], options = {}, settings) => handler(skills, options, settings).handleProviders(value, context) };
}
const derived = (result, path = 'SKILL.md', id = 'demo') => result.derivedEntries.find((e) => e.destination === `.kiro/skills/${id}/${path}`);

test('provider endpoint is additive: empty selection preserves canonical output and performs no Git/provider probe', async (t) => {
  const f = await fixture(t, false); let markers = 0;
  const h = f.handler(undefined, { io: { ...fs, lstat: async (path, ...args) => { if (String(path).endsWith('/.git')) markers++; return fs.lstat(path, ...args); } } });
  const value = intent(f.root); const canonical = await h.handle(value, context); const result = await h.handleProviders(value, context);
  assert.deepEqual(result, { ...canonical, providers: [], derivedEntries: [], diagnostics: [] });
  assert.equal(markers, 0); assert.equal(providerPreviewRpc.output.safeParse(result).success, true);
  assert.equal(canonicalPreviewRpc.output.safeParse(canonical).success, true);
  assert.equal(canonicalPreviewRpc.output.safeParse(result).success, false, 'Old strict contract must not be widened');
});

test('Codex, Cursor ACP and Antigravity each plan zero extra files with exact historical version/mode scope', async (t) => {
  const f = await fixture(t); const before = await tree(f.root);
  for (const [id, version, mode] of [['codex', '0.167.0', 'auto; read-only; approval never; web search disabled'],
    ['cursor', '2026.10.22-27dcf5f', 'ask'], ['antigravity', '1.5.18', 'plan']]) {
    const r = await f.run(intent(f.root, [id])); assert.equal(r.status, 'ready'); assert.deepEqual(r.derivedEntries, []);
    assert.equal(r.providers.length, 1); const p = r.providers[0]; assert.equal(p.status, 'canonical_only');
    assert.equal(p.verification.binaryVersion, version); assert.equal(p.verification.loadMode, mode);
    assert.equal(p.verification.basis, 'historical_m3_1'); assert.equal(p.verification.cwdScope, 'root_and_nested');
    if (id === 'cursor') assert.equal(p.verification.transport, 'cursor-agent acp');
    if (id === 'antigravity') assert.match(p.verification.note, /permission flow.*ancestor/);
  }
  assert.deepEqual(await tree(f.root), before);
});

test('all four providers at Git root share the canonical package bytes, modes, supporting files and diff engine', async (t) => {
  const f = await fixture(t); const before = await tree(f.root);
  const r = await f.run(intent(f.root, ['kiro', 'cursor', 'codex', 'antigravity'])); assert.equal(r.status, 'ready', JSON.stringify(r));
  assert.equal(r.entries.length, 4); assert.equal(r.derivedEntries.length, 4);
  assert.deepEqual(r.providers.map((p) => p.providerId), ['antigravity', 'codex', 'cursor', 'kiro']);
  const kiro = r.providers.find((p) => p.providerId === 'kiro'); assert.equal(kiro.rootStatus, 'git_root'); assert.equal(kiro.status, 'ready');
  assert.equal(kiro.verification.loadMode, 'kiro_default'); assert.equal(kiro.verification.cwdScope, 'git_root');
  for (const e of r.derivedEntries) {
    const source = r.entries.find((s) => s.destination === e.canonicalDestination);
    assert.deepEqual(e.proposed, source.proposed); assert.equal(e.status, 'create');
    if (e.change.kind === 'text') assert.match(e.change.unifiedDiff, /\.kiro\/skills\/demo/);
  }
  assert.equal(derived(r, 'scripts/check.sh').proposed.mode, 0o755); assert.equal(derived(r, 'nested/raw.bin').change.kind, 'binary');
  assert.deepEqual(await tree(f.root), before);
  const canonical = await f.handler().handle(intent(f.root, ['kiro']), context);
  assert.deepEqual(Object.keys(canonical).sort(), ['entries', 'intent', 'status']);
});

test('linked worktree root is confirmed by Git and preview preserves both worktree and repository metadata', async (t) => {
  const f = await fixture(t); await f.put('README.md', 'fixture');
  await git(f.root, 'add', '--', 'README.md'); await git(f.root, 'commit', '-m', 'fixture');
  const linked = join(f.base, 'linked'); await git(f.root, 'worktree', 'add', '--detach', linked);
  const before = await tree(f.base); const r = await f.run(intent(linked, ['kiro']));
  assert.equal(r.status, 'ready'); assert.equal(r.providers[0].rootStatus, 'gitfile_root'); assert.equal(r.derivedEntries.length, 4);
  assert.deepEqual(await tree(f.base), before);
});

test('nested workspace and non-Git targets retain canonical preview with limited Kiro compatibility', async (t) => {
  const f = await fixture(t); const nested = join(f.root, 'nested'); await fs.mkdir(nested);
  const nongit = join(f.base, 'plain'); await fs.mkdir(nongit); const before = await tree(f.base);
  for (const target of [nested, nongit]) {
    const r = await f.run(intent(target, ['kiro', 'codex'])); assert.equal(r.status, 'ready'); assert.equal(r.entries.length, 4);
    assert.deepEqual(r.derivedEntries, []); const p = r.providers.find((p) => p.providerId === 'kiro');
    assert.equal(p.status, 'limited'); assert.equal(p.rootStatus, 'unconfirmed'); assert.equal(p.skills[0].reason, 'kiro_root_unconfirmed');
    assert.ok(r.diagnostics.some((d) => d.code === 'kiro_root_unconfirmed'));
  }
  assert.deepEqual(await tree(f.base), before);
});

test('fake .git markers, malformed gitfiles and symlinked Git metadata never grant Kiro root eligibility', async (t) => {
  const f = await fixture(t, false);
  await fs.mkdir(join(f.root, '.git')); let r = await f.run(intent(f.root, ['kiro'])); assert.equal(r.providers[0].status, 'limited');
  await fs.rmdir(join(f.root, '.git')); await f.put('.git', 'gitdir: missing-metadata\n');
  r = await f.run(intent(f.root, ['kiro'])); assert.equal(r.providers[0].status, 'limited');
  await fs.unlink(join(f.root, '.git')); const other = join(f.base, 'other'); await fs.mkdir(other); await git(other, 'init', '-b', 'main');
  await fs.symlink(join(other, '.git'), join(f.root, '.git'));
  const before = await tree(f.base); r = await f.run(intent(f.root, ['kiro']));
  assert.equal(r.providers[0].status, 'limited'); assert.deepEqual(r.derivedEntries, []); assert.deepEqual(await tree(f.base), before);
});

test('every canonical conflict or block defers its complete Kiro package while other skills still plan', async (t) => {
  const f = await fixture(t); const a = skill('alpha'), b = skill('beta'); await f.put('.agents/skills/alpha/LICENSE', 'user custom license');
  const before = await tree(f.root); let r = await f.run(intent(f.root, ['kiro'], ['alpha', 'beta']), [a, b]);
  assert.equal(r.providers[0].status, 'partial'); assert.equal(r.providers[0].skills[0].reason, 'canonical_conflict');
  assert.equal(r.derivedEntries.length, 4); assert.ok(r.derivedEntries.every((e) => e.skillId === 'beta'));
  assert.ok(r.diagnostics.some((d) => d.code === 'canonical_conflict' && d.paths.includes('.agents/skills/alpha/LICENSE')));
  assert.deepEqual(await tree(f.root), before);
  await fs.rm(join(f.root, '.agents'), { recursive: true }); await fs.symlink(f.base, join(f.root, '.agents'));
  r = await f.run(intent(f.root, ['kiro'], ['alpha']), [a]); assert.equal(r.providers[0].status, 'deferred');
  assert.equal(r.providers[0].skills[0].reason, 'canonical_blocked'); assert.deepEqual(r.derivedEntries, []);
});

test('Kiro destinations use M3.2 unchanged/bytes conflict/mode conflict/create/binary/blocked semantics directly', async (t) => {
  const f = await fixture(t); const s = skill(); await f.put('.kiro/skills/demo/SKILL.md', s.entrypoint.bytes);
  await f.put('.kiro/skills/demo/LICENSE', 'custom license'); await f.put('.kiro/skills/demo/scripts/check.sh', s.supportingFiles[2].bytes, 0o644);
  await f.put('.kiro/skills/demo/nested/raw.bin', Buffer.from([0, 2, 255]));
  const before = await tree(f.root); let r = await f.run(intent(f.root, ['kiro'])); assert.equal(r.status, 'ready');
  assert.equal(derived(r).status, 'unchanged'); assert.equal(derived(r, 'LICENSE').status, 'conflict');
  assert.equal(derived(r, 'scripts/check.sh').status, 'conflict'); assert.match(derived(r, 'scripts/check.sh').change.unifiedDiff, /old mode 100644\nnew mode 100755/);
  assert.equal(derived(r, 'nested/raw.bin').status, 'conflict'); assert.equal(derived(r, 'nested/raw.bin').change.kind, 'binary');
  assert.equal(r.providers[0].status, 'partial'); assert.deepEqual(await tree(f.root), before);
  await fs.unlink(join(f.root, '.kiro/skills/demo/LICENSE')); await fs.symlink(join(f.root, 'sentinel'), join(f.root, '.kiro/skills/demo/LICENSE'));
  r = await f.run(intent(f.root, ['kiro'])); assert.equal(derived(r, 'LICENSE').status, 'blocked');
  await fs.rm(join(f.root, '.kiro'), { recursive: true }); r = await f.run(intent(f.root, ['kiro']));
  assert.ok(r.derivedEntries.every((e) => e.status === 'create'));
});

test('existing same-ID occurrences across root layouts produce deterministic diagnostics without changing files', async (t) => {
  const f = await fixture(t); const s = skill();
  for (const layout of ['.agents', '.cursor', '.kiro']) await f.put(`${layout}/skills/demo/SKILL.md`, s.entrypoint.bytes);
  const before = await tree(f.root); const r = await f.run(intent(f.root, ['codex', 'kiro']));
  const d = r.diagnostics.find((d) => d.code === 'duplicate_skill_id'); assert.equal(d.skillId, 'demo');
  assert.equal(d.basis, 'directory_id');
  assert.deepEqual(d.paths, ['.agents/skills/demo/SKILL.md', '.cursor/skills/demo/SKILL.md', '.kiro/skills/demo/SKILL.md']);
  assert.equal(derived(r).status, 'unchanged'); assert.deepEqual(await tree(f.root), before);
});

test('provider/canonical output is deterministic across selection and catalog order', async (t) => {
  const f = await fixture(t); const a = skill('alpha'), b = skill('beta');
  const one = await f.run(intent(f.root, ['kiro', 'cursor', 'antigravity', 'codex'], ['beta', 'alpha']), [b, a]);
  const two = await f.run(intent(f.root, ['codex', 'antigravity', 'cursor', 'kiro'], ['alpha', 'beta']),
    [{ ...a, supportingFiles: [...a.supportingFiles].reverse() }, b]);
  assert.deepEqual(one, two);
  const empty = await f.run(intent(f.root, ['kiro'], [])); assert.equal(empty.providers[0].status, 'ready'); assert.deepEqual(empty.derivedEntries, []);
});

test('canonical mutation during final settings read withdraws all derived files of that skill', async (t) => {
  const f = await fixture(t); let reads = 0;
  const r = await f.run(intent(f.root, ['kiro']), [skill()], {}, { read: async () => {
    if (++reads === 2) await f.put('.agents/skills/demo/LICENSE', 'appeared'); return state();
  } });
  assert.equal(r.status, 'ready'); assert.equal(r.providers[0].skills[0].reason, 'canonical_blocked'); assert.deepEqual(r.derivedEntries, []);
});

test('derived destination mutation and lost Git root are revalidated before publish', async (t) => {
  const f = await fixture(t); let reads = 0;
  let r = await f.run(intent(f.root, ['kiro']), [skill()], {}, { read: async () => {
    if (++reads === 2) await f.put('.kiro/skills/demo/LICENSE', 'appeared'); return state();
  } });
  assert.equal(r.status, 'ready'); assert.ok(r.derivedEntries.every((e) => e.status === 'blocked'));
  reads = 0;
  r = await f.run(intent(f.root, ['kiro']), [skill()], {}, { read: async () => {
    if (++reads === 2) await fs.rename(join(f.root, '.git'), join(f.root, 'old-git')); return state();
  } });
  assert.equal(r.providers[0].status, 'limited'); assert.deepEqual(r.derivedEntries, []); assert.equal(r.entries.length, 4);
});

test('combined file/read/diff/response budgets apply to derived plans too, without truncation', async (t) => {
  const f = await fixture(t);
  let r = await f.run(intent(f.root, ['kiro']), [skill()], { limits: { ...previewLimits, files: 4 } });
  assert.deepEqual(r, { status: 'error', code: 'limit_exceeded' });
  await f.put('.kiro/skills/demo/SKILL.md', 'existing kiro body');
  r = await f.run(intent(f.root, ['kiro']), [skill()], { limits: { ...previewLimits, readBytes: 1 } });
  assert.equal(derived(r).reason, 'read_limit');
  r = await f.run(intent(f.root, ['kiro']), [skill()], { limits: { ...previewLimits, diffBytes: 10 } });
  assert.deepEqual(r.derivedEntries, []); assert.equal(r.providers[0].skills[0].reason, 'canonical_blocked');
  r = await f.run(intent(f.root, ['kiro']), [skill()], { limits: { ...previewLimits, responseBytes: 100 } });
  assert.deepEqual(r, { status: 'error', code: 'limit_exceeded' });
});

test('both endpoints share a busy/disposal slot and provider requests retain host/settings validation', async (t) => {
  const f = await fixture(t); const deferred = Promise.withResolvers(); const started = Promise.withResolvers();
  const h = createCanonicalPreviewHandler({ read: async () => state() }, { load: async () => { started.resolve(); return deferred.promise; } });
  const first = h.handle(intent(f.root), context); await started.promise;
  assert.deepEqual(await h.handleProviders(intent(f.root, ['kiro']), context), { status: 'error', code: 'busy' });
  const disposing = h.dispose(); deferred.resolve(snapshot()); assert.deepEqual(await first, { status: 'error', code: 'cancelled' }); await disposing;
  const other = f.handler();
  assert.deepEqual(await other.handleProviders({ ...intent(f.root, ['kiro']), hostId: 'other' }, context), { status: 'error', code: 'host_mismatch' });
  assert.deepEqual(await other.handleProviders({ ...intent(f.root, ['kiro']), settingsRevision: 'other' }, context), { status: 'error', code: 'settings_changed' });
});
