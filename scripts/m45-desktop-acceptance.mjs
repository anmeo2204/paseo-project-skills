import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const app = process.env.M45_PASEO_APP ?? '/Applications/Paseo.app';
const cli = join(app, 'Contents/Resources/bin/paseo');
const executable = join(app, 'Contents/MacOS/Paseo');
assert.equal((await exec(cli,['--version'])).stdout.trim(),'0.17.5');
const sdkVersions = {};
for (const name of ['client','plugin','protocol']) {
  sdkVersions[name] = JSON.parse(await fs.readFile(join(repo,'node_modules/@getpaseo',name,'package.json'),'utf8')).version;
  assert.equal(sdkVersions[name],'0.17.4');
}
const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(),'pps-m43-m45-')));
console.log('M4.5 Desktop fixture evidence: ' + base);
const home = join(base,'daemon'), desktopProfile = join(base,'desktop');
const localRc = process.argv.includes('--local-rc');
const stage = join(base,'plugin');
const plugin = stage;
const coordinator = join(home,'runtime/project-skills-m44');
const targetRoot = localRc ? join(base,'targets') : base;
const id = localRc ? 'paseo-project-skills-local-rc' : 'm45-approval-fixture';
const fixtureTitle = localRc ? 'Project Skills Local RC' : 'Approval Fixture';
const integrated = localRc || process.argv.includes('--integrated');
const product = join(base,'product');
if (integrated) {
  await fs.mkdir(product,{mode:0o700});
  for (const directory of ['client','server','shared']) await fs.cp(join(repo,directory),join(product,directory),{recursive:true});
  for (const name of ['paseo-plugin.json','index.client.tsx','index.server.ts']) await fs.copyFile(join(repo,name),join(product,name));
  await fs.symlink(join(repo,'node_modules'),join(product,'node_modules'));
}
const sha = 'a'.repeat(40);
for (const path of [home,join(home,'runtime'),coordinator,desktopProfile,stage]) await fs.mkdir(path,{mode:0o700});
if(localRc) await fs.mkdir(targetRoot,{mode:0o700});
for (const directory of ['client','server','shared'])
  await fs.cp(join(repo,directory),join(stage,directory),{recursive:true});
await fs.symlink(join(repo,'node_modules'),join(stage,'node_modules'));
if (!localRc) {
await fs.writeFile(join(plugin,'paseo-plugin.json'),JSON.stringify({ id, name:'Approval Fixture', requirements:{paseo:'>=0.17.4'} }));
await fs.writeFile(join(plugin,'index.client.tsx'),`
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { FoundationScreen } from './client/foundation-screen';
import { FixtureApprovalScope } from './client/fixture-approval';
import { createOperationTracker } from './client/apply-tracker';
export default function contribute(client) {
  const tracker = createOperationTracker({slot:${JSON.stringify(id)}, storage:()=>globalThis.localStorage});
  const removeScreen = client.addScreen({id:'foundation',title:'Approval Fixture',Component:props=>
    <FixtureApprovalScope slot=${JSON.stringify(id)} tracker={tracker}><FoundationScreen {...props}/></FixtureApprovalScope>});
  const removeSidebar = client.addSidebarHeaderItem({id:'foundation',title:'Approval Fixture',Component:({currentScreen,openScreen})=>
    <SidebarRow icon="BookOpen" active={currentScreen?.screenId==='foundation'} onPress={()=>openScreen({screenId:'foundation'})}/>});
  return ()=>{ removeSidebar(); removeScreen(); };
}`);
}
const setup = `import { createHash } from 'node:crypto';
import { existsSync,appendFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogSettings,catalogSource } from './shared/catalog-settings';
import { catalogLoadRpc,foundationStatusRpc,recommendationEvaluateSubscription,providerPreviewV2Rpc,validateDirectoryRpc } from './shared/rpc';
import { applyCreateRpc,applyStatusRpc } from './shared/apply';
import { createFixtureApply,isFixtureApplyTarget } from './server/fixture-apply';
import { PreviewReceiptStore } from './server/preview-receipts';
import { createCanonicalPreviewHandler } from './server/canonical-preview';
import { createRecommendationHandler } from './server/recommendation-rpc';
import { ProjectScanner } from './server/project-scanner';
import { loadCatalogForHost } from './server/catalog-rpc';
import { validateDirectory } from './server/validate-directory';
const base=${JSON.stringify(base)};
const audit=(method,input)=>appendFileSync(join(base,'rpc-audit.ndjson'),JSON.stringify({method,operationId:input.operationId,pid:process.pid})+String.fromCharCode(10),{mode:0o600});
async function gate(name, data) {
  writeFileSync(join(base,name+'.ready'),JSON.stringify(data),{mode:0o600});
  for(let i=0;i<400;i++) {
    if(existsSync(join(base,name+'.release')))return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('fixture timeout '+name);
}
const descriptor = (path,text,mode='100644') => {
  const bytes=Buffer.from(text);
  return {path,bytes,mode,sizeBytes:bytes.length,blobSha:createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex')};
};
const catalog={load:async()=>({schemaVersion:1,source:catalogSource,commitSha:${JSON.stringify(sha)},skills:[{
  id:'demo',directory:'skills/demo',metadata:{name:'demo',description:'Fixture skill'},
  entrypoint:descriptor('SKILL.md','---\\nname: demo\\ndescription: Fixture skill\\n---\\nFixture.\\n'),
  supportingFiles:Array.from({length:32},(_,i)=>descriptor('file-'+String(i).padStart(2,'0')+'.txt','fixture '+i+'\\n',i===31?'100755':undefined))
}]})};
`;
const hooks = `let extraction;
const fixtureHooks={
      controls:()=>{
        const destination='.agents/skills/demo/file-01.txt';
        if(existsSync(join(base,'inject-partial'))) return {barriers:[],faults:[{point:'write',destination,error:'ENOSPC',afterBytes:1}]};
        if(existsSync(join(base,'inject-late'))) return {barriers:[{point:'after_create_check',destination:'.agents/skills/demo/file-00.txt'}],faults:[]};
        if(existsSync(join(base,'inject-switch'))) return {barriers:[{point:'after_create',destination}],faults:[]};
        if(existsSync(join(base,'inject-restart'))) return {barriers:[{point:'after_create',destination}],faults:[]};
        if(existsSync(join(base,'inject-recovery'))) return {barriers:[{point:'after_create',destination}],faults:[]};
      },
      onExtracted:async directory=>{const stat=await import('node:fs/promises').then(fs=>fs.lstat(directory,{bigint:true}));extraction={directory,dev:String(stat.dev),ino:String(stat.ino)};},
      onEvent:async event=>{
        if(event.event!=='barrier')return;
        if(existsSync(join(base,'inject-late')))return gate('late-boundary',{point:event.point});
        if(existsSync(join(base,'inject-switch')))return gate('switch-boundary',{helper:event.pid,parent:process.pid,point:event.point});
        if(existsSync(join(base,'inject-restart')))return gate('restart-boundary',{helper:event.pid,parent:process.pid,point:event.point,extraction});
        process.kill(event.pid,'SIGKILL');
      },
      afterTerminal:async operation=>{
        if(existsSync(join(base,'inject-lost'))) await gate('lost-terminal',{operationId:operation.operationId});
      },
};
`;
const legacy = `export default function contribute(server) {
  const settings=server.registerSettings(catalogSettings);
  const receipts=new PreviewReceiptStore({fixtureApply: target=>isFixtureApplyTarget(base,target)});
  const preview=createCanonicalPreviewHandler(settings,catalog,{receiptStore:receipts});
  const scanner=new ProjectScanner();
  const apply=createFixtureApply({fixtureBase:base,installation:${JSON.stringify(id)},receipts,settings,catalog,
    environment:{paseoVersion:'0.17.5',sdkVersion:'0.17.4'},
    test:fixtureHooks});
  server.handle(foundationStatusRpc,()=>({status:'ready'}));
  server.handle(validateDirectoryRpc,validateDirectory);
  server.handle(catalogLoadRpc,()=>loadCatalogForHost(settings,catalog));
  server.handle(recommendationEvaluateSubscription,createRecommendationHandler(settings,catalog,scanner));
  server.handle(providerPreviewV2Rpc,preview.handleProvidersV2);
  server.handle(applyCreateRpc,(input,ctx)=>{audit('apply',input);return apply.create(input,ctx);});
  server.handle(applyStatusRpc,async(input,ctx)=>{
    audit('status',input);
    const result=await apply.status(input,ctx);
    if(existsSync(join(base,'hold-status-'+input.operationId))){
      await gate('status-'+input.operationId,{phase:result.phase??result.code});
      audit('held_status_returned',input);
    }
    return result;
  });
  return async()=>{await apply.dispose(); await preview.dispose(); await scanner.dispose();};
}`;
if (localRc) {
  for (const file of ['index.server.ts','index.client.tsx','paseo-plugin.json'])
    await fs.copyFile(join(repo,'release/local',file),join(plugin,file));
  const adapterPath = join(plugin,'server/local-rc-profile.ts');
  const profileTypes = (await fs.readFile(adapterPath,'utf8')).split('// Filled only')[0];
  const sharedSetup = setup.replace("'./shared/catalog-settings'", "'../shared/catalog-settings'");
  const adapter = `
export const profile = {
  base, targetRoot:${JSON.stringify(targetRoot)}, cli:${JSON.stringify(cli)}, sdkVersions:${JSON.stringify(Object.values(sdkVersions))}, catalog,
  test:fixtureHooks, trace:(method,operationId)=>audit(method,{operationId}),
  async afterStatus(operationId,phase) {
    if(existsSync(join(base,'hold-status-'+operationId))){
      await gate('status-'+operationId,{phase});
      audit('held_status_returned',{operationId});
    }
  },
} satisfies LocalProfile;
`;
  await fs.writeFile(adapterPath,profileTypes+sharedSetup.replace(/^import .*$/gm, line =>
    line.includes("node:") ? line : line.includes("catalog-settings") ? line.replace("catalogSettings,","") : "")+hooks+adapter);
} else {
  await fs.writeFile(join(plugin,'index.server.ts'),setup+hooks+legacy);
}

const openPort = async () => {
  const server = createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
};
const port = await openPort();
const debug = await openPort();
await fs.writeFile(join(home,'config.json'),JSON.stringify({version:1,pluginsEnabled:true,
  daemon:{listen:'127.0.0.1:'+port,relay:{enabled:false}},features:{voiceMode:{enabled:false}},
  plugins:{...(!localRc && {[id]:{source:'directory',path:plugin,enabled:true}}),
    ...(integrated && {'paseo-project-skills':{source:'directory',path:product,enabled:true}})}}));
const { createHostClient } = await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/node/index.js')));
const { createPaseoApi } = await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/index.js')));
const { settingsRpc } = await import(pathToFileURL(join(repo,'node_modules/@getpaseo/plugin/dist/index.js')));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=25000) {
  const end=Date.now()+ms;
  while(Date.now()<end) {
    const value=await fn();
    if(value) return value;
    await sleep(100);
  }
  throw Error('Timed out: '+label);
}
const snapshot = async root => {
  const rows = {};
  async function walk(path,key) {
    const st=await fs.lstat(path,{bigint:true});
    rows[key]={dev:String(st.dev),ino:String(st.ino),mode:Number(st.mode & 0o7777n),
      ...(st.isFile() && {size:Number(st.size),sha256:createHash('sha256').update(await fs.readFile(path)).digest('hex')})};
    if(st.isDirectory()) for(const name of (await fs.readdir(path)).sort()) await walk(join(path,name),key==='.'?name:key+'/'+name);
  }
  await walk(root,'.');
  return rows;
};
async function target(name) {
  const path=join(targetRoot,name);
  await fs.mkdir(path,{mode:0o700});
  await fs.writeFile(join(path,'existing.txt'),'existing sentinel',{mode:0o640});
  return path;
}
const completedTarget=await target('completed'), partialTarget=await target('partial'), recoveryTarget=await target('recovery');
const completedBefore=await snapshot(completedTarget), partialBefore=await snapshot(partialTarget), recoveryBefore=await snapshot(recoveryTarget);
const log=await fs.open(join(base,'desktop.log'),'w',0o600);
const desktop=spawn(executable,['--remote-debugging-port='+debug],{
  cwd:base,env:{...process.env,PASEO_HOME:home,PASEO_ELECTRON_USER_DATA_DIR:desktopProfile},stdio:['ignore',log.fd,log.fd],
});
await log.close();
let client, ws, cdp, evaluate, peerProcess, peerHome;

try {
  const debugTarget=await until(async()=>{
    try {const list=await (await fetch('http://127.0.0.1:'+debug+'/json/list')).json(); return list.find(item=>item.type==='page');}
    catch { return undefined; }
  },'temporary Desktop DevTools');
  ws=new WebSocket(debugTarget.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let sequence=0;
  const pending=new Map();
  ws.addEventListener('message',event=>{
    const reply=JSON.parse(event.data), request=pending.get(reply.id);
    if(!request) return;
    pending.delete(reply.id);
    if(reply.error) request.reject(Error(reply.error.message)); else request.resolve(reply.result);
  });
  cdp=(method,params={})=>new Promise((resolve,reject)=>{
    const seq=++sequence;
    pending.set(seq,{resolve,reject});
    ws.send(JSON.stringify({id:seq,method,params}));
  });
  evaluate=async expression=>{
    const reply=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  };
  await cdp('Page.bringToFront');
  await cdp('Emulation.setFocusEmulationEnabled',{enabled:true});
  await evaluate(`(()=>{window.m45Keys=[];for(const type of ['keydown','keyup','click'])
    document.addEventListener(type,e=>window.m45Keys.push({type,key:e.key,target:e.target?.textContent?.trim()?.slice(0,100),tag:e.target?.tagName}),true);})()`);
  const text=()=>evaluate('document.body.innerText');
  const waitText=async needle=>until(async()=>{const body=await text();return body.includes(needle) && body;},needle);
  const buttons=`[...document.querySelectorAll('button,[role=button],[role=checkbox],[role=menuitem],[role=option]')]`;
  const find=(label)=>`${buttons}.filter(n=>n.getClientRects().length&&!n.closest('[aria-hidden=true]')).find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)})`;
  const click=async (label,{double=false}={})=>assert.equal(await evaluate(`(()=>{
    const n=${find(label)};if(!n)return 'missing';if(n.disabled||n.getAttribute('aria-disabled')==='true')return 'disabled';
    n.scrollIntoView({block:'center'});n.click();${double?'n.click();':''}return 'clicked';
  })()`),'clicked',label);
  const keyboard=async (label,key)=>{
    assert.equal(await evaluate(`(()=>{const n=${find(label)};if(!n)return false;n.scrollIntoView({block:'center'});n.focus();return document.activeElement===n&&n.tabIndex>=0})()`),true,label);
    const code=key==='Enter'?13:32;
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code:key==='Enter'?'Enter':'Space',windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,text:key==='Enter'?'\r':' ',unmodifiedText:key==='Enter'?'\r':' '});
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code:key==='Enter'?'Enter':'Space',windowsVirtualKeyCode:code});
  };
  let installation;
  if (localRc) {
    await until(async()=>{try {
      const status=JSON.parse((await exec(cli,['--home',home,'status','--json'],{timeout:2500})).stdout);
      return status.localDaemon==='running';
    }catch{return false;}},'temporary daemon before directory install');
    installation=JSON.parse((await exec(cli,['--home',home,'plugin','install',plugin,'--json'],{timeout:15000})).stdout);
  }
  await until(async()=>{
    try {
      const rows=JSON.parse((await exec(cli,['--home',home,'plugin','ls','--json'],{timeout:2000})).stdout);
      return rows.some(row=>row.id===id&&row.status==='running') &&
        (!integrated || rows.some(row=>row.id==='paseo-project-skills'&&row.status==='running'));
    } catch { return false; }
  },'Desktop-managed fixture daemon');
  client=createHostClient('127.0.0.1:'+port,{clientId:'m45-desktop-driver',clientType:'cli',reconnect:{enabled:false},
    localCredential:async()=>(await fs.readFile(join(home,'local-credential'),'utf8')).trim()});
  await client.connect();
  const endpoint = '127.0.0.1:'+port;
  const connect = async () => {
    const next=createHostClient(endpoint,{clientId:'m46-reconnect',clientType:'cli',reconnect:{enabled:false},
      localCredential:async()=>(await fs.readFile(join(home,'local-credential'),'utf8')).trim()});
    await next.connect();
    return next;
  };
  const settings=settingsRpc('catalog');
  if(localRc) assert.deepEqual(await client.invokePluginRpc(id,'apply.local-capability.v1',{}),{enabled:true});
  const initial=await client.invokePluginRpc(id,settings.read.name,{});
  await client.invokePluginRpc(id,settings.write.name,{revision:initial.revision,values:{catalogRef:sha}});
  await until(async()=>await evaluate(`Boolean(${find(fixtureTitle)})`),'fixture sidebar entry');
  if(await evaluate(`Boolean(${find('Skip setup')})`)) await click('Skip setup');
  await click(fixtureTitle);
  await waitText('Target Project');

  const select=async path=>{
    const input="[...document.querySelectorAll('input')].filter(n=>n.getClientRects().length&&!n.closest('[aria-hidden=true]')).find(n=>n.getAttribute('aria-label')==='Absolute path on the host')";
    await cdp('Page.bringToFront');
    await cdp('Emulation.setFocusEmulationEnabled',{enabled:true});
    let selected=false;
    for(let i=0;i<3&&!selected;i++){
      await until(async()=>await evaluate(`(()=>{const n=${input};if(!n)return false;n.scrollIntoView({block:'center'});n.focus();n.select();return document.activeElement===n;})()`),'focus target input',4000);
      await cdp('Input.insertText',{text:path});
      await until(async()=>await evaluate(`(${input})?.value===${JSON.stringify(path)}&&${find('Use directory')}?.getAttribute('aria-disabled')!=='true'`),'target input state',3000);
      await click('Use directory');
      try {await until(async()=> (await text()).includes('Target directory: '+path),'target validation',3500);selected=true;}
      catch(error){if(i===2)throw error;}
    }
    await click('Scan & Recommend');
    await waitText('Recommendation Results');
    if(!await evaluate(`Boolean(${find('Select demo')})`)) await click('Unknown (1)');
    await click('Select demo');
  };
  async function review() {
    await click('Preview Changes');
    await waitText('Eligible for create-only approval.');
    await waitText('Canonical files (33)');
    await waitText('1–25 of 33');
  }
  await select(completedTarget);
  const kiro=await evaluate("[...document.querySelectorAll('[role=checkbox]')].map(n=>n.getAttribute('aria-label')).find(label=>label?.startsWith('Kiro, '))");
  assert.ok(kiro);
  await click(kiro);
  await review();
  await waitText('Kiro is limited:');
  await keyboard('Next canonical files','Enter');
  await waitText('26–33 of 33');
  await keyboard('Review create-only approval',' ');
  const beforeConfirm=await waitText('Canonical files only. Kiro files are excluded');
  assert.ok(beforeConfirm.includes(sha));
  assert.deepEqual(await snapshot(completedTarget),completedBefore);
  await click('Select demo');
  await click('Select demo');
  assert.equal(await evaluate(`Boolean(${find('Confirm create-only')})`),false);
  assert.deepEqual(await snapshot(completedTarget),completedBefore);
  await review();
  await keyboard('Review create-only approval','Enter');
  await keyboard('Confirm create-only','Enter');
  await waitText('Completed');
  await click('Operation ledger');
  await waitText('Created and verified');
  const completedAfter=await snapshot(completedTarget);
  assert.deepEqual(completedAfter['existing.txt'],completedBefore['existing.txt']);
  assert.equal(completedAfter['.agents/skills/demo/file-31.txt'].mode,0o755);
  assert.equal(Object.keys(completedAfter).filter(path=>path.startsWith('.kiro')).length,0);
  const journalNames=async()=>(await fs.readdir(coordinator)).filter(name=>name.endsWith('.json'));
  assert.equal((await journalNames()).length,1);
  const completedText=await text();

  await fs.writeFile(join(base,'inject-partial'),'');
  await select(partialTarget);
  await review();
  await click('Review create-only approval');
  await click('Confirm create-only',{double:true});
  await waitText('Stopped after a partial write');
  // The first ledger stays expanded. Open the newest operation's ledger.
  await click('Operation ledger');
  await waitText('Created, incomplete');
  await waitText('Not attempted');
  const partialAfter=await snapshot(partialTarget);
  assert.deepEqual(partialAfter['existing.txt'],partialBefore['existing.txt']);
  assert.equal(partialAfter['.agents/skills/demo/file-01.txt'].mode,0o600);
  assert.equal(partialAfter['.agents/skills/demo/file-01.txt'].size,1);
  assert.equal(partialAfter['.agents/skills/demo/file-02.txt'],undefined);
  const partialText=await text();
  assert.equal((await journalNames()).length,2);
  await fs.unlink(join(base,'inject-partial'));
  await fs.writeFile(join(base,'inject-recovery'),'');
  await select(recoveryTarget);
  await review();
  await click('Review create-only approval');
  await click('Confirm create-only');
  await waitText('Recovery required');
  await click('Operation ledger');
  await waitText('Ownership unverified');
  const recoveryAfter=await snapshot(recoveryTarget);
  assert.deepEqual(recoveryAfter['existing.txt'],recoveryBefore['existing.txt']);
  assert.equal(recoveryAfter['.agents/skills/demo/file-01.txt'].size,0);
  const recoveryText=await text();
  const names=await journalNames();
  assert.equal(names.length,3);
  const journal=await Promise.all(names.map(async name=>{
    const operationId=name.slice(0,-5);
    return client.invokePluginRpc(id,'apply.status.v1',{operationId});
  }));
  for (const row of journal.flatMap(operation=>operation.ledger.filter(row=>row.state==='created_verified'&&row.kind==='file').map(row=>({operation,row})))) {
    const after=row.operation.phase==='completed'?completedAfter:row.operation.phase==='partial_failure'?partialAfter:recoveryAfter;
    assert.equal(after[row.row.destination].sha256,row.row.expected.sha256);
    assert.equal(after[row.row.destination].mode,row.row.expected.mode);
    assert.equal(after[row.row.destination].ino,row.row.identity.ino);
  }
  const geometryBefore=await evaluate('({width:innerWidth,height:innerHeight})');
  await cdp('Emulation.setDeviceMetricsOverride',{width:520,height:720,deviceScaleFactor:1,mobile:false});
  await sleep(300);
  const geometry=await evaluate(`(()=>{
    const n=[...document.querySelectorAll('[role=header],h1,h2,h3,div')].find(n=>n.childElementCount===0&&n.textContent.trim()==='Apply Operations');
    const container=n?.parentElement;
    return {width:innerWidth,height:innerHeight,containerWidth:container?.clientWidth,scrollWidth:container?.scrollWidth,visible:Boolean(n)};
  })()`);
  assert.ok(geometry.visible);assert.equal(geometry.width,520);
  assert.ok(geometry.scrollWidth<=geometry.containerWidth+1,JSON.stringify(geometry));
  await cdp('Emulation.clearDeviceMetricsOverride');
  const integration = {};
  if (integrated) {
    await fs.unlink(join(base,'inject-recovery'));
    async function approve(path, useKiro = false) {
      await select(path);
      if(useKiro) {
        const label=await evaluate("[...document.querySelectorAll('[role=checkbox]')].map(n=>n.getAttribute('aria-label')).find(label=>label?.startsWith('Kiro, '))");
        assert.ok(label);
        await click(label);
      }
      await review();
      await click('Review create-only approval');
      await click('Confirm create-only');
    }
    const audit=async()=> (await fs.readFile(join(base,'rpc-audit.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const readGate=async name=>until(async()=>{
      try {return JSON.parse(await fs.readFile(join(base,name+'.ready'),'utf8'));} catch {return null;}
    },name);
    const release=name=>fs.writeFile(join(base,name+'.release'),'');
    const openFixture=async()=>{
      await until(async()=>{try{return await evaluate(`Boolean(${find(fixtureTitle)})`);}catch{return false;}},'fixture sidebar after reload');
      await click(fixtureTitle);
      await waitText('Target Project');
    };

    const reloadFixture=async()=>{
      const old=await evaluate('performance.timeOrigin');
      await cdp('Page.reload');
      await until(async()=>{try{return await evaluate('performance.timeOrigin')!==old;}catch{return false;}},'new renderer');
      await openFixture();
    };

    const lateTarget=await target('late-no-clobber');
    const foreign='.agents/skills/demo/file-00.txt';
    await fs.mkdir(join(lateTarget,dirname(foreign)),{recursive:true,mode:0o755});
    await fs.writeFile(join(base,'inject-late'),'');
    await approve(lateTarget);
    await readGate('late-boundary');
    await fs.writeFile(join(lateTarget,foreign),'foreign at boundary',{mode:0o640});
    const lateBefore=await snapshot(lateTarget);
    await release('late-boundary');
    const lateUi=await waitText('Failed before writing');
    assert.ok(lateUi.includes('destination_exists'));
    assert.deepEqual(await snapshot(lateTarget),lateBefore);
    integration.late={before:lateBefore,after:await snapshot(lateTarget),ui:lateUi};
    await fs.writeFile(join(base,'integration-checkpoints.json'),JSON.stringify(integration,null,2));
    await fs.unlink(join(base,'inject-late'));

    const repoTarget=await target('kiro-root');
    await exec('git',['-C',repoTarget,'init','-b','main']);
    const worktree=join(targetRoot,'kiro-worktree');
    await exec('git',['-C',repoTarget,'worktree','add','--orphan','-b','fixture-linked',worktree]);
    const nested=join(repoTarget,'nested');
    await fs.mkdir(nested,{mode:0o755});
    integration.kiro=[];
    for (const [kind,path,derived] of [['root',repoTarget,true],['worktree',worktree,true],['nested',nested,false]]) {
      const before=await snapshot(path);
      const prior=(await audit()).filter(row=>row.method==='apply').length;
      await approve(path,true);
      const submitted=await until(async()=>{const rows=(await audit()).filter(row=>row.method==='apply');return rows.length>prior&&rows.at(-1);},'kiro submit');
      const result=await until(async()=>{const status=await client.invokePluginRpc(id,'apply.status.v1',{operationId:submitted.operationId});return status.phase==='completed'&&status;},'kiro completed');
      await until(async()=> (await text()).includes('Completed') && (await text()).includes(submitted.operationId),'Kiro Desktop result');
      const after=await snapshot(path);
      for(const [name,value] of Object.entries(before)) assert.deepEqual(after[name],value,name);
      const files=result.ledger.filter(row=>row.kind==='file');
      assert.equal(files.filter(row=>row.destination.startsWith('.kiro/')).length,derived?33:0);
      for(const row of files) {
        assert.equal(after[row.destination].sha256,row.expected.sha256);
        assert.equal(after[row.destination].mode,row.expected.mode);
        assert.equal(after[row.destination].ino,row.identity.ino);
      }
      integration.kiro.push({kind,before,after,result});
    }

    const lostTarget=await target('lost-reply-reload');
    await fs.writeFile(join(base,'inject-lost'),'');
    await approve(lostTarget);
    const lost=await readGate('lost-terminal');
    const stored=await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify('project-skills.apply-operations.v1:'+id)}))`);
    assert.ok(stored.some(row=>row.operationId===lost.operationId));
    assert.ok(stored.every(row=>Object.keys(row).sort().join(',')==='hostId,operationId,planDigest'));
    const count=(await audit()).filter(row=>row.method==='apply').length;
    await fs.writeFile(join(base,'hold-status-'+lost.operationId),'');
    await reloadFixture();
    const lostStatus=await readGate('status-'+lost.operationId);
    assert.equal(lostStatus.phase,'completed');
    await waitText('Outcome unknown');
    await fs.unlink(join(base,'hold-status-'+lost.operationId));
    // Drop the old renderer's held status request, then recover from a new connection.
    await reloadFixture();
    await until(async()=> (await audit()).filter(row=>row.method==='status'&&row.operationId===lost.operationId).length>=2,'fresh Status');
    await release('status-'+lost.operationId);
    await release('lost-terminal');
    await until(async()=>!(await text()).includes('Outcome unknown'),'resolved Desktop outcomes');
    assert.equal((await audit()).filter(row=>row.method==='apply').length,count);
    integration.lost={operationId:lost.operationId,lookupOnly:true,stored,status:lostStatus,ui:await text()};
    await fs.writeFile(join(base,'integration-checkpoints.json'),JSON.stringify(integration,null,2));
    await fs.unlink(join(base,'inject-lost'));

    const restartTarget=await target('daemon-restart');
    const restartBefore=await snapshot(restartTarget);
    await fs.writeFile(join(base,'inject-restart'),'');
    await approve(restartTarget);
    const boundary=await readGate('restart-boundary');
    const submitted=(await audit()).filter(row=>row.method==='apply').at(-1);
    const atCrash=await snapshot(restartTarget);
    assert.equal(atCrash['.agents/skills/demo/file-01.txt'].size,0);
    assert.deepEqual(atCrash['existing.txt'],restartBefore['existing.txt']);
    process.kill(boundary.parent,'SIGKILL');
    await client.close();
    await exec(cli,['--home',home,'daemon','restart'],{timeout:20000});
    client=await until(async()=>{try{return await connect();}catch{return null;}},'daemon reconnect');
    await reloadFixture();
    const recovered=await until(async()=>{
      try {const result=await client.invokePluginRpc(id,'apply.status.v1',{operationId:submitted.operationId});return result.phase==='recovery_required'&&result;} catch {return null;}
    },'restart recovery');
    await until(async()=> (await audit()).some(row=>row.method==='status'&&row.operationId===submitted.operationId&&row.pid!==boundary.parent),'Desktop Status after restart');
    assert.deepEqual(await snapshot(restartTarget),atCrash);
    const orphan=await fs.lstat(boundary.extraction.directory,{bigint:true});
    assert.equal(String(orphan.dev),boundary.extraction.dev);
    assert.equal(String(orphan.ino),boundary.extraction.ino);
    assert.equal(Number(orphan.mode&0o7777n),0o700);
    assert.ok(boundary.extraction.directory.startsWith(await fs.realpath(tmpdir())+'/pps-helper-m43-'));
    await fs.rm(boundary.extraction.directory,{recursive:true});
    integration.restart={privateOrphanRemovedByHarness:true,before:restartBefore,atCrash,after:await snapshot(restartTarget),recovered,ui:await text(),boundary};
    await fs.writeFile(join(base,'integration-checkpoints.json'),JSON.stringify(integration,null,2));

    if (!localRc) {
    await fs.unlink(join(base,'inject-restart'));
    peerHome=join(base,'peer-daemon');
    const peerPort=await openPort();
    const peerEndpoint='127.0.0.1:'+peerPort;
    await fs.mkdir(peerHome,{mode:0o700});
    await fs.mkdir(join(peerHome,'runtime/project-skills-m44'),{recursive:true,mode:0o700});
    await fs.writeFile(join(peerHome,'config.json'),JSON.stringify({version:1,pluginsEnabled:true,
      daemon:{listen:peerEndpoint,relay:{enabled:false}},features:{voiceMode:{enabled:false}},
      plugins:{[id]:{source:'directory',path:plugin,enabled:true}}}));
    const peerLog=await fs.open(join(base,'peer.log'),'w',0o600);
    peerProcess=spawn(cli,['daemon','run','--home',peerHome],{cwd:base,stdio:['ignore',peerLog.fd,peerLog.fd]});
    await peerLog.close();
    const peer=await until(async()=>{
      const next=createHostClient(peerEndpoint,{clientId:'m46-peer',clientType:'cli',reconnect:{enabled:false}});
      try{await next.connect(); return next;}catch{await next.close();return null;}
    },'peer daemon');
    let peerHost;
    try{peerHost=(await createPaseoApi(peer).hosts.list()).self.serverId;}finally{await peer.close();}
    const origin=(await createPaseoApi(client).hosts.list()).self.serverId;
    assert.notEqual(peerHost,origin);
    const peerLabel='Fixture Peer M46';
    const originLabel=await evaluate(`(()=>{
      const key='@paseo:daemon-registry', rows=JSON.parse(localStorage.getItem(key));
      const origin=rows.find(row=>row.serverId===${JSON.stringify(origin)});
      if(!origin)throw Error('original host missing');
      const time=new Date().toISOString(), endpoint=${JSON.stringify(peerEndpoint)}, connectionId='direct:'+endpoint;
      rows.push({serverId:${JSON.stringify(peerHost)},label:${JSON.stringify(peerLabel)},appearance:{color:'none',badgeDisplay:null},
        lifecycle:{},connections:[{id:connectionId,type:'directTcp',endpoint}],preferredConnectionId:connectionId,createdAt:time,updatedAt:time});
      localStorage.setItem(key,JSON.stringify(rows));
      return origin.label;
    })()`);
    async function switchHost(label) {
      await until(async()=>await evaluate("Boolean(document.querySelector('[data-testid=plugin-host-filter-trigger]'))"),'plugin host picker');
      await evaluate("document.querySelector('[data-testid=plugin-host-filter-trigger]').click()");
      await waitText(label);
      await click(label);
      await waitText('Paseo host: '+label);
    }
    await reloadFixture();
    if(!(await text()).includes('Paseo host: '+originLabel)) await switchHost(originLabel);
    await waitText('Saved on this host: '+sha);
    const switchTarget=await target('switch-host');
    await fs.writeFile(join(base,'inject-switch'),'');
    await approve(switchTarget);
    await readGate('switch-boundary');
    const switching=(await audit()).filter(row=>row.method==='apply').at(-1);
    const switchOperation=switching.operationId;
    const switchAtBoundary=await snapshot(switchTarget);
    assert.equal(switchAtBoundary['.agents/skills/demo/file-01.txt'].size,0);
    await fs.writeFile(join(base,'hold-status-'+switchOperation),'');
    const rowText=op=>evaluate(`[...document.querySelectorAll('div')].find(n=>n.childElementCount===0&&n.textContent.trim()==='Operation '+${JSON.stringify(op)})?.parentElement?.innerText`);
    assert.equal(await evaluate(`(()=>{
      const row=[...document.querySelectorAll('div')].find(n=>n.childElementCount===0&&n.textContent.trim()==='Operation '+${JSON.stringify(switchOperation)})?.parentElement;
      const button=[...row?.querySelectorAll('button,[role=button]')??[]].find(n=>n.textContent.trim()==='Check operation status');
      if(!button||button.getAttribute('aria-disabled')==='true')return false;button.click();return true;
    })()`),true);
    assert.equal((await readGate('status-'+switchOperation)).phase,'writing');
    await switchHost(peerLabel);
    await waitText('Operation '+switchOperation);
    const during=(await audit()).filter(row=>row.operationId===switchOperation&&row.method==='status');
    assert.equal(during.length,1);
    assert.equal(during[0].pid,switching.pid);
    await release('switch-boundary');
    await until(async()=>{
      const record=JSON.parse(await fs.readFile(join(coordinator,switchOperation+'.json'),'utf8'));
      return record.operation.phase==='completed';
    },'terminal after host switch');
    await fs.unlink(join(base,'hold-status-'+switchOperation));
    await switchHost(originLabel);
    const completedRow=()=>until(async()=>{const row=await rowText(switchOperation);return row?.includes('Completed')&&row;},'operation complete');
    await completedRow();
    await release('status-'+switchOperation);
    await until(async()=>(await audit()).some(row=>row.method==='held_status_returned'&&row.operationId===switchOperation),'stale Status released');
    const switchUi=await completedRow();
    const switchAudit=(await audit()).filter(row=>row.operationId===switchOperation);
    assert.ok(switchAudit.every(row=>row.pid===switching.pid));
    assert.equal(switchAudit.filter(row=>row.method==='apply').length,1);
    integration.hostSwitch={origin,peerHost,atBoundary:switchAtBoundary,after:await snapshot(switchTarget),switchUi,switchAudit};
    await fs.writeFile(join(base,'integration-checkpoints.json'),JSON.stringify(integration,null,2));

    }
    if (localRc) {
      await fs.unlink(join(base,'inject-restart'));
      const mount=join(targetRoot,'unsupported-apfs');
      const image=join(base,'unsupported-apfs.sparseimage');
      await fs.mkdir(mount,{mode:0o700});
      await exec('/usr/bin/hdiutil',['create','-size','72m','-fs','Case-sensitive APFS','-volname','PPSRCGate','-type','SPARSE',image],{timeout:12000});
      await exec('/usr/bin/hdiutil',['attach','-nobrowse','-mountpoint',mount,image],{timeout:12000});
      try {
        const root=join(mount,'fixture');
        await fs.mkdir(root,{mode:0o700});
        await fs.writeFile(join(root,'CaseWitness'),'upper',{mode:0o600});
        await assert.rejects(fs.lstat(join(root,'casewitness')),{code:'ENOENT'});
        const hostId=(await createPaseoApi(client).hosts.list()).self.serverId;
        const saved=await client.invokePluginRpc(id,settings.read.name,{});
        const before=await snapshot(root);
        const result=await client.invokePluginRpc(id,'preview.providers.v2',{
          viewNonce:'unsupported-apfs',intent:{schemaVersion:1,hostId,canonicalDirectory:root,
            catalogSource:'https://github.com/anmeo2204/project-skills',catalogCommitSha:sha,settingsRevision:saved.revision,
            selectedSkillIds:['demo'],targetProviderIds:[],recommendationRequestId:'unsupported-apfs'},
        });
        assert.equal(result.status,'ready');
        assert.deepEqual(result.applyEligibility,{status:'ineligible',reasons:['write_capability_unavailable']});
        const attempt=await client.invokePluginRpc(id,'apply.create.v1',{
          previewId:result.receipt.previewId,planDigest:result.receipt.planDigest,viewNonce:result.receipt.viewNonce,
          operationId:randomBytes(16).toString('hex'),approval:'create_only_v1',
        });
        assert.deepEqual(attempt,{status:'error',code:'unsupported_environment'});
        const after=await snapshot(root);
        assert.deepEqual(after,before);
        integration.unsupported={filesystem:'APFS case-sensitive disk image',eligibility:result.applyEligibility,attempt,before,after};
      } finally { await exec('/usr/bin/hdiutil',['detach',mount],{timeout:12000}); }
    }

    await click('Project Skills');
    await waitText('Target Project');
    const productUi=await text();
    assert.doesNotMatch(productUi,/Create-only Approval|Confirm create-only|Apply Operations/);
    assert.deepEqual(await client.invokePluginRpc('paseo-project-skills','foundation.status',{}),{status:'ready'});
    assert.deepEqual(await client.invokePluginRpc('paseo-project-skills','preview.providers.v2',{
      viewNonce:'shipping-probe',intent:{schemaVersion:1,hostId:'wrong-host',canonicalDirectory:completedTarget,
        catalogSource:'https://github.com/anmeo2204/project-skills',catalogCommitSha:sha,settingsRevision:'shipping',
        selectedSkillIds:['demo'],targetProviderIds:[],recommendationRequestId:'shipping-probe'},
    }),{status:'error',code:'host_mismatch'});
    for(const name of ['apply.create.v1','apply.status.v1'])
      await assert.rejects(client.invokePluginRpc('paseo-project-skills',name,{operationId:'a'.repeat(32)}));
    integration.shipping={route:'directory',productEntryPoints:true,productApplyRpcAbsent:true,productUi};
    integration.audit=await audit();
  }
  const versionLog=await fs.readFile(join(base,'desktop.log'),'utf8');
  assert.match(versionLog, /version: '0\.17\.5'/);
  const report={integration,localRc,installation,pluginId:id,paseoVersion:'0.17.5',sdkVersions,testing:{
    staleSelectionABA:true, keyboardEnterAndSpace:true, compactOperationPanel:geometry, originalViewport:geometryBefore,
    paginated33FilePlan:true, doubleClickJournalCount:2, kiroCanonicalOnly:true,
  }, completed:{before:completedBefore,after:completedAfter,text:completedText},partial:{before:partialBefore,after:partialAfter,text:partialText}, recovery:{before:recoveryBefore,after:recoveryAfter,text:recoveryText}, journal};
  await fs.writeFile(join(base,'result.json'),JSON.stringify(report,null,2));
  console.log('PASS Desktop fixture approval, real writes, keyboard, compact panel, 33-file plan and partial ledger');
} catch (error) {
  if(evaluate) try {await fs.writeFile(join(base,'failure-ui.txt'),await evaluate('document.body.innerText'));
    await fs.writeFile(join(base,'failure-keys.json'),JSON.stringify(await evaluate('window.m45Keys'),null,2));} catch {}
  throw error;
} finally {
  await client?.close();
  const exited = desktop.exitCode===null && desktop.signalCode===null ? once(desktop,'exit') : Promise.resolve();
  if(cdp) {
    try {await Promise.race([cdp('Browser.close'),sleep(1000)]);} catch {}
  }
  try { ws?.close(); } catch {}
  await Promise.race([exited,sleep(4500)]);
  if(desktop.exitCode===null && desktop.signalCode===null) {desktop.kill('SIGTERM');await exited;}
  try {await exec(cli,['--home',home,'daemon','stop'],{timeout:10000});} catch {}
  let peerStopped;
  if(peerHome){
    try{await exec(cli,['--home',peerHome,'daemon','stop'],{timeout:10000});}
    catch{peerProcess?.kill('SIGTERM');}
    peerStopped=JSON.parse((await exec(cli,['--home',peerHome,'status','--json'],{timeout:4000})).stdout);
    assert.equal(peerStopped.localDaemon,'stopped');
  }
  const status=JSON.parse((await exec(cli,['--home',home,'status','--json'],{timeout:4000})).stdout);
  assert.equal(status.localDaemon,'stopped');assert.equal(status.pid,null);
  await fs.writeFile(join(base,'cleanup.json'),JSON.stringify({desktopExited:true,status,peerStopped},null,2));
}
