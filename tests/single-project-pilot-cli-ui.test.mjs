import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { PaseoApiProvider, PluginRpcProvider } from '@getpaseo/plugin/client/host';
import { HostFixture } from './client-fixture.mjs';
import contributePilot, { pilotPreviewOnlyNotice } from '../client/single-project-pilot.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
notifyManager.setScheduler(queueMicrotask);

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const cliScript = join(repo, 'scripts/enroll-single-project-pilot.mjs');
const supported = process.platform === 'darwin' && process.arch === 'arm64';

async function runEnrollCli(args) {
  return exec(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', join(repo, 'tests/register.mjs'), cliScript, ...args], { cwd: repo });
}

test('enroll-single-project-pilot CLI reports status, enrolls canonical root, toggles opt-in, rotates revision, and rejects symlink alias', { skip: !supported, timeout: 30000 }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-enroll-cli-test-')));
  const home = join(base, 'daemon');
  const root = join(base, 'project-copy');
  const alias = join(base, 'project-alias');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(root, { mode: 0o700 });
  await fs.symlink(root, alias);
  try {
    // 1. Default status is inactive (opt-in OFF).
    const s0 = JSON.parse((await runEnrollCli(['status', '--home', home])).stdout);
    assert.equal(s0.active, false);

    // 2. Enrolling a symlink alias fails closed.
    await assert.rejects(runEnrollCli(['enroll', '--home', home, '--root', alias]));

    // 3. Enroll exact canonical root.
    const enrolled = JSON.parse((await runEnrollCli(['enroll', '--home', home, '--root', root])).stdout);
    assert.equal(enrolled.status, 'enrolled');
    assert.equal(enrolled.enabled, true);
    assert.equal(enrolled.canonicalRoot, root);
    assert.match(enrolled.policyRevision, /^[0-9a-f]{64}$/);
    assert.equal(enrolled.volume.fstype, 'apfs');
    assert.equal(enrolled.volume.caseMode, 'insensitive');

    // 4. Status reflects active enrollment.
    const s1 = JSON.parse((await runEnrollCli(['status', '--home', home])).stdout);
    assert.equal(s1.active, true);
    assert.equal(s1.canonicalRoot, root);
    assert.equal(s1.policyRevision, enrolled.policyRevision);

    // 5. Disable sets opt-in OFF.
    const disabled = JSON.parse((await runEnrollCli(['disable', '--home', home])).stdout);
    assert.equal(disabled.enabled, false);
    const s2 = JSON.parse((await runEnrollCli(['status', '--home', home])).stdout);
    assert.equal(s2.active, false);

    // 6. Enable with --rotate generates a new policyRevision.
    const enabled = JSON.parse((await runEnrollCli(['enable', '--home', home, '--rotate'])).stdout);
    assert.equal(enabled.enabled, true);
    assert.notEqual(enabled.policyRevision, enrolled.policyRevision);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('single-project pilot client displays Preview-only status notice when capability is disabled and hides it when enabled', async () => {
  const prevStorage = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  try {
    let ScreenComponent;
    const cleanup = contributePilot({
      addScreen: ({ Component }) => { ScreenComponent = Component; return () => {}; },
      addSidebarHeaderItem: () => () => {},
    });
    assert.ok(ScreenComponent);

    const theme = {
      colors: {
        surface0: '#000', surface1: '#111', border: '#222', foreground: '#fff', foregroundMuted: '#aaa',
        accent: '#0af', accentForeground: '#000', destructive: '#f00',
      },
    };
    const renderWithCapability = async (enabled) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const paseo = {
        projects: { list: async () => [] },
        workspaces: { list: async () => ({ entries: [], pageInfo: {} }) },
        providers: { snapshot: async () => ({ providers: [] }) },
      };
      const invoke = async (method) => {
        if (method === 'apply.local-capability.v1') return { enabled };
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
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      const text = JSON.stringify(tree.toJSON());
      await act(async () => { tree.unmount(); });
      return text;
    };

    const disabledText = await renderWithCapability(false);
    assert.ok(disabledText.includes(pilotPreviewOnlyNotice), 'Expected Preview-only notice when capability is disabled');

    const enabledText = await renderWithCapability(true);
    assert.ok(!enabledText.includes(pilotPreviewOnlyNotice), 'Expected Preview-only notice to hide when capability is enabled');

    cleanup();
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});
