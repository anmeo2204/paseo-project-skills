// Fresh fixture-only plugin/home. Product entrypoints are never modified.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { openSync,closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
const exec=promisify(execFile),repo=fileURLToPath(new URL('../',import.meta.url));
const cli=process.env.M43_PASEO_CLI??'/Applications/Paseo.app/Contents/Resources/bin/paseo';
assert.equal((await exec(cli,['--version'])).stdout.trim(),'0.17.5');
const sdkVersions={};for(const name of ['client','plugin','protocol']){const p=JSON.parse(await fs.readFile(join(repo,'node_modules/@getpaseo',name,'package.json'),'utf8'));assert.equal(p.version,'0.17.4');sdkVersions[name]=p.version;}
const base=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'pps-m43-runtime-'))),home=join(base,'daemon'),plugin=join(base,'plugin');
await fs.mkdir(home,{mode:0o700});await fs.mkdir(plugin,{mode:0o700});
for(const directory of ['server','shared'])await fs.cp(join(repo,directory),join(plugin,directory),{recursive:true});
for(const name of ['m43-fixtures.mjs','m43-native-acceptance.mjs']){
 const source=(await fs.readFile(join(repo,'scripts/lib',name),'utf8')).replaceAll('../../server/','./').replaceAll('../../shared/','../shared/');
 await fs.writeFile(join(plugin,'server',name),source);
}
await fs.symlink(join(repo,'node_modules'),join(plugin,'node_modules'));
await fs.writeFile(join(plugin,'paseo-plugin.json'),JSON.stringify({id:'m43-writer-fixtures',name:'M43 native fixture acceptance',requirements:{paseo:'>=0.17.4'}}));
await fs.writeFile(join(plugin,'index.server.ts'),`
import {defineRpc} from '@getpaseo/plugin';import {z} from 'zod';
import {runNativeAcceptance} from './server/m43-native-acceptance.mjs';
import {receiptPolicy} from './shared/preview-receipt';
import {createFixture,tree,fingerprint} from './server/m43-fixtures.mjs';
import {runFixtureWriter} from './server/native-writer';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
export default function(server:any){
 const fixtures=new Map();
 server.handle(defineRpc({name:'fixture.acceptance',input:z.strictObject({scope:z.literal('m43-temporary-fixtures-only')}),output:z.any()}),async(_input:any,ctx:any)=>({
  runtime:{pid:process.pid,node:process.versions.node,electron:process.versions.electron,platform:process.platform,arch:process.arch,contextKeys:Object.keys(ctx)},
  productWriteCapability:receiptPolicy.writeCapability,...await runNativeAcceptance()
 }));
 server.handle(defineRpc({name:'fixture.prepare-parent',input:z.strictObject({}),output:z.any()}),async()=>{
  const f=await createFixture({parents:true});fixtures.set(f.base,f);
  return {request:await f.preview({lock:true,controls:{barriers:[{point:'after_preflight'}],faults:[]}}),targetBefore:await tree(f.root)};
 });
 server.handle(defineRpc({name:'fixture.hold-parent',input:z.strictObject({request:z.any()}),output:z.any()}),async({request}:any)=>{
  let extraction:any;
  return runFixtureWriter(request,{testing:true,onExtracted:async(directory:string)=>{const st=await fs.lstat(directory,{bigint:true});extraction={directory,dev:String(st.dev),ino:String(st.ino),mode:Number(st.mode&0o7777n)};},
   onEvent:async(event:any)=>{if(event.event==='barrier'){await fs.writeFile(join(request.fixtureBase,'parent-progress.json'),JSON.stringify({parentPid:process.pid,helperPid:event.pid,extraction}),{mode:0o600});await new Promise(()=>{});}}});
 });
 server.handle(defineRpc({name:'fixture.run-peer',input:z.strictObject({request:z.any()}),output:z.any()}),async({request}:any)=>runFixtureWriter(request));
 server.handle(defineRpc({name:'fixture.cleanup-parent',input:z.strictObject({base:z.string()}),output:z.any()}),async({base}:any)=>{const f=fixtures.get(base);if(!f)throw Error('unknown fixture');await f.cleanup();fixtures.delete(base);return {cleaned:true};});
 return async()=>{for(const f of fixtures.values())await f.cleanup();};
}
`);
const peer=join(base,'plugin-peer');await fs.cp(plugin,peer,{recursive:true,dereference:false});
await fs.writeFile(join(peer,'paseo-plugin.json'),JSON.stringify({id:'m43-writer-peer',name:'M43 writer peer fixture',requirements:{paseo:'>=0.17.4'}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
await fs.writeFile(join(home,'config.json'),JSON.stringify({version:1,pluginsEnabled:true,daemon:{listen:'127.0.0.1:'+port,relay:{enabled:false}},features:{voiceMode:{enabled:false}},
 plugins:{'m43-writer-fixtures':{source:'directory',path:plugin,enabled:true},'m43-writer-peer':{source:'directory',path:peer,enabled:true}}}));
const fd=openSync(join(base,'console.log'),'w',0o600),daemon=spawn(cli,['daemon','run','--home',home],{cwd:base,stdio:['ignore',fd,fd]});closeSync(fd);
let client;
try{
 let ready=false;
 for(let i=0;i<60;i++){
  try{const {stdout}=await exec(cli,['--home',home,'plugin','ls','--json'],{timeout:3000});const plugins=JSON.parse(stdout),item=plugins.find(p=>p.id==='m43-writer-fixtures');
   if(item?.status==='running'&&plugins.some(p=>p.id==='m43-writer-peer'&&p.status==='running')){ready=true;break;}if(item?.status==='failed')throw Error('Fixture plugin failed: '+item.error);
  }catch(error){if(error.message.startsWith('Fixture plugin failed:'))throw error;}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 assert.equal(ready,true,'temporary plugin did not become ready');
 const log=await fs.readFile(join(base,'console.log'),'utf8');assert.ok(log.includes('"daemonVersion":"0.17.5"'));
 const {createHostClient}=await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/node/index.js')));
 const {createPaseoApi}=await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/index.js')));
 client=createHostClient('127.0.0.1:'+port,{clientId:'m43-runtime-fixtures',clientType:'cli',reconnect:{enabled:false}});await client.connect();
 const result=await client.invokePluginRpc('m43-writer-fixtures','fixture.acceptance',{scope:'m43-temporary-fixtures-only'});
 assert.equal(result.productWriteCapability,'unavailable_m4_2');assert.equal(result.runtime.arch,'arm64');assert.equal(result.runtime.platform,'darwin');assert.ok(result.passed>=17);
 const prepared=await client.invokePluginRpc('m43-writer-peer','fixture.prepare-parent',{}),request=prepared.request;
 const heldCall=client.invokePluginRpc('m43-writer-fixtures','fixture.hold-parent',{request}).then(()=>({settled:'unexpected_success'}),error=>({settled:'rejected',code:error.code??'transport_error'}));
 let progress;for(let i=0;i<100;i++){try{progress=JSON.parse(await fs.readFile(join(request.fixtureBase,'parent-progress.json'),'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
 assert.ok(progress,'plugin parent did not reach native barrier');assert.equal(progress.parentPid,result.runtime.pid);
 const plain={...request};delete plain.controls;
 const busy=await client.invokePluginRpc('m43-writer-peer','fixture.run-peer',{request:plain});assert.equal(busy.result.code,'busy');
 const statLock=async()=>{const st=await fs.lstat(join(request.coordinator.directory,'writer.lock'),{bigint:true});return{dev:String(st.dev),ino:String(st.ino),mode:Number(st.mode&0o7777n)};};
 const lockBefore=await statLock();process.kill(progress.parentPid,'SIGKILL');
 let afterParentDeath;const releaseDeadline=Date.now()+4000;
 do{afterParentDeath=await client.invokePluginRpc('m43-writer-peer','fixture.run-peer',{request:plain});if(afterParentDeath.result.code!=='busy')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<releaseDeadline);
 assert.equal(afterParentDeath.result.phase,'completed',JSON.stringify(afterParentDeath));const lockAfter=await statLock();assert.deepEqual(lockAfter,lockBefore);
 const orphan=await fs.lstat(progress.extraction.directory,{bigint:true});assert.equal(String(orphan.dev),progress.extraction.dev);assert.equal(String(orphan.ino),progress.extraction.ino);assert.equal(Number(orphan.mode&0o7777n),0o700);
 assert.ok(progress.extraction.directory.startsWith(await fs.realpath(tmpdir())+'/pps-helper-m43-'));
 await fs.rm(progress.extraction.directory,{recursive:true});
 const parentRpcOutcome=await Promise.race([heldCall,new Promise(resolve=>{const timer=setTimeout(()=>resolve({settled:'pending_after_2s'}),2000);timer.unref();})]);
 const parentLifecycle={...progress,lockBefore,lockAfter,busy,afterParentDeath,parentRpcOutcome,privateOrphanObserved:true,orphanRemovedByFixtureHarness:true,targetBefore:prepared.targetBefore};
 await client.invokePluginRpc('m43-writer-peer','fixture.cleanup-parent',{base:request.fixtureBase});
 const agents=(await createPaseoApi(client).agents.list()).entries.length;assert.equal(agents,0);
 await fs.writeFile(join(base,'result.json'),JSON.stringify({paseoVersion:'0.17.5',sdkVersions,agents,parentLifecycle,...result},null,2));
 console.log('PASS '+result.passed+' native fixture acceptance groups through Paseo 0.17.5/SDK 0.17.4; parent-plugin death lease release verified; product capability unavailable. Evidence: '+base);
}finally{
 await client?.close();
 try{await exec(cli,['--home',home,'daemon','stop'],{timeout:10000});}catch{daemon.kill('SIGTERM');}
 const {stdout}=await exec(cli,['--home',home,'status','--json'],{timeout:3000});const status=JSON.parse(stdout);assert.equal(status.localDaemon,'stopped');
 await fs.writeFile(join(base,'cleanup.json'),JSON.stringify(status,null,2));
}
