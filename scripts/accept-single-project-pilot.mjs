// Live directory-install & Desktop acceptance for the single-project Safe Apply pilot candidate.
// Writes ONLY to independent copies in a private temp profile/daemon. Never touches the real project or main daemon.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  enrollSingleProjectRoot,
  pilotPolicyPath,
  setSingleProjectOptIn,
} from '../server/single-project-policy.ts';
import { runSingleProjectWriter } from '../server/native-writer.ts';
import { singleProjectWriterRequest } from '../server/native-writer-contract.ts';
import { createCanonicalPreviewHandler } from '../server/canonical-preview.ts';
import { PreviewReceiptStore } from '../server/preview-receipts.ts';
import { toEnrollmentBinding } from '../server/single-project-policy.ts';
import { catalogSource } from '../shared/catalog-settings.ts';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const app = process.env.M45_PASEO_APP ?? '/Applications/Paseo.app';
const cli = join(app, 'Contents/Resources/bin/paseo');
const executable = join(app, 'Contents/MacOS/Paseo');
const environment = { paseoVersion: '0.17.5', sdkVersion: '0.17.4' };
const pluginId = 'paseo-project-skills-single-project-pilot';
const pluginTitle = 'Project Skills Single-Project Pilot';
const sha = 'b'.repeat(40);

assert.equal((await exec(cli, ['--version'])).stdout.trim(), environment.paseoVersion);
const sdkVersions = [];
for (const name of ['client', 'plugin', 'protocol']) {
  const { version } = JSON.parse(await fs.readFile(join(repo, 'node_modules/@getpaseo', name, 'package.json'), 'utf8'));
  assert.equal(version, environment.sdkVersion);
  sdkVersions.push(version);
}

const { createHostClient } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/client/dist/node/index.js')));
const { createPaseoApi } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/client/dist/index.js')));
const { settingsRpc } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/plugin/dist/index.js')));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw Error('Timed out: ' + label);
}

async function openPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fingerprint(path) {
  const st = await fs.lstat(path, { bigint: true });
  return {
    kind: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file',
    dev: String(st.dev),
    ino: String(st.ino),
    mode: Number(st.mode & 0o7777n),
    size: Number(st.size),
    ...(st.isFile() ? { sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex') } : {}),
  };
}

async function snapshotDir(root) {
  const rows = {};
  async function walk(p, key) {
    const st = await fs.lstat(p, { bigint: true });
    rows[key] = {
      kind: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : 'file',
      dev: String(st.dev),
      ino: String(st.ino),
      mode: Number(st.mode & 0o7777n),
      ...(st.isFile() ? { size: Number(st.size), sha256: createHash('sha256').update(await fs.readFile(p)).digest('hex') } : {}),
    };
    if (st.isDirectory()) {
      for (const name of (await fs.readdir(p)).sort()) {
        await walk(join(p, name), key === '.' ? name : `${key}/${name}`);
      }
    }
  }
  await walk(root, '.');
  return rows;
}

const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-pilot-accept-')));
console.log('Single-Project Pilot acceptance workspace: ' + base);
const home = join(base, 'daemon');
const desktopProfile = join(base, 'desktop');
const plugin = join(base, 'candidate');
const port = await openPort();
const listen = `127.0.0.1:${port}`;

for (const dir of [home, desktopProfile, plugin, join(home, 'runtime'), join(home, 'runtime/project-skills-pilot'), join(home, 'runtime/project-skills-pilot/coordinator')]) {
  await fs.mkdir(dir, { mode: 0o700 });
}
for (const dir of ['client', 'server', 'shared']) {
  await fs.cp(join(repo, dir), join(plugin, dir), { recursive: true });
}
for (const file of ['index.server.ts', 'index.client.tsx', 'paseo-plugin.json']) {
  await fs.copyFile(join(repo, 'release/single-project-pilot', file), join(plugin, file));
}
await fs.symlink(join(repo, 'node_modules'), join(plugin, 'node_modules'));

// Inject deterministic catalog + test barrier/crash hooks controlled by flag files in `base`.
const adapterPath = join(plugin, 'server/single-project-pilot-profile.ts');
const adapterTypes = (await fs.readFile(adapterPath, 'utf8')).split('// Filled only')[0];
const adapterBody = `
import { createHash } from 'node:crypto';
import { existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogSource } from '../shared/catalog-settings';

const base = ${JSON.stringify(base)};
const sha = ${JSON.stringify(sha)};
const descriptor = (path: string, text: string, mode: '100644' | '100755' = '100644') => {
  const bytes = Buffer.from(text);
  return { path, bytes, mode, sizeBytes: bytes.length, blobSha: createHash('sha1').update('blob ' + bytes.length + '\\0').update(bytes).digest('hex') };
};
const catalog = {
  load: async () => ({
    schemaVersion: 1 as const,
    source: catalogSource,
    commitSha: sha,
    skills: [{
      id: 'demo',
      directory: 'skills/demo',
      metadata: { name: 'demo', description: 'Pilot acceptance skill' },
      entrypoint: descriptor('SKILL.md', '---\\nname: demo\\ndescription: Pilot acceptance skill\\n---\\nPilot.\\n'),
      supportingFiles: [
        descriptor('file-00.txt', 'pilot file 00\\n'),
        descriptor('file-01.txt', 'pilot file 01\\n'),
        descriptor('run.sh', '#!/bin/sh\\necho ok\\n', '100755'),
      ],
    }],
  }),
};
async function gate(name: string, data: unknown) {
  writeFileSync(join(base, name + '.ready'), JSON.stringify(data), { mode: 0o600 });
  for (let i = 0; i < 400; i++) {
    if (existsSync(join(base, name + '.release'))) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error('pilot barrier timeout ' + name);
}
export const pilotProfile: SingleProjectPilotProfile = {
  daemonHome: ${JSON.stringify(home)},
  cli: ${JSON.stringify(cli)},
  sdkVersions: ${JSON.stringify(sdkVersions)},
  catalog,
  trace: (method, operationId) => appendFileSync(join(base, 'rpc-audit.ndjson'), JSON.stringify({ method, operationId, pid: process.pid }) + '\\n', { mode: 0o600 }),
  test: {
    controls: () => {
      if (existsSync(join(base, 'inject-move-after-check'))) return { barriers: [{ point: 'before_openat', destination: '.agents/skills/demo/file-01.txt' }], faults: [] };
      if (existsSync(join(base, 'inject-late-collision'))) return { barriers: [{ point: 'after_create_check', destination: '.agents/skills/demo/file-00.txt' }], faults: [] };
      if (existsSync(join(base, 'inject-crash'))) return { barriers: [{ point: 'after_create', destination: '.agents/skills/demo/file-01.txt' }], faults: [] };
      return undefined;
    },
    onEvent: async (event, { helperPid }) => {
      if (event.event !== 'barrier') return;
      if (existsSync(join(base, 'inject-move-after-check'))) return gate('move-after-check', { point: event.point, destination: event.destination });
      if (existsSync(join(base, 'inject-late-collision'))) return gate('late-collision', { point: event.point, destination: event.destination });
      if (existsSync(join(base, 'inject-crash'))) {
        process.kill(helperPid, 'SIGKILL');
      }
    },
  },
};
`;
await fs.writeFile(adapterPath, adapterTypes + adapterBody);

await fs.writeFile(join(home, 'config.json'), JSON.stringify({
  version: 1,
  pluginsEnabled: true,
  daemon: { listen, relay: { enabled: false } },
  features: { voiceMode: { enabled: false } },
}));

async function makeProjectCopy(name) {
  const dir = join(base, name);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(join(dir, 'sentinel.txt'), `sentinel-${name}\n`, { mode: 0o640 });
  await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ name, private: true }) + '\n', { mode: 0o644 });
  return dir;
}

const evidence = {
  workspace: base,
  environment: { ...environment, macOS: (await exec('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim(), arch: process.arch },
  cases: {},
};

let daemon;
let client;

async function startDaemon() {
  const log = await fs.open(join(base, 'daemon.log'), 'a', 0o600);
  daemon = spawn(cli, ['daemon', 'run', '--home', home], { cwd: base, stdio: ['ignore', log.fd, log.fd] });
  await log.close();
  client = await until(async () => {
    try {
      const status = JSON.parse((await exec(cli, ['--home', home, 'status', '--json'], { timeout: 1500 })).stdout);
      if (status.localDaemon === 'running') {
        const c = createHostClient(listen, {
          clientId: 'pilot-acceptance-driver',
          clientType: 'cli',
          reconnect: { enabled: false },
          localCredential: async () => (await fs.readFile(join(home, 'local-credential'), 'utf8')).trim(),
        });
        try { await c.connect(); return c; } catch { await c.close(); }
      }
    } catch {}
    return undefined;
  }, 'temporary daemon startup');
}

async function stopDaemon() {
  await client?.close();
  client = undefined;
  try { await exec(cli, ['--home', home, 'daemon', 'stop'], { timeout: 10000 }); }
  catch { daemon?.kill('SIGTERM'); }
  await until(async () => {
    try {
      const status = JSON.parse((await exec(cli, ['--home', home, 'status', '--json'], { timeout: 1500 })).stdout);
      return status.localDaemon === 'stopped';
    } catch { return false; }
  }, 'temporary daemon stop');
}

const call = (method, input) => client.invokePluginRpc(pluginId, method, input);

async function previewTarget(hostId, settingsRevision, target, viewNonce) {
  return call('preview.providers.v2', {
    viewNonce,
    intent: {
      schemaVersion: 1,
      hostId,
      canonicalDirectory: target,
      catalogSource,
      catalogCommitSha: sha,
      settingsRevision,
      selectedSkillIds: ['demo'],
      targetProviderIds: [],
      recommendationRequestId: 'pilot-req',
    },
  });
}

try {
  // Prepare independent project copies & out-of-scope targets.
  const copy1 = await makeProjectCopy('project-copy-1');
  const sibling = await makeProjectCopy('sibling-copy');
  const nested = join(copy1, 'nested-sub');
  await fs.mkdir(nested, { mode: 0o700 });
  await fs.writeFile(join(nested, 'nested-sentinel.txt'), 'nested\n', { mode: 0o640 });
  const alias = join(base, 'alias-to-copy-1');
  await fs.symlink(copy1, alias);

  // Start temporary daemon and perform REAL directory install.
  await startDaemon();
  const install = JSON.parse((await exec(cli, ['--home', home, 'plugin', 'install', plugin, '--json'], { timeout: 15000 })).stdout);
  evidence.install = install;

  const settings = settingsRpc('catalog');
  const origSettings = await call(settings.read.name, {});
  await call(settings.write.name, { revision: origSettings.revision, values: { catalogRef: sha } });
  const saved = await call(settings.read.name, {});
  const hostId = (await createPaseoApi(client).hosts.list()).self.serverId;

  // ── Case 1: Opt-in OFF by default ──
  const capOff = await call('apply.local-capability.v1', {});
  assert.deepEqual(capOff, { enabled: false });
  const prevOff = await previewTarget(hostId, saved.revision, copy1, 'opt-in-off');
  assert.equal(prevOff.status, 'ready');
  assert.deepEqual(prevOff.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });
  const applyOff = await call('apply.create.v1', {
    previewId: prevOff.receipt.previewId,
    planDigest: prevOff.receipt.planDigest,
    viewNonce: prevOff.receipt.viewNonce,
    operationId: randomBytes(16).toString('hex'),
    approval: 'create_only_v1',
  });
  assert.deepEqual(applyOff, { status: 'error', code: 'receipt_invalid' });
  await assert.rejects(fs.lstat(join(copy1, '.agents')), { code: 'ENOENT' });
  evidence.cases.optInOff = { pass: true, capability: capOff, previewEligibility: prevOff.applyEligibility, applyError: applyOff };
  console.log('PASS Case 1: Opt-in OFF by default');

  // ── Case 2: Enroll independent copy & reject sibling / nested / alias ──
  const aliasEnroll = await enrollSingleProjectRoot({ daemonHome: home, root: alias, environment });
  assert.equal(aliasEnroll.status, 'error');
  const enrolled1 = await enrollSingleProjectRoot({ daemonHome: home, root: copy1, environment });
  assert.equal(enrolled1.status, 'enrolled');
  assert.deepEqual(await call('apply.local-capability.v1', {}), { enabled: true });

  const siblingSnapBefore = await snapshotDir(sibling);
  const nestedSnapBefore = await snapshotDir(nested);
  const prevSibling = await previewTarget(hostId, saved.revision, sibling, 'scope-sibling');
  assert.deepEqual(prevSibling.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });
  const applySibling = await call('apply.create.v1', {
    previewId: prevSibling.receipt.previewId, planDigest: prevSibling.receipt.planDigest,
    viewNonce: prevSibling.receipt.viewNonce, operationId: randomBytes(16).toString('hex'), approval: 'create_only_v1',
  });
  assert.deepEqual(applySibling, { status: 'error', code: 'receipt_invalid' });

  const prevNested = await previewTarget(hostId, saved.revision, nested, 'scope-nested');
  assert.deepEqual(prevNested.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });
  const applyNested = await call('apply.create.v1', {
    previewId: prevNested.receipt.previewId, planDigest: prevNested.receipt.planDigest,
    viewNonce: prevNested.receipt.viewNonce, operationId: randomBytes(16).toString('hex'), approval: 'create_only_v1',
  });
  assert.deepEqual(applyNested, { status: 'error', code: 'receipt_invalid' });

  const prevAlias = await previewTarget(hostId, saved.revision, alias, 'scope-alias');
  assert.equal(prevAlias.status, 'error');

  assert.deepEqual(await snapshotDir(sibling), siblingSnapBefore);
  assert.deepEqual(await snapshotDir(nested), nestedSnapBefore);
  evidence.cases.outOfScope = {
    pass: true,
    enrolledRoot: enrolled1.policy.enrollment.canonicalRoot,
    policyRevision: enrolled1.policy.enrollment.policyRevision,
    aliasEnrollError: aliasEnroll.code,
    sibling: { eligibility: prevSibling.applyEligibility, applyError: applySibling, untouched: true },
    nested: { eligibility: prevNested.applyEligibility, applyError: applyNested, untouched: true },
    alias: { previewResult: prevAlias },
  };
  console.log('PASS Case 2: Sibling / nested / alias rejected');

  // ── Case 3: Root replacement (before Preview, after Preview, and move after linkage check) ──
  // 3a: Before Preview
  const moved3a = join(base, 'moved-3a');
  await fs.rename(copy1, moved3a);
  await fs.mkdir(copy1, { mode: 0o700 });
  await fs.writeFile(join(copy1, 'repl.txt'), 'repl-3a\n', { mode: 0o640 });
  const repl3aSnap = await snapshotDir(copy1);
  const prev3a = await previewTarget(hostId, saved.revision, copy1, 'repl-3a');
  assert.deepEqual(prev3a.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });
  assert.deepEqual(await snapshotDir(copy1), repl3aSnap);
  await fs.rm(copy1, { recursive: true, force: true });
  await fs.rename(moved3a, copy1);

  // 3b: After Preview, before Apply
  const prev3b = await previewTarget(hostId, saved.revision, copy1, 'repl-3b');
  assert.deepEqual(prev3b.applyEligibility, { status: 'eligible' });
  const moved3b = join(base, 'moved-3b');
  await fs.rename(copy1, moved3b);
  await fs.mkdir(copy1, { mode: 0o700 });
  await fs.writeFile(join(copy1, 'repl.txt'), 'repl-3b\n', { mode: 0o640 });
  const repl3bSnap = await snapshotDir(copy1);
  const apply3b = await call('apply.create.v1', {
    previewId: prev3b.receipt.previewId, planDigest: prev3b.receipt.planDigest,
    viewNonce: prev3b.receipt.viewNonce, operationId: randomBytes(16).toString('hex'), approval: 'create_only_v1',
  });
  assert.deepEqual(apply3b, { status: 'error', code: 'unsupported_environment' });
  assert.deepEqual(await snapshotDir(copy1), repl3bSnap);
  await fs.rm(copy1, { recursive: true, force: true });
  await fs.rename(moved3b, copy1);

  // 3c: Move AFTER linkage check (at before_openat barrier on file-01.txt)
  const flagMove = join(base, 'inject-move-after-check');
  await fs.writeFile(flagMove, '1', { mode: 0o600 });
  const prev3c = await previewTarget(hostId, saved.revision, copy1, 'move-after-linkage');
  assert.deepEqual(prev3c.applyEligibility, { status: 'eligible' });
  const op3c = randomBytes(16).toString('hex');
  const moved3c = join(base, 'moved-old-root-3c');
  const apply3cPromise = call('apply.create.v1', {
    previewId: prev3c.receipt.previewId, planDigest: prev3c.receipt.planDigest,
    viewNonce: prev3c.receipt.viewNonce, operationId: op3c, approval: 'create_only_v1',
  });
  await until(async () => {
    try { await fs.lstat(join(base, 'move-after-check.ready')); return true; } catch { return false; }
  }, 'move-after-check barrier');
  await fs.rename(copy1, moved3c);
  await fs.mkdir(copy1, { mode: 0o700 });
  await fs.writeFile(join(copy1, 'replacement-sentinel.txt'), 'replacement-untouched\n', { mode: 0o640 });
  const repl3cBefore = await snapshotDir(copy1);
  await fs.writeFile(join(base, 'move-after-check.release'), '1', { mode: 0o600 });
  const apply3c = await apply3cPromise;
  await fs.unlink(flagMove);
  assert.equal(apply3c.status, 'operation');
  assert.equal(apply3c.phase, 'partial_failure');
  assert.equal(apply3c.code, 'linkage_changed');
  assert.equal(apply3c.targetMutated, true);

  // Inspect OLD directory and REPLACEMENT directory separately!
  const oldDirFile00 = await fingerprint(join(moved3c, '.agents/skills/demo/file-00.txt'));
  const oldDirFile01 = await fingerprint(join(moved3c, '.agents/skills/demo/file-01.txt'));
  const row00 = apply3c.ledger.find(r => r.destination === '.agents/skills/demo/file-00.txt');
  const row01 = apply3c.ledger.find(r => r.destination === '.agents/skills/demo/file-01.txt');
  const rowSkill = apply3c.ledger.find(r => r.destination === '.agents/skills/demo/SKILL.md');
  assert.equal(row00.state, 'created_verified');
  assert.equal(oldDirFile00.ino, row00.identity.ino);
  assert.equal(row01.state, 'created_incomplete');
  assert.equal(row01.bytesWritten, 0);
  assert.equal(oldDirFile01.ino, row01.identity.ino);
  assert.equal(oldDirFile01.size, 0);
  assert.equal(oldDirFile01.mode, 0o600);
  assert.equal(rowSkill.state, 'not_attempted');
  await assert.rejects(fs.lstat(join(moved3c, '.agents/skills/demo/SKILL.md')), { code: 'ENOENT' });

  const repl3cAfter = await snapshotDir(copy1);
  assert.deepEqual(repl3cAfter, repl3cBefore);
  const postReplPreview = await previewTarget(hostId, saved.revision, copy1, 'post-repl');
  assert.deepEqual(postReplPreview.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });

  evidence.cases.rootReplacement = {
    pass: true,
    beforePreview: { eligibility: prev3a.applyEligibility, replacementUntouched: true },
    afterPreview: { applyError: apply3b, replacementUntouched: true },
    moveAfterLinkageCheck: {
      operation: apply3c,
      oldDirectory: { path: moved3c, file00: oldDirFile00, file01: oldDirFile01, skillMdAbsent: true },
      replacementDirectory: { path: copy1, untouched: true, postPreviewEligibility: postReplPreview.applyEligibility },
    },
  };
  console.log('PASS Case 3: Root replacement (before Preview, after Preview, move after linkage check)');

  // ── Case 4: Late collision & two writers racing same leaf ──
  const copy2 = await makeProjectCopy('project-copy-2');
  const enrolled2 = await enrollSingleProjectRoot({ daemonHome: home, root: copy2, environment });
  assert.equal(enrolled2.status, 'enrolled');
  await fs.mkdir(join(copy2, '.agents/skills/demo'), { recursive: true, mode: 0o755 });

  // 4a: Late collision at after_create_check
  const flagLate = join(base, 'inject-late-collision');
  await fs.writeFile(flagLate, '1', { mode: 0o600 });
  const prevLate = await previewTarget(hostId, saved.revision, copy2, 'late-collision');
  assert.deepEqual(prevLate.applyEligibility, { status: 'eligible' });
  const latePromise = call('apply.create.v1', {
    previewId: prevLate.receipt.previewId, planDigest: prevLate.receipt.planDigest,
    viewNonce: prevLate.receipt.viewNonce, operationId: randomBytes(16).toString('hex'), approval: 'create_only_v1',
  });
  await until(async () => {
    try { await fs.lstat(join(base, 'late-collision.ready')); return true; } catch { return false; }
  }, 'late-collision barrier');
  const foreignLeaf = join(copy2, '.agents/skills/demo/file-00.txt');
  await fs.writeFile(foreignLeaf, 'foreign-content\n', { mode: 0o640 });
  const foreignBefore = await fingerprint(foreignLeaf);
  await fs.writeFile(join(base, 'late-collision.release'), '1', { mode: 0o600 });
  const lateRes = await latePromise;
  await fs.unlink(flagLate);
  assert.equal(lateRes.status, 'operation');
  assert.equal(lateRes.phase, 'failed_before_write');
  assert.equal(lateRes.code, 'destination_exists');
  assert.equal(lateRes.targetMutated, false);
  const foreignAfter = await fingerprint(foreignLeaf);
  assert.deepEqual(foreignAfter, foreignBefore);
  await fs.unlink(foreignLeaf);

  // 4b: Two writers racing the same leaf at before_openat
  const raceReceipts = new PreviewReceiptStore({ singleProject: () => toEnrollmentBinding(enrolled2.policy.enrollment) });
  const raceBytes = Buffer.from('---\nname: demo\ndescription: Race skill\n---\n');
  const raceCatalog = {
    load: async () => ({
      schemaVersion: 1, source: catalogSource, commitSha: sha,
      skills: [{
        id: 'demo', directory: 'skills/demo', metadata: { name: 'demo', description: 'Race skill' },
        entrypoint: { path: 'SKILL.md', bytes: raceBytes, mode: '100644', sizeBytes: raceBytes.length, blobSha: createHash('sha1').update(`blob ${raceBytes.length}\0`).update(raceBytes).digest('hex') },
        supportingFiles: [],
      }],
    }),
  };
  const raceSettings = { read: async () => ({ status: 'ready', revision: 'race-rev', values: { catalogRef: sha } }) };
  const racePreview = createCanonicalPreviewHandler(raceSettings, raceCatalog, { receiptStore: raceReceipts });
  const racePrev = await racePreview.handleProvidersV2({
    viewNonce: 'race-leaf',
    intent: { schemaVersion: 1, hostId, canonicalDirectory: copy2, catalogSource, catalogCommitSha: sha, settingsRevision: 'race-rev', selectedSkillIds: ['demo'], targetProviderIds: [], recommendationRequestId: 'race' },
  }, { paseo: { hosts: { list: async () => ({ self: { serverId: hostId } }) } } });
  const raceInspected = raceReceipts.inspectApply({
    previewId: racePrev.receipt.previewId, planDigest: racePrev.receipt.planDigest, viewNonce: racePrev.receipt.viewNonce,
    hostId, installationInstanceId: raceReceipts.installationInstanceId,
  });
  const raceReq = singleProjectWriterRequest({
    enrollment: enrolled2.policy.enrollment, manifest: raceInspected.manifest, planDigest: racePrev.receipt.planDigest,
    sources: raceInspected.sources, environment,
    controls: { barriers: [{ point: 'before_openat', destination: '.agents/skills/demo/SKILL.md' }], faults: [] },
  });
  const c1 = join(home, 'runtime/project-skills-pilot/race-1');
  const c2 = join(home, 'runtime/project-skills-pilot/race-2');
  await fs.mkdir(c1, { mode: 0o700 });
  await fs.mkdir(c2, { mode: 0o700 });
  const both = Promise.withResolvers();
  const releaseRace = Promise.withResolvers();
  let arrived = 0;
  const onRaceEvent = async (e) => {
    if (e.event === 'barrier' && e.point === 'before_openat') {
      if (++arrived === 2) both.resolve();
      await releaseRace.promise;
    }
  };
  const [raceA, raceB] = await Promise.all([
    runSingleProjectWriter({ ...raceReq, durableAdmission: true, coordinator: { directory: c1 } }, { testing: true, onEvent: onRaceEvent, onAdmission: async () => true, onProgress: () => {} }),
    (async () => {
      const p = runSingleProjectWriter({ ...raceReq, durableAdmission: true, coordinator: { directory: c2 } }, { testing: true, onEvent: onRaceEvent, onAdmission: async () => true, onProgress: () => {} });
      await both.promise;
      releaseRace.resolve();
      return p;
    })(),
  ]);
  await racePreview.dispose();
  assert.deepEqual([raceA.result.phase, raceB.result.phase].sort(), ['completed', 'failed_before_write']);
  const loserRace = raceA.result.phase === 'failed_before_write' ? raceA : raceB;
  assert.equal(loserRace.result.code, 'destination_exists');
  assert.equal(loserRace.result.targetMutated, false);
  evidence.cases.noClobberAndRace = {
    pass: true,
    lateCollision: { operation: lateRes, foreignBefore, foreignAfter },
    twoWritersSameLeaf: {
      phases: [raceA.result.phase, raceB.result.phase].sort(),
      loserCode: loserRace.result.code,
      loserMutated: loserRace.result.targetMutated,
      winnerLeaf: await fingerprint(join(copy2, '.agents/skills/demo/SKILL.md')),
    },
  };
  console.log('PASS Case 4: Late collision & two writers racing same leaf');

  // ── Case 5: Crash recovery + daemon restart + opt-in OFF / policy change while Status stays readable ──
  const copy3 = await makeProjectCopy('project-copy-3');
  const enrolled3 = await enrollSingleProjectRoot({ daemonHome: home, root: copy3, environment });
  assert.equal(enrolled3.status, 'enrolled');
  const flagCrash = join(base, 'inject-crash');
  await fs.writeFile(flagCrash, '1', { mode: 0o600 });
  const prevCrash = await previewTarget(hostId, saved.revision, copy3, 'crash-rec');
  assert.deepEqual(prevCrash.applyEligibility, { status: 'eligible' });
  const crashOpId = randomBytes(16).toString('hex');
  const crashRes = await call('apply.create.v1', {
    previewId: prevCrash.receipt.previewId, planDigest: prevCrash.receipt.planDigest,
    viewNonce: prevCrash.receipt.viewNonce, operationId: crashOpId, approval: 'create_only_v1',
  });
  await fs.unlink(flagCrash);
  assert.equal(crashRes.status, 'operation');
  assert.equal(crashRes.phase, 'recovery_required');
  assert.equal(crashRes.code, 'terminal_record_missing');

  // Restart daemon completely and turn opt-in OFF!
  await stopDaemon();
  setSingleProjectOptIn(home, false);
  await startDaemon();

  assert.deepEqual(await call('apply.local-capability.v1', {}), { enabled: false });
  const statusAfterRestart = await call('apply.status.v1', { operationId: crashOpId });
  assert.equal(statusAfterRestart.status, 'operation');
  assert.equal(statusAfterRestart.phase, 'recovery_required');
  assert.equal(statusAfterRestart.code, 'terminal_record_missing');
  assert.equal(statusAfterRestart.requiresPreview, true);
  const diskFile00 = await fingerprint(join(copy3, '.agents/skills/demo/file-00.txt'));
  const diskFile01 = await fingerprint(join(copy3, '.agents/skills/demo/file-01.txt'));
  assert.equal(diskFile01.size, 0);
  assert.equal(diskFile01.mode, 0o600);
  await assert.rejects(fs.lstat(join(copy3, '.agents/skills/demo/SKILL.md')), { code: 'ENOENT' });

  // Also verify Preview after crash blocks the plan due to partial 0-byte file!
  setSingleProjectOptIn(home, true, true);
  const prevAfterCrash = await previewTarget(hostId, saved.revision, copy3, 'after-crash-preview');
  assert.equal(prevAfterCrash.status, 'ready');
  assert.equal(prevAfterCrash.applyEligibility.status, 'ineligible');
  assert.ok(prevAfterCrash.applyEligibility.reasons.includes('plan_conflict'));

  // Verify old receipt is rejected after policyRevision rotation.
  const prevRotate = await previewTarget(hostId, saved.revision, copy3, 'pre-rotate');
  setSingleProjectOptIn(home, true, true);
  const applyStaleRev = await call('apply.create.v1', {
    previewId: prevRotate.receipt.previewId, planDigest: prevRotate.receipt.planDigest,
    viewNonce: prevRotate.receipt.viewNonce, operationId: randomBytes(16).toString('hex'), approval: 'create_only_v1',
  });
  assert.deepEqual(applyStaleRev, { status: 'error', code: 'receipt_invalid' });

  // Stop CLI-launched daemon before Desktop acceptance so Desktop manages the temporary daemon cleanly.
  await stopDaemon();

  evidence.cases.crashRecovery = {
    pass: true,
    operationId: crashOpId,
    statusAfterRestartAndOptInOff: statusAfterRestart,
    diskEvidence: { file00: diskFile00, file01: diskFile01, skillMdAbsent: true },
    previewAfterCrash: prevAfterCrash.applyEligibility,
    stalePolicyRevisionApplyError: applyStaleRev,
  };
  console.log('PASS Case 5: Crash recovery, restart, opt-in OFF Status, policy revision invalidation');

  // ── Case 6: Real Paseo Desktop Apply -> Status -> Preview no-op ──
  const desktopCopy = await makeProjectCopy('project-copy-desktop');
  const sentinelBefore = await fingerprint(join(desktopCopy, 'sentinel.txt'));
  const enrolledDesktop = await enrollSingleProjectRoot({ daemonHome: home, root: desktopCopy, environment });
  assert.equal(enrolledDesktop.status, 'enrolled');

  const debugPort = await openPort();
  const desktopLog = await fs.open(join(base, 'desktop.log'), 'w', 0o600);
  const desktop = spawn(executable, ['--remote-debugging-port=' + debugPort], {
    cwd: base,
    env: { ...process.env, PASEO_HOME: home, PASEO_ELECTRON_USER_DATA_DIR: desktopProfile },
    stdio: ['ignore', desktopLog.fd, desktopLog.fd],
  });
  await desktopLog.close();
  let ws;
  try {
    const debugTarget = await until(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        return list.find(item => item.type === 'page');
      } catch { return undefined; }
    }, 'Desktop DevTools');
    ws = new WebSocket(debugTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const reply = JSON.parse(event.data);
      const req = pending.get(reply.id);
      if (!req) return;
      pending.delete(reply.id);
      if (reply.error) req.reject(Error(reply.error.message));
      else req.resolve(reply.result);
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const reply = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    };
    await cdp('Page.bringToFront');
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
    const text = () => evaluate('document.body.innerText');
    const waitText = async needle => until(async () => { const body = await text(); return body.includes(needle) && body; }, needle, 30000);
    const buttons = `[...document.querySelectorAll('button,[role=button],[role=checkbox],[role=menuitem],[role=option]')]`;
    const find = label => `${buttons}.filter(n=>n.getClientRects().length&&!n.closest('[aria-hidden=true]')).find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)})`;
    const click = async label => assert.equal(await evaluate(`(()=>{const n=${find(label)};if(!n)return 'missing';if(n.disabled||n.getAttribute('aria-disabled')==='true')return 'disabled';n.scrollIntoView({block:'center'});n.click();return 'clicked';})()`), 'clicked', label);

    await until(async () => {
      try {
        const rows = JSON.parse((await exec(cli, ['--home', home, 'plugin', 'ls', '--json'], { timeout: 2000 })).stdout);
        return rows.some(row => row.id === pluginId && row.status === 'running');
      } catch { return false; }
    }, 'Desktop-managed pilot daemon');

    await until(async () => await evaluate(`Boolean(${find(pluginTitle)})`), 'pilot sidebar item', 30000);
    if (await evaluate(`Boolean(${find('Skip setup')})`)) await click('Skip setup');
    await click(pluginTitle);
    await waitText('Target Project');

    const inputSel = "[...document.querySelectorAll('input')].filter(n=>n.getClientRects().length&&!n.closest('[aria-hidden=true]')).find(n=>n.getAttribute('aria-label')==='Absolute path on the host')";
    for (let i = 0; i < 3; i++) {
      await until(async () => await evaluate(`(()=>{const n=${inputSel};if(!n)return false;n.scrollIntoView({block:'center'});n.focus();n.select();return document.activeElement===n;})()`), 'focus target input', 5000);
      await cdp('Input.insertText', { text: desktopCopy });
      await until(async () => await evaluate(`(${inputSel})?.value===${JSON.stringify(desktopCopy)}&&${find('Use directory')}?.getAttribute('aria-disabled')!=='true'`), 'target input ready', 4000);
      await click('Use directory');
      try { await until(async () => (await text()).includes('Target directory: ' + desktopCopy), 'target validated', 4000); break; }
      catch (err) { if (i === 2) throw err; }
    }
    await click('Scan & Recommend');
    await waitText('Recommendation Results');
    if (!await evaluate(`Boolean(${find('Select demo')})`)) await click('Unknown (1)');
    await click('Select demo');
    await click('Preview Changes');
    await waitText('Eligible for create-only approval.');
    await click('Review create-only approval');
    await waitText('Confirm create-only');
    await click('Confirm create-only');
    await waitText('Completed');
    await click('Operation ledger');
    await waitText('Created and verified');

    // Verify Status via RPC & disk fingerprints.
    const desktopClient = createHostClient(listen, {
      clientId: 'pilot-desktop-verify',
      clientType: 'cli',
      reconnect: { enabled: false },
      localCredential: async () => (await fs.readFile(join(home, 'local-credential'), 'utf8')).trim(),
    });
    await desktopClient.connect();
    try {
      const auditLines = (await fs.readFile(join(base, 'rpc-audit.ndjson'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
      const lastApply = [...auditLines].reverse().find(a => a.method === 'apply');
      assert.ok(lastApply, 'desktop apply recorded in audit');
      const desktopStatus = await desktopClient.invokePluginRpc(pluginId, 'apply.status.v1', { operationId: lastApply.operationId });
      assert.equal(desktopStatus.status, 'operation');
      assert.equal(desktopStatus.phase, 'completed');
      assert.equal(desktopStatus.targetMutated, true);
      const createdFiles = {};
      for (const row of desktopStatus.ledger.filter(r => r.kind === 'file')) {
        const fp = await fingerprint(join(desktopCopy, row.destination));
        assert.equal(fp.sha256, row.expected.sha256);
        assert.equal(fp.mode, row.expected.mode);
        assert.equal(fp.ino, row.identity.ino);
        createdFiles[row.destination] = fp;
      }
      const sentinelAfter = await fingerprint(join(desktopCopy, 'sentinel.txt'));
      assert.deepEqual(sentinelAfter, sentinelBefore);

      // Re-run Preview in Desktop -> must report no-op!
      await click('Preview Changes');
      await waitText('No changes to approve.');
      const dHostId = (await createPaseoApi(desktopClient).hosts.list()).self.serverId;
      const dSaved = await desktopClient.invokePluginRpc(pluginId, settings.read.name, {});
      const noopPrev = await desktopClient.invokePluginRpc(pluginId, 'preview.providers.v2', {
        viewNonce: 'desktop-noop',
        intent: {
          schemaVersion: 1, hostId: dHostId, canonicalDirectory: desktopCopy, catalogSource, catalogCommitSha: sha,
          settingsRevision: dSaved.revision, selectedSkillIds: ['demo'], targetProviderIds: [], recommendationRequestId: 'desktop-noop',
        },
      });
      assert.equal(noopPrev.status, 'ready');
      assert.deepEqual(noopPrev.applyEligibility, { status: 'no_changes' });
      evidence.cases.desktopApplyStatusNoop = {
        pass: true,
        enrolledRoot: desktopCopy,
        operationId: lastApply.operationId,
        status: desktopStatus,
        createdFiles,
        sentinelUnchanged: true,
        repreviewEligibility: noopPrev.applyEligibility,
      };
      console.log('PASS Case 6: Desktop Apply -> Status -> Preview no-op');
    } finally {
      await desktopClient.close();
    }
  } finally {
    ws?.close();
    desktop.kill('SIGTERM');
    await sleep(1000);
    if (desktop.exitCode === null) desktop.kill('SIGKILL');
    try { await exec(cli, ['--home', home, 'daemon', 'stop'], { timeout: 10000 }); } catch {}
  }

  const finalStatus = JSON.parse((await exec(cli, ['--home', home, 'status', '--json'])).stdout);
  assert.equal(finalStatus.localDaemon, 'stopped');
  evidence.cleanup = finalStatus;

  const evidenceDir = join(repo, 'docs/evidence/single-project-pilot');
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(join(evidenceDir, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('ALL SINGLE-PROJECT PILOT ACCEPTANCE CASES PASSED. Evidence saved to docs/evidence/single-project-pilot/acceptance.json');
} finally {
  if (client) await stopDaemon().catch(() => {});
}
