import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
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
const home = join(base,'daemon'), desktopProfile = join(base,'desktop'), plugin = join(base,'plugin');
const coordinator = join(home,'runtime/project-skills-m44');
const id = 'm45-approval-fixture';
const sha = 'a'.repeat(40);
for (const path of [home,join(home,'runtime'),coordinator,desktopProfile,plugin]) await fs.mkdir(path,{mode:0o700});
for (const directory of ['client','server','shared']) await fs.cp(join(repo,directory),join(plugin,directory),{recursive:true});
await fs.symlink(join(repo,'node_modules'),join(plugin,'node_modules'));
await fs.writeFile(join(plugin,'paseo-plugin.json'),JSON.stringify({ id, name:'Approval Fixture', requirements:{paseo:'>=0.17.4'} }));
await fs.writeFile(join(plugin,'index.client.tsx'),`
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { FoundationScreen } from './client/foundation-screen';
import { FixtureApprovalScope } from './client/fixture-approval';
import { createOperationTracker } from './client/apply-tracker';
export default function contribute(client) {
  const tracker = createOperationTracker();
  const removeScreen = client.addScreen({id:'foundation',title:'Approval Fixture',Component:props=>
    <FixtureApprovalScope slot=${JSON.stringify(id)} tracker={tracker}><FoundationScreen {...props}/></FixtureApprovalScope>});
  const removeSidebar = client.addSidebarHeaderItem({id:'foundation',title:'Approval Fixture',Component:({currentScreen,openScreen})=>
    <SidebarRow icon="BookOpen" active={currentScreen?.screenId==='foundation'} onPress={()=>openScreen({screenId:'foundation'})}/>});
  return ()=>{ removeSidebar(); removeScreen(); };
}`);
await fs.writeFile(join(plugin,'index.server.ts'),`
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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
const descriptor = (path,text,mode='100644') => {
  const bytes=Buffer.from(text);
  return {path,bytes,mode,sizeBytes:bytes.length,blobSha:createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex')};
};
const catalog={load:async()=>({schemaVersion:1,source:catalogSource,commitSha:${JSON.stringify(sha)},skills:[{
  id:'demo',directory:'skills/demo',metadata:{name:'demo',description:'Fixture skill'},
  entrypoint:descriptor('SKILL.md','---\\nname: demo\\ndescription: Fixture skill\\n---\\nFixture.\\n'),
  supportingFiles:Array.from({length:32},(_,i)=>descriptor('file-'+String(i).padStart(2,'0')+'.txt','fixture '+i+'\\n',i===31?'100755':undefined))
}]})};
export default function contribute(server) {
  const settings=server.registerSettings(catalogSettings);
  const receipts=new PreviewReceiptStore({fixtureApply: target=>isFixtureApplyTarget(base,target)});
  const preview=createCanonicalPreviewHandler(settings,catalog,{receiptStore:receipts});
  const scanner=new ProjectScanner();
  const apply=createFixtureApply({fixtureBase:base,installation:${JSON.stringify(id)},receipts,settings,catalog,
    environment:{paseoVersion:'0.17.5',sdkVersion:'0.17.4'},
    test:{
      controls:()=>{
        const destination='.agents/skills/demo/file-01.txt';
        if(existsSync(join(base,'inject-partial'))) return {barriers:[],faults:[{point:'write',destination,error:'ENOSPC',afterBytes:1}]};
        if(existsSync(join(base,'inject-recovery'))) return {barriers:[{point:'after_create',destination}],faults:[]};
      },
      onEvent:event=>{if(event.event==='barrier') process.kill(event.pid,'SIGKILL');},
    }});
  server.handle(foundationStatusRpc,()=>({status:'ready'}));
  server.handle(validateDirectoryRpc,validateDirectory);
  server.handle(catalogLoadRpc,()=>loadCatalogForHost(settings,catalog));
  server.handle(recommendationEvaluateSubscription,createRecommendationHandler(settings,catalog,scanner));
  server.handle(providerPreviewV2Rpc,preview.handleProvidersV2);
  server.handle(applyCreateRpc,apply.create);
  server.handle(applyStatusRpc,apply.status);
  return async()=>{await apply.dispose(); await preview.dispose(); await scanner.dispose();};
}`);

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
  plugins:{[id]:{source:'directory',path:plugin,enabled:true}}}));
const { createHostClient } = await import(pathToFileURL(join(repo,'node_modules/@getpaseo/client/dist/node/index.js')));
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
  const path=join(base,name);
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
let client, ws, cdp, evaluate;
try {
  const target=await until(async()=>{
    try {const list=await (await fetch('http://127.0.0.1:'+debug+'/json/list')).json(); return list.find(item=>item.type==='page');}
    catch { return undefined; }
  },'temporary Desktop DevTools');
  ws=new WebSocket(target.webSocketDebuggerUrl);
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
  const buttons=`[...document.querySelectorAll('button,[role=button],[role=checkbox]')]`;
  const find=(label)=>`${buttons}.find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)})`;
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
  await until(async()=>{
    try {
      const rows=JSON.parse((await exec(cli,['--home',home,'plugin','ls','--json'],{timeout:2000})).stdout);
      return rows.some(row=>row.id===id&&row.status==='running');
    } catch { return false; }
  },'Desktop-managed fixture daemon');
  client=createHostClient('127.0.0.1:'+port,{clientId:'m45-desktop-driver',clientType:'cli',reconnect:{enabled:false},
    localCredential:async()=>(await fs.readFile(join(home,'local-credential'),'utf8')).trim()});
  await client.connect();
  const settings=settingsRpc('catalog');
  const initial=await client.invokePluginRpc(id,settings.read.name,{});
  await client.invokePluginRpc(id,settings.write.name,{revision:initial.revision,values:{catalogRef:sha}});
  await until(async()=>await evaluate(`Boolean(${find('Approval Fixture')})`),'fixture sidebar entry');
  if(await evaluate(`Boolean(${find('Skip setup')})`)) await click('Skip setup');
  await click('Approval Fixture');
  await waitText('Target Project');

  const select=async path=>{
    await evaluate(`(()=>{const n=[...document.querySelectorAll('input')].find(n=>n.getAttribute('aria-label')==='Absolute path on the host');
      if(!n)throw Error('missing target field');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(path)});
      n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click('Use directory');
    await waitText('Target directory: '+path);
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
  const versionLog=await fs.readFile(join(base,'desktop.log'),'utf8');
  assert.match(versionLog, /version: '0\.17\.5'/);
  const report={paseoVersion:'0.17.5',sdkVersions,testing:{
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
  const status=JSON.parse((await exec(cli,['--home',home,'status','--json'],{timeout:4000})).stdout);
  assert.equal(status.localDaemon,'stopped');assert.equal(status.pid,null);
  await fs.writeFile(join(base,'cleanup.json'),JSON.stringify({desktopExited:true,status},null,2));
}
