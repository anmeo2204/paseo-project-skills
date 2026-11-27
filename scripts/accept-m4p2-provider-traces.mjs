// Isolated M4.P2 live verification of native discovery AND read-only tool trace reading SKILL.md
// for Cursor ACP (ask mode) and Antigravity ACP (plan mode) after installing canonical skills
// via the main plugin server entrypoint (index.server.ts) on an independent temporary Git copy.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createMainPluginServer } from '../index.server.ts';
import { enrollMultiRoot } from '../server/multi-root-policy.ts';
import { applyCreateRpc } from '../shared/apply.ts';
import { providerPreviewV2Rpc } from '../shared/rpc.ts';
import { catalogSource } from '../shared/catalog-settings.ts';

const exec = promisify(execFile);
const sha = 'f'.repeat(40);
const hostId = 'm4p2-trace-host';
const settingsRevision = 'rev-m4p2-trace';
const environment = { paseoVersion: '0.17.5', sdkVersion: '0.17.4' };
const gitBlobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function getVersion(cmd) {
  try {
    const { stdout, stderr } = await exec(cmd, ['--version'], { timeout: 5000 });
    return (stdout || stderr).trim().split('\n')[0];
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function probeAcpDiscoveryAndReadTrace({ label, command, args, preferredMode, cwd, skillId, marker, timeoutMs = 45000 }) {
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
              referencesSkillMd: raw.includes(`${skillId}/SKILL.md`),
              referencesCanonicalPath: raw.includes(`.agents/skills/${skillId}/SKILL.md`),
            });
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
      clientInfo: { name: 'm4p2-trace-probe', version: '0.1.0' },
    });
    if (init.error) throw new Error(`initialize error: ${JSON.stringify(init.error)}`);

    const session = await send(2, 'session/new', { cwd, mcpServers: [] });
    if (session.error) throw new Error(`session/new error: ${JSON.stringify(session.error)}`);
    const sessionId = session.result?.sessionId;
    let effectiveMode = session.result?.modes?.currentModeId ?? 'unknown';

    if (preferredMode && session.result?.modes?.availableModes?.some(m => m.id === preferredMode) && effectiveMode !== preferredMode) {
      const modeRes = await send(3, 'session/set_mode', { sessionId, modeId: preferredMode });
      if (!modeRes.error) effectiveMode = preferredMode;
    }

    // Wait briefly for available_commands_update.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !commands.some(c => String(c?.name ?? '').includes(skillId))) {
      await new Promise(r => setTimeout(r, 200));
    }
    const discovered = commands.some(c => String(c?.name ?? '').includes(skillId));

    // Ask the agent to activate the skill naturally (without giving the file path) and return the Marker.
    const promptRes = await send(4, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `Use the project skill "${skillId}" (M4P2 amber verification) and reply with ONLY the exact Marker value found inside its instructions.` }],
    });
    if (promptRes.error) throw new Error(`session/prompt error: ${JSON.stringify(promptRes.error)}`);

    const readToolMatched = toolCalls.some(t => t.referencesCanonicalPath || t.referencesSkillMd);
    const markerLoaded = reply.includes(marker);
    return {
      provider: label,
      command: [command, ...args].join(' '),
      binaryVersion: version,
      effectiveMode,
      status: discovered && readToolMatched && markerLoaded ? 'pass' : 'fail',
      discovered,
      readToolMatched,
      markerLoaded,
      toolCallCount: toolCalls.length,
      matchingToolTraces: toolCalls.filter(t => t.referencesCanonicalPath || t.referencesSkillMd).slice(0, 4),
      agentReplyExcerpt: reply.replaceAll(cwd, '<ISOLATED_FIXTURE_ROOT>').slice(0, 200),
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

const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p2-trace-')));
const fakeHome = join(base, 'user-home');
const paseoHome = join(fakeHome, '.paseo');
const project = join(base, 'repo-copy');
for (const d of [fakeHome, paseoHome, project]) await fs.mkdir(d, { mode: 0o700 });

try {
  await exec('git', ['init', '-b', 'main', project]);
  await exec('git', ['-C', project, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', project, 'config', 'user.name', 'Test User']);
  await fs.writeFile(join(project, 'README.md'), '# M4.P2 Provider Trace Fixture\n');
  await exec('git', ['-C', project, 'add', 'README.md']);
  await exec('git', ['-C', project, 'commit', '-m', 'init']);

  await enrollMultiRoot({ daemonHome: paseoHome, root: project, environment, enabled: true });

  const skillId = 'm4p2-trace-skill';
  const marker = 'M4P2_TRACE_MARKER_9417';
  const body = Buffer.from(`---\nname: ${skillId}\ndescription: M4P2 amber verification skill.\n---\n\n# M4P2 Trace Skill\n\nMarker: ${marker}\n`, 'utf8');
  const snapshot = {
    schemaVersion: 1,
    source: catalogSource,
    commitSha: sha,
    skills: [{
      id: skillId,
      directory: `skills/${skillId}`,
      metadata: { name: skillId, description: 'M4P2 amber verification skill.' },
      entrypoint: { path: 'SKILL.md', blobSha: gitBlobSha(body), sizeBytes: body.length, mode: '100644', bytes: body },
      supportingFiles: [],
    }],
  };

  const handlers = new Map();
  const cleanup = createMainPluginServer({
    handle: (contract, fn) => handlers.set(contract, fn),
    registerSettings: () => ({ read: async () => ({ status: 'ready', revision: settingsRevision, values: { catalogRef: sha } }) }),
  }, {
    homeDir: fakeHome,
    env: {},
    paseoVersion: '0.17.5',
    sdkVersions: ['0.17.4', '0.17.4', '0.17.4'],
    macOsVersion: '27.2.1',
    catalog: { load: async () => snapshot, dispose: async () => {} },
  });
  const context = { paseo: { hosts: { list: async () => ({ self: { serverId: hostId } }) } } };

  try {
    const prev = await handlers.get(providerPreviewV2Rpc)({
      intent: {
        schemaVersion: 1, hostId, canonicalDirectory: project, settingsRevision, catalogSource,
        catalogCommitSha: sha, recommendationRequestId: 'rec-trace',
        selectedSkillIds: [skillId], targetProviderIds: ['cursor', 'antigravity'],
      },
      viewNonce: 'trace-' + randomBytes(6).toString('hex'),
    }, context);
    assert.equal(prev.status, 'ready');
    assert.equal(prev.applyEligibility.status, 'eligible');

    const op = await handlers.get(applyCreateRpc)({
      previewId: prev.receipt.previewId,
      planDigest: prev.receipt.planDigest,
      viewNonce: prev.receipt.viewNonce,
      operationId: randomBytes(16).toString('hex'),
      approval: 'create_only_v1',
    }, context);
    assert.equal(op.status, 'operation');
    assert.equal(op.phase, 'completed');

    const [cursor, antigravity] = await Promise.all([
      probeAcpDiscoveryAndReadTrace({
        label: 'cursor', command: 'cursor-agent', args: ['acp'], preferredMode: 'ask',
        cwd: project, skillId, marker,
      }),
      probeAcpDiscoveryAndReadTrace({
        label: 'antigravity', command: 'agy', args: ['acp', '--disable-telemetry'], preferredMode: 'plan',
        cwd: project, skillId, marker,
      }),
    ]);

    const summary = {
      capturedAt: new Date().toISOString(),
      isolatedFixture: true,
      installedViaMainEntrypoint: true,
      skillId,
      canonicalPath: `.agents/skills/${skillId}/SKILL.md`,
      providers: { cursor, antigravity },
    };
    const outPath = process.argv[2];
    if (outPath) {
      await fs.mkdir(join(outPath, '..'), { recursive: true });
      await fs.writeFile(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await cleanup();
  }
} finally {
  await fs.rm(base, { recursive: true, force: true });
}
