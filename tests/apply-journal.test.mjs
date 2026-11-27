import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyJournal, terminalRetentionMs } from '../server/apply-journal.ts';
import { applyCreateInputSchema } from '../shared/apply.ts';

const token = 'a'.repeat(64);
const input = {
  operationId: 'b'.repeat(32), previewId: token, planDigest: token,
  viewNonce: 'fixture', approval: 'create_only_v1',
};
test('Apply wire input admits only the receipt binding and operation ID', () => {
  assert.ok(applyCreateInputSchema.safeParse(input).success);
  for (const extra of [{ files: [] }, { hostId: 'fake' }, { canonicalDirectory: '/tmp' }, { controls: {} }]) {
    assert.equal(applyCreateInputSchema.safeParse({ ...input, ...extra }).success, false);
  }
  assert.equal(applyCreateInputSchema.safeParse({ ...input, operationId: 'short' }).success, false);
});

test('fixture journal publishes an exclusive receipt claim and atomic terminal replacement', {
  skip: process.platform !== 'darwin',
}, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'm44-journal-test-')));
  try {
    const journal = new ApplyJournal(directory);
    const record = {
      hostId: 'host', installation: 'fixture', instance: token, receiptHash: token, requestHash: token,
      operation: {
        status: 'operation', operationId: input.operationId, planDigest: token, phase: 'accepted',
        code: 'none', targetMutated: 'unknown', requiresPreview: false, durability: 'not_confirmed', ledger: [],
      },
    };
    assert.equal(journal.checkAdmission(record), undefined);
    journal.publish(record, true);
    const path = join(directory, input.operationId + '.json');
    assert.equal((await fs.lstat(path)).mode & 0o7777, 0o600);
    assert.deepEqual(new ApplyJournal(directory).read(input.operationId), record);
    assert.equal(journal.checkAdmission({ ...record, operation: { ...record.operation, operationId: 'c'.repeat(32) } }), 'receipt_consumed');
    assert.throws(() => journal.publish({ ...record, requestHash: 'c'.repeat(64) }, true), { code: 'EEXIST' });
    assert.deepEqual(journal.read(input.operationId), record);
    const terminal = { ...record, operation: { ...record.operation, phase: 'completed', targetMutated: true, durability: 'fsync_completed' } };
    journal.publish(terminal);
    assert.deepEqual(new ApplyJournal(directory).read(input.operationId)?.operation, terminal.operation);
    await fs.writeFile(path, '{bad');
    assert.throws(() => journal.checkAdmission({ ...record, receiptHash: 'd'.repeat(64) }));
    assert.deepEqual(await fs.readdir(directory), [input.operationId + '.json']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('full journal prunes expired terminal records and retains writing and recovery across restart', {skip:process.platform!=='darwin'}, async () => {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(),'m46-retention-')));
  let now = 1000;
  const clock = () => now;
  const record = (n, phase) => {
    const id = n.toString(16).padStart(32,'0');
    return { hostId:'host', installation:'slot', instance:token, requestHash:token,
      receiptHash:id.padStart(64,'0'), operation:{
        status:'operation', operationId:id, planDigest:token, phase, code:'none',
        targetMutated:'unknown', requiresPreview:phase==='recovery_required', durability:'not_confirmed', ledger:[],
      } };
  };
  try {
    const journal = new ApplyJournal(directory,clock);
    const finished = record(0,'completed'), recovery = record(1,'recovery_required'), active = record(2,'writing');
    for (let i=0;i<64;i++) journal.publish(i===0 ? finished : i===1 ? recovery : i===2 ? active : record(i,'accepted'),true);
    assert.equal(journal.checkAdmission(record(64,'accepted')),'journal_full');
    now += terminalRetentionMs - 1;
    const restarted = new ApplyJournal(directory,clock);
    assert.deepEqual(restarted.read(finished.operation.operationId).operation, finished.operation);
    assert.equal(restarted.checkAdmission(record(64,'accepted')),'journal_full');
    assert.equal(restarted.checkAdmission({...record(65,'accepted'),receiptHash:finished.receiptHash}),'receipt_consumed');
    now++;
    assert.equal(restarted.read(finished.operation.operationId),undefined);
    assert.equal(restarted.checkAdmission(record(64,'accepted')),undefined);
    await assert.rejects(fs.lstat(join(directory,finished.operation.operationId+'.json')), {code:'ENOENT'});
    assert.deepEqual(restarted.read(recovery.operation.operationId),recovery);
    assert.deepEqual(restarted.read(active.operation.operationId),active);
    restarted.publish(record(64,'accepted'),true);
    assert.equal(new ApplyJournal(directory,clock).checkAdmission(record(65,'accepted')),'journal_full');
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
