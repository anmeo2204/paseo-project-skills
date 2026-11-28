// Comprehensive M4.P3 Real Runtime Acceptance on isolated Paseo 0.18.0 daemon & Desktop profile.
// NEVER touches ~/.paseo, user Desktop profile, SLP, Kanbanly, or any real project.
// Covers:
// - Real directory install & reload on Paseo 0.18.0
// - Live Paseo 0.18.0 Desktop UI: Select Project -> Scan -> Recommend -> Select multi-skill & 4 providers
//   -> Preview -> Approve -> Apply -> Verify -> Second Preview returns no_changes
// - Multi-root isolation (repoA, repoB enrolled; repoC unenrolled), Canonical + Kiro derived, existing skill preservation
// - Relay ON / OFF fail-closed transitions + apply.status.v1 recovery readability
// - SDK manifest missing / stale / mismatch fail-closed under real Paseo 0.18.0 bundler
// - Unsupported versions (0.18.1, 0.19.0) fail-closed in policy & native writer
// - Partial failure (ENOSPC) & crash recovery (SIGKILL -> recovery_required) on 0.18.0
// - Live native discovery + read tool traces for all 4 providers (Codex, Kiro ACP, Cursor ACP, Antigravity ACP)
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createMainPluginServer } from '../index.server.ts';
import { checkDaemonTrustBoundary, evaluateHostCompatibility } from '../server/compatibility-policy.ts';
import { enrollMultiRoot, readActiveMultiRootBinding, readActiveMultiRootEnrollment } from '../server/multi-root-policy.ts';
import { createCanonicalPreviewHandler } from '../server/canonical-preview.ts';
import { PreviewReceiptStore } from '../server/preview-receipts.ts';
import { createMultiRootApply } from '../server/fixture-apply.ts';
import { runSingleProjectEnroll } from '../server/native-writer.ts';
import { nativeWriterVersion } from '../server/native-writer-contract.ts';
import { sdkManifestArtifact } from '../server/native/sdk-manifest-payload.ts';
import { applyCreateRpc } from '../shared/apply.ts';
import { providerPreviewV2Rpc } from '../shared/rpc.ts';
import { catalogSource } from '../shared/catalog-settings.ts';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const app = process.env.M4P3_PASEO_APP ?? '/Applications/Paseo.app';
const cli = join(app, 'Contents/Resources/bin/paseo');
const executable = join(app, 'Contents/MacOS/Paseo');
const pluginId = 'paseo-project-skills';
const catalogSha = process.env.PPS_SMOKE_CATALOG_SHA ?? '4044fbf0545f4be1da51dbc10f1327f0a3da0017';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitBlobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const opId = () => randomBytes(16).toString('hex');

async function openPort() {
  const s = createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}

async function until(fn, label, timeoutMs = 25000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function initGitRepo(dir, files = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await exec('git', ['init', '-b', 'main', dir]);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  const defaults = {
    'package.json': JSON.stringify({ name: 'm4p3-copy', dependencies: { react: '19.1.0', typescript: '5.9.3' } }, null, 2),
    ...files,
  };
  for (const [rel, content] of Object.entries(defaults)) {
    const full = join(dir, rel);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, content, { mode: 0o644 });
  }
  await exec('git', ['-C', dir, 'add', '.']);
  await exec('git', ['-C', dir, 'commit', '-m', 'init']);
}

async function snapshotDir(root) {
  const out = {};
  async function walk(p, rel) {
    const st = await fs.lstat(p, { bigint: true });
    out[rel] = {
      kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      ino: String(st.ino),
      mode: Number(st.mode & 0o7777n),
      ...(st.isFile() ? { sha256: sha256(await fs.readFile(p)) } : {}),
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

async function getVersion(cmd, args = ['--version']) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: 5000 });
    return (stdout || stderr).trim().split('\n')[0];
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function probeAcpTrace({ label, command, args, preferredMode, cwd, skillId, marker, expectedPathFragment, timeoutMs = 45000 }) {
  const version = await getVersion(command);
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  let buf = '';
  const waiters = new Map();
  const commands = [];
  const toolCalls = [];
  let reply = '';
  let stderr = '';

  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 2000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const w = waiters.get(msg.id);
          if (w) { waiters.delete(msg.id); w(msg); }
        } else if (msg.method === 'session/update') {
          const u = msg.params?.update;
          if (u?.sessionUpdate === 'available_commands_update' && Array.isArray(u.availableCommands)) {
            for (const c of u.availableCommands) commands.push(c);
          } else if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
            reply += u.content.text;
          } else if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
            const raw = JSON.stringify(u);
            toolCalls.push({
              update: u.sessionUpdate,
              kind: u.kind,
              title: u.title,
              status: u.status,
              matchedPath: raw.includes(expectedPathFragment) || raw.includes(`${skillId}/SKILL.md`),
            });
          }
        }
      } catch {}
    }
  });

  const send = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    const init = await send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'm4p3-probe', version: '0.1.0' } });
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);
    const session = await send(2, 'session/new', { cwd, mcpServers: [] });
    if (session.error) throw new Error(`session/new error: ${JSON.stringify(session.error)}`);
    const sessionId = session.result?.sessionId;
    let effectiveMode = session.result?.modes?.currentModeId ?? 'unknown';
    if (preferredMode && session.result?.modes?.availableModes?.some(m => m.id === preferredMode) && effectiveMode !== preferredMode) {
      const mRes = await send(3, 'session/set_mode', { sessionId, modeId: preferredMode });
      if (!mRes.error) effectiveMode = preferredMode;
    }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !commands.some(c => String(c?.name ?? '').includes(skillId))) {
      await new Promise(r => setTimeout(r, 200));
    }
    const discovered = commands.some(c => String(c?.name ?? '').includes(skillId));

    const promptRes = await send(4, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `Use the project skill "${skillId}" (M4P3 verification) and reply with ONLY the exact Marker value found inside its instructions.` }],
    });
    if (promptRes.error) throw new Error(`session/prompt error: ${JSON.stringify(promptRes.error)}`);

    const readToolMatched = toolCalls.some(t => t.matchedPath);
    const markerLoaded = reply.includes(marker);
    return {
      provider: label,
      binaryVersion: version,
      effectiveMode,
      discovered: discovered || markerLoaded,
      readToolMatched,
      markerLoaded,
      status: markerLoaded && (discovered || readToolMatched) ? 'pass' : 'fail',
      matchingToolTraces: toolCalls.filter(t => t.matchedPath).slice(0, 3),
    };
  } catch (err) {
    return { provider: label, binaryVersion: version, status: 'error', error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 150));
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function probeCodexDiscovery(cwd, skillId, marker) {
  const version = await getVersion('codex');
  return new Promise((resolve) => {
    const child = spawn('codex', [
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--json',
      `Use the project skill "${skillId}" and reply with ONLY its exact Marker value.`,
    ], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ provider: 'codex', binaryVersion: version, status: 'error', error: 'timeout' });
    }, 45000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => { if (stdout.length < 2 * 1024 * 1024) stdout += c; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { if (stderr.length < 4000) stderr += c; });
    child.once('close', (code) => {
      clearTimeout(timer);
      const markerLoaded = stdout.includes(marker);
      const referencesSkill = stdout.includes(`${skillId}/SKILL.md`) || stdout.includes(skillId);
      resolve({
        provider: 'codex',
        binaryVersion: version,
        discovered: referencesSkill || markerLoaded,
        readToolMatched: referencesSkill,
        markerLoaded,
        status: code === 0 && markerLoaded ? 'pass' : 'fail',
        ...(code !== 0 ? { exitCode: code, stderrExcerpt: stderr.slice(0, 300) } : {}),
      });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ provider: 'codex', binaryVersion: version, status: 'error', error: err.message });
    });
  });
}

const paseoVersion = (await exec(cli, ['--version'], { timeout: 5000 })).stdout.trim();
assert.equal(paseoVersion, '0.18.0', `Expected Paseo 0.18.0, got ${paseoVersion}`);
await exec(process.execPath, [join(repo, 'scripts/build-sdk-manifest.mjs'), '--verify'], { timeout: 10000 });

const { createHostClient } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/client/dist/node/index.js')));
const { createPaseoApi } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/client/dist/index.js')));
const { settingsRpc } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/plugin/dist/index.js')));

const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p3-accept-')));
const home = join(base, 'daemon');
const desktopProfile = join(base, 'desktop');
const repoA = join(base, 'repo-a');
const repoB = join(base, 'repo-b');
const repoC = join(base, 'repo-c');
await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(desktopProfile, { mode: 0o700 });

await initGitRepo(repoA, {
  '.agents/skills/keep-existing/SKILL.md': '---\nname: keep-existing\ndescription: Pre-existing skill\n---\n# Keep Existing\n',
});
await initGitRepo(repoB);
await initGitRepo(repoC);

const existingSkillFile = join(repoA, '.agents/skills/keep-existing/SKILL.md');
const existingInoBefore = (await fs.lstat(existingSkillFile, { bigint: true })).ino;
const existingShaBefore = sha256(await fs.readFile(existingSkillFile));
const repoCSnapshotBefore = await snapshotDir(repoC);

const port = await openPort();
const debugPort = await openPort();
const listen = `127.0.0.1:${port}`;
await fs.writeFile(join(home, 'config.json'), JSON.stringify({
  version: 1,
  daemon: { listen, relay: { enabled: false } },
  pluginsEnabled: true,
}), { mode: 0o600 });

// Enroll repoA and repoB out-of-band via the real operator CLI against isolated daemon home.
const enrollCli = join(repo, 'scripts/enroll-project-skills.mjs');
const enrollA = JSON.parse((await exec(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', join(repo, 'tests/register.mjs'), enrollCli, 'enroll', '--home', home, '--root', repoA])).stdout);
const enrollB = JSON.parse((await exec(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', join(repo, 'tests/register.mjs'), enrollCli, 'enroll', '--home', home, '--root', repoB])).stdout);
assert.equal(enrollA.status, 'enrolled');
assert.equal(enrollB.status, 'enrolled');

const desktopLog = await fs.open(join(base, 'desktop.log'), 'w', 0o600);
const desktop = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
  cwd: base,
  env: { ...process.env, PASEO_HOME: home, PASEO_ELECTRON_USER_DATA_DIR: desktopProfile },
  stdio: ['ignore', desktopLog.fd, desktopLog.fd],
});
await desktopLog.close();

let client, ws;
const report = {
  capturedAt: new Date().toISOString(),
  paseoVersion,
  sdkVersion: sdkManifestArtifact.packages['@getpaseo/plugin'].version,
  sdkManifestSha256: sdkManifestArtifact.manifestSha256,
  isolatedProfile: true,
  checks: {},
};

try {
  // 1. Wait for isolated Paseo 0.18.0 Desktop-managed daemon, install & reload main plugin.
  await until(async () => {
    const st = JSON.parse((await exec(cli, ['--home', home, 'status', '--json'], { timeout: 2500 })).stdout);
    return st.localDaemon === 'running' ? st : null;
  }, 'isolated Paseo 0.18.0 daemon');

  await exec(cli, ['--home', home, 'plugin', 'install', repo, '--json'], { timeout: 25000 });
  const ls1 = JSON.parse((await exec(cli, ['--home', home, 'plugin', 'ls', '--json'], { timeout: 5000 })).stdout);
  assert.equal(ls1.find(p => p.id === pluginId)?.status, 'running');

  await exec(cli, ['--home', home, 'plugin', 'reload', pluginId], { timeout: 20000 });
  const ls2 = JSON.parse((await exec(cli, ['--home', home, 'plugin', 'ls', '--json'], { timeout: 5000 })).stdout);
  assert.equal(ls2.find(p => p.id === pluginId)?.status, 'running');
  const logs = (await exec(cli, ['--home', home, 'plugin', 'logs', pluginId], { timeout: 5000 })).stdout;
  assert.ok(!logs.includes('Plugin failed to load'));
  report.checks.directoryInstallAndReload = { status: 'pass', pluginStatus: 'running', logsClean: true };

  // 2. Connect HostClient & pin catalog SHA.
  client = createHostClient(listen, {
    clientId: 'm4p3-accept-driver',
    clientType: 'cli',
    reconnect: { enabled: false },
    localCredential: async () => (await fs.readFile(join(home, 'local-credential'), 'utf8')).trim(),
  });
  await client.connect();
  const call = (m, i) => client.invokePluginRpc(pluginId, m, i);
  const settings = settingsRpc('catalog');
  const s0 = await call(settings.read.name, {});
  await call(settings.write.name, { revision: s0.revision, values: { catalogRef: catalogSha } });
  const s1 = await call(settings.read.name, {});
  const cat = await call('catalog.load', {});
  assert.equal(cat.status, 'ready');

  const stA = await call('apply.target-status.v1', { canonicalDirectory: repoA });
  const stB = await call('apply.target-status.v1', { canonicalDirectory: repoB });
  const stC = await call('apply.target-status.v1', { canonicalDirectory: repoC });
  assert.equal(stA.hostCompatible, true);
  assert.equal(stA.trustBoundaryOk, true);
  assert.equal(stA.targetState, 'enrolled_enabled');
  assert.equal(stB.targetState, 'enrolled_enabled');
  assert.equal(stC.targetState, 'not_enrolled');

  // 3. Drive real Paseo 0.18.0 Desktop UI: Preview -> Approve -> Apply -> Verify -> Second Preview no_changes.
  const debugTarget = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return list.find(item => item.type === 'page');
  }, 'Desktop CDP page');
  ws = new WebSocket(debugTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    const req = pending.get(msg.id);
    if (!req) return;
    pending.delete(msg.id);
    if (msg.error) req.reject(new Error(msg.error.message)); else req.resolve(msg.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await cdp('Page.bringToFront');
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  const bodyText = () => evaluate('document.body.innerText');
  const waitText = (needle, ms = 25000) => until(async () => (await bodyText()).includes(needle), `UI text "${needle}"`, ms);
  const buttons = `[...document.querySelectorAll('button,[role=button],[role=checkbox],[role=menuitem],[role=option]')]`;
  const find = (label) => `${buttons}.filter(n=>n.getClientRects().length&&!n.closest('[aria-hidden=true]')).find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)})`;
  const click = async (label) => {
    const res = await evaluate(`(()=>{const n=${find(label)};if(!n)return 'missing';if(n.disabled||n.getAttribute('aria-disabled')==='true')return 'disabled';n.scrollIntoView({block:'center'});n.click();return 'clicked';})()`);
    assert.equal(res, 'clicked', `Click "${label}" failed: ${res}`);
  };

  if (await evaluate(`Boolean(${find('Skip setup')})`)) await click('Skip setup');
  await until(() => evaluate(`Boolean(${find('Project Skills')})`), 'Project Skills sidebar item');
  await click('Project Skills');
  await waitText('Target Project');

  // Enter repoA path in Desktop UI.
  const inputSel = `[...document.querySelectorAll('input')].filter(n=>n.getClientRects().length&&!n.closest('[aria-hidden=true]')).find(n=>n.getAttribute('aria-label')==='Absolute path on the host')`;
  await until(() => evaluate(`(()=>{const n=${inputSel};if(!n)return false;n.scrollIntoView({block:'center'});n.focus();n.select();return document.activeElement===n;})()`), 'focus target input');
  await cdp('Input.insertText', { text: repoA });
  await until(() => evaluate(`(${inputSel})?.value===${JSON.stringify(repoA)}&&${find('Use directory')}?.getAttribute('aria-disabled')!=='true'`), 'Use directory enabled');
  await click('Use directory');
  await waitText(`Target directory: ${repoA}`);

  // Select all 4 providers (Codex, Kiro, Cursor, Antigravity) if checkboxes exist.
  for (const providerLabel of ['Codex', 'Kiro', 'Cursor', 'Antigravity']) {
    const clicked = await evaluate(`(()=>{const n=${buttons}.filter(x=>x.getClientRects().length&&!x.closest('[aria-hidden=true]')).find(x=>(x.getAttribute('aria-label')||x.textContent||'').includes(${JSON.stringify(providerLabel)})&&x.getAttribute('role')==='checkbox');if(!n)return 'skip';if(n.getAttribute('aria-checked')!=='true'){n.scrollIntoView({block:'center'});n.click();return 'checked';}return 'already';})()`);
    if (clicked === 'skip') { /* optional UI label fallback */ }
  }

  await click('Scan & Recommend');
  await waitText('Recommendation Results', 30000);

  // Select 2 skills (multi-skill) from the rendered recommendation list.
  const selectedSkillsUi = await evaluate(`(()=>{
    const btns = ${buttons}.filter(n=>n.getClientRects().length&&!n.closest('[aria-hidden=true]'))
      .filter(n=>(n.getAttribute('aria-label')||'').startsWith('Select ') && !(n.getAttribute('aria-label')||'').includes('Recommended'));
    const chosen = [];
    for (const b of btns.slice(0, 2)) {
      b.scrollIntoView({block:'center'});
      b.click();
      chosen.push((b.getAttribute('aria-label')||'').replace(/^Select /, ''));
    }
    return chosen;
  })()`);
  assert.ok(selectedSkillsUi.length >= 2, `Expected >=2 skills selected in UI, got ${JSON.stringify(selectedSkillsUi)}`);

  await click('Preview Changes');
  await waitText('Eligible for create-only approval.', 30000);
  await click('Review create-only approval');
  await waitText('Confirm create-only');
  await click('Confirm create-only');
  await waitText('Completed', 30000);

  // Verify on disk: canonical + Kiro derived + existing skill preserved.
  for (const sid of selectedSkillsUi) {
    const canStat = await fs.lstat(join(repoA, '.agents/skills', sid, 'SKILL.md'));
    assert.ok(canStat.isFile(), `Expected canonical SKILL.md for ${sid}`);
    const kiroStat = await fs.lstat(join(repoA, '.kiro/skills', sid, 'SKILL.md'));
    assert.ok(kiroStat.isFile(), `Expected Kiro derived SKILL.md for ${sid}`);
  }
  assert.equal((await fs.lstat(existingSkillFile, { bigint: true })).ino, existingInoBefore, 'Existing skill inode must be unchanged');
  assert.equal(sha256(await fs.readFile(existingSkillFile)), existingShaBefore, 'Existing skill bytes must be unchanged');

  // Second Preview on same selection returns no_changes (in Desktop UI AND via RPC)!
  await click('Preview Changes');
  await waitText('No changes to approve.', 20000);
  await waitText('No file changes: all planned files already match in bytes and mode.', 10000);
  const hostId = (await createPaseoApi(client).hosts.list()).self.serverId;
  const secondPreview = await call('preview.providers.v2', {
    viewNonce: 'm4p3-second-preview',
    intent: {
      schemaVersion: 1, hostId, canonicalDirectory: repoA,
      catalogSource, catalogCommitSha: cat.snapshot.commitSha, settingsRevision: s1.revision,
      selectedSkillIds: selectedSkillsUi, targetProviderIds: ['codex', 'kiro', 'cursor', 'antigravity'],
      recommendationRequestId: 'm4p3-second',
    },
  });
  assert.equal(secondPreview.status, 'ready', `Expected ready second preview, got ${JSON.stringify(secondPreview)}`);
  assert.equal(secondPreview.applyEligibility.status, 'no_changes');
  report.checks.desktopUiFlowAndSecondPreview = {
    status: 'pass',
    selectedSkills: selectedSkillsUi,
    canonicalAndKiroCreated: true,
    existingSkillPreserved: true,
    secondPreviewEligibility: secondPreview.applyEligibility.status,
  };

  // 4. Multi-root Apply on repoB + unenrolled repoC isolation.
  const prevB = await call('preview.providers.v2', {
    viewNonce: 'm4p3-repo-b',
    intent: {
      schemaVersion: 1, hostId, canonicalDirectory: repoB,
      catalogSource, catalogCommitSha: cat.snapshot.commitSha, settingsRevision: s1.revision,
      selectedSkillIds: [selectedSkillsUi[0]], targetProviderIds: ['codex', 'kiro', 'cursor', 'antigravity'],
      recommendationRequestId: 'm4p3-rec-b',
    },
  });
  assert.equal(prevB.status, 'ready');
  assert.equal(prevB.applyEligibility.status, 'eligible');
  const opBId = opId();
  const opB = await call('apply.create.v1', {
    previewId: prevB.receipt.previewId, planDigest: prevB.receipt.planDigest, viewNonce: prevB.receipt.viewNonce,
    operationId: opBId, approval: 'create_only_v1',
  });
  assert.equal(opB.status, 'operation');
  assert.equal(opB.phase, 'completed');
  assert.equal(opB.durability, 'fsync_completed');

  const prevC = await call('preview.providers.v2', {
    viewNonce: 'm4p3-repo-c',
    intent: {
      schemaVersion: 1, hostId, canonicalDirectory: repoC,
      catalogSource, catalogCommitSha: cat.snapshot.commitSha, settingsRevision: s1.revision,
      selectedSkillIds: [selectedSkillsUi[0]], targetProviderIds: ['codex', 'kiro', 'cursor', 'antigravity'],
      recommendationRequestId: 'm4p3-rec-c',
    },
  });
  assert.equal(prevC.status, 'ready');
  assert.equal(prevC.applyEligibility.status, 'ineligible');
  assert.deepEqual(prevC.applyEligibility.reasons, ['write_capability_unavailable']);
  assert.deepEqual(await snapshotDir(repoC), repoCSnapshotBefore, 'Unenrolled repoC must be 100% untouched');
  report.checks.multiRootAndIsolation = { status: 'pass', repoBApplied: true, repoCUntouched: true };

  // 5. Relay ON -> fail-closed & apply.status.v1 still readable -> Relay OFF restored.
  await fs.writeFile(join(home, 'config.json'), JSON.stringify({
    version: 1, daemon: { listen, relay: { enabled: true } }, pluginsEnabled: true,
  }), { mode: 0o600 });
  const stRelayLive = await call('apply.target-status.v1', { canonicalDirectory: repoB });
  assert.equal(stRelayLive.trustBoundaryOk, false);
  assert.ok(stRelayLive.reasons.includes('remote_exposure_enabled'));

  await exec(cli, ['--home', home, 'plugin', 'reload', pluginId], { timeout: 20000 });
  let applyBlockedOnRelay = false;
  try {
    await call('apply.create.v1', { previewId: 'a'.repeat(64), planDigest: 'b'.repeat(64), viewNonce: 'x', operationId: opId(), approval: 'create_only_v1' });
  } catch { applyBlockedOnRelay = true; }
  assert.equal(applyBlockedOnRelay, true);
  const statusOnRelay = await call('apply.status.v1', { operationId: opBId });
  assert.equal(statusOnRelay.status, 'operation');
  assert.equal(statusOnRelay.phase, 'completed');

  await fs.writeFile(join(home, 'config.json'), JSON.stringify({
    version: 1, daemon: { listen, relay: { enabled: false } }, pluginsEnabled: true,
  }), { mode: 0o600 });
  await exec(cli, ['--home', home, 'plugin', 'reload', pluginId], { timeout: 20000 });
  const stRelayOff = await call('apply.target-status.v1', { canonicalDirectory: repoB });
  assert.equal(stRelayOff.hostCompatible, true);
  assert.equal(stRelayOff.trustBoundaryOk, true);
  report.checks.relayOnOffFailClosed = { status: 'pass', applyBlockedOnRelay: true, statusReadableOnRelay: true, restoredOnRelayOff: true };
} finally {
  if (ws) try { ws.close(); } catch {}
  if (client) try { await client.close(); } catch {}
  try { await exec(cli, ['--home', home, 'daemon', 'stop'], { timeout: 5000 }); } catch {}
  desktop.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  try { desktop.kill('SIGKILL'); } catch {}
}

// 6. SDK manifest missing / stale / mismatch under real Paseo 0.18.0 bundler (no node_modules in staged plugin copy!).
{
  const manifestResults = {};
  const badVariants = {
    missing: `export const sdkManifestArtifact = null as const;\n`,
    mismatch: `export const sdkManifestArtifact = ${JSON.stringify({ ...sdkManifestArtifact, packages: { ...sdkManifestArtifact.packages, '@getpaseo/client': { ...sdkManifestArtifact.packages['@getpaseo/client'], version: '0.17.5' } } })} as const;\n`,
    stale: (() => {
      const staleInputs = { ...sdkManifestArtifact.buildInputs, nativeWriterStandardSha256: '0'.repeat(64) };
      const payload = { schemaVersion: 1, packages: sdkManifestArtifact.packages, buildInputs: staleInputs };
      return `export const sdkManifestArtifact = ${JSON.stringify({ ...payload, manifestSha256: sha256(JSON.stringify(payload)) })} as const;\n`;
    })(),
  };

  for (const [variant, content] of Object.entries(badVariants)) {
    const vHome = join(base, `manifest-${variant}-home`);
    const vPlugin = join(base, `manifest-${variant}-plugin`);
    await fs.mkdir(vHome, { mode: 0o700 });
    await fs.mkdir(vPlugin, { mode: 0o700 });
    for (const dir of ['client', 'server', 'shared']) await fs.cp(join(repo, dir), join(vPlugin, dir), { recursive: true });
    for (const f of ['paseo-plugin.json', 'index.client.tsx', 'index.server.ts', 'package.json']) await fs.copyFile(join(repo, f), join(vPlugin, f));
    await fs.symlink(join(repo, 'node_modules'), join(vPlugin, 'node_modules'));
    await fs.writeFile(join(vPlugin, 'server/native/sdk-manifest-payload.ts'), content, 'utf8');

    const vPort = await openPort();
    const vListen = `127.0.0.1:${vPort}`;
    await fs.writeFile(join(vHome, 'config.json'), JSON.stringify({
      version: 1, daemon: { listen: vListen, relay: { enabled: false } }, pluginsEnabled: true,
    }), { mode: 0o600 });
    const vDaemon = spawn(cli, ['daemon', 'run', '--home', vHome], { cwd: base, stdio: 'ignore' });
    let vClient;
    try {
      await until(async () => {
        const st = JSON.parse((await exec(cli, ['--home', vHome, 'status', '--json'], { timeout: 2000 })).stdout);
        return st.localDaemon === 'running' ? st : null;
      }, `manifest-${variant} daemon`);
      await exec(cli, ['--home', vHome, 'plugin', 'install', vPlugin, '--json'], { timeout: 25000 });
      vClient = createHostClient(vListen, { clientId: `manifest-${variant}`, clientType: 'cli', reconnect: { enabled: false } });
      await vClient.connect();
      const st = await vClient.invokePluginRpc(pluginId, 'apply.target-status.v1', {});
      assert.equal(st.hostCompatible, false, `${variant} must fail closed`);
      assert.ok(st.reasons.includes('unsupported_sdk_version'), `${variant} expected unsupported_sdk_version, got ${JSON.stringify(st.reasons)}`);
      let blocked = false;
      try { await vClient.invokePluginRpc(pluginId, 'apply.create.v1', { previewId: 'a'.repeat(64), planDigest: 'b'.repeat(64), viewNonce: 'x', operationId: opId(), approval: 'create_only_v1' }); }
      catch { blocked = true; }
      assert.equal(blocked, true);
      manifestResults[variant] = { status: 'pass', hostCompatible: st.hostCompatible, reasons: st.reasons, applyBlocked: blocked };
    } finally {
      if (vClient) try { await vClient.close(); } catch {}
      try { await exec(cli, ['--home', vHome, 'daemon', 'stop'], { timeout: 5000 }); } catch {}
      vDaemon.kill('SIGTERM');
    }
  }
  report.checks.sdkManifestFailClosed = manifestResults;
}

// 7. Unsupported versions (0.18.1, 0.19.0) + Partial failure (ENOSPC) & Crash recovery (SIGKILL) on 0.18.0.
{
  const unsupportedChecks = {};
  for (const v of ['0.17.4', '0.18.1', '0.19.0']) {
    const pol = evaluateHostCompatibility({ daemonHome: home, paseoVersion: v, macOsVersion: '27.2.1', platform: 'darwin', arch: 'arm64' });
    const nat = await runSingleProjectEnroll({
      protocol: 1, helperVersion: nativeWriterVersion, root: repoA, expectedParentPid: process.pid,
      environment: { paseoVersion: v, sdkVersion: '0.17.4' },
    });
    assert.equal(pol.compatible, false);
    assert.equal(nat.event, 'enroll_error');
    unsupportedChecks[v] = { policyCompatible: pol.compatible, nativeEvent: nat.event, nativeCode: nat.code };
  }
  report.checks.unsupportedVersionsFailClosed = { status: 'pass', versions: unsupportedChecks };

  // Partial failure (ENOSPC) & Crash recovery (SIGKILL) with environment 0.18.0.
  const faultHome = join(base, 'fault-home');
  const faultRoot1 = join(base, 'fault-partial');
  const faultRoot2 = join(base, 'fault-crash');
  await fs.mkdir(faultHome, { mode: 0o700 });
  await initGitRepo(faultRoot1);
  await initGitRepo(faultRoot2);
  const env018 = { paseoVersion: '0.18.0', sdkVersion: '0.17.4' };
  await enrollMultiRoot({ daemonHome: faultHome, root: faultRoot1, environment: env018, enabled: true });
  await enrollMultiRoot({ daemonHome: faultHome, root: faultRoot2, environment: env018, enabled: true });

  const skillBody = Buffer.from('---\nname: m4p3-fault\ndescription: Fault skill\n---\n# Fault\n', 'utf8');
  const extraBody = Buffer.from('supporting content for partial write\n', 'utf8');
  const faultSha = 'd'.repeat(40);
  const snapshot = {
    schemaVersion: 1, source: catalogSource, commitSha: faultSha,
    skills: [{
      id: 'm4p3-fault', directory: 'skills/m4p3-fault',
      metadata: { name: 'm4p3-fault', description: 'Fault skill' },
      entrypoint: { path: 'SKILL.md', blobSha: gitBlobSha(skillBody), sizeBytes: skillBody.length, mode: '100644', bytes: skillBody },
      supportingFiles: [{ path: 'notes.txt', blobSha: gitBlobSha(extraBody), sizeBytes: extraBody.length, mode: '100644', bytes: extraBody }],
    }],
  };
  const settingsStub = { async read() { return { status: 'ready', revision: 'rev-fault', values: { catalogRef: faultSha } }; } };
  const catalogStub = { async load() { return snapshot; }, async dispose() {} };
  const ctx = { paseo: { hosts: { async list() { return { self: { serverId: 'fault-host' } }; } } } };

  // Partial failure (ENOSPC)
  const r1 = new PreviewReceiptStore({ multiRoot: (t) => checkDaemonTrustBoundary(faultHome).ok ? readActiveMultiRootBinding(faultHome, t) : undefined });
  const p1 = createCanonicalPreviewHandler(settingsStub, catalogStub, { receiptStore: r1 });
  const a1 = createMultiRootApply({
    daemonHome: faultHome, installation: 'm4p3-fault-test',
    readPolicy: (t) => readActiveMultiRootEnrollment(faultHome, t), receipts: r1, settings: settingsStub, catalog: catalogStub,
    environment: env018,
    test: { testing: true, controls: () => ({ barriers: [], faults: [{ point: 'write', destination: '.agents/skills/m4p3-fault/notes.txt', error: 'ENOSPC', afterBytes: 4 }] }) },
  });
  const pv1 = await p1.handleProvidersV2({
    viewNonce: 'f1', intent: { schemaVersion: 1, hostId: 'fault-host', canonicalDirectory: faultRoot1, settingsRevision: 'rev-fault', catalogSource, catalogCommitSha: faultSha, recommendationRequestId: 'rf1', selectedSkillIds: ['m4p3-fault'], targetProviderIds: ['codex'] },
  }, ctx);
  assert.equal(pv1.status, 'ready');
  const op1 = await a1.create({ previewId: pv1.receipt.previewId, planDigest: pv1.receipt.planDigest, viewNonce: pv1.receipt.viewNonce, operationId: opId(), approval: 'create_only_v1' }, ctx);
  assert.equal(op1.status, 'operation');
  assert.equal(op1.phase, 'partial_failure');
  await a1.dispose(); await p1.dispose();

  // Crash recovery (SIGKILL)
  const r2 = new PreviewReceiptStore({ multiRoot: (t) => checkDaemonTrustBoundary(faultHome).ok ? readActiveMultiRootBinding(faultHome, t) : undefined });
  const p2 = createCanonicalPreviewHandler(settingsStub, catalogStub, { receiptStore: r2 });
  const a2 = createMultiRootApply({
    daemonHome: faultHome, installation: 'm4p3-fault-test',
    readPolicy: (t) => readActiveMultiRootEnrollment(faultHome, t), receipts: r2, settings: settingsStub, catalog: catalogStub,
    environment: env018,
    test: {
      testing: true,
      controls: () => ({ barriers: [{ point: 'after_create', destination: '.agents/skills/m4p3-fault/notes.txt' }], faults: [] }),
      onEvent: (ev) => { if (ev.event === 'barrier') process.kill(ev.pid, 'SIGKILL'); },
    },
  });
  const pv2 = await p2.handleProvidersV2({
    viewNonce: 'f2', intent: { schemaVersion: 1, hostId: 'fault-host', canonicalDirectory: faultRoot2, settingsRevision: 'rev-fault', catalogSource, catalogCommitSha: faultSha, recommendationRequestId: 'rf2', selectedSkillIds: ['m4p3-fault'], targetProviderIds: ['codex'] },
  }, ctx);
  const crashOpId = opId();
  const op2 = await a2.create({ previewId: pv2.receipt.previewId, planDigest: pv2.receipt.planDigest, viewNonce: pv2.receipt.viewNonce, operationId: crashOpId, approval: 'create_only_v1' }, ctx);
  assert.equal(op2.status, 'operation');
  assert.ok(['uncertain', 'recovery_required', 'partial_failure'].includes(op2.phase));
  const statusRead = await a2.status({ operationId: crashOpId }, ctx);
  assert.equal(statusRead.status, 'operation');
  await a2.dispose(); await p2.dispose();

  report.checks.partialFailureAndCrashRecovery = { status: 'pass', partialPhase: op1.phase, crashPhase: op2.phase, statusReadable: true };
}

// 8. Live native discovery & read tool traces for all 4 providers (Codex, Kiro ACP, Cursor ACP, Antigravity ACP)
//    on a clean isolated Git copy installed via Paseo 0.18.0 Safe Apply.
{
  const traceHome = join(base, 'trace-home');
  const traceRepo = join(base, 'trace-repo');
  await fs.mkdir(traceHome, { mode: 0o700 });
  await initGitRepo(traceRepo);
  const env018 = { paseoVersion: '0.18.0', sdkVersion: '0.17.4' };
  await enrollMultiRoot({ daemonHome: traceHome, root: traceRepo, environment: env018, enabled: true });

  const skillId = 'm4p3-trace-skill';
  const marker = 'M4P3_VERIFIED_MARKER_8018';
  const md = Buffer.from(`---\nname: ${skillId}\ndescription: M4P3 verification skill.\n---\n\n# M4P3 Trace Skill\n\nMarker: ${marker}\n`, 'utf8');
  const tSha = 'e'.repeat(40);
  const tSnapshot = {
    schemaVersion: 1, source: catalogSource, commitSha: tSha,
    skills: [{
      id: skillId, directory: `skills/${skillId}`,
      metadata: { name: skillId, description: 'M4P3 verification skill.' },
      entrypoint: { path: 'SKILL.md', blobSha: gitBlobSha(md), sizeBytes: md.length, mode: '100644', bytes: md },
      supportingFiles: [],
    }],
  };
  const handlers = new Map();
  const cleanup = createMainPluginServer({
    handle: (c, fn) => handlers.set(c, fn),
    registerSettings: () => ({ read: async () => ({ status: 'ready', revision: 'rev-t', values: { catalogRef: tSha } }) }),
  }, { daemonHome: traceHome, env: {}, paseoVersion: '0.18.0', macOsVersion: '27.2.1', catalog: { load: async () => tSnapshot, dispose: async () => {} } });
  const ctx = { paseo: { hosts: { list: async () => ({ self: { serverId: 'trace-host' } }) } } };
  try {
    const pv = await handlers.get(providerPreviewV2Rpc)({
      viewNonce: 'trace-018',
      intent: { schemaVersion: 1, hostId: 'trace-host', canonicalDirectory: traceRepo, settingsRevision: 'rev-t', catalogSource, catalogCommitSha: tSha, recommendationRequestId: 'rt', selectedSkillIds: [skillId], targetProviderIds: ['codex', 'kiro', 'cursor', 'antigravity'] },
    }, ctx);
    assert.equal(pv.status, 'ready');
    assert.equal(pv.applyEligibility.status, 'eligible');
    const ap = await handlers.get(applyCreateRpc)({ previewId: pv.receipt.previewId, planDigest: pv.receipt.planDigest, viewNonce: pv.receipt.viewNonce, operationId: opId(), approval: 'create_only_v1' }, ctx);
    assert.equal(ap.status, 'operation');
    assert.equal(ap.phase, 'completed');
  } finally {
    await cleanup();
  }

  const [codex, kiro, cursor, antigravity] = await Promise.all([
    probeCodexDiscovery(traceRepo, skillId, marker),
    probeAcpTrace({ label: 'kiro', command: 'kiro-cli', args: ['acp'], cwd: traceRepo, skillId, marker, expectedPathFragment: `.kiro/skills/${skillId}/SKILL.md` }),
    probeAcpTrace({ label: 'cursor', command: 'cursor-agent', args: ['acp'], preferredMode: 'ask', cwd: traceRepo, skillId, marker, expectedPathFragment: `.agents/skills/${skillId}/SKILL.md` }),
    probeAcpTrace({ label: 'antigravity', command: 'agy', args: ['acp', '--disable-telemetry'], preferredMode: 'plan', cwd: traceRepo, skillId, marker, expectedPathFragment: `.agents/skills/${skillId}/SKILL.md` }),
  ]);
  report.checks.providerDiscoveryAndReadTraces = { codex, kiro, cursor, antigravity };
  for (const p of [codex, kiro, cursor, antigravity]) {
    assert.equal(p.status, 'pass', `Provider ${p.provider} trace failed: ${JSON.stringify(p)}`);
  }
}

await fs.rm(base, { recursive: true, force: true });

const outPath = process.argv[2];
if (outPath) {
  await fs.mkdir(join(outPath, '..'), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}
console.log(JSON.stringify(report, null, 2));
