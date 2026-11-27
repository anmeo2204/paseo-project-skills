import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runFixtureWriter } from '../../server/native-writer.ts';
import { createFixture, fingerprint, tree } from './m43-fixtures.mjs';

export async function runParentDeathAcceptance(){
 const f=await createFixture({parents:true});let parent,extraction,helperPid;
 try{
  const request=await f.preview({lock:true,controls:{barriers:[{point:'after_preflight'}],faults:[]}}),path=join(f.base,'request.json');await fs.writeFile(path,JSON.stringify(request),{mode:0o600});
  const held=Promise.withResolvers();
  parent=fork(fileURLToPath(new URL('../../tests/m43-parent-fixture.mjs',import.meta.url)),[path],{
   execArgv:['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','--import',fileURLToPath(new URL('../../tests/register.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';parent.stderr.on('data',chunk=>stderr+=String(chunk).slice(0,2048));
  parent.on('message',message=>{if(message.event==='extraction')extraction=message;if(message.event==='held'){helperPid=message.helperPid;held.resolve();}});
  parent.once('exit',(code,signal)=>{if(!helperPid)held.reject(Error('fixture parent exited before barrier: '+code+'/'+signal+' '+stderr));});
  const timeout=setTimeout(()=>held.reject(Error('parent helper did not reach deterministic barrier')),10000);
  try{await held.promise;}finally{clearTimeout(timeout);}
  const plain={...request};delete plain.controls;
  const busy=await runFixtureWriter(plain);assert.equal(busy.result.code,'busy');const lockBefore=await fingerprint(join(f.coordinator,'writer.lock')),targetBefore=await tree(f.root);
  const exited=once(parent,'exit');parent.kill('SIGKILL');await exited;
  let after;const deadline=Date.now()+4000;
  do{after=await runFixtureWriter(plain);if(after.result.code!=='busy')break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
  assert.equal(after.result.phase,'completed',JSON.stringify(after));assert.equal(after.result.ledger.length,1);
  const lockAfter=await fingerprint(join(f.coordinator,'writer.lock'));assert.deepEqual(lockAfter,lockBefore);
  assert.equal(targetBefore.length,4);assert.ok(extraction&&helperPid);const orphan=await fs.lstat(extraction.directory,{bigint:true});
  assert.equal(String(orphan.dev),extraction.dev);assert.equal(String(orphan.ino),extraction.ino);assert.equal(Number(orphan.mode&0o7777n),0o700);
  // Acceptance harness owns this recorded temp namespace; product has no orphan sweeper.
  await fs.rm(extraction.directory,{recursive:true});
  return {parentPid:parent.pid,helperPid,lockHeldBeforeParentDeath:busy,afterParentDeath:after,lockBefore,lockAfter,
   privateOrphanObserved:true,privateOrphanMode:0o700,orphanRemovedByFixtureHarness:true,targetBefore};
 }finally{
  if(parent&&parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');
  if(extraction)try{const st=await fs.lstat(extraction.directory,{bigint:true});if(String(st.dev)===extraction.dev&&String(st.ino)===extraction.ino&&(st.mode&0o7777n)===0o700n)await fs.rm(extraction.directory,{recursive:true});}catch{}
  await f.cleanup();
 }
}
