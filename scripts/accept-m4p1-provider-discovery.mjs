// Isolated M4.P1 provider native discovery acceptance on an independent temporary Git copy.
// Installs 3 skills (canonical .agents/skills + derived .kiro/skills) via createMultiRootApply,
// then verifies native discovery for Codex, Kiro ACP, Cursor ACP, and Antigravity ACP.
// Never touches any real project or ~/.paseo.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { enrollMultiRoot, readActiveMultiRootBinding, readActiveMultiRootEnrollment } from '../server/multi-root-policy.ts';
import { checkDaemonTrustBoundary } from '../server/compatibility-policy.ts';
import { createCanonicalPreviewHandler } from '../server/canonical-preview.ts';
import { PreviewReceiptStore } from '../server/preview-receipts.ts';
import { createMultiRootApply } from '../server/fixture-apply.ts';
import { catalogSource } from '../shared/catalog-settings.ts';

const exec = promisify(execFile);
const sha = 'c'.repeat(40);
const hostId = 'm4p1-discovery-host';
const settingsRevision = 'rev-m4p1-disc';
const environment = { paseoVersion: '0.17.5', sdkVersion: '0.17.4' };
const gitBlobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function makeSkill(id, marker, extra = {}) {
  const md = `---\nname: ${id}\ndescription: M4.P1 isolated verification skill (${id}).\n---\n\n# ${id}\n\nMarker: ${marker}\n`;
  const entryBytes = Buffer.from(md, 'utf8');
  const supportingFiles = Object.entries(extra).map(([path, spec]) => {
    const bytes = Buffer.from(typeof spec === 'string' ? spec : spec.content, 'utf8');
    const mode = typeof spec === 'string' ? '100644' : spec.mode;
    return { path, blobSha: gitBlobSha(bytes), sizeBytes: bytes.length, mode, bytes };
  });
  return {
    id,
    directory: `skills/${id}`,
    metadata: { name: id, description: `M4.P1 isolated verification skill (${id}).` },
    entrypoint: { path: 'SKILL.md', blobSha: gitBlobSha(entryBytes), sizeBytes: entryBytes.length, mode: '100644', bytes: entryBytes },
    supportingFiles,
  };
}

async function getVersion(cmd, args = ['--version']) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: 5000 });
    return (stdout || stderr).trim().split('\n')[0];
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function probeAcpDiscovery(label, command, args, cwd, expectedIds, timeoutMs = 25000) {
  const version = await getVersion(command);
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  let buf = '';
  const notifications = [];
  const responses = new Map();
  const waiters = new Map();
  let stderr = '';

  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 4000); });
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
          responses.set(msg.id, msg);
          const w = waiters.get(msg.id);
          if (w) { waiters.delete(msg.id); w(msg); }
        } else {
          notifications.push(msg);
        }
      } catch { /* ignore non-JSON log lines */ }
    }
  });

  const send = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    const init = await send(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'm4p1-discovery-probe', version: '0.1.0' },
    });
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);

    const session = await send(2, 'session/new', { cwd, mcpServers: [] });
    if (session.error) throw new Error(`session/new error: ${JSON.stringify(session.error)}`);

    // Wait for asynchronous available_commands_update notifications (kiro-cli can take ~8-10s).
    const deadline = Date.now() + 12000;
    const extractCommands = () => {
      const found = [];
      for (const n of notifications) {
        const upd = n?.params?.update;
        if (upd?.sessionUpdate === 'available_commands_update' && Array.isArray(upd.availableCommands)) {
          for (const c of upd.availableCommands) found.push(c);
        }
        if (Array.isArray(n?.params?.availableCommands)) {
          for (const c of n.params.availableCommands) found.push(c);
        }
        if (Array.isArray(n?.params?.commands)) {
          for (const c of n.params.commands) found.push(c);
        }
      }
      return found;
    };
    const cmdName = (c) => typeof c === 'string' ? c : String(c?.name ?? c?.command ?? c?.id ?? c?.title ?? '');
    let commands = extractCommands();
    while (Date.now() < deadline && !expectedIds.every(id => commands.some(c => { const n = cmdName(c); return n === id || n === `/${id}` || n.includes(id); }))) {
      await new Promise(r => setTimeout(r, 250));
      commands = extractCommands();
    }

    const matched = expectedIds.filter(id => commands.some(c => { const n = cmdName(c); return n === id || n === `/${id}` || n.includes(id); }));
    const sampleKeys = commands.length > 0 && typeof commands[0] === 'object' ? Object.keys(commands[0]) : [];
    const matchedDetails = commands.filter(c => expectedIds.some(id => cmdName(c).includes(id))).map(c => ({ name: cmdName(c), kind: c?.kind ?? c?.type ?? c?.category }));
    return {
      provider: label,
      command: [command, ...args].join(' '),
      binaryVersion: version,
      status: matched.length === expectedIds.length ? 'pass' : 'fail',
      discoveredCount: matched.length,
      expectedCount: expectedIds.length,
      matchedSkills: matched,
      matchedDetails,
      totalCommandsReported: commands.length,
      ...(matched.length === 0 ? { sampleKeys } : {}),
      notificationMethods: [...new Set(notifications.map(n => n.method || n?.params?.update?.sessionUpdate).filter(Boolean))],
    };
  } catch (err) {
    return {
      provider: label,
      command: [command, ...args].join(' '),
      binaryVersion: version,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      stderrExcerpt: stderr.slice(0, 300),
    };
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 150));
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function probeKiroDiscovery(cwd, expectedIds, timeoutMs = 30000) {
  const version = await getVersion('kiro-cli');
  const child = spawn('kiro-cli', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  let buf = '';
  const waiters = new Map();
  let reply = '';
  const readPaths = [];
  let stderr = '';

  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 4000); });
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
          if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.text) reply += u.content.text;
          if ((u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') && Array.isArray(u.locations)) {
            for (const loc of u.locations) {
              if (typeof loc?.path === 'string' && !readPaths.includes(loc.path)) readPaths.push(loc.path);
            }
          }
        }
      } catch { /* ignore */ }
    }
  });

  const send = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    const init = await send(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'm4p1-kiro-probe', version: '0.1.0' },
    });
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);
    const session = await send(2, 'session/new', { cwd, mcpServers: [] });
    if (session.error) throw new Error(`session/new error: ${JSON.stringify(session.error)}`);
    const sessionId = session.result?.sessionId;
    const mode = session.result?.modes?.currentModeId ?? 'unknown';

    const promptText = `Without scanning directories, list the names of the M4.P1 isolated verification skills currently loaded in your skill context, and read the Marker from m4p1-alpha. Reply concisely with the skill names and exact Marker.`;
    const promptRes = await send(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] });
    if (promptRes.error) throw new Error(`session/prompt error: ${JSON.stringify(promptRes.error)}`);

    const matched = expectedIds.filter(id => reply.includes(id));
    const readKiroDerived = readPaths.some(p => p.includes('.kiro/skills/m4p1-alpha/SKILL.md'));
    const markerLoaded = reply.includes('M4P1_ALPHA_OK');
    return {
      provider: 'kiro',
      command: 'kiro-cli acp',
      binaryVersion: version,
      mode,
      status: matched.length === expectedIds.length && markerLoaded && readKiroDerived ? 'pass' : 'fail',
      discoveredCount: matched.length,
      expectedCount: expectedIds.length,
      matchedSkills: matched,
      markerLoaded,
      readKiroDerived,
      readRelativePaths: readPaths.map(p => p.startsWith(cwd) ? p.slice(cwd.length + 1) : '<external>'),
      agentReplyExcerpt: reply.replaceAll(cwd, '<ISOLATED_FIXTURE_ROOT>').slice(0, 300),
    };
  } catch (err) {
    return {
      provider: 'kiro',
      command: 'kiro-cli acp',
      binaryVersion: version,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      stderrExcerpt: stderr.slice(0, 300),
    };
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise(r => setTimeout(r, 150));
    try { child.kill('SIGKILL'); } catch {}
  }
}

async function probeCodexDiscovery(cwd, expectedIds) {
  const version = await getVersion('codex');
  const prompt = `List which of these project skills are natively discovered in this workspace: ${expectedIds.join(', ')}. Read .agents/skills/${expectedIds[0]}/SKILL.md and return ONLY compact JSON: {"discovered":[...],"firstHeading":"..."}.`;
  return new Promise((resolve) => {
    const child = spawn('codex', ['exec', '--json', '--sandbox', 'read-only', '-C', cwd, prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 45000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8').slice(0, 1000); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const messages = lines.filter(l => l.type === 'item.completed' && l.item?.type === 'agent_message').map(l => l.item.text);
      const lastText = messages[messages.length - 1] ?? '';
      const matched = expectedIds.filter(id => lastText.includes(id));
      resolve({
        provider: 'codex',
        command: 'codex exec --json --sandbox read-only',
        binaryVersion: version,
        status: code === 0 && matched.length === expectedIds.length ? 'pass' : 'fail',
        exitCode: code,
        discoveredCount: matched.length,
        expectedCount: expectedIds.length,
        matchedSkills: matched,
        agentReplyExcerpt: lastText.slice(0, 300),
        ...(code !== 0 ? { stderrExcerpt: stderr.slice(0, 300) } : {}),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ provider: 'codex', command: 'codex exec --json --sandbox read-only', binaryVersion: version, status: 'error', error: err.message });
    });
  });
}

const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p1-discovery-')));
const daemonHome = join(base, 'daemon');
const project = join(base, 'repo-copy');
await fs.mkdir(daemonHome, { mode: 0o700 });
await fs.mkdir(project, { mode: 0o700 });

try {
  await exec('git', ['init', '-b', 'main', project]);
  await exec('git', ['-C', project, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', project, 'config', 'user.name', 'Test User']);
  await fs.writeFile(join(project, 'README.md'), '# M4.P1 Discovery Fixture\n');
  await exec('git', ['-C', project, 'add', 'README.md']);
  await exec('git', ['-C', project, 'commit', '-m', 'init']);

  const enrolled = await enrollMultiRoot({ daemonHome, root: project, environment, enabled: true });
  assert.equal(enrolled.status, 'enrolled');

  const skillIds = ['m4p1-alpha', 'm4p1-beta', 'm4p1-gamma'];
  const skills = [
    makeSkill('m4p1-alpha', 'M4P1_ALPHA_OK', { 'references/notes.md': '# Notes\n' }),
    makeSkill('m4p1-beta', 'M4P1_BETA_OK', { 'scripts/run.sh': { content: '#!/bin/sh\necho ok\n', mode: '100755' } }),
    makeSkill('m4p1-gamma', 'M4P1_GAMMA_OK'),
  ];
  const snapshot = { schemaVersion: 1, source: catalogSource, commitSha: sha, skills };
  const settings = { async read() { return { status: 'ready', revision: settingsRevision, values: { catalogRef: sha } }; } };
  const catalog = { async load() { return snapshot; }, async dispose() {} };
  const context = { paseo: { hosts: { async list() { return { self: { serverId: hostId } }; } } } };
  const receipts = new PreviewReceiptStore({
    multiRoot: (t) => checkDaemonTrustBoundary(daemonHome).ok ? readActiveMultiRootBinding(daemonHome, t) : undefined,
  });
  const preview = createCanonicalPreviewHandler(settings, catalog, { receiptStore: receipts });
  const apply = createMultiRootApply({
    daemonHome,
    installation: 'paseo-project-skills-m4p1-discovery',
    readPolicy: (t) => readActiveMultiRootEnrollment(daemonHome, t),
    receipts,
    settings,
    catalog,
    environment,
  });

  try {
    const prev = await preview.handleProvidersV2({
      intent: {
        schemaVersion: 1,
        hostId,
        canonicalDirectory: project,
        settingsRevision,
        catalogSource,
        catalogCommitSha: sha,
        recommendationRequestId: 'rec-disc-1',
        selectedSkillIds: skillIds,
        targetProviderIds: ['codex', 'cursor', 'antigravity', 'kiro'],
      },
      viewNonce: 'disc-' + randomBytes(6).toString('hex'),
    }, context);
    assert.equal(prev.status, 'ready');
    assert.equal(prev.applyEligibility.status, 'eligible');

    const op = await apply.create({
      previewId: prev.receipt.previewId,
      planDigest: prev.receipt.planDigest,
      viewNonce: prev.receipt.viewNonce,
      operationId: randomBytes(16).toString('hex'),
      approval: 'create_only_v1',
    }, context);
    assert.equal(op.status, 'operation');
    assert.equal(op.phase, 'completed');

    // Run native discovery probes across all 4 providers in parallel.
    const [codex, kiro, cursor, antigravity] = await Promise.all([
      probeCodexDiscovery(project, skillIds),
      probeKiroDiscovery(project, skillIds),
      probeAcpDiscovery('cursor', 'cursor-agent', ['acp'], project, skillIds),
      probeAcpDiscovery('antigravity', 'agy', ['acp', '--disable-telemetry'], project, skillIds),
    ]);

    const summary = {
      capturedAt: new Date().toISOString(),
      isolatedFixture: true,
      installedSkills: skillIds,
      canonicalFilesCreated: prev.manifest.plan.entries.length,
      kiroDerivedFilesCreated: prev.manifest.plan.derivedEntries.length,
      applyPhase: op.phase,
      durability: op.durability,
      providers: { codex, kiro, cursor, antigravity },
    };
    const outPath = process.argv[2];
    if (outPath) {
      await fs.mkdir(join(outPath, '..'), { recursive: true });
      await fs.writeFile(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await apply.dispose();
    await preview.dispose();
  }
} finally {
  await fs.rm(base, { recursive: true, force: true });
}
