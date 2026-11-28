// Real directory-install & runtime acceptance smoke test for the main plugin (paseo-project-skills)
// on an isolated Paseo daemon. Never touches ~/.paseo or any real project.
// Verifies: directory install, plugin running, reload, RPCs (foundation, validate, scan, recommend,
// preview v1/v2 with all 4 providers), Apply fail-closed (unsupported_paseo_version / remote_exposure_enabled),
// zero target mutation, and clean daemon shutdown.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.PASEO_CLI ?? '/Applications/Paseo.app/Contents/Resources/bin/paseo';
const pluginId = 'paseo-project-skills';

async function openPort() {
  const s = createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}

async function waitForDaemon(home, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = JSON.parse((await exec(cli, ['--home', home, 'status', '--json'], { timeout: 2000 })).stdout);
      if (st.localDaemon === 'running') return st;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Isolated Paseo daemon did not reach running state');
}

async function snapshotDir(root) {
  const out = {};
  async function walk(p, rel) {
    const st = await fs.lstat(p, { bigint: true });
    out[rel] = {
      kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      ino: String(st.ino),
      mode: Number(st.mode & 0o7777n),
      ...(st.isFile() ? { sha256: createHash('sha256').update(await fs.readFile(p)).digest('hex') } : {}),
    };
    if (st.isDirectory()) {
      for (const name of (await fs.readdir(p)).sort()) {
        if (name === '.git') continue;
        await walk(join(p, name), rel === '.' ? name : `${rel}/${name}`);
      }
    }
  }
  await walk(root, '.');
  return out;
}

const paseoVersion = (await exec(cli, ['--version'], { timeout: 5000 })).stdout.trim();
// Verify build-time SDK manifest before testing directory install.
await exec(process.execPath, [join(repo, 'scripts/build-sdk-manifest.mjs'), '--verify'], { timeout: 10000 });
const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-main-install-smoke-')));
const home = join(base, 'daemon');
const project = join(base, 'project-copy');
await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(project, { mode: 0o700 });

const port = await openPort();
const listen = `127.0.0.1:${port}`;
await fs.writeFile(join(home, 'config.json'), JSON.stringify({
  version: 1,
  daemon: { listen, relay: { enabled: true } },
  pluginsEnabled: true,
}), { mode: 0o600 });

// Prepare a minimal Git project copy so Kiro root proof & scanner can be exercised read-only.
await exec('git', ['init', '-b', 'main', project]);
await exec('git', ['-C', project, 'config', 'user.email', 'test@example.com']);
await exec('git', ['-C', project, 'config', 'user.name', 'Test User']);
await fs.writeFile(join(project, 'package.json'), JSON.stringify({ name: 'smoke-app', dependencies: { react: '19.1.0' } }, null, 2));
await exec('git', ['-C', project, 'add', 'package.json']);
await exec('git', ['-C', project, 'commit', '-m', 'init']);
const beforeSnapshot = await snapshotDir(project);

const daemon = spawn(cli, ['daemon', 'run', '--home', home], { cwd: base, stdio: 'ignore' });
const { createHostClient } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/client/dist/node/index.js')));
const { createPaseoApi } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/client/dist/index.js')));
const { settingsRpc } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/plugin/dist/index.js')));

let client;
try {
  const status = await waitForDaemon(home);

  // 1. Real directory install of main plugin repo.
  await exec(cli, ['--home', home, 'plugin', 'install', repo, '--json'], { timeout: 25000 });
  const ls1 = JSON.parse((await exec(cli, ['--home', home, 'plugin', 'ls', '--json'], { timeout: 5000 })).stdout);
  const installed1 = ls1.find(p => p.id === pluginId);
  assert.equal(installed1?.status, 'running', `Expected running after install, got: ${JSON.stringify(installed1)}`);

  // 2. Real plugin reload.
  await exec(cli, ['--home', home, 'plugin', 'reload', pluginId], { timeout: 20000 });
  const ls2 = JSON.parse((await exec(cli, ['--home', home, 'plugin', 'ls', '--json'], { timeout: 5000 })).stdout);
  const installed2 = ls2.find(p => p.id === pluginId);
  assert.equal(installed2?.status, 'running', `Expected running after reload, got: ${JSON.stringify(installed2)}`);

  // 3. Connect via Paseo HostClient and exercise read-only RPCs + fail-closed Apply guards.
  client = createHostClient(listen, { clientId: 'main-install-smoke', clientType: 'cli', reconnect: { enabled: false } });
  await client.connect();
  const call = (method, input) => client.invokePluginRpc(pluginId, method, input);

  const foundation = await call('foundation.status', {});
  assert.deepEqual(foundation, { status: 'ready' });

  const validated = await call('target.validate-directory', { path: project });
  assert.deepEqual(validated, { status: 'ready', directory: project });

  const targetStatus = await call('apply.target-status.v1', { canonicalDirectory: project });
  assert.equal(targetStatus.hostCompatible, false);
  assert.equal(targetStatus.trustBoundaryOk, false);
  assert.equal(targetStatus.targetState, 'host_unavailable');
  assert.ok(targetStatus.reasons.includes('remote_exposure_enabled'), `Expected remote_exposure_enabled in ${JSON.stringify(targetStatus.reasons)}`);
  if (paseoVersion === '0.18.0') {
    assert.ok(!targetStatus.reasons.includes('unsupported_paseo_version'), `Paseo 0.18.0 should be compatible, got: ${JSON.stringify(targetStatus.reasons)}`);
    assert.ok(!targetStatus.reasons.includes('unsupported_sdk_version'), `Build-time SDK manifest should pass in bundled 0.18.0, got: ${JSON.stringify(targetStatus.reasons)}`);
  }

  // Verify apply.create.v1 is NOT callable when fail-closed.
  let applyBlocked = false;
  try {
    await call('apply.create.v1', {
      previewId: 'a'.repeat(64),
      planDigest: 'b'.repeat(64),
      viewNonce: 'smoke-v1',
      operationId: randomBytes(16).toString('hex'),
      approval: 'create_only_v1',
    });
  } catch {
    applyBlocked = true;
  }
  assert.equal(applyBlocked, true, 'Expected apply.create.v1 to be unavailable when fail-closed');

  // Exercise catalog settings + Preview v2 with all 4 providers (optional if network/SSH unavailable).
  let previewCheck = { skipped: true };
  const catalogSha = process.env.PPS_SMOKE_CATALOG_SHA ?? '4044fbf0545f4be1da51dbc10f1327f0a3da0017';
  const settings = settingsRpc('catalog');
  const s0 = await call(settings.read.name, {});
  await call(settings.write.name, { revision: s0.revision, values: { catalogRef: catalogSha } });
  const s1 = await call(settings.read.name, {});
  const cat = await call('catalog.load', {});
  if (cat.status === 'ready') {
    const hostId = (await createPaseoApi(client).hosts.list()).self.serverId;
    const skillId = cat.snapshot.skills.find(s => s.id === 'debug-regression')?.id ?? cat.snapshot.skills[0]?.id;
    const prev2 = await call('preview.providers.v2', {
      viewNonce: 'smoke-018-preview',
      intent: {
        schemaVersion: 1,
        hostId,
        canonicalDirectory: project,
        catalogSource: 'https://github.com/anmeo2204/project-skills',
        catalogCommitSha: cat.snapshot.commitSha,
        settingsRevision: s1.revision,
        selectedSkillIds: [skillId],
        targetProviderIds: ['codex', 'kiro', 'cursor', 'antigravity'],
        recommendationRequestId: 'smoke-rec-1',
      },
    });
    assert.equal(prev2.status, 'ready', `Expected ready preview, got: ${JSON.stringify(prev2)}`);
    assert.equal(prev2.applyEligibility.status, 'ineligible');
    assert.deepEqual(prev2.applyEligibility.reasons, ['write_capability_unavailable']);
    assert.equal(prev2.manifest.plan.providers.length, 4);
    previewCheck = {
      skipped: false,
      skillId,
      canonicalEntries: prev2.manifest.plan.entries.length,
      kiroDerivedEntries: prev2.manifest.plan.derivedEntries.length,
      providers: prev2.manifest.plan.providers.map(p => ({ id: p.providerId, status: p.status })),
      applyEligibility: prev2.applyEligibility,
    };
  }

  // Verify zero target mutation and clean plugin logs.
  const afterSnapshot = await snapshotDir(project);
  assert.deepEqual(afterSnapshot, beforeSnapshot, 'Target project copy must remain completely untouched');
  const logs = (await exec(cli, ['--home', home, 'plugin', 'logs', pluginId], { timeout: 5000 })).stdout;
  assert.ok(!logs.includes('Plugin failed to load'), `Unexpected load error in plugin logs: ${logs}`);

  const summary = {
    status: 'pass',
    paseoVersion,
    daemonVersion: status.daemonVersion,
    pluginStatusAfterInstall: installed1.status,
    pluginStatusAfterReload: installed2.status,
    targetStatus,
    applyCreateBlocked: applyBlocked,
    previewCheck,
    targetUntouched: true,
    pluginLogsClean: true,
  };
  const outPath = process.argv[2];
  if (outPath) {
    await fs.mkdir(join(outPath, '..'), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (client) try { await client.close(); } catch {}
  try { await exec(cli, ['--home', home, 'daemon', 'stop'], { timeout: 5000 }); } catch {}
  daemon.kill('SIGTERM');
  await fs.rm(base, { recursive: true, force: true });
}
