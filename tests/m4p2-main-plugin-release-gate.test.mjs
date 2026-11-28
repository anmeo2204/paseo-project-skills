import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { PaseoApiProvider, PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { HostFixture } from './client-fixture.mjs';
import { createMainPluginServer, resolveDefaultPluginRoot } from '../index.server.ts';
import contributeMainClient, { formatHostApplyNotice } from '../index.client.tsx';
import { FixtureApprovalScope, FixtureOperations } from '../client/fixture-approval.tsx';
import { createOperationTracker } from '../client/apply-tracker.ts';
import { enrollMultiRoot, setMultiRootOptIn } from '../server/multi-root-policy.ts';
import { applyCreateRpc, applyStatusRpc, applyTargetStatusRpc } from '../shared/apply.ts';
import { providerPreviewV2Rpc } from '../shared/rpc.ts';
import { catalogSource } from '../shared/catalog-settings.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const exec = promisify(execFile);
const supported = process.platform === 'darwin' && process.arch === 'arm64';
const sha = 'e'.repeat(40);
const hostId = 'm4p2-main-host';
const settingsRevision = 'rev-m4p2-1';
const environment = { paseoVersion: '0.17.5', sdkVersion: '0.17.4' };
const gitBlobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const opId = () => randomBytes(16).toString('hex');

function makeSkill(id, files) {
  const entryBytes = Buffer.from(files['SKILL.md'], 'utf8');
  const supportingFiles = Object.entries(files)
    .filter(([p]) => p !== 'SKILL.md')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, spec]) => {
      const bytes = Buffer.from(typeof spec === 'string' ? spec : spec.content, 'utf8');
      const mode = typeof spec === 'string' ? '100644' : spec.mode;
      return { path, blobSha: gitBlobSha(bytes), sizeBytes: bytes.length, mode, bytes };
    });
  return {
    id,
    directory: `skills/${id}`,
    metadata: { name: id, description: `M4.P2 skill ${id}` },
    entrypoint: { path: 'SKILL.md', blobSha: gitBlobSha(entryBytes), sizeBytes: entryBytes.length, mode: '100644', bytes: entryBytes },
    supportingFiles,
  };
}

function mountMainServer({ homeDir, env = {}, skills, paseoVersion = '0.17.5', sdkVersions = ['0.17.4', '0.17.4', '0.17.4'] }) {
  const handlers = new Map();
  const snapshot = { schemaVersion: 1, source: catalogSource, commitSha: sha, skills };
  const cleanup = createMainPluginServer({
    handle: (contract, fn) => handlers.set(contract, fn),
    registerSettings: () => ({
      read: async () => ({ status: 'ready', revision: settingsRevision, values: { catalogRef: sha } }),
    }),
  }, {
    homeDir,
    env,
    paseoVersion,
    sdkVersions,
    macOsVersion: '27.2.1',
    catalog: { load: async () => snapshot, dispose: async () => {} },
  });
  const context = { paseo: { hosts: { list: async () => ({ self: { serverId: hostId } }) } } };
  return { handlers, context, cleanup };
}

test('AT-4 & Main Entrypoint: default ~/.paseo without PASEO_HOME, Preview-only default, multi-root + Kiro Apply, Relay fail-closed (nested daemon.relay), and policy changes', { skip: !supported, timeout: 60000 }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p2-main-')));
  const fakeUserHome = join(base, 'user-home');
  const defaultPaseoHome = join(fakeUserHome, '.paseo');
  const repoA = join(base, 'repo-a');
  const repoB = join(base, 'repo-b');
  for (const d of [fakeUserHome, defaultPaseoHome, repoA, repoB]) await fs.mkdir(d, { mode: 0o700 });

  try {
    // Prepare Git repoA with a pre-existing skill to verify preservation.
    await exec('git', ['init', '-b', 'main', repoA]);
    await exec('git', ['-C', repoA, 'config', 'user.email', 'test@example.com']);
    await exec('git', ['-C', repoA, 'config', 'user.name', 'Test User']);
    await fs.mkdir(join(repoA, '.agents/skills/keep-existing'), { recursive: true, mode: 0o755 });
    const existingFile = join(repoA, '.agents/skills/keep-existing/SKILL.md');
    await fs.writeFile(existingFile, '---\nname: keep-existing\ndescription: Keep\n---\n# Keep\n', { mode: 0o644 });
    const existingIno = (await fs.lstat(existingFile, { bigint: true })).ino;
    const existingSha = sha256(await fs.readFile(existingFile));

    // Write Paseo 0.17.5 style config.json with relay OFF & loopback listen.
    await fs.writeFile(join(defaultPaseoHome, 'config.json'), JSON.stringify({
      version: 1,
      daemon: { listen: '127.0.0.1:6767', relay: { enabled: false } },
    }), { mode: 0o600 });

    const skills = [
      makeSkill('main-one', { 'SKILL.md': '---\nname: main-one\ndescription: One\n---\n# One\n' }),
      makeSkill('main-two', {
        'SKILL.md': '---\nname: main-two\ndescription: Two\n---\n# Two\n',
        'scripts/run.sh': { content: '#!/bin/sh\necho ok\n', mode: '100755' },
      }),
    ];

    // 1. Mount main server WITHOUT PASEO_HOME env -> resolves default ~/.paseo cleanly, Preview-only by default.
    const s1 = mountMainServer({ homeDir: fakeUserHome, env: {}, skills });
    try {
      const hostStatus0 = await s1.handlers.get(applyTargetStatusRpc)({}, s1.context);
      assert.equal(hostStatus0.hostCompatible, true);
      assert.equal(hostStatus0.trustBoundaryOk, true);
      assert.equal(hostStatus0.enrolledCount, 0);
      assert.equal(hostStatus0.targetState, 'none');

      const targetStatus0 = await s1.handlers.get(applyTargetStatusRpc)({ canonicalDirectory: repoA }, s1.context);
      assert.equal(targetStatus0.targetState, 'not_enrolled');

      const intentA = {
        schemaVersion: 1, hostId, canonicalDirectory: repoA, settingsRevision, catalogSource,
        catalogCommitSha: sha, recommendationRequestId: 'rec-1',
        selectedSkillIds: ['main-one', 'main-two'], targetProviderIds: ['codex', 'kiro'],
      };
      const prevUnenrolled = await s1.handlers.get(providerPreviewV2Rpc)({ intent: intentA, viewNonce: 'v-unenrolled' }, s1.context);
      assert.equal(prevUnenrolled.status, 'ready');
      assert.equal(prevUnenrolled.applyEligibility.status, 'ineligible');
      assert.deepEqual(prevUnenrolled.applyEligibility.reasons, ['write_capability_unavailable']);

      // 2. Enroll repoA (out-of-band) -> targetStatus becomes enrolled_enabled, Preview becomes eligible, Apply creates canonical + Kiro.
      const enrA = await enrollMultiRoot({ daemonHome: defaultPaseoHome, root: repoA, environment, enabled: true });
      assert.equal(enrA.status, 'enrolled');
      const targetStatusA = await s1.handlers.get(applyTargetStatusRpc)({ canonicalDirectory: repoA }, s1.context);
      assert.equal(targetStatusA.targetState, 'enrolled_enabled');
      assert.equal(targetStatusA.policyRevision, enrA.entry.enrollment.policyRevision);

      const targetStatusB = await s1.handlers.get(applyTargetStatusRpc)({ canonicalDirectory: repoB }, s1.context);
      assert.equal(targetStatusB.targetState, 'not_enrolled');

      const prevA = await s1.handlers.get(providerPreviewV2Rpc)({ intent: intentA, viewNonce: 'v-apply-a' }, s1.context);
      assert.equal(prevA.status, 'ready');
      assert.equal(prevA.applyEligibility.status, 'eligible');
      assert.equal(prevA.manifest.plan.derivedEntries.length, 3);

      const applyOpId = opId();
      const applyRes = await s1.handlers.get(applyCreateRpc)({
        previewId: prevA.receipt.previewId,
        planDigest: prevA.receipt.planDigest,
        viewNonce: prevA.receipt.viewNonce,
        operationId: applyOpId,
        approval: 'create_only_v1',
      }, s1.context);
      assert.equal(applyRes.status, 'operation');
      assert.equal(applyRes.phase, 'completed');
      assert.equal(applyRes.durability, 'fsync_completed');

      // Existing skill preserved 100%.
      assert.equal((await fs.lstat(existingFile, { bigint: true })).ino, existingIno);
      assert.equal(sha256(await fs.readFile(existingFile)), existingSha);

      // 3. Enroll repoB, issue receipt, then enable nested daemon.relay -> fail-closed!
      await enrollMultiRoot({ daemonHome: defaultPaseoHome, root: repoB, environment, enabled: true });
      const intentB = { ...intentA, canonicalDirectory: repoB, targetProviderIds: ['codex'] };
      const prevB = await s1.handlers.get(providerPreviewV2Rpc)({ intent: intentB, viewNonce: 'v-relay-b' }, s1.context);
      assert.equal(prevB.status, 'ready');
      assert.equal(prevB.applyEligibility.status, 'eligible');

      // Flip Paseo 0.17.5 nested daemon.relay.enabled = true mid-session.
      await fs.writeFile(join(defaultPaseoHome, 'config.json'), JSON.stringify({
        version: 1,
        daemon: { listen: '127.0.0.1:6767', relay: { enabled: true } },
      }), { mode: 0o600 });

      const statusRelay = await s1.handlers.get(applyTargetStatusRpc)({ canonicalDirectory: repoB }, s1.context);
      assert.equal(statusRelay.trustBoundaryOk, false);
      assert.equal(statusRelay.targetState, 'host_unavailable');
      assert.ok(statusRelay.reasons.includes('remote_exposure_enabled'));

      const applyBlockedRelay = await s1.handlers.get(applyCreateRpc)({
        previewId: prevB.receipt.previewId,
        planDigest: prevB.receipt.planDigest,
        viewNonce: prevB.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, s1.context);
      assert.deepEqual(applyBlockedRelay, { status: 'error', code: 'receipt_invalid' });

      // 4. Restart main server while Relay is enabled: apply.create.v1 NOT registered, but apply.status.v1 STILL reads prior op!
      const sRelayBoot = mountMainServer({ homeDir: fakeUserHome, env: {}, skills });
      try {
        assert.equal(sRelayBoot.handlers.has(applyCreateRpc), false);
        assert.equal(sRelayBoot.handlers.has(applyStatusRpc), true);
        const oldStatus = await sRelayBoot.handlers.get(applyStatusRpc)({ operationId: applyOpId }, sRelayBoot.context);
        assert.equal(oldStatus.status, 'operation');
        assert.equal(oldStatus.phase, 'completed');
      } finally {
        await sRelayBoot.cleanup();
      }

      // 5. Unverified Paseo version (0.18.0) fails closed at startup (Preview-only).
      await fs.writeFile(join(defaultPaseoHome, 'config.json'), JSON.stringify({
        version: 1,
        daemon: { listen: '127.0.0.1:6767', relay: { enabled: false } },
      }), { mode: 0o600 });
      const sFuture = mountMainServer({ homeDir: fakeUserHome, env: {}, skills, paseoVersion: '0.18.0' });
      try {
        assert.equal(sFuture.handlers.has(applyCreateRpc), false);
        const stFuture = await sFuture.handlers.get(applyTargetStatusRpc)({ canonicalDirectory: repoB }, sFuture.context);
        assert.equal(stFuture.hostCompatible, false);
        assert.ok(stFuture.reasons.includes('unsupported_paseo_version'));
      } finally {
        await sFuture.cleanup();
      }

      // Disable repoB -> targetState reports enrolled_disabled.
      setMultiRootOptIn(defaultPaseoHome, repoB, false);
      const stDisabled = await s1.handlers.get(applyTargetStatusRpc)({ canonicalDirectory: repoB }, s1.context);
      assert.equal(stDisabled.targetState, 'enrolled_disabled');
    } finally {
      await s1.cleanup();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('Main Client UI displays Preview-only notices (Relay / unenrolled) and renders busy, receipt_invalid, journal_full, and recovery_required clearly', async () => {
  const prevStorage = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };

  const theme = {
    colors: {
      surface0: '#000', surface1: '#111', border: '#222', foreground: '#fff', foregroundMuted: '#aaa',
      accent: '#0af', accentForeground: '#000', destructive: '#f00',
    },
  };

  try {
    // 1. Main client banner tests via contributeMainClient.
    let ScreenComponent;
    const cleanup = contributeMainClient({
      addScreen: ({ Component }) => { ScreenComponent = Component; return () => {}; },
      addSidebarHeaderItem: () => () => {},
    });
    assert.ok(ScreenComponent);

    const renderMain = async (targetStatusPayload) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const paseo = {
        projects: { list: async () => [] },
        workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
        providers: { snapshot: async () => ({ providers: [] }) },
      };
      const invoke = async (method) => {
        if (method === 'apply.target-status.v1') return targetStatusPayload;
        return {};
      };
      const hostValue = {
        hosts: [{ serverId: 'host-1', status: 'online' }],
        settings: { status: 'ready', revision: 'rev-1', values: { catalogRef: '' }, saving: false, save: async () => {} },
      };
      let tree;
      await act(async () => {
        tree = create(
          React.createElement(QueryClientProvider, { client: queryClient },
            React.createElement(HostFixture.Provider, { value: hostValue },
              React.createElement(PaseoApiProvider, { paseo },
                React.createElement(PluginRpcProvider, { invoke },
                  React.createElement(ScreenComponent, { theme, layout: { platform: 'web', compact: false }, host: { id: 'host-1', label: 'Local Host' }, params: {} })
                )
              )
            )
          )
        );
        await new Promise(r => setTimeout(r, 25));
      });
      const text = JSON.stringify(tree.toJSON());
      await act(async () => { tree.unmount(); });
      return text;
    };

    const relayStatus = { hostCompatible: false, trustBoundaryOk: false, reasons: ['remote_exposure_enabled'], enrolledCount: 1, targetState: 'host_unavailable' };
    const relayText = await renderMain(relayStatus);
    assert.ok(relayText.includes(formatHostApplyNotice(relayStatus)));

    const unenrolledStatus = { hostCompatible: true, trustBoundaryOk: true, reasons: [], enrolledCount: 0, targetState: 'none' };
    const unenrolledText = await renderMain(unenrolledStatus);
    assert.ok(unenrolledText.includes(formatHostApplyNotice(unenrolledStatus)));

    cleanup();

    // 2. OperationRow UI handling for busy, receipt_invalid, journal_full, and recovery_required.
    const tracker = createOperationTracker({ slot: 'paseo-project-skills', storage: () => globalThis.localStorage });
    const scope = { hostId: 'host-1', slot: 'paseo-project-skills', target: '/tmp/example' };
    const makeInput = (operationId) => ({
      previewId: 'a'.repeat(64), planDigest: 'b'.repeat(64), viewNonce: 'n-1', operationId, approval: 'create_only_v1',
    });

    tracker.submit(scope, makeInput('1'.repeat(32)), async () => ({ status: 'error', code: 'busy' }));
    tracker.submit(scope, makeInput('2'.repeat(32)), async () => ({ status: 'error', code: 'receipt_invalid' }));
    tracker.submit(scope, makeInput('3'.repeat(32)), async () => ({ status: 'error', code: 'journal_full' }));
    tracker.submit(scope, makeInput('4'.repeat(32)), async () => ({
      status: 'operation', operationId: '4'.repeat(32), planDigest: 'b'.repeat(64),
      phase: 'recovery_required', code: 'terminal_record_missing', targetMutated: 'unknown',
      requiresPreview: true, durability: 'not_confirmed', ledger: [],
    }));
    await new Promise(r => setTimeout(r, 30));

    let opsTree;
    await act(async () => {
      opsTree = create(
        React.createElement(PluginRpcProvider, { invoke: async () => ({ status: 'error', code: 'outcome_unknown' }) },
          React.createElement(FixtureApprovalScope, { slot: 'paseo-project-skills', tracker },
            React.createElement(FixtureOperations, { theme, host: { id: 'host-1', label: 'Local Host' }, online: true })
          )
        )
      );
      await new Promise(r => setTimeout(r, 20));
    });
    const opsText = JSON.stringify(opsTree.toJSON());
    assert.ok(opsText.includes('Another Apply operation is running on this daemon.'), 'Expected busy message');
    assert.ok(opsText.includes('Preview receipt is expired, evicted, or invalidated'), 'Expected receipt_invalid message');
    assert.ok(opsText.includes('Apply operation journal is full (64 active records)'), 'Expected journal_full message');
    assert.ok(opsText.includes('Recovery required: inspect the operation ledger below against disk'), 'Expected recovery_required message');
    await act(async () => { opsTree.unmount(); });
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});

test('CJS/ESM bundler regression: resolveDefaultPluginRoot never throws or falls back to cwd, and unverified pluginRoot fails closed to Preview-only', async () => {
  assert.equal(resolveDefaultPluginRoot(undefined, undefined), undefined);
  assert.equal(resolveDefaultPluginRoot('', ''), undefined);
  assert.equal(resolveDefaultPluginRoot('not-a-file-url', undefined), undefined);
  assert.equal(resolveDefaultPluginRoot('file:///tmp/plugin/index.server.ts', undefined), '/tmp/plugin');
  assert.equal(resolveDefaultPluginRoot(undefined, '/tmp/bundled-dir'), '/tmp/bundled-dir');

  // Even when pluginRoot points to a bundled dir without node_modules/@getpaseo/*, server loads cleanly in Preview-only mode.
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-cjs-reg-')));
  const fakeHome = join(base, 'home');
  const paseoHome = join(fakeHome, '.paseo');
  const bundledDir = join(base, 'bundled-cache');
  for (const d of [fakeHome, paseoHome, bundledDir]) await fs.mkdir(d, { mode: 0o700 });
  try {
    const handlers = new Map();
    const cleanup = createMainPluginServer({
      handle: (contract, fn) => handlers.set(contract, fn),
      registerSettings: () => ({ read: async () => ({ status: 'ready', revision: 'rev-cjs', values: { catalogRef: '' } }) }),
    }, {
      homeDir: fakeHome,
      env: {},
      pluginRoot: bundledDir,
      paseoVersion: '0.17.5',
      macOsVersion: '27.2.1',
    });
    try {
      assert.equal(handlers.has(applyCreateRpc), false, 'apply.create.v1 must not be registered when SDK versions cannot be verified');
      const status = await handlers.get(applyTargetStatusRpc)({}, { paseo: { hosts: { list: async () => ({ self: { serverId: 'h1' } }) } } });
      assert.equal(status.hostCompatible, false);
      assert.ok(status.reasons.includes('unsupported_sdk_version'));
    } finally {
      await cleanup();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
