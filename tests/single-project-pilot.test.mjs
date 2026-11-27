import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogSource } from '../shared/catalog-settings.ts';
import { createCanonicalPreviewHandler } from '../server/canonical-preview.ts';
import { createSingleProjectApply } from '../server/fixture-apply.ts';
import { PreviewReceiptStore } from '../server/preview-receipts.ts';
import { runSingleProjectWriter } from '../server/native-writer.ts';
import { singleProjectWriterRequest } from '../server/native-writer-contract.ts';
import {
  enrollSingleProjectRoot,
  pilotPolicyPath,
  readActiveSingleProjectPolicy,
  setSingleProjectOptIn,
  toEnrollmentBinding,
} from '../server/single-project-policy.ts';
import { probeSingleProjectRoot } from '../server/single-project-pilot.ts';

const supported = process.platform === 'darwin' && process.arch === 'arm64';
const environment = { paseoVersion: '0.17.5', sdkVersion: '0.17.4' };
const sha = 'a'.repeat(40);
const hostId = 'pilot-test-host';
const installation = 'paseo-project-skills-single-project-pilot';
const context = { paseo: { hosts: { list: async () => ({ self: { serverId: hostId } }) } } };

function descriptor(path, text, mode = '100644') {
  const bytes = Buffer.from(text);
  return {
    path,
    bytes,
    mode,
    sizeBytes: bytes.length,
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  };
}

function makeCatalog(extraFiles = []) {
  return {
    load: async () => ({
      schemaVersion: 1,
      source: catalogSource,
      commitSha: sha,
      skills: [{
        id: 'demo',
        directory: 'skills/demo',
        metadata: { name: 'demo', description: 'Pilot test skill' },
        entrypoint: descriptor('SKILL.md', '---\nname: demo\ndescription: Pilot test skill\n---\nPilot.\n'),
        supportingFiles: [
          descriptor('a.txt', 'alpha\n'),
          descriptor('b.txt', 'beta\n'),
          ...extraFiles,
        ],
      }],
    }),
  };
}

function makeSettings() {
  return {
    read: async () => ({ status: 'ready', revision: 'rev-1', values: { catalogRef: sha } }),
  };
}

async function fingerprint(path) {
  const st = await fs.lstat(path, { bigint: true });
  const hash = st.isFile() ? createHash('sha256').update(await fs.readFile(path)).digest('hex') : undefined;
  return { kind: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file', dev: String(st.dev), ino: String(st.ino), mode: Number(st.mode & 0o7777n), size: Number(st.size), hash };
}

async function withPilotHarness(fn, opts = {}) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-pilot-unit-')));
  const home = join(base, 'daemon');
  const root = join(base, 'project-copy');
  const sibling = join(base, 'sibling-project');
  const nested = join(root, 'nested-subproject');
  const alias = join(base, 'alias-link');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(sibling, { mode: 0o700 });
  await fs.mkdir(nested, { mode: 0o700 });
  await fs.symlink(root, alias);
  await fs.writeFile(join(root, 'sentinel.txt'), 'keep-me\n', { mode: 0o640 });
  await fs.writeFile(join(sibling, 'sentinel.txt'), 'sibling-keep\n', { mode: 0o640 });
  await fs.writeFile(join(nested, 'sentinel.txt'), 'nested-keep\n', { mode: 0o640 });

  const prevHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const settings = makeSettings();
  const catalog = makeCatalog(opts.extraFiles);
  const readPolicy = () => readActiveSingleProjectPolicy(home);
  const createInstance = (testHooks) => {
    const receipts = new PreviewReceiptStore({
      singleProject: () => {
        const active = readPolicy();
        return active ? toEnrollmentBinding(active) : undefined;
      },
    });
    const preview = createCanonicalPreviewHandler(settings, catalog, { receiptStore: receipts });
    const apply = createSingleProjectApply({
      daemonHome: home,
      installation,
      readPolicy,
      receipts,
      settings,
      catalog,
      environment,
      test: testHooks,
    });
    const previewV2 = async (target, viewNonce = 'nonce-1') => {
      const res = await preview.handleProvidersV2({
        viewNonce,
        intent: {
          schemaVersion: 1,
          hostId,
          canonicalDirectory: target,
          catalogSource,
          catalogCommitSha: sha,
          settingsRevision: 'rev-1',
          selectedSkillIds: ['demo'],
          targetProviderIds: [],
          recommendationRequestId: 'req-1',
        },
      }, context);
      if (res.status === 'ready' && res.applyEligibility.status === 'eligible') {
        const active = readPolicy();
        if (!active || !(await probeSingleProjectRoot(active, res.manifest.plan.intent.canonicalDirectory))) {
          return { ...res, applyEligibility: { status: 'ineligible', reasons: ['write_capability_unavailable'] } };
        }
      }
      return res;
    };
    return {
      receipts,
      preview,
      apply,
      previewV2,
      async dispose() {
        await apply.dispose();
        await preview.dispose();
      },
    };
  };

  try {
    return await fn({ base, home, root, sibling, nested, alias, createInstance, readPolicy });
  } finally {
    if (prevHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = prevHome;
    await fs.rm(base, { recursive: true, force: true });
  }
}

test('opt-in defaults to OFF; enrollment captures native identity; out-of-scope targets and policy changes block old receipts while Status stays readable', { skip: !supported, timeout: 60000 }, async () => {
  await withPilotHarness(async ({ home, root, sibling, nested, alias, createInstance }) => {
    const inst = createInstance();
    try {
      // 1. Default OFF: Preview is ineligible, direct Apply rejected.
      assert.equal(readActiveSingleProjectPolicy(home), undefined);
      const offPreview = await inst.previewV2(root, 'off-1');
      assert.equal(offPreview.status, 'ready');
      assert.deepEqual(offPreview.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });
      assert.equal(offPreview.manifest.policy.writeCapability, 'unavailable_m4_2');
      assert.equal(offPreview.manifest.policy.enrollment, undefined);
      const offApply = await inst.apply.create({
        previewId: offPreview.receipt.previewId,
        planDigest: offPreview.receipt.planDigest,
        viewNonce: offPreview.receipt.viewNonce,
        operationId: randomBytes(16).toString('hex'),
        approval: 'create_only_v1',
      }, context);
      assert.deepEqual(offApply, { status: 'error', code: 'receipt_invalid' });
      await assert.rejects(fs.lstat(join(root, '.agents')), { code: 'ENOENT' });

      // 2. Enrollment rejects symlink alias.
      const aliasEnroll = await enrollSingleProjectRoot({ daemonHome: home, root: alias, environment });
      assert.equal(aliasEnroll.status, 'error');

      // 3. Enroll exact canonical root.
      const enrolled = await enrollSingleProjectRoot({ daemonHome: home, root, environment });
      assert.equal(enrolled.status, 'enrolled');
      assert.equal(enrolled.policy.enrollment.canonicalRoot, root);
      assert.equal(enrolled.policy.enrollment.ancestors[0].path, '/');
      assert.equal(enrolled.policy.enrollment.ancestors.at(-1).path, root);
      assert.equal(enrolled.policy.enrollment.volume.fstype, 'apfs');
      assert.equal(enrolled.policy.enrollment.volume.caseMode, 'insensitive');

      // 4. Sibling, nested, and symlink alias are ineligible / rejected.
      for (const bad of [sibling, nested]) {
        const p = await inst.previewV2(bad, 'scope-bad');
        assert.equal(p.status, 'ready');
        assert.deepEqual(p.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });
        const a = await inst.apply.create({
          previewId: p.receipt.previewId,
          planDigest: p.receipt.planDigest,
          viewNonce: p.receipt.viewNonce,
          operationId: randomBytes(16).toString('hex'),
          approval: 'create_only_v1',
        }, context);
        assert.deepEqual(a, { status: 'error', code: 'receipt_invalid' });
        await assert.rejects(fs.lstat(join(bad, '.agents')), { code: 'ENOENT' });
      }
      const aliasPreview = await inst.previewV2(alias, 'scope-alias');
      assert.equal(aliasPreview.status, 'error');

      // 5. Enrolled root is eligible and receipt binds policyRevision + rootIdentity.
      const p1 = await inst.previewV2(root, 'rev-bind-1');
      assert.equal(p1.status, 'ready');
      assert.deepEqual(p1.applyEligibility, { status: 'eligible' });
      assert.equal(p1.manifest.policy.writeCapability, 'single_project_v1');
      assert.equal(p1.manifest.policy.enrollment.policyRevision, enrolled.policy.enrollment.policyRevision);
      assert.equal(p1.manifest.policy.enrollment.rootIdentity.ino, enrolled.policy.enrollment.ancestors.at(-1).ino);

      // 6. Turning opt-in OFF invalidates p1 receipt.
      setSingleProjectOptIn(home, false);
      const afterOff = await inst.apply.create({
        previewId: p1.receipt.previewId,
        planDigest: p1.receipt.planDigest,
        viewNonce: p1.receipt.viewNonce,
        operationId: randomBytes(16).toString('hex'),
        approval: 'create_only_v1',
      }, context);
      assert.deepEqual(afterOff, { status: 'error', code: 'receipt_invalid' });

      // 7. Re-enabling with rotated policyRevision still rejects old p1 receipt.
      setSingleProjectOptIn(home, true, true);
      const afterRotate = await inst.apply.create({
        previewId: p1.receipt.previewId,
        planDigest: p1.receipt.planDigest,
        viewNonce: p1.receipt.viewNonce,
        operationId: randomBytes(16).toString('hex'),
        approval: 'create_only_v1',
      }, context);
      assert.deepEqual(afterRotate, { status: 'error', code: 'receipt_invalid' });

      // 8. Fresh Preview + Apply succeeds, then Preview reports no-op.
      const p2 = await inst.previewV2(root, 'apply-ok');
      assert.equal(p2.status, 'ready');
      assert.deepEqual(p2.applyEligibility, { status: 'eligible' });
      const opId = randomBytes(16).toString('hex');
      const applied = await inst.apply.create({
        previewId: p2.receipt.previewId,
        planDigest: p2.receipt.planDigest,
        viewNonce: p2.receipt.viewNonce,
        operationId: opId,
        approval: 'create_only_v1',
      }, context);
      assert.equal(applied.status, 'operation');
      assert.equal(applied.phase, 'completed');
      assert.equal(applied.targetMutated, true);

      const noop = await inst.previewV2(root, 'noop-after');
      assert.equal(noop.status, 'ready');
      assert.deepEqual(noop.applyEligibility, { status: 'no_changes' });

      // 9. Turning opt-in OFF and deleting enrollment STILL allows read-only Status on original host/slot!
      setSingleProjectOptIn(home, false);
      assert.deepEqual(await inst.apply.status({ operationId: opId }, context), applied);
      await fs.unlink(pilotPolicyPath(home));
      assert.deepEqual(await inst.apply.status({ operationId: opId }, context), applied);
    } finally {
      await inst.dispose();
    }
  });
});

test('root replacement before Preview, after Preview, and move after linkage check (before_openat) isolate old vs replacement directory', { skip: !supported, timeout: 60000 }, async () => {
  await withPilotHarness(async ({ base, home, root, createInstance }) => {
    const enrolled = await enrollSingleProjectRoot({ daemonHome: home, root, environment });
    assert.equal(enrolled.status, 'enrolled');

    // A. Root replaced before Preview -> ineligible, replacement untouched.
    const movedA = join(base, 'moved-a');
    await fs.rename(root, movedA);
    await fs.mkdir(root, { mode: 0o700 });
    await fs.writeFile(join(root, 'replacement.txt'), 'new-root-a\n', { mode: 0o640 });
    const replBeforeA = await fingerprint(join(root, 'replacement.txt'));
    const instA = createInstance();
    try {
      const p = await instA.previewV2(root, 'repl-before');
      assert.equal(p.status, 'ready');
      assert.deepEqual(p.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });
      assert.deepEqual(await fingerprint(join(root, 'replacement.txt')), replBeforeA);
    } finally {
      await instA.dispose();
    }

    // Restore original enrolled root for B & C.
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(movedA, root);

    // B. Root replaced after Preview, before Apply -> rejected before mutation, replacement untouched.
    const instB = createInstance();
    try {
      const p = await instB.previewV2(root, 'repl-after');
      assert.equal(p.status, 'ready');
      assert.deepEqual(p.applyEligibility, { status: 'eligible' });
      const movedB = join(base, 'moved-b');
      await fs.rename(root, movedB);
      await fs.mkdir(root, { mode: 0o700 });
      await fs.writeFile(join(root, 'replacement.txt'), 'new-root-b\n', { mode: 0o640 });
      const replBeforeB = await fingerprint(join(root, 'replacement.txt'));
      const res = await instB.apply.create({
        previewId: p.receipt.previewId,
        planDigest: p.receipt.planDigest,
        viewNonce: p.receipt.viewNonce,
        operationId: randomBytes(16).toString('hex'),
        approval: 'create_only_v1',
      }, context);
      assert.equal(res.status, 'error');
      assert.equal(res.code, 'unsupported_environment');
      assert.deepEqual(await fingerprint(join(root, 'replacement.txt')), replBeforeB);
      await assert.rejects(fs.lstat(join(root, '.agents')), { code: 'ENOENT' });

      // Restore original root for C.
      await fs.rm(root, { recursive: true, force: true });
      await fs.rename(movedB, root);
    } finally {
      await instB.dispose();
    }

    // C. Move AFTER last linkage check (at before_openat barrier) on second file!
    // Expect: openat creates 0-byte 0600 file in OLD directory, immediate post-create linkage() detects replacement,
    // stops with partial_failure (linkage_changed), leaves REPLACEMENT directory 100% untouched!
    const movedC = join(base, 'moved-after-linkage');
    let replSentinelBefore;
    const instC = createInstance({
      controls: () => ({
        barriers: [{ point: 'before_openat', destination: '.agents/skills/demo/b.txt' }],
        faults: [],
      }),
      onEvent: async (event) => {
        if (event.event === 'barrier' && event.point === 'before_openat') {
          await fs.rename(root, movedC);
          await fs.mkdir(root, { mode: 0o700 });
          await fs.writeFile(join(root, 'replacement-c.txt'), 'untouched-replacement\n', { mode: 0o640 });
          replSentinelBefore = await fingerprint(join(root, 'replacement-c.txt'));
        }
      },
    });
    try {
      const p = await instC.previewV2(root, 'move-after-check');
      assert.equal(p.status, 'ready');
      assert.deepEqual(p.applyEligibility, { status: 'eligible' });
      const opId = randomBytes(16).toString('hex');
      const res = await instC.apply.create({
        previewId: p.receipt.previewId,
        planDigest: p.receipt.planDigest,
        viewNonce: p.receipt.viewNonce,
        operationId: opId,
        approval: 'create_only_v1',
      }, context);
      assert.equal(res.status, 'operation');
      assert.equal(res.phase, 'partial_failure');
      assert.equal(res.code, 'linkage_changed');
      assert.equal(res.targetMutated, true);
      assert.equal(res.requiresPreview, true);

      const rowA = res.ledger.find(r => r.destination === '.agents/skills/demo/a.txt');
      const rowB = res.ledger.find(r => r.destination === '.agents/skills/demo/b.txt');
      const rowSkill = res.ledger.find(r => r.destination === '.agents/skills/demo/SKILL.md');
      assert.equal(rowA.state, 'created_verified');
      assert.equal(rowB.state, 'created_incomplete');
      assert.equal(rowB.bytesWritten, 0);
      assert.equal(rowSkill.state, 'not_attempted');

      // Inspect OLD directory separately: has a.txt (verified), b.txt (0-byte 0600 matching ledger ino), no SKILL.md!
      const oldA = await fingerprint(join(movedC, '.agents/skills/demo/a.txt'));
      const oldB = await fingerprint(join(movedC, '.agents/skills/demo/b.txt'));
      assert.equal(oldA.ino, rowA.identity.ino);
      assert.equal(oldB.ino, rowB.identity.ino);
      assert.equal(oldB.size, 0);
      assert.equal(oldB.mode, 0o600);
      await assert.rejects(fs.lstat(join(movedC, '.agents/skills/demo/SKILL.md')), { code: 'ENOENT' });

      // Inspect REPLACEMENT directory separately: 100% untouched and NOT granted write capability!
      assert.deepEqual(await fingerprint(join(root, 'replacement-c.txt')), replSentinelBefore);
      await assert.rejects(fs.lstat(join(root, '.agents')), { code: 'ENOENT' });
      const postPreview = await instC.previewV2(root, 'post-replace');
      assert.equal(postPreview.status, 'ready');
      assert.deepEqual(postPreview.applyEligibility, { status: 'ineligible', reasons: ['write_capability_unavailable'] });
    } finally {
      await instC.dispose();
    }
  });
});

test('late collision, two writers racing same leaf, whole-plan conflict reject, and crash recovery', { skip: !supported, timeout: 60000 }, async () => {
  await withPilotHarness(async ({ home, root, createInstance }) => {
    const enrolled = await enrollSingleProjectRoot({ daemonHome: home, root, environment });
    assert.equal(enrolled.status, 'enrolled');

    // 1. Whole-plan reject on conflict.
    await fs.mkdir(join(root, '.agents/skills/demo'), { recursive: true, mode: 0o755 });
    await fs.writeFile(join(root, '.agents/skills/demo/a.txt'), 'conflict-bytes\n', { mode: 0o640 });
    const instConflict = createInstance();
    try {
      const p = await instConflict.previewV2(root, 'conflict-1');
      assert.equal(p.status, 'ready');
      assert.equal(p.applyEligibility.status, 'ineligible');
      assert.ok(p.applyEligibility.reasons.includes('plan_conflict'));
      const a = await instConflict.apply.create({
        previewId: p.receipt.previewId,
        planDigest: p.receipt.planDigest,
        viewNonce: p.receipt.viewNonce,
        operationId: randomBytes(16).toString('hex'),
        approval: 'create_only_v1',
      }, context);
      assert.deepEqual(a, { status: 'error', code: 'plan_not_applicable' });
    } finally {
      await instConflict.dispose();
    }
    await fs.unlink(join(root, '.agents/skills/demo/a.txt'));

    // 2. Late collision at native barrier before exclusive create -> foreign leaf untouched.
    let foreignBefore;
    const instLate = createInstance({
      controls: () => ({ barriers: [{ point: 'after_create_check', destination: '.agents/skills/demo/a.txt' }], faults: [] }),
      onEvent: async (event) => {
        if (event.event === 'barrier' && event.point === 'after_create_check') {
          const targetFile = join(root, '.agents/skills/demo/a.txt');
          await fs.writeFile(targetFile, 'foreign-late\n', { mode: 0o640 });
          foreignBefore = await fingerprint(targetFile);
        }
      },
    });
    try {
      const p = await instLate.previewV2(root, 'late-1');
      assert.deepEqual(p.applyEligibility, { status: 'eligible' });
      const res = await instLate.apply.create({
        previewId: p.receipt.previewId,
        planDigest: p.receipt.planDigest,
        viewNonce: p.receipt.viewNonce,
        operationId: randomBytes(16).toString('hex'),
        approval: 'create_only_v1',
      }, context);
      assert.equal(res.status, 'operation');
      assert.equal(res.phase, 'failed_before_write');
      assert.equal(res.code, 'destination_exists');
      assert.equal(res.targetMutated, false);
      assert.deepEqual(await fingerprint(join(root, '.agents/skills/demo/a.txt')), foreignBefore);
    } finally {
      await instLate.dispose();
    }
    await fs.unlink(join(root, '.agents/skills/demo/a.txt'));

    // 3. Crash recovery: kill helper after exclusive create -> restart -> Status returns recovery_required.
    const crashOpId = randomBytes(16).toString('hex');
    const instCrash = createInstance({
      controls: () => ({ barriers: [{ point: 'after_create', destination: '.agents/skills/demo/b.txt' }], faults: [] }),
      onEvent: async (event, { helperPid }) => {
        if (event.event === 'barrier' && event.point === 'after_create') {
          process.kill(helperPid, 'SIGKILL');
        }
      },
    });
    try {
      const p = await instCrash.previewV2(root, 'crash-1');
      assert.deepEqual(p.applyEligibility, { status: 'eligible' });
      const crashed = await instCrash.apply.create({
        previewId: p.receipt.previewId,
        planDigest: p.receipt.planDigest,
        viewNonce: p.receipt.viewNonce,
        operationId: crashOpId,
        approval: 'create_only_v1',
      }, context);
      assert.equal(crashed.status, 'operation');
      assert.equal(crashed.phase, 'recovery_required');
      assert.equal(crashed.code, 'terminal_record_missing');
      assert.equal(crashed.requiresPreview, true);
    } finally {
      await instCrash.dispose();
    }

    // Restarted instance (even with opt-in OFF!) reports recovery_required and leaves partial file intact.
    setSingleProjectOptIn(home, false);
    const instRestarted = createInstance();
    try {
      const status = await instRestarted.apply.status({ operationId: crashOpId }, context);
      assert.equal(status.status, 'operation');
      assert.equal(status.phase, 'recovery_required');
      assert.equal(status.code, 'terminal_record_missing');
      assert.equal(status.ledger.find(r => r.destination === '.agents/skills/demo/a.txt').state, 'created_verified');
      assert.equal(status.ledger.find(r => r.destination === '.agents/skills/demo/b.txt').state, 'ownership_unknown');
      assert.equal(status.ledger.find(r => r.destination === '.agents/skills/demo/SKILL.md').state, 'not_attempted');
      const diskB = await fingerprint(join(root, '.agents/skills/demo/b.txt'));
      assert.equal(diskB.size, 0);
      assert.equal(diskB.mode, 0o600);
    } finally {
      await instRestarted.dispose();
    }
  });
});

test('two single-project writers racing the same leaf allow exactly one exclusive create', { skip: !supported, timeout: 60000 }, async () => {
  await withPilotHarness(async ({ home, root, createInstance }) => {
    const enrolled = await enrollSingleProjectRoot({ daemonHome: home, root, environment });
    assert.equal(enrolled.status, 'enrolled');
    await fs.mkdir(join(root, '.agents/skills/demo'), { recursive: true, mode: 0o755 });
    const inst = createInstance();
    try {
      const p = await inst.previewV2(root, 'race-1');
      assert.equal(p.status, 'ready');
      assert.deepEqual(p.applyEligibility, { status: 'eligible' });
      const inspected = inst.receipts.inspectApply({
        previewId: p.receipt.previewId,
        planDigest: p.receipt.planDigest,
        viewNonce: p.receipt.viewNonce,
        hostId,
        installationInstanceId: inst.receipts.installationInstanceId,
      });
      assert.equal(inspected.status, 'ready');
      const req = singleProjectWriterRequest({
        enrollment: enrolled.policy.enrollment,
        manifest: inspected.manifest,
        planDigest: p.receipt.planDigest,
        sources: inspected.sources,
        environment,
        controls: { barriers: [{ point: 'before_openat', destination: '.agents/skills/demo/a.txt' }], faults: [] },
      });
      // Two writers with separate coordinators racing the same enrolled leaf via O_CREAT|O_EXCL.
      const c1 = join(home, 'runtime/project-skills-pilot/race-c1');
      const c2 = join(home, 'runtime/project-skills-pilot/race-c2');
      await fs.mkdir(c1, { recursive: true, mode: 0o700 });
      await fs.mkdir(c2, { recursive: true, mode: 0o700 });
      const both = Promise.withResolvers();
      const release = Promise.withResolvers();
      let arrived = 0;
      const onEvent = async (e) => {
        if (e.event === 'barrier' && e.point === 'before_openat') {
          if (++arrived === 2) both.resolve();
          await release.promise;
        }
      };
      const r1 = runSingleProjectWriter({ ...req, durableAdmission: true, coordinator: { directory: c1 } }, {
        testing: true, onEvent, onAdmission: async () => true, onProgress: () => {},
      });
      const r2 = runSingleProjectWriter({ ...req, durableAdmission: true, coordinator: { directory: c2 } }, {
        testing: true, onEvent, onAdmission: async () => true, onProgress: () => {},
      });
      await both.promise;
      release.resolve();
      const [o1, o2] = await Promise.all([r1, r2]);
      assert.deepEqual([o1.result.phase, o2.result.phase].sort(), ['completed', 'failed_before_write']);
      const loser = o1.result.phase === 'failed_before_write' ? o1 : o2;
      assert.equal(loser.result.code, 'destination_exists');
      assert.equal(loser.result.targetMutated, false);
    } finally {
      await inst.dispose();
    }
  });
});
