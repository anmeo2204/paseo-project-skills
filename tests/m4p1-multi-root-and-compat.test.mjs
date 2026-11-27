import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  checkDaemonTrustBoundary,
  evaluateHostCompatibility,
  isMacOsVersionCompatible,
  isPaseoVersionCompatible,
  isSdkVersionCompatible,
  resolveSafeDaemonHome,
  verifyEmbeddedHelperIntegrity,
} from '../server/compatibility-policy.ts';
import {
  enrollMultiRoot,
  inspectLegacyPilotMigrationStatus,
  listMultiRootEnrollments,
  multiRootPolicyPath,
  readActiveMultiRootBinding,
  readActiveMultiRootEnrollment,
  revokeMultiRoot,
  setMultiRootOptIn,
} from '../server/multi-root-policy.ts';
import { enrollSingleProjectRoot } from '../server/single-project-policy.ts';
import { createCanonicalPreviewHandler } from '../server/canonical-preview.ts';
import { PreviewReceiptStore } from '../server/preview-receipts.ts';
import { createMultiRootApply } from '../server/fixture-apply.ts';
import { ApplyJournal } from '../server/apply-journal.ts';
import { catalogSource } from '../shared/catalog-settings.ts';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const cliScript = join(repo, 'scripts/enroll-project-skills.mjs');
const supported = process.platform === 'darwin' && process.arch === 'arm64';
const environment = { paseoVersion: '0.17.5', sdkVersion: '0.17.4' };
const hostId = 'm4p1-local-host';
const sha = 'a'.repeat(40);
const settingsRevision = 'rev-m4p1-1';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const gitBlobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const opId = () => randomBytes(16).toString('hex');
const nonce = (prefix = 'n') => `${prefix}-${randomBytes(8).toString('hex')}`;

async function runCli(args, env = {}) {
  return exec(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', join(repo, 'tests/register.mjs'), cliScript, ...args],
    { cwd: repo, env: { ...process.env, ...env } },
  );
}

function makeSkill(id, files) {
  const entrypointBody = Buffer.from(files['SKILL.md'], 'utf8');
  const supportingFiles = Object.entries(files)
    .filter(([path]) => path !== 'SKILL.md')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, spec]) => {
      const bytes = Buffer.from(typeof spec === 'string' ? spec : spec.content, 'utf8');
      const mode = typeof spec === 'string' ? '100644' : spec.mode;
      return { path, blobSha: gitBlobSha(bytes), sizeBytes: bytes.length, mode, bytes };
    });
  return {
    id,
    directory: `skills/${id}`,
    metadata: { name: id, description: `Skill ${id} for M4.P1 testing.` },
    entrypoint: { path: 'SKILL.md', blobSha: gitBlobSha(entrypointBody), sizeBytes: entrypointBody.length, mode: '100644', bytes: entrypointBody },
    supportingFiles,
  };
}

function makeHarness({ daemonHome, skills, testHooks }) {
  const snapshot = {
    schemaVersion: 1,
    source: catalogSource,
    commitSha: sha,
    skills,
  };
  const settings = {
    async read() { return { status: 'ready', revision: settingsRevision, values: { catalogRef: sha } }; },
  };
  const catalog = {
    async load() { return snapshot; },
    async dispose() {},
  };
  const context = {
    paseo: { hosts: { async list() { return { self: { serverId: hostId } }; } } },
  };
  const receipts = new PreviewReceiptStore({
    multiRoot: (target) => {
      if (!checkDaemonTrustBoundary(daemonHome).ok) return undefined;
      return readActiveMultiRootBinding(daemonHome, target);
    },
  });
  const preview = createCanonicalPreviewHandler(settings, catalog, { receiptStore: receipts });
  const apply = createMultiRootApply({
    daemonHome,
    installation: 'paseo-project-skills-m4p1-test',
    readPolicy: (target) => readActiveMultiRootEnrollment(daemonHome, target),
    receipts,
    settings,
    catalog,
    environment,
    test: testHooks,
  });
  return {
    context,
    receipts,
    preview,
    apply,
    intent(canonicalDirectory, selectedSkillIds, targetProviderIds = ['codex']) {
      return {
        schemaVersion: 1,
        hostId,
        canonicalDirectory,
        settingsRevision,
        catalogSource,
        catalogCommitSha: sha,
        recommendationRequestId: 'rec-m4p1-1',
        selectedSkillIds,
        targetProviderIds,
      };
    },
    async dispose() {
      await apply.dispose();
      await preview.dispose();
    },
  };
}

async function initGitRepo(dir) {
  await exec('git', ['init', '-b', 'main', dir]);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test User']);
  await fs.writeFile(join(dir, 'README.md'), '# Test Repo\n');
  await exec('git', ['-C', dir, 'add', 'README.md']);
  await exec('git', ['-C', dir, 'commit', '-m', 'init']);
}

test('compatibility policy evaluates semver ranges, safe default daemon home, trust boundary, and helper integrity', async () => {
  assert.equal(isPaseoVersionCompatible('0.17.5'), true);
  assert.equal(isPaseoVersionCompatible('0.17.9'), true);
  assert.equal(isPaseoVersionCompatible('0.18.0'), true);
  assert.equal(isPaseoVersionCompatible('0.17.4'), false);
  assert.equal(isPaseoVersionCompatible('1.0.0'), false);
  assert.equal(isPaseoVersionCompatible('invalid'), false);

  assert.equal(isSdkVersionCompatible('0.17.4'), true);
  assert.equal(isSdkVersionCompatible('0.17.9'), true);
  assert.equal(isSdkVersionCompatible('0.17.3'), false);
  assert.equal(isSdkVersionCompatible('0.18.0'), false);

  assert.equal(isMacOsVersionCompatible('14.0.0'), true);
  assert.equal(isMacOsVersionCompatible('27.2.1'), true);
  assert.equal(isMacOsVersionCompatible('27.3.0'), true);
  assert.equal(isMacOsVersionCompatible('13.6.9'), false);

  assert.equal(verifyEmbeddedHelperIntegrity(false).ok, true);
  assert.equal(verifyEmbeddedHelperIntegrity(true).ok, true);

  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p1-compat-')));
  const fakeHome = join(base, 'user-home');
  const defaultPaseo = join(fakeHome, '.paseo');
  const symlinkHome = join(base, 'paseo-link');
  const worldWritable = join(base, 'world-writable');
  await fs.mkdir(fakeHome, { mode: 0o700 });
  await fs.mkdir(defaultPaseo, { mode: 0o700 });
  await fs.symlink(defaultPaseo, symlinkHome);
  await fs.mkdir(worldWritable, { mode: 0o777 });
  await fs.chmod(worldWritable, 0o777);
  try {
    // Default ~/.paseo resolution when PASEO_HOME is unset.
    const defRes = resolveSafeDaemonHome(undefined, { env: {}, homeDir: fakeHome });
    assert.equal(defRes.ok, true);
    if (defRes.ok) {
      assert.equal(defRes.daemonHome, defaultPaseo);
      assert.equal(defRes.source, 'default');
    }

    // Rejects symlink and group/world-writable daemon homes.
    assert.equal(resolveSafeDaemonHome(symlinkHome).ok, false);
    assert.equal(resolveSafeDaemonHome(worldWritable).ok, false);

    // Trust boundary passes on clean loopback config, fails closed on relay/remote/non-loopback/malformed.
    assert.equal(checkDaemonTrustBoundary(defaultPaseo, { env: {} }).ok, true);
    assert.deepEqual(checkDaemonTrustBoundary(defaultPaseo, { env: { PASEO_RELAY_ENABLED: 'true' } }), { ok: false, reason: 'remote_exposure_enabled' });
    assert.deepEqual(checkDaemonTrustBoundary(defaultPaseo, { env: { PASEO_LISTEN: '0.0.0.0:6767' } }), { ok: false, reason: 'remote_exposure_enabled' });

    await fs.writeFile(join(defaultPaseo, 'config.json'), JSON.stringify({ listen: '127.0.0.1:6767', relay: { enabled: false } }), { mode: 0o600 });
    assert.equal(checkDaemonTrustBoundary(defaultPaseo, { env: {} }).ok, true);

    await fs.writeFile(join(defaultPaseo, 'config.json'), JSON.stringify({ listen: '127.0.0.1:6767', relay: { enabled: true } }), { mode: 0o600 });
    assert.deepEqual(checkDaemonTrustBoundary(defaultPaseo, { env: {} }), { ok: false, reason: 'remote_exposure_enabled' });

    await fs.writeFile(join(defaultPaseo, 'config.json'), '{not-valid-json', { mode: 0o600 });
    assert.deepEqual(checkDaemonTrustBoundary(defaultPaseo, { env: {} }), { ok: false, reason: 'trust_boundary_unverified' });

    await fs.unlink(join(defaultPaseo, 'config.json'));

    // Full host compatibility evaluation.
    const compatOk = evaluateHostCompatibility({
      paseoVersion: '0.17.6',
      sdkVersions: ['0.17.4', '0.17.4', '0.17.4'],
      macOsVersion: '27.3.0',
      platform: 'darwin',
      arch: 'arm64',
      env: {},
      homeDir: fakeHome,
    });
    assert.equal(compatOk.compatible, true);
    if (compatOk.compatible) assert.equal(compatOk.daemonHomeSource, 'default');

    const compatBad = evaluateHostCompatibility({
      paseoVersion: '0.17.4',
      sdkVersions: ['0.18.0'],
      macOsVersion: '13.5.0',
      platform: 'linux',
      arch: 'x64',
      env: { PASEO_RELAY_ENABLED: '1' },
      homeDir: fakeHome,
    });
    assert.equal(compatBad.compatible, false);
    if (!compatBad.compatible) {
      assert.ok(compatBad.reasons.includes('unsupported_platform'));
      assert.ok(compatBad.reasons.includes('unsupported_arch'));
      assert.ok(compatBad.reasons.includes('unsupported_macos_version'));
      assert.ok(compatBad.reasons.includes('unsupported_paseo_version'));
      assert.ok(compatBad.reasons.includes('unsupported_sdk_version'));
      assert.ok(compatBad.reasons.includes('remote_exposure_enabled'));
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('AT-1: multi-root enrollment, CLI, concurrent updates, non-auto-migration, per-target receipt & cross-root isolation', { skip: !supported, timeout: 60000 }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p1-at1-')));
  const daemonHome = join(base, 'daemon');
  const rootA = join(base, 'proj-a');
  const rootB = join(base, 'proj-b');
  const rootC = join(base, 'proj-c');
  const nestedA = join(rootA, 'nested');
  const aliasA = join(base, 'proj-a-link');
  for (const dir of [daemonHome, rootA, rootB, rootC, nestedA]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.symlink(rootA, aliasA);

  try {
    // 1. Legacy single-root pilot enrollment NEVER auto-grants write access in multi-root store.
    const legacy = await enrollSingleProjectRoot({ daemonHome, root: rootA, environment, enabled: true });
    assert.equal(legacy.status, 'enrolled');
    assert.deepEqual(inspectLegacyPilotMigrationStatus(daemonHome), { legacyPilotPolicyPresent: true, autoMigrated: false });
    assert.equal(readActiveMultiRootEnrollment(daemonHome, rootA), undefined);

    // 2. CLI rejects symlink alias and wildcards.
    await assert.rejects(runCli(['enroll', '--home', daemonHome, '--root', aliasA]));
    await assert.rejects(runCli(['enroll', '--home', daemonHome, '--root', join(base, 'proj-*')]));

    // 3. Concurrent CLI enrollments for rootA and rootB both succeed without losing either root.
    const [resA, resB] = await Promise.all([
      runCli(['enroll', '--home', daemonHome, '--root', rootA]),
      runCli(['enroll', '--home', daemonHome, '--root', rootB]),
    ]);
    assert.equal(JSON.parse(resA.stdout).status, 'enrolled');
    assert.equal(JSON.parse(resB.stdout).status, 'enrolled');

    const listed = JSON.parse((await runCli(['list', '--home', daemonHome])).stdout);
    assert.equal(listed.count, 2);
    assert.equal(listed.legacyPilot.legacyPilotPolicyPresent, true);
    assert.equal(listed.legacyPilot.autoMigrated, false);

    // 4. Per-target receipts & cross-root isolation.
    const skill = makeSkill('alpha-skill', { 'SKILL.md': '---\nname: alpha-skill\ndescription: Alpha\n---\n# Alpha\n' });
    const h = makeHarness({ daemonHome, skills: [skill] });
    try {
      const prevA = await h.preview.handleProvidersV2({ intent: h.intent(rootA, ['alpha-skill']), viewNonce: nonce('a') }, h.context);
      const prevB = await h.preview.handleProvidersV2({ intent: h.intent(rootB, ['alpha-skill']), viewNonce: nonce('b') }, h.context);
      const prevC = await h.preview.handleProvidersV2({ intent: h.intent(rootC, ['alpha-skill']), viewNonce: nonce('c') }, h.context);
      const prevNested = await h.preview.handleProvidersV2({ intent: h.intent(nestedA, ['alpha-skill']), viewNonce: nonce('n') }, h.context);

      assert.equal(prevA.status, 'ready');
      assert.equal(prevA.applyEligibility.status, 'eligible');
      assert.equal(prevA.manifest.policy.writeCapability, 'multi_root_v1');
      assert.equal(prevB.status, 'ready');
      assert.equal(prevB.applyEligibility.status, 'eligible');
      assert.equal(prevC.status, 'ready');
      assert.equal(prevC.applyEligibility.status, 'ineligible');
      assert.equal(prevNested.status, 'ready');
      assert.equal(prevNested.applyEligibility.status, 'ineligible');

      // Disable rootA: rootA's receipt is invalidated, rootB's receipt STILL succeeds!
      const disA = JSON.parse((await runCli(['disable', '--home', daemonHome, '--root', rootA])).stdout);
      assert.equal(disA.enabled, false);

      const applyA = await h.apply.create({
        previewId: prevA.receipt.previewId,
        planDigest: prevA.receipt.planDigest,
        viewNonce: prevA.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, h.context);
      assert.deepEqual(applyA, { status: 'error', code: 'receipt_invalid' });

      const applyB = await h.apply.create({
        previewId: prevB.receipt.previewId,
        planDigest: prevB.receipt.planDigest,
        viewNonce: prevB.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, h.context);
      assert.equal(applyB.status, 'operation');
      assert.equal(applyB.phase, 'completed');

      // Re-enable rootA with --rotate, get fresh receipt, then revoke rootA -> receipt invalidated.
      await runCli(['enable', '--home', daemonHome, '--root', rootA, '--rotate']);
      const prevA2 = await h.preview.handleProvidersV2({ intent: h.intent(rootA, ['alpha-skill']), viewNonce: nonce('a2') }, h.context);
      assert.equal(prevA2.status, 'ready');
      assert.equal(prevA2.applyEligibility.status, 'eligible');

      const revA = JSON.parse((await runCli(['revoke', '--home', daemonHome, '--root', rootA])).stdout);
      assert.equal(revA.status, 'revoked');
      const applyA2 = await h.apply.create({
        previewId: prevA2.receipt.previewId,
        planDigest: prevA2.receipt.planDigest,
        viewNonce: prevA2.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, h.context);
      assert.deepEqual(applyA2, { status: 'error', code: 'receipt_invalid' });

      // Relay enabled mid-session fails closed before target mutation.
      await runCli(['enroll', '--home', daemonHome, '--root', rootA]);
      const prevA3 = await h.preview.handleProvidersV2({ intent: h.intent(rootA, ['alpha-skill']), viewNonce: nonce('a3') }, h.context);
      assert.equal(prevA3.status, 'ready');
      assert.equal(prevA3.applyEligibility.status, 'eligible');
      await fs.writeFile(join(daemonHome, 'config.json'), JSON.stringify({ relay: { enabled: true } }), { mode: 0o600 });
      const applyRelay = await h.apply.create({
        previewId: prevA3.receipt.previewId,
        planDigest: prevA3.receipt.planDigest,
        viewNonce: prevA3.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, h.context);
      assert.deepEqual(applyRelay, { status: 'error', code: 'receipt_invalid' });
      await fs.unlink(join(daemonHome, 'config.json'));
    } finally {
      await h.dispose();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('AT-2: multi-skill Apply (3 skills, supporting files, 0755 executable, existing skills preserved, whole-plan conflict reject)', { skip: !supported, timeout: 60000 }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p1-at2-')));
  const daemonHome = join(base, 'daemon');
  const project = join(base, 'project');
  await fs.mkdir(daemonHome, { mode: 0o700 });
  await fs.mkdir(join(project, '.agents', 'skills', 'pre-existing'), { recursive: true, mode: 0o755 });
  const existingPath = join(project, '.agents', 'skills', 'pre-existing', 'SKILL.md');
  await fs.writeFile(existingPath, '---\nname: pre-existing\ndescription: Keep me\n---\n# Keep\n', { mode: 0o644 });
  const existingBefore = await fs.lstat(existingPath, { bigint: true });
  const existingHashBefore = sha256(await fs.readFile(existingPath));

  try {
    const enrolled = await enrollMultiRoot({ daemonHome, root: project, environment, enabled: true });
    assert.equal(enrolled.status, 'enrolled');

    const skills = [
      makeSkill('skill-one', {
        'SKILL.md': '---\nname: skill-one\ndescription: One\n---\n# One\n',
        'references/guide.md': '# Guide\n',
      }),
      makeSkill('skill-two', {
        'SKILL.md': '---\nname: skill-two\ndescription: Two\n---\n# Two\n',
        'scripts/check.sh': { content: '#!/bin/sh\necho ok\n', mode: '100755' },
      }),
      makeSkill('skill-three', {
        'SKILL.md': '---\nname: skill-three\ndescription: Three\n---\n# Three\n',
        'applicability.json': '{"schemaVersion":1}\n',
      }),
    ];

    const h = makeHarness({ daemonHome, skills });
    try {
      const prev = await h.preview.handleProvidersV2({
        intent: h.intent(project, ['skill-one', 'skill-two', 'skill-three']),
        viewNonce: nonce('at2'),
      }, h.context);
      assert.equal(prev.status, 'ready');
      assert.equal(prev.applyEligibility.status, 'eligible');

      const applied = await h.apply.create({
        previewId: prev.receipt.previewId,
        planDigest: prev.receipt.planDigest,
        viewNonce: prev.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, h.context);
      assert.equal(applied.status, 'operation');
      assert.equal(applied.phase, 'completed');
      assert.equal(applied.durability, 'fsync_completed');

      // Verify executable 0755 mode & supporting files.
      const execStat = await fs.lstat(join(project, '.agents/skills/skill-two/scripts/check.sh'));
      assert.equal(execStat.mode & 0o777, 0o755);
      const refStat = await fs.lstat(join(project, '.agents/skills/skill-one/references/guide.md'));
      assert.equal(refStat.mode & 0o777, 0o644);

      // Existing skill preserved 100%.
      const existingAfter = await fs.lstat(existingPath, { bigint: true });
      assert.equal(existingAfter.ino, existingBefore.ino);
      assert.equal(sha256(await fs.readFile(existingPath)), existingHashBefore);

      // Second preview returns no_changes.
      const prev2 = await h.preview.handleProvidersV2({
        intent: h.intent(project, ['skill-one', 'skill-two', 'skill-three']),
        viewNonce: nonce('at2-noop'),
      }, h.context);
      assert.equal(prev2.status, 'ready');
      assert.equal(prev2.applyEligibility.status, 'no_changes');

      // Whole-plan conflict reject: add a 4th skill + corrupt 1 existing file -> whole plan blocked, 4th skill NOT created.
      await fs.writeFile(join(project, '.agents/skills/skill-one/SKILL.md'), 'modified locally\n');
      const skillsWith4 = [...skills, makeSkill('skill-four', { 'SKILL.md': '---\nname: skill-four\ndescription: Four\n---\n# Four\n' })];
      const h2 = makeHarness({ daemonHome, skills: skillsWith4 });
      try {
        const prevConflict = await h2.preview.handleProvidersV2({
          intent: h2.intent(project, ['skill-one', 'skill-four']),
          viewNonce: nonce('at2-conflict'),
        }, h2.context);
        assert.equal(prevConflict.status, 'ready');
        assert.equal(prevConflict.applyEligibility.status, 'ineligible');
        assert.ok(prevConflict.applyEligibility.reasons.includes('plan_conflict'));
        const rej = await h2.apply.create({
          previewId: prevConflict.receipt.previewId,
          planDigest: prevConflict.receipt.planDigest,
          viewNonce: prevConflict.receipt.viewNonce,
          operationId: opId(),
          approval: 'create_only_v1',
        }, h2.context);
        assert.deepEqual(rej, { status: 'error', code: 'plan_not_applicable' });
        await assert.rejects(fs.lstat(join(project, '.agents/skills/skill-four')));
      } finally {
        await h2.dispose();
      }
    } finally {
      await h.dispose();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('AT-3: canonical + Kiro derived Apply on Git root and linked worktree, partial failure recovery, and Git proof drift', { skip: !supported, timeout: 60000 }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p1-at3-')));
  const daemonHome = join(base, 'daemon');
  const gitRoot = join(base, 'repo-main');
  const worktree = join(base, 'repo-worktree');
  const partialRepo = join(base, 'repo-partial');
  await fs.mkdir(daemonHome, { mode: 0o700 });
  await fs.mkdir(gitRoot, { mode: 0o700 });
  await fs.mkdir(partialRepo, { mode: 0o700 });

  try {
    await initGitRepo(gitRoot);
    await exec('git', ['-C', gitRoot, 'worktree', 'add', '-b', 'wt-branch', worktree]);
    await initGitRepo(partialRepo);

    for (const r of [gitRoot, worktree, partialRepo]) {
      const enr = await enrollMultiRoot({ daemonHome, root: r, environment, enabled: true });
      assert.equal(enr.status, 'enrolled');
    }

    const skill = makeSkill('kiro-ready', {
      'SKILL.md': '---\nname: kiro-ready\ndescription: Kiro test\n---\n# Kiro Ready\n',
      'scripts/helper.sh': { content: '#!/bin/sh\necho hi\n', mode: '100755' },
    });

    // 1. Git root + linked worktree Apply with Codex + Kiro.
    const h = makeHarness({ daemonHome, skills: [skill] });
    try {
      for (const target of [gitRoot, worktree]) {
        const prev = await h.preview.handleProvidersV2({
          intent: h.intent(target, ['kiro-ready'], ['codex', 'kiro']),
          viewNonce: nonce('at3'),
        }, h.context);
        assert.equal(prev.status, 'ready');
        assert.equal(prev.applyEligibility.status, 'eligible');
        assert.equal(prev.manifest.plan.derivedEntries.length, 2);

        const applied = await h.apply.create({
          previewId: prev.receipt.previewId,
          planDigest: prev.receipt.planDigest,
          viewNonce: prev.receipt.viewNonce,
          operationId: opId(),
          approval: 'create_only_v1',
        }, h.context);
        assert.equal(applied.status, 'operation');
        assert.equal(applied.phase, 'completed');

        // Verify byte & mode parity between .agents/skills and .kiro/skills.
        for (const rel of ['SKILL.md', 'scripts/helper.sh']) {
          const canonBytes = await fs.readFile(join(target, '.agents/skills/kiro-ready', rel));
          const kiroBytes = await fs.readFile(join(target, '.kiro/skills/kiro-ready', rel));
          assert.deepEqual(kiroBytes, canonBytes);
          const canonMode = (await fs.lstat(join(target, '.agents/skills/kiro-ready', rel))).mode & 0o777;
          const kiroMode = (await fs.lstat(join(target, '.kiro/skills/kiro-ready', rel))).mode & 0o777;
          assert.equal(kiroMode, canonMode);
        }

        // Second preview returns no_changes.
        const noop = await h.preview.handleProvidersV2({
          intent: h.intent(target, ['kiro-ready'], ['codex', 'kiro']),
          viewNonce: nonce('at3-noop'),
        }, h.context);
        assert.equal(noop.status, 'ready');
        assert.equal(noop.applyEligibility.status, 'no_changes');
      }

      // 2. Git root proof drift between Preview and Apply fails before write.
      const driftRepo = join(base, 'repo-drift');
      await fs.mkdir(driftRepo, { mode: 0o700 });
      await initGitRepo(driftRepo);
      await enrollMultiRoot({ daemonHome, root: driftRepo, environment, enabled: true });
      const prevDrift = await h.preview.handleProvidersV2({
        intent: h.intent(driftRepo, ['kiro-ready'], ['kiro']),
        viewNonce: nonce('at3-drift'),
      }, h.context);
      assert.equal(prevDrift.status, 'ready');
      assert.equal(prevDrift.applyEligibility.status, 'eligible');
      await fs.rm(join(driftRepo, '.git'), { recursive: true, force: true });
      const applyDrift = await h.apply.create({
        previewId: prevDrift.receipt.previewId,
        planDigest: prevDrift.receipt.planDigest,
        viewNonce: prevDrift.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, h.context);
      assert.equal(applyDrift.status, 'operation');
      assert.equal(applyDrift.phase, 'failed_before_write');
      assert.equal(applyDrift.code, 'stale_plan');
      assert.equal(applyDrift.targetMutated, false);
    } finally {
      await h.dispose();
    }

    // 3. Partial failure between canonical and Kiro derived -> recovery -> second Apply finishes Kiro only.
    let injectFault = true;
    const hPartial = makeHarness({
      daemonHome,
      skills: [skill],
      testHooks: {
        controls: () => injectFault ? {
          barriers: [],
          faults: [{ point: 'write', destination: '.kiro/skills/kiro-ready/SKILL.md', error: 'ENOSPC' }],
        } : undefined,
      },
    });
    try {
      const prev1 = await hPartial.preview.handleProvidersV2({
        intent: hPartial.intent(partialRepo, ['kiro-ready'], ['codex', 'kiro']),
        viewNonce: nonce('at3-part1'),
      }, hPartial.context);
      assert.equal(prev1.status, 'ready');
      assert.equal(prev1.applyEligibility.status, 'eligible');

      const partialOp = await hPartial.apply.create({
        previewId: prev1.receipt.previewId,
        planDigest: prev1.receipt.planDigest,
        viewNonce: prev1.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, hPartial.context);
      assert.equal(partialOp.status, 'operation');
      assert.equal(partialOp.phase, 'partial_failure');
      assert.equal(partialOp.targetMutated, true);
      assert.equal(partialOp.requiresPreview, true);

      // Canonical files are already created_verified; record their inodes.
      const canonSkillIno = (await fs.lstat(join(partialRepo, '.agents/skills/kiro-ready/SKILL.md'), { bigint: true })).ino;
      assert.equal(partialOp.ledger.find(r => r.destination === '.agents/skills/kiro-ready/SKILL.md')?.state, 'created_verified');
      assert.equal(partialOp.ledger.find(r => r.destination === '.kiro/skills/kiro-ready/SKILL.md')?.state, 'created_incomplete');

      // Before manual cleanup, Preview blocks because incomplete Kiro file conflicts.
      const prevBlocked = await hPartial.preview.handleProvidersV2({
        intent: hPartial.intent(partialRepo, ['kiro-ready'], ['codex', 'kiro']),
        viewNonce: nonce('at3-part-blocked'),
      }, hPartial.context);
      assert.equal(prevBlocked.status, 'ready');
      assert.equal(prevBlocked.applyEligibility.status, 'ineligible');

      // Operator cleans up the incomplete Kiro file outside Safe Apply.
      await fs.unlink(join(partialRepo, '.kiro/skills/kiro-ready/SKILL.md'));
      injectFault = false;

      // Second Preview: canonical is unchanged, Kiro SKILL.md is create -> eligible!
      const prev2 = await hPartial.preview.handleProvidersV2({
        intent: hPartial.intent(partialRepo, ['kiro-ready'], ['codex', 'kiro']),
        viewNonce: nonce('at3-part2'),
      }, hPartial.context);
      assert.equal(prev2.status, 'ready');
      assert.equal(prev2.applyEligibility.status, 'eligible');
      assert.ok(prev2.manifest.plan.entries.every(e => e.status === 'unchanged'));
      assert.equal(prev2.manifest.plan.derivedEntries.find(e => e.destination === '.kiro/skills/kiro-ready/SKILL.md')?.status, 'create');

      const finishOp = await hPartial.apply.create({
        previewId: prev2.receipt.previewId,
        planDigest: prev2.receipt.planDigest,
        viewNonce: prev2.receipt.viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, hPartial.context);
      assert.equal(finishOp.status, 'operation');
      assert.equal(finishOp.phase, 'completed');
      // Canonical inode untouched!
      assert.equal((await fs.lstat(join(partialRepo, '.agents/skills/kiro-ready/SKILL.md'), { bigint: true })).ino, canonSkillIno);
    } finally {
      await hPartial.dispose();
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('AT-5: concurrent clients busy/idempotency, receipt eviction (>8), and journal retention', { skip: !supported, timeout: 60000 }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m4p1-at5-')));
  const daemonHome = join(base, 'daemon');
  const root1 = join(base, 'r1');
  const root2 = join(base, 'r2');
  for (const d of [daemonHome, root1, root2]) await fs.mkdir(d, { mode: 0o700 });

  try {
    await enrollMultiRoot({ daemonHome, root: root1, environment, enabled: true });
    await enrollMultiRoot({ daemonHome, root: root2, environment, enabled: true });
    const skill = makeSkill('conc-skill', { 'SKILL.md': '---\nname: conc-skill\ndescription: Conc\n---\n# Conc\n' });

    // 1. Concurrent Apply calls: first enters beforeAdmission/barrier, second returns busy; same opId joins idempotently.
    let releaseFirst;
    const firstEntered = new Promise(resolve => { releaseFirst = resolve; });
    const h = makeHarness({
      daemonHome,
      skills: [skill],
      testHooks: {
        beforeAdmission: () => { releaseFirst(); },
      },
    });
    try {
      const p1 = await h.preview.handleProvidersV2({ intent: h.intent(root1, ['conc-skill']), viewNonce: nonce('c1') }, h.context);
      const p2 = await h.preview.handleProvidersV2({ intent: h.intent(root2, ['conc-skill']), viewNonce: nonce('c2') }, h.context);
      assert.equal(p1.status, 'ready');
      assert.equal(p2.status, 'ready');

      const op1 = opId();
      const req1 = { previewId: p1.receipt.previewId, planDigest: p1.receipt.planDigest, viewNonce: p1.receipt.viewNonce, operationId: op1, approval: 'create_only_v1' };
      const req2 = { previewId: p2.receipt.previewId, planDigest: p2.receipt.planDigest, viewNonce: p2.receipt.viewNonce, operationId: opId(), approval: 'create_only_v1' };

      const prom1 = h.apply.create(req1, h.context);
      const prom1Dup = h.apply.create(req1, h.context);
      const prom1Mismatch = h.apply.create({ ...req1, viewNonce: 'different-nonce' }, h.context);
      const prom2 = h.apply.create(req2, h.context);
      await firstEntered;

      const [r1, r1Dup, r1Mis, r2] = await Promise.all([prom1, prom1Dup, prom1Mismatch, prom2]);
      assert.equal(r1.status, 'operation');
      assert.equal(r1.phase, 'completed');
      assert.deepEqual(r1Dup, r1);
      assert.deepEqual(r1Mis, { status: 'error', code: 'operation_mismatch' });
      assert.deepEqual(r2, { status: 'error', code: 'busy' });

      // 2. Receipt eviction: issue 9 receipts -> 1st is evicted, 9th succeeds.
      const issued = [];
      for (let i = 0; i < 9; i++) {
        const p = await h.preview.handleProvidersV2({ intent: h.intent(root2, ['conc-skill']), viewNonce: nonce(`ev${i}`) }, h.context);
        assert.equal(p.status, 'ready');
        issued.push(p.receipt);
      }
      const evictedApply = await h.apply.create({
        previewId: issued[0].previewId,
        planDigest: issued[0].planDigest,
        viewNonce: issued[0].viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, h.context);
      assert.deepEqual(evictedApply, { status: 'error', code: 'receipt_invalid' });

      const newestApply = await h.apply.create({
        previewId: issued[8].previewId,
        planDigest: issued[8].planDigest,
        viewNonce: issued[8].viewNonce,
        operationId: opId(),
        approval: 'create_only_v1',
      }, h.context);
      assert.equal(newestApply.status, 'operation');
      assert.equal(newestApply.phase, 'completed');
    } finally {
      await h.dispose();
    }

    // 3. Journal retention: 64 active records -> journal_full; after 24h expired terminals pruned while recovery_required kept.
    const jDir = join(base, 'journal-test');
    await fs.mkdir(jDir, { mode: 0o700 });
    let clock = 1_700_000_000_000;
    const journal = new ApplyJournal(jDir, () => clock);
    const makeRec = (phase) => ({
      hostId,
      installation: 'test-slot',
      instance: 'c'.repeat(64),
      requestHash: sha256(opId()),
      receiptHash: sha256(opId()),
      operation: {
        status: 'operation',
        operationId: opId(),
        planDigest: 'd'.repeat(64),
        phase,
        code: 'none',
        targetMutated: phase === 'completed',
        requiresPreview: phase === 'recovery_required',
        durability: phase === 'completed' ? 'fsync_completed' : 'not_confirmed',
        ledger: [],
      },
    });
    const recKeep = makeRec('recovery_required');
    journal.publish(recKeep, true);
    for (let i = 0; i < 63; i++) journal.publish(makeRec('completed'), true);
    assert.equal(journal.checkAdmission(makeRec('accepted')), 'journal_full');
    clock += 24 * 60 * 60 * 1000 + 1000;
    assert.equal(journal.checkAdmission(makeRec('accepted')), undefined);
    assert.ok(journal.read(recKeep.operation.operationId), 'recovery_required record must be retained');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
