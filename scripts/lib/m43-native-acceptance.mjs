import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { runFixtureWriter } from '../../server/native-writer.ts';
import { writerArtifacts } from '../../server/native/writer-payload.ts';
import { createFixture, descriptor, fingerprint, tree } from './m43-fixtures.mjs';
const exec=promisify(execFile), leaf='.agents/skills/demo/SKILL.md';
const controls=(point,destination=leaf)=>({barriers:[{point,...(destination?{destination}:{})}],faults:[]});
const rows=r=>r.result.ledger;
const complete=r=>assert.equal(r.result.phase,'completed',JSON.stringify(r));
const before=r=>{assert.equal(r.result.phase,'failed_before_write',JSON.stringify(r));assert.equal(r.result.targetMutated,false);};
async function fixtureCase(options,fn){const f=await createFixture(options);try{return await fn(f);}finally{await f.cleanup();}}

export async function runNativeAcceptance({onCase=()=>{}}={}) {
 const cases=[];
 const run=async(name,fn)=>{const evidence=await fn();const row={name,pass:true,...evidence};cases.push(row);await onCase(row);};
 await run('packaging-private-extraction',()=>fixtureCase({},async f=>{
  let directoryMode;
  const request=await f.preview(),r=await runFixtureWriter(request,{onExtracted:async p=>{directoryMode=(await fs.lstat(p)).mode&0o7777;assert.equal(directoryMode,0o700);assert.equal((await fs.lstat(join(p,'writer'))).mode&0o7777,0o700);}});
  complete(r);assert.equal(r.extraction.removed,true);assert.equal(directoryMode,0o700);
  for(const row of rows(r)){assert.equal(row.state,'created_verified');if(row.kind==='directory')assert.equal((await fingerprint(join(f.root,row.destination))).mode,0o755);}
  const gate=r.events.find(e=>e.event==='environment');assert.equal(gate.caseMode,'insensitive');
  await fs.writeFile(join(f.base,'Case-Probe'),'case');assert.equal((await fingerprint(join(f.base,'Case-Probe'))).ino,(await fingerprint(join(f.base,'case-probe'))).ino);
  return {outcome:r,caseAliasConfirmed:true,rootSnapshot:await tree(f.root)};
 }));
 await run('helper-fail-closed',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview(),snapshot=await tree(f.root),outcomes={};
  const fakeBytes=Buffer.from('#!/bin/sh\necho \'{"protocol":1,"version":"wrong","fixtureOnly":true,"testing":0,"arch":"arm64"}\'\n');
  const fake={...writerArtifacts.standard,base64:fakeBytes.toString('base64'),sha256:createHash('sha256').update(fakeBytes).digest('hex')};
  for(const [name,options,code] of [
   ['missing',{artifact:null},'helper_missing'],['corrupt',{artifact:{...writerArtifacts.standard,sha256:'0'.repeat(64)}},'helper_integrity'],
   ['wrong-metadata',{artifact:{...writerArtifacts.standard,version:'wrong'}},'helper_version'],['wrong-handshake',{artifact:fake},'helper_version'],
   ['removed',{onExtracted:async p=>fs.unlink(join(p,'writer'))},'helper_missing'],
   ['modified-extraction',{onExtracted:async p=>{
    const fd=await fs.open(join(p,'writer'),'r+');
    try{await fd.write(Buffer.from([0]),0,1,0);}finally{await fd.close();}
   }},'helper_integrity']]){
    const r=await runFixtureWriter(request,options);before(r);assert.equal(r.result.code,code,JSON.stringify(r));assert.equal(r.extraction.removed,true);outcomes[name]=r;
  }
  assert.deepEqual(await tree(f.root),snapshot);return{outcomes,targetSnapshotMatch:true};
 }));
 await run('environment-and-scope-gate',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview(),snapshot=await tree(f.root),outcomes=[];
  for(const change of [{environment:{paseoVersion:'0.17.6',sdkVersion:'0.17.4'}},{environment:{paseoVersion:'0.17.5',sdkVersion:'0.17.5'}},{fixtureBase:dirname(f.base)}]){
   const r=await runFixtureWriter({...request,...change});before(r);assert.ok(['unsupported_environment','fixture_scope_required'].includes(r.result.code));outcomes.push(r);
  }
  const disabled=await runFixtureWriter({...request,controls:controls('before_create')});before(disabled);assert.equal(disabled.result.code,'test_controls_disabled');
  assert.deepEqual(await tree(f.root),snapshot);return{outcomes,standardRejectsControls:disabled,targetSnapshotMatch:true};
 }));
 await run('bytes-modes-binary-empty-and-short-writes',()=>fixtureCase({extras:[descriptor('a-empty',''),descriptor('b-binary',[0,1,255,7]),descriptor('c-run.sh','#!/bin/sh\necho fixture\n','100755'),descriptor('d-many.bin',Buffer.alloc(501,139))]},async f=>{
  const request=await f.preview({controls:{barriers:[],faults:[{point:'short_write',destination:'.agents/skills/demo/d-many.bin',shortBytes:3}]}});
  const r=await runFixtureWriter(request,{testing:true});complete(r);
  for(const file of request.files){const current=await fingerprint(join(f.root,file.destination));assert.equal(current.sha256,file.sha256);assert.equal(current.mode,file.mode);}
  assert.ok(rows(r).find(row=>row.destination.endsWith('d-many.bin')).shortWriteResults>0);
  const secondRequest=await f.preview(),snapshot=await tree(f.root),identities=await Promise.all(secondRequest.files.map(file=>fingerprint(join(f.root,file.destination))));
  const noop=await runFixtureWriter(secondRequest);complete(noop);assert.equal(noop.result.targetMutated,false);assert.ok(rows(noop).every(row=>row.state==='unchanged_verified'));assert.ok(!noop.events.some(e=>e.event==='mutation_intent'));
  assert.deepEqual(await tree(f.root),snapshot);assert.deepEqual(await Promise.all(secondRequest.files.map(file=>fingerprint(join(f.root,file.destination)))),identities);
  return{outcome:r,noOp:noop,files:identities};
 }));
 await run('kiro-derived-pinned-bytes-and-read-only-git',()=>fixtureCase({extras:[descriptor('nested/data.bin',[0,255,7]),descriptor('run.sh','#!/bin/sh\n','100755')]},async f=>{
  await exec('git',['-C',f.root,'init','-b','main']);const gitBefore=await tree(join(f.root,'.git'));
  const request=await f.preview({providers:['kiro']}),r=await runFixtureWriter(request);complete(r);
  assert.ok(request.files.some(file=>file.destination.startsWith('.kiro/')));
  for(const file of request.files){const current=await fingerprint(join(f.root,file.destination));assert.equal(current.sha256,file.sha256);assert.equal(current.mode,file.mode);}
  assert.deepEqual(await tree(join(f.root,'.git')),gitBefore);return{outcome:r,gitSnapshotUnchanged:true,snapshot:await tree(f.root)};
 }));
 await run('changed-canonical-dependency-stops-derived-create',()=>fixtureCase({},async f=>{
  await exec('git',['-C',f.root,'init','-b','main']);
  const derived='.kiro/skills/demo/SKILL.md',canonical=join(f.root,leaf);
  const request=await f.preview({providers:['kiro'],controls:controls('before_create',derived)});
  let foreignBefore;
  const outcome=await runFixtureWriter(request,{testing:true,onEvent:async e=>{
   if(e.event!=='barrier')return;
   await fs.rename(canonical,join(f.base,'own-canonical'));
   await fs.writeFile(canonical,'foreign canonical',{mode:0o640});
   foreignBefore=await fingerprint(canonical);
  }});
  assert.equal(outcome.result.phase,'partial_failure');
  assert.equal(rows(outcome).find(row=>row.destination===leaf).state,'observation_changed');
  assert.equal(rows(outcome).find(row=>row.destination===derived).state,'not_attempted');
  await assert.rejects(fs.lstat(join(f.root,derived)),{code:'ENOENT'});
  const foreignAfter=await fingerprint(canonical);assert.deepEqual(foreignAfter,foreignBefore);
  return{outcome,foreignBefore,foreignAfter};
 }));
 await run('full-preflight-conflict-source-collision-and-budget',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview(),snapshot=await tree(f.root),outcomes={};
  const variants=[['conflict',{...request,files:request.files.map(file=>({...file,status:'conflict'}))},'plan_not_applicable'],
   ['blocked',{...request,files:request.files.map(file=>({...file,status:'blocked'}))},'plan_not_applicable'],
   ['source',{...request,files:request.files.map(file=>({...file,sha256:'0'.repeat(64)}))},'source_mismatch'],
   ['case-alias',{...request,files:[...request.files,{...request.files[0],destination:'.agents/skills/demo/skill.md'}]},'invalid_request'],
   ['directory-alias',{...request,directories:[{destination:'.agents/skills/demo/SKILL.md',mode:0o755}]},'invalid_request']];
  for(const [name,value,code]of variants){const r=await runFixtureWriter(value);before(r);assert.equal(r.result.code,code,JSON.stringify(r));outcomes[name]=r;}
  const largeBytes=Buffer.alloc(4*1024*1024),large={...request.files[0],sha256:createHash('sha256').update(largeBytes).digest('hex'),sizeBytes:largeBytes.length,bytesBase64:largeBytes.toString('base64')};
  const largeResult=await runFixtureWriter({...request,files:[{...large,destination:'.agents/skills/demo/a.bin'},{...large,destination:'.agents/skills/demo/b.bin'},request.files[0]]});
  before(largeResult);assert.equal(largeResult.result.code,'limit_exceeded');outcomes.sourceBudget=largeResult;
  assert.deepEqual(await tree(f.root),snapshot);return{outcomes,targetSnapshotMatch:true};
 }));
 await run('late-leaf-no-clobber',async()=>{
  const variants=[];
  for(const kind of ['different','identical','symlink','hardlink'])await fixtureCase({parents:true},async f=>{
   const request=await f.preview({controls:controls('after_create_check')});let foreignBefore,sentinelBefore;
   const r=await runFixtureWriter(request,{testing:true,onEvent:async event=>{if(event.event!=='barrier')return;
    const full=join(f.root,leaf),sentinel=join(f.base,'foreign-sentinel');await fs.writeFile(sentinel,'foreign sentinel',{mode:0o600});sentinelBefore=await fingerprint(sentinel);
    if(kind==='symlink')await fs.symlink(sentinel,full);else if(kind==='hardlink')await fs.link(sentinel,full);else{await fs.writeFile(full,kind==='identical'?Buffer.from(request.files[0].bytesBase64,'base64'):'foreign bytes');await fs.chmod(full,0o640);}
    foreignBefore=await fingerprint(full);
   }});
   before(r);assert.equal(r.result.code,'destination_exists');assert.deepEqual(await fingerprint(join(f.root,leaf)),foreignBefore);assert.deepEqual(await fingerprint(join(f.base,'foreign-sentinel')),sentinelBefore);
   variants.push({kind,outcome:r,foreignBefore,foreignAfter:await fingerprint(join(f.root,leaf))});
  });return{variants};
 });
 await run('two-writers-exclusive-leaf',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview({controls:controls('after_create_check')}),both=Promise.withResolvers(),release=Promise.withResolvers();let arrivals=0;
  const hook=async e=>{if(e.event==='barrier'){if(++arrivals===2)both.resolve();await release.promise;}};
  const running=[runFixtureWriter(request,{testing:true,onEvent:hook}),runFixtureWriter(request,{testing:true,onEvent:hook})];
  await both.promise;release.resolve();const outcomes=await Promise.all(running);
  assert.deepEqual(outcomes.map(r=>r.result.phase).sort(),['completed','failed_before_write']);
  const winner=outcomes.find(r=>r.result.phase==='completed'),loser=outcomes.find(r=>r.result.phase!=='completed'),current=await fingerprint(join(f.root,leaf));
  assert.equal(loser.result.code,'destination_exists');assert.equal(current.sha256,request.files[0].sha256);assert.equal(current.mode,request.files[0].mode);assert.equal(current.ino,rows(winner)[0].identity.ino);
  return{outcomes,winnerFile:current};
 }));
 await run('replacement-before-and-after-linkage-check',async()=>{
  const variants=[];
  for(const which of ['root','ancestor'])for(const point of ['before_create','after_create_check'])await fixtureCase({parents:true},async f=>{
   const request=await f.preview({controls:controls(point)});let foreignBefore;
   const moved=join(f.base,'detached'),foreignRoot=which==='root'?f.root:join(f.root,'.agents/skills/demo');
   const r=await runFixtureWriter(request,{testing:true,onEvent:async event=>{if(event.event!=='barrier')return;
    await fs.rename(foreignRoot,moved);await fs.mkdir(foreignRoot,{mode:0o700});
    const full=join(f.root,leaf);await fs.mkdir(dirname(full),{recursive:true});await fs.writeFile(full,'foreign replacement');await fs.chmod(full,0o640);foreignBefore=await fingerprint(full);
   }});
   const movedFile=which==='root'?join(moved,leaf):join(moved,'SKILL.md');
   assert.deepEqual(await fingerprint(join(f.root,leaf)),foreignBefore);assert.equal(r.result.code,'linkage_changed',JSON.stringify(r));
   let detachedFile=null;
   if(point==='before_create'){before(r);await assert.rejects(fs.lstat(movedFile),{code:'ENOENT'});}
   else{assert.equal(r.result.phase,'partial_failure',JSON.stringify(r));assert.equal(r.result.targetMutated,true);detachedFile=await fingerprint(movedFile);assert.equal(detachedFile.size,'0');assert.equal(detachedFile.mode,0o600);assert.equal(rows(r)[0].state,'created_incomplete');}
   variants.push({which,point,outcome:r,foreignBefore,foreignAfter:await fingerprint(join(f.root,leaf)),detachedFile});
  });return{variants};
 });
 await run('symlink-ancestor-redirection-refused',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview({controls:controls('before_create')}),outside=join(f.base,'outside');await fs.mkdir(outside);await fs.writeFile(join(outside,'SKILL.md'),'outside sentinel',{mode:0o600});const foreign=await fingerprint(join(outside,'SKILL.md'));
  const r=await runFixtureWriter(request,{testing:true,onEvent:async e=>{if(e.event==='barrier'){await fs.rename(join(f.root,'.agents/skills/demo'),join(f.base,'detached'));await fs.symlink(outside,join(f.root,'.agents/skills/demo'));}}});
  before(r);assert.equal(r.result.code,'linkage_changed');assert.deepEqual(await fingerprint(join(outside,'SKILL.md')),foreign);return{outcome:r,foreign};
 }));
 await run('mkdir-collision-and-replacement-never-chmod-foreign',async()=>{
  const variants=[];
  for(const point of ['after_mkdir_check','after_mkdir'])await fixtureCase({},async f=>{
   const request=await f.preview({controls:controls(point,'.agents')});let foreignBefore;
   const r=await runFixtureWriter(request,{testing:true,onEvent:async e=>{if(e.event!=='barrier')return;
    if(point==='after_mkdir')await fs.rename(join(f.root,'.agents'),join(f.base,'detached'));
    await fs.mkdir(join(f.root,'.agents'),{mode:0o700});foreignBefore=await fingerprint(join(f.root,'.agents'));
   }});
   assert.deepEqual(await fingerprint(join(f.root,'.agents')),foreignBefore);
   if(point==='after_mkdir_check'){before(r);assert.equal(r.result.code,'destination_exists');}
   else{assert.equal(r.result.phase,'uncertain');assert.equal(r.result.code,'ownership_unknown');assert.equal(rows(r)[0].state,'ownership_unknown');}
   variants.push({point,outcome:r,foreignBefore,foreignAfter:await fingerprint(join(f.root,'.agents'))});
  });return{variants};
 });
 await run('partial-write-and-not-attempted-ledger',()=>fixtureCase({extras:[descriptor('a-good','good'),descriptor('b-broken.bin',Buffer.alloc(20000,73)),descriptor('z-not-attempted','later')]},async f=>{
  const broken='.agents/skills/demo/b-broken.bin',request=await f.preview({controls:{barriers:[],faults:[{point:'write',destination:broken,afterBytes:8195,error:'ENOSPC'}]}});
  const r=await runFixtureWriter(request,{testing:true});assert.equal(r.result.phase,'partial_failure');assert.equal(r.result.code,'write_failed');
  assert.equal(rows(r).find(x=>x.destination.endsWith('a-good')).state,'created_verified');const row=rows(r).find(x=>x.destination===broken);assert.equal(row.state,'created_incomplete');assert.equal(row.bytesWritten,8195);assert.equal(row.systemErrno,28);
  assert.equal((await fingerprint(join(f.root,broken))).size,'8195');assert.equal((await fingerprint(join(f.root,broken))).mode,0o600);
  assert.ok(rows(r).filter(x=>x.kind==='file'&&x.destination!==broken&&!x.destination.endsWith('a-good')).every(x=>x.state==='not_attempted'));
  await assert.rejects(fs.lstat(join(f.root,leaf)),{code:'ENOENT'});return{outcome:r,snapshot:await tree(f.root)};
 }));
 await run('sync-close-chmod-zero-write-readback-failures',async()=>{
  const variants=[];
  for(const point of ['sync','directory_sync','close','chmod','zero_write','readback'])await fixtureCase({parents:true},async f=>{
   const request=await f.preview({controls:{barriers:[],faults:[{point,destination:leaf}]}}),r=await runFixtureWriter(request,{testing:true});
   assert.equal(r.result.phase,'partial_failure',JSON.stringify(r));assert.equal(rows(r)[0].state,'created_incomplete');
   variants.push({point,outcome:r,file:await fingerprint(join(f.root,leaf))});
  });return{variants};
 });
 await run('foreign-swap-after-create-no-rollback',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview({controls:controls('after_create')});let foreignBefore;
  const saved=join(f.base,'own-created');const r=await runFixtureWriter(request,{testing:true,onEvent:async e=>{if(e.event==='barrier'){await fs.rename(join(f.root,leaf),saved);await fs.writeFile(join(f.root,leaf),'foreign after create',{mode:0o640});foreignBefore=await fingerprint(join(f.root,leaf));}}});
  assert.equal(r.result.phase,'partial_failure');assert.equal(r.result.code,'observation_changed');assert.deepEqual(await fingerprint(join(f.root,leaf)),foreignBefore);
  assert.equal((await fingerprint(saved)).size,'0');return{outcome:r,foreignBefore,foreignAfter:await fingerprint(join(f.root,leaf)),ownCreatedStillPresent:await fingerprint(saved)};
 }));
 await run('coordinator-busy-helper-exit-and-stable-inode',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview({controls:controls('after_preflight',null),lock:true}),held=Promise.withResolvers(),release=Promise.withResolvers();let helperPid;
  const first=runFixtureWriter(request,{testing:true,onEvent:async e=>{if(e.event==='barrier'){helperPid=e.pid;held.resolve();await release.promise;}}});
  await held.promise;const lockBefore=await fingerprint(join(f.coordinator,'writer.lock'));
  const busyRequest={...request};delete busyRequest.controls;const busy=await runFixtureWriter(busyRequest);before(busy);assert.equal(busy.result.code,'busy');
  process.kill(helperPid,'SIGKILL');const killed=await first;release.resolve();before(killed);assert.equal(killed.result.code,'helper_exit');
  const next=await runFixtureWriter(busyRequest);complete(next);const lockAfter=await fingerprint(join(f.coordinator,'writer.lock'));assert.deepEqual(lockAfter,lockBefore);
  return{busy,killed,afterHelperExit:next,lockBefore,lockAfter};
 }));
 await run('coordinator-held-through-parent-finalization',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview({lock:true});let busyDuringFinalization;
  const r=await runFixtureWriter(request,{onFinalize:async provisional=>{
   assert.equal(provisional.phase,'completed');busyDuringFinalization=await runFixtureWriter(request);before(busyDuringFinalization);assert.equal(busyDuringFinalization.result.code,'busy');
  }});complete(r);assert.ok(busyDuringFinalization);return{outcome:r,busyDuringFinalization};
 }));
 await run('helper-death-after-create-reports-uncertainty',()=>fixtureCase({parents:true,extras:[descriptor('a-first','verified')]},async f=>{
  const request=await f.preview({lock:true,controls:controls('after_create')});
  const outcome=await runFixtureWriter(request,{testing:true,onEvent:e=>{
   if(e.event==='barrier')process.kill(e.pid,'SIGKILL');
  }});
  assert.equal(outcome.result.phase,'uncertain');
  assert.equal(outcome.result.targetMutated,'unknown');
  assert.equal(outcome.nativeExit.signal,'SIGKILL');
  assert.equal(outcome.extraction.removed,true);
  const finished=rows(outcome).find(row=>row.destination.endsWith('/a-first'));
  assert.equal(finished.state,'created_verified');assert.equal(finished.bytesWritten,8);
  assert.equal(rows(outcome).find(row=>row.destination===leaf).state,'ownership_unknown');
  const leftover=await fingerprint(join(f.root,leaf));
  assert.equal(leftover.size,'0');assert.equal(leftover.mode,0o600);
  const retry={...request};delete retry.controls;
  const afterExit=await runFixtureWriter(retry);before(afterExit);
  assert.ok(afterExit.events.some(event=>event.event==='lock_acquired'));
  assert.deepEqual(await fingerprint(join(f.root,leaf)),leftover);
  return{outcome,leftover,afterExit};
 }));
 await run('unsafe-coordinator-link-refused',()=>fixtureCase({parents:true},async f=>{
  const request=await f.preview({lock:true}),foreign=join(f.base,'foreign-lock');await fs.writeFile(foreign,'foreign lock',{mode:0o600});await fs.symlink(foreign,join(f.coordinator,'writer.lock'));const beforeForeign=await fingerprint(foreign);
  const r=await runFixtureWriter(request);before(r);assert.equal(r.result.code,'invalid_coordinator');assert.deepEqual(await fingerprint(foreign),beforeForeign);return{outcome:r,foreign:beforeForeign};
 }));
 return{passed:cases.length,cases};
}
