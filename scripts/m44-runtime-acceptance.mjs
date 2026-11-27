import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.M44_PASEO_CLI ?? '/Applications/Paseo.app/Contents/Resources/bin/paseo';
assert.equal((await exec(cli, ['--version'])).stdout.trim(), '0.17.5');
const sdkVersions = {};
for (const name of ['client', 'plugin', 'protocol']) {
  const pkg = JSON.parse(await fs.readFile(join(repo, 'node_modules/@getpaseo', name, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.17.4');
  sdkVersions[name] = pkg.version;
}
const sdk = await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/node/index.js')));
const { createPaseoApi } = await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/index.js')));
const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m43-m44-')));
console.log('M4.4 fixture evidence: ' + base);
const home = join(base, 'daemon');
const coordinator = join(home, 'runtime', 'project-skills-m44');
const leaf = '.agents/skills/demo/SKILL.md';
const sha = 'a'.repeat(40);
const cases = {};
const sdkIds = ['m44-fixture-a', 'm44-fixture-b'];
const operationId = () => randomBytes(16).toString('hex');
const faultIds = Object.fromEntries(['hold','late','journal','crash','reply','partial'].map(key => [key, operationId()]));
await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(join(home, 'runtime'), { mode: 0o700 });
await fs.mkdir(coordinator, { mode: 0o700 });
const plugins = {};
for (const id of sdkIds) {
  const folder = join(base, id);
  await fs.mkdir(folder, { mode: 0o700 });
  for (const directory of ['server', 'shared']) await fs.cp(join(repo, directory), join(folder, directory), { recursive: true });
  await fs.symlink(join(repo, 'node_modules'), join(folder, 'node_modules'));
  await fs.writeFile(join(folder, 'paseo-plugin.json'), JSON.stringify({ id, name: id, requirements: { paseo: '>=0.17.4' } }));
  await fs.writeFile(join(folder, 'index.server.ts'), `
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync, chmodSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { PreviewReceiptStore } from './server/preview-receipts';
import { createCanonicalPreviewHandler } from './server/canonical-preview';
import { createFixtureApply } from './server/fixture-apply';
import { catalogSource } from './shared/catalog-settings';
import { applyCreateRpc, applyStatusRpc } from './shared/apply';
import { providerPreviewV2Rpc } from './shared/rpc';
const base = ${JSON.stringify(base)}, ids = ${JSON.stringify(faultIds)}, leaf = ${JSON.stringify(leaf)};
const support = '.agents/skills/demo/a-data.bin';
const descriptor = (path, value, mode='100644') => {
  const bytes = Buffer.from(value);
  return { path, bytes, mode, sizeBytes: bytes.length,
    blobSha: createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex') };
};
const settings = { read: async () => ({status:'ready', revision:readFileSync(join(base,'revision'),'utf8'), values:{catalogRef:'fixture-ref'}}) };
const catalog = { load: async () => ({schemaVersion:1,source:catalogSource,commitSha:readFileSync(join(base,'sha'),'utf8'),
  skills:[{id:'demo',directory:'skills/demo',metadata:{name:'demo',description:'Fixture'},
    entrypoint:descriptor('SKILL.md','---\\nname: demo\\ndescription: Fixture\\n---\\nBody\\n'),
    supportingFiles:[descriptor('a-data.bin',[0,255,3]),descriptor('z-run.sh','#!/bin/sh\\n','100755')]}]}) };
async function gate(name, data) {
  const temporary = join(base,name+'.tmp'), path = join(base,name+'.ready');
  await fs.writeFile(temporary, JSON.stringify(data), {mode:0o600});
  await fs.rename(temporary,path);
  for (let i=0;i<250;i++) {
    try { await fs.access(join(base,name+'.release')); return; }
    catch { await new Promise(resolve=>setTimeout(resolve,40)); }
  }
  throw Error('fixture_barrier_timeout');
}
export default function(server) {
  const receipts = new PreviewReceiptStore();
  const preview = createCanonicalPreviewHandler(settings,catalog,{receiptStore:receipts});
  let extraction;
  const apply = createFixtureApply({ fixtureBase:base, installation:${JSON.stringify(id)}, settings, catalog, receipts,
    environment:{paseoVersion:'0.17.5',sdkVersion:'0.17.4'},
    test:{
      controls: input => {
        if (input.operationId===ids.partial) return {barriers:[],faults:[{point:'write',destination:support,afterBytes:1,error:'ENOSPC'}]};
        if (input.operationId===ids.crash) return {barriers:[{point:'after_create',destination:support}],faults:[]};
        if (input.operationId===ids.hold || input.operationId===ids.late)
          return {barriers:[{point:'after_create_check',destination:support}],faults:[]};
      },
      onExtracted: async directory => {
        const node = await fs.lstat(directory,{bigint:true});
        extraction = {directory,dev:String(node.dev),ino:String(node.ino)};
      },
      onEvent: async event => {
        if(event.event==='barrier') await gate('native-'+event.pid,{parent:process.pid,helper:event.pid,point:event.point,extraction});
      },
      beforeAdmission: input => {
        if(input.operationId===ids.journal) chmodSync(join(process.env.PASEO_HOME,'runtime/project-skills-m44'),0o500);
      },
      afterTerminal: async result => {
        if(result.operationId===ids.reply) await gate('reply',{pid:process.pid, operationId:result.operationId});
      },
    },
  });
  server.handle(providerPreviewV2Rpc,preview.handleProvidersV2);
  server.handle(applyCreateRpc,apply.create);
  server.handle(applyStatusRpc,apply.status);
  server.handle(defineRpc({name:'fixture.identity',input:z.strictObject({}),output:z.any()}),async(_input,ctx)=>({
    pid:process.pid,ppid:process.ppid,hostId:(await ctx.paseo.hosts.list()).self.serverId,
    context:Object.keys(ctx),catalogSource,home:process.env.PASEO_HOME,node:process.versions.node,electron:process.versions.electron,
    platform:process.platform,arch:process.arch
  }));
  return async()=>{await apply.dispose();await preview.dispose();};
}
`);
  plugins[id] = { source: 'directory', path: folder, enabled: true };
}

const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
await fs.writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, pluginsEnabled: true, plugins,
  daemon: { listen: '127.0.0.1:' + port, relay: { enabled: false } }, features: { voiceMode: { enabled: false } } }));
await fs.writeFile(join(base, 'revision'), 'rev');
await fs.writeFile(join(base, 'sha'), sha);
let daemon;
const clients = new Set();
async function start() {
  const handle = openSync(join(base, 'console.log'), 'a', 0o600);
  daemon = spawn(cli, ['daemon', 'run', '--home', home], { cwd: base, stdio: ['ignore', handle, handle] });
  closeSync(handle);
  for (let i = 0; i < 80; i++) {
    try {
      const { stdout } = await exec(cli, ['--home', home, 'plugin', 'ls', '--json'], { timeout: 2500 });
      const rows = JSON.parse(stdout);
      assert.ok(!rows.some(row => sdkIds.includes(row.id) && row.status === 'failed'), JSON.stringify(rows));
      if (sdkIds.every(id => rows.some(row => row.id === id && row.status === 'running'))) return;
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('fixture daemon did not start');
}
async function stop() {
  await Promise.allSettled([...clients].map(client => client.close()));
  clients.clear();
  if (!daemon) return;
  try { await exec(cli, ['--home', home, 'daemon', 'stop'], { timeout: 10000 }); }
  catch { daemon.kill('SIGTERM'); }
  const { stdout } = await exec(cli, ['--home', home, 'status', '--json'], { timeout: 3500 });
  const status = JSON.parse(stdout);
  assert.equal(status.localDaemon, 'stopped');
  assert.equal(status.pid, null);
  daemon = undefined;
  return status;
}
async function connect(name) {
  const client = sdk.createHostClient('127.0.0.1:' + port, { clientId: 'm44-' + name, clientType: 'cli', reconnect: { enabled: false } });
  clients.add(client);
  await client.connect();
  return client;
}
async function fingerprint(path) {
  const node = await fs.lstat(path, { bigint: true });
  return { dev: String(node.dev), ino: String(node.ino), mode: Number(node.mode & 0o7777n),
    ...(node.isSymbolicLink() && { link: await fs.readlink(path) }),
    ...(node.isFile() && { size: Number(node.size), sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex') }) };
}
async function tree(root) {
  const result = {};
  async function walk(path, relative) {
    result[relative] = await fingerprint(path);
    if ((await fs.lstat(path)).isDirectory()) {
      for (const name of (await fs.readdir(path)).sort()) await walk(join(path, name), relative === '.' ? name : relative+'/'+name);
    }
  }
  await walk(root, '.');
  return result;
}
async function fixture(name, git = false) {
  const root = join(base, name);
  await fs.mkdir(join(root, dirname(leaf)), { recursive: true, mode: 0o755 });
  await fs.writeFile(join(root, 'existing'), 'existing sentinel', { mode: 0o640 });
  if (git) await exec('git', ['-C', root, 'init', '-b', 'main']);
  return root;
}
const invoke = (client, plugin, rpc, input) => client.invokePluginRpc(plugin, rpc, input);
const apply = (client, plugin, input) => invoke(client, plugin, 'apply.create.v1', input);
const status = (client, plugin, operationId) => invoke(client, plugin, 'apply.status.v1', { operationId });
const reject = (result, code) => assert.deepEqual(result, { status: 'error', code });
const phase = (result, expected) => assert.equal(result.phase, expected, JSON.stringify(result));
const bound = (preview, id = operationId()) => {
  assert.equal(preview.status, 'ready', JSON.stringify(preview));
  const { previewId, planDigest, viewNonce } = preview.receipt;
  return { previewId, planDigest, viewNonce, operationId: id, approval: 'create_only_v1' };
};
let runtime;
async function preview(client, plugin, root, kiro = false) {
  return invoke(client, plugin, 'preview.providers.v2', { viewNonce:'fixture', intent: {
    schemaVersion: 1, hostId: runtime.hostId, canonicalDirectory: root, catalogSource: runtime.catalogSource,
    catalogCommitSha: sha, settingsRevision: 'rev', selectedSkillIds: ['demo'],
    targetProviderIds: kiro ? ['kiro'] : [], recommendationRequestId: 'fixture',
  }});
}
const waitFor = async (predicate, label) => {
  for (let i = 0; i < 200; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error('Fixture evidence timeout: ' + label);
};
const seen = new Set();
async function gate(prefix) {
  const name = await waitFor(async () => (await fs.readdir(base)).find(name => name.startsWith(prefix) && name.endsWith('.ready') && !seen.has(name)), prefix);
  seen.add(name);
  return { ...(JSON.parse(await fs.readFile(join(base, name), 'utf8'))), release: () => fs.writeFile(join(base, name.replace(/\.ready$/, '.release')), '') };
}
const tracked = promise => promise.then(value => ({ value }), error => ({ failure: error.code ?? 'transport_failure' }));
const existingMatch = (before, after) => {
  for (const [path, value] of Object.entries(before)) assert.deepEqual(after[path], value, path);
};
const verifyCompleted = (result, snapshot) => {
  for (const row of result.ledger.filter(row => row.expected && row.state === 'created_verified')) {
    const { dev, ino, mode, size, sha256 } = snapshot[row.destination];
    assert.deepEqual({ dev, ino }, row.identity);
    assert.deepEqual({ mode, sizeBytes: size, sha256 }, row.expected);
  }
};
const a = sdkIds[0], b = sdkIds[1];
try {
  await start();
  let one = await connect('one'), two = await connect('two');
  runtime = await invoke(one, a, 'fixture.identity', {});
  const peer = await invoke(two, b, 'fixture.identity', {});
  assert.notEqual(runtime.pid, peer.pid);
  assert.equal(runtime.ppid, peer.ppid);
  assert.equal(runtime.home, home);
  assert.deepEqual(runtime.context, ['paseo']);

  const root = await fixture('contention');
  const other = await fixture('peer-target');
  const before = await tree(root);
  const held = bound(await preview(one,a,root),faultIds.hold);
  const contender = bound(await preview(two,b,other));
  const running = apply(one,a,held);
  const barrier = await gate('native-');
  assert.equal(barrier.parent,runtime.pid);
  const inFlight = await status(two,a,held.operationId);
  phase(inFlight,'preflight');
  reject(await status(two,b,held.operationId),'outcome_unknown');
  reject(await apply(two,a,{...held,viewNonce:'other'}),'operation_mismatch');
  const duplicate = apply(two,a,held);
  reject(await apply(two,a,{...held,operationId:operationId()}),'busy');
  reject(await apply(two,b,contender),'busy');
  reject(await status(two,b,contender.operationId),'outcome_unknown');
  const lock = await fingerprint(join(coordinator,'writer.lock'));
  await barrier.release();
  const winner = await running; phase(winner,'completed');
  assert.deepEqual(await duplicate,winner);
  assert.deepEqual(await apply(two,a,held),winner);
  reject(await apply(two,a,{...held,operationId:operationId()}),'receipt_consumed');
  reject(await apply(two,b,{...held,operationId:operationId()}),'receipt_invalid');
  const after = await tree(root);
  existingMatch(before,after); verifyCompleted(winner,after);
  const peerResult = await apply(two,b,contender); phase(peerResult,'completed');
  assert.deepEqual(await fingerprint(join(coordinator,'writer.lock')),lock);
  cases.contention = { before, after, winner, peerResult, inFlight, lock };

  cases.stale = [];
  for (const variant of ['settings','sha','read_set','kiro','conflict','blocked']) {
    const target = await fixture('stale-'+variant,variant==='kiro');
    if (variant==='conflict') await fs.writeFile(join(target,leaf),'foreign conflict',{mode:0o640});
    if (variant==='blocked') await fs.symlink(join(target,'existing'),join(target,leaf));
    const input = bound(await preview(one,a,target,variant==='kiro'));
    if (variant==='settings') await fs.writeFile(join(base,'revision'),'new-rev');
    if (variant==='sha') await fs.writeFile(join(base,'sha'),'b'.repeat(40));
    if (variant==='read_set') await fs.writeFile(join(target,leaf),'late preflight',{mode:0o640});
    if (variant==='kiro') {
      await fs.rename(join(target,'.git'),join(base,'detached-git'));
      await exec('git',['-C',target,'init','-b','main']);
    }
    const before = await tree(target), result = await apply(one,a,input), after = await tree(target);
    if (variant==='conflict' || variant==='blocked') reject(result,'plan_not_applicable');
    else { phase(result,'failed_before_write'); assert.equal(result.code,'stale_plan'); assert.equal(result.targetMutated,false); }
    assert.deepEqual(after,before);
    cases.stale.push({variant,result,before,after});
    await fs.writeFile(join(base,'revision'),'rev');
    await fs.writeFile(join(base,'sha'),sha);
  }

  const kiroRoot = await fixture('kiro-approved',true), kiroBefore = await tree(kiroRoot);
  const kiroResult = await apply(one,a,bound(await preview(one,a,kiroRoot,true)));
  const kiroAfter = await tree(kiroRoot);
  phase(kiroResult,'completed');
  assert.ok(kiroResult.ledger.some(row=>row.destination.startsWith('.kiro/') &&
    row.canonicalDestination?.startsWith('.agents/')));
  existingMatch(kiroBefore,kiroAfter);
  verifyCompleted(kiroResult,kiroAfter);
  cases.kiro = { result:kiroResult,before:kiroBefore,after:kiroAfter };

  const late = await fixture('late');
  const lateInput = bound(await preview(one,a,late),faultIds.late);
  const lateRun = apply(one,a,lateInput), lateBarrier = await gate('native-');
  await fs.writeFile(join(late,'.agents/skills/demo/a-data.bin'),'foreign at create',{mode:0o640});
  const lateBefore = await tree(late);
  await lateBarrier.release();
  const collision = await lateRun;
  phase(collision,'failed_before_write'); assert.equal(collision.code,'destination_exists');
  const lateAfter = await tree(late); assert.deepEqual(lateAfter,lateBefore);
  cases.late = { collision, before:lateBefore, after:lateAfter };

  const bad = await fixture('journal-failure'), badBefore = await tree(bad);
  const badInput = bound(await preview(one,a,bad),faultIds.journal);
  const badResult = await apply(one,a,badInput);
  await fs.chmod(coordinator,0o700);
  reject(badResult,'journal_unavailable');
  reject(await status(one,a,badInput.operationId),'outcome_unknown');
  const badAfter = await tree(bad); assert.deepEqual(badBefore,badAfter);
  const badRetry = await apply(one,a,{...badInput,operationId:operationId()});
  phase(badRetry,'completed');
  cases.journal = { result:badResult, retry:badRetry, before:badBefore, after:badAfter };

  const partial = await fixture('partial'), partialBefore = await tree(partial);
  const partialResult = await apply(one,a,bound(await preview(one,a,partial),faultIds.partial));
  phase(partialResult,'partial_failure');
  assert.equal(partialResult.ledger.find(row=>row.state==='created_incomplete').bytesWritten,1);
  assert.ok(partialResult.ledger.some(row=>row.state==='not_attempted'));
  const partialAfter = await tree(partial); existingMatch(partialBefore,partialAfter);
  assert.equal(partialAfter['.agents/skills/demo/a-data.bin'].size,1);
  cases.partial = { result:partialResult,before:partialBefore,after:partialAfter };

  const replyTarget = await fixture('lost-reply'), replyBefore = await tree(replyTarget);
  const replyInput = bound(await preview(one,a,replyTarget),faultIds.reply);
  const disconnected = tracked(apply(one,a,replyInput));
  const replyGate = await gate('reply');
  const terminal = await status(two,a,replyInput.operationId); phase(terminal,'completed');
  await one.close(); clients.delete(one);
  const lost = await disconnected; assert.ok(lost.failure,JSON.stringify(lost));
  await replyGate.release();
  assert.deepEqual(await apply(two,a,replyInput),terminal);
  const replyAfter = await tree(replyTarget); existingMatch(replyBefore,replyAfter); verifyCompleted(terminal,replyAfter);
  cases.lostReply = { lost, terminal, before:replyBefore, after:replyAfter };

  const crashTarget = await fixture('crash'), crashBefore = await tree(crashTarget);
  const crashInput = bound(await preview(two,a,crashTarget),faultIds.crash);
  const crash = tracked(apply(two,a,crashInput)), crashGate = await gate('native-');
  const writing = await status(two,a,crashInput.operationId); phase(writing,'writing');
  assert.equal(writing.ledger[0].state,'ownership_unknown');
  const afterCreate = await tree(crashTarget);
  const created = afterCreate['.agents/skills/demo/a-data.bin'];
  assert.equal(created.mode,0o600); assert.equal(created.size,0);
  existingMatch(crashBefore,afterCreate);
  process.kill(crashGate.parent,'SIGKILL');
  const crashReply = await crash; assert.ok(crashReply.failure);
  await stop(); await start(); two = await connect('after-restart');
  const restarted = await invoke(two,a,'fixture.identity',{});
  assert.notEqual(restarted.pid,runtime.pid);
  assert.equal(restarted.hostId,runtime.hostId);
  const recovered = await status(two,a,crashInput.operationId);
  phase(recovered,'recovery_required');
  assert.equal(recovered.targetMutated,'unknown');
  assert.equal(recovered.ledger[0].state,'ownership_unknown');
  assert.deepEqual(await apply(two,a,crashInput),recovered);
  reject(await apply(two,a,{...crashInput,operationId:operationId()}),'receipt_invalid');
  assert.deepEqual(await tree(crashTarget),afterCreate);
  assert.deepEqual(await status(two,a,replyInput.operationId),terminal);
  assert.deepEqual(await apply(two,a,replyInput),terminal);
  assert.deepEqual(await tree(replyTarget),replyAfter);
  const postRestart = await fixture('post-restart');
  phase(await apply(two,a,bound(await preview(two,a,postRestart))),'completed');
  assert.deepEqual(await fingerprint(join(coordinator,'writer.lock')),lock);
  const extraction = crashGate.extraction;
  const orphan = await fingerprint(extraction.directory);
  assert.ok(extraction.directory.startsWith(await fs.realpath(tmpdir())+'/pps-helper-m43-'));
  assert.equal(orphan.ino,extraction.ino); assert.equal(orphan.dev,extraction.dev); assert.equal(orphan.mode,0o700);
  await fs.rm(extraction.directory,{recursive:true});
  assert.equal((await createPaseoApi(two).agents.list()).entries.length,0);
  cases.restart = { restarted, crashReply, writing, recovered, before:crashBefore, after:afterCreate, terminalRetry:terminal, lockReusedAfterRestart:true, privateOrphanRemovedByHarness:true };
  const logs = await fs.readFile(join(base,'console.log'),'utf8');
  assert.ok(logs.includes('"daemonVersion":"0.17.5"'));
  await fs.writeFile(join(base,'result.json'),JSON.stringify({ runtime, peer, sdkVersions, cases },null,2));
  console.log('PASS M4.4 daemon fixture Apply/Status acceptance');
} finally {
  const cleanup = await stop();
  if (cleanup) await fs.writeFile(join(base,'cleanup.json'),JSON.stringify(cleanup,null,2));
}
