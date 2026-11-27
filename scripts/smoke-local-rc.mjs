// CLI-only acceptance of the staged candidate with the standard, hook-free profile.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../',import.meta.url));
const {stdout} = await exec(process.execPath,[join(repo,'scripts/stage-local-rc.mjs')]);
const {base,cli,home,plugin,targetRoot,listen}=JSON.parse(stdout);
console.log('Local RC standard smoke evidence: '+base);
const {createHostClient}=await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/node/index.js')));
const {createPaseoApi}=await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/index.js')));
const {settingsRpc}=await import(pathToFileURL(join(repo,'node_modules/@getpaseo/plugin/dist/index.js')));
const id='paseo-project-skills-local-rc';
const sha=process.env.PPS_RC_CATALOG_SHA ?? '4044fbf0545f4be1da51dbc10f1327f0a3da0017';
assert.match(sha,/^[0-9a-f]{40}$/);
const root=join(targetRoot,'smoke');
await fs.mkdir(root,{mode:0o700});
const log=await fs.open(join(base,'daemon-console.log'),'w',0o600);
const daemon=spawn(cli,['daemon','run','--home',home],{cwd:base,stdio:['ignore',log.fd,log.fd]});
await log.close();
let client;
try {
  await fs.writeFile(join(root,'sentinel'),'fixture sentinel',{mode:0o640});
  const original=await fs.lstat(join(root,'sentinel'),{bigint:true});
  for(let i=0;i<50&&!client;i++){
    try {
      const status=JSON.parse((await exec(cli,['--home',home,'status','--json'],{timeout:1000})).stdout);
      if(status.localDaemon==='running'){
        const connected=createHostClient(listen,{clientId:'local-rc-standard-smoke',clientType:'cli',reconnect:{enabled:false}});
        try{await connected.connect();client=connected;}catch{await connected.close();}
      }
    }catch{}
    if(!client)await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(client,'temporary daemon did not start');
  const install=JSON.parse((await exec(cli,['--home',home,'plugin','install',plugin,'--json'],{timeout:15000})).stdout);
  const call=(method,input)=>client.invokePluginRpc(id,method,input);
  assert.deepEqual(await call('apply.local-capability.v1',{}),{enabled:true});
  const settings=settingsRpc('catalog');
  const originalSettings=await call(settings.read.name,{});
  await call(settings.write.name,{revision:originalSettings.revision,values:{catalogRef:sha}});
  const saved=await call(settings.read.name,{});
  const hostId=(await createPaseoApi(client).hosts.list()).self.serverId;
  const preview=await call('preview.providers.v2',{viewNonce:'standard-smoke',intent:{
    schemaVersion:1,hostId,canonicalDirectory:root,catalogSource:'https://github.com/anmeo2204/project-skills',
    catalogCommitSha:sha,settingsRevision:saved.revision,selectedSkillIds:['debug-regression'],targetProviderIds:[],
    recommendationRequestId:'standard-smoke',
  }});
  assert.equal(preview.status,'ready',JSON.stringify(preview));
  assert.deepEqual(preview.applyEligibility,{status:'eligible'});
  const operationId=randomBytes(16).toString('hex');
  const {previewId,planDigest,viewNonce}=preview.receipt;
  const result=await call('apply.create.v1',{previewId,planDigest,viewNonce,operationId,approval:'create_only_v1'});
  assert.equal(result.phase,'completed',JSON.stringify(result));
  assert.deepEqual(await call('apply.status.v1',{operationId}),result);
  for(const row of result.ledger.filter(row=>row.kind==='file')){
    const path=join(root,row.destination);
    const node=await fs.lstat(path,{bigint:true});
    assert.equal(createHash('sha256').update(await fs.readFile(path)).digest('hex'),row.expected.sha256);
    assert.equal(Number(node.mode&0o7777n),row.expected.mode);
    assert.equal(String(node.ino),row.identity.ino);
  }
  const sentinel=await fs.lstat(join(root,'sentinel'),{bigint:true});
  assert.equal(sentinel.ino,original.ino);
  assert.equal(sentinel.mode,original.mode);
  assert.equal(await fs.readFile(join(root,'sentinel'),'utf8'),'fixture sentinel');
  const negativeId=id+'-negative';
  const negativePlugin=join(base,'negative-candidate');
  await fs.cp(plugin,negativePlugin,{recursive:true,verbatimSymlinks:true});
  const negativeManifest=join(negativePlugin,'paseo-plugin.json');
  const manifest=JSON.parse(await fs.readFile(negativeManifest,'utf8'));
  await fs.writeFile(negativeManifest,JSON.stringify({...manifest,id:negativeId}));
  const adapter=join(negativePlugin,'server/local-rc-profile.ts');
  const profile=await fs.readFile(adapter,'utf8');
  assert.match(profile,/"sdkVersions":\["0\.17\.4","0\.17\.4","0\.17\.4"\]/);
  await fs.writeFile(adapter,profile.replace('"sdkVersions":["0.17.4"', '"sdkVersions":["0.17.3"'));
  await exec(cli,['--home',home,'plugin','install',negativePlugin,'--json'],{timeout:15000});
  const negative=(method,input)=>client.invokePluginRpc(negativeId,method,input);
  assert.deepEqual(await negative('apply.local-capability.v1',{}),{enabled:false});
  assert.deepEqual(await negative('foundation.status',{}),{status:'ready'});
  await assert.rejects(negative('apply.create.v1',{previewId,planDigest,viewNonce,operationId,approval:'create_only_v1'}));
  await assert.rejects(negative('apply.status.v1',{operationId}));
  await fs.writeFile(join(base,'standard-smoke.json'),JSON.stringify({install,sha,result,sentinelUnchanged:true,negativeProfile:{sdkMismatch:true,capability:false,applyAndStatusAbsent:true,foundationReady:true}},null,2));
  console.log('PASS standard directory install, published catalog Preview, Apply and Status without acceptance hooks');
} finally {
  await client?.close();
  try{await exec(cli,['--home',home,'daemon','stop'],{timeout:10000});}catch{daemon.kill('SIGTERM');}
  const status=JSON.parse((await exec(cli,['--home',home,'status','--json'])).stdout);
  assert.equal(status.localDaemon,'stopped');
  await fs.writeFile(join(base,'cleanup.json'),JSON.stringify(status,null,2));
}
