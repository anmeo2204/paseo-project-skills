// Cold-reopen the isolated Desktop profile created by the integrated fixture driver.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const base = await fs.realpath(process.argv[2]);
assert.equal(dirname(base), await fs.realpath(tmpdir()));
assert.match(basename(base), /^pps-m43-m45-[A-Za-z0-9]+$/);
const prior = JSON.parse(await fs.readFile(join(base,'result.json'),'utf8'));
const priorCleanup = JSON.parse(await fs.readFile(join(base,'cleanup.json'),'utf8'));
assert.equal(priorCleanup.desktopExited,true);
assert.equal(priorCleanup.status.localDaemon,'stopped');
const operationId = prior.integration.lost.operationId;
const pluginId = prior.pluginId ?? "m45-approval-fixture";
assert.match(pluginId, /^[a-z0-9-]+$/);
assert.match(operationId,/^[a-f0-9]{32,64}$/);
const app = process.env.M45_PASEO_APP ?? '/Applications/Paseo.app';
const cli = join(app,'Contents/Resources/bin/paseo');
const home = join(base,'daemon');
const audit = async () => (await fs.readFile(join(base,'rpc-audit.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
const before = await audit();
const server = createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const debug = server.address().port;
await new Promise(resolve=>server.close(resolve));
const log = await fs.open(join(base,'desktop-cold-reopen.log'),'w',0o600);
const desktop = spawn(join(app,'Contents/MacOS/Paseo'),['--remote-debugging-port='+debug],{
  cwd:base,env:{...process.env,PASEO_HOME:home,PASEO_ELECTRON_USER_DATA_DIR:join(base,'desktop')},
  stdio:['ignore',log.fd,log.fd],
});
await log.close();
const exited = once(desktop,'exit');
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,label) {
  for(let i=0;i<260;i++){
    try{const value=await read();if(value)return value;}catch{}
    await sleep(100);
  }
  throw Error('Timed out: '+label);
}
let socket, call;
try {
  const page = await until(async()=> (await (await fetch('http://127.0.0.1:'+debug+'/json/list')).json()).find(row=>row.type==='page'),'Desktop page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;
  const pending=new Map();
  socket.onmessage=event=>{
    const reply=JSON.parse(event.data), entry=pending.get(reply.id);
    if(!entry)return;
    pending.delete(reply.id);
    if(reply.error)entry.reject(Error(reply.error.message));else entry.resolve(reply.result);
  };
  call=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence;
    pending.set(id,{resolve,reject});
    socket.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>(await call('Runtime.evaluate',{expression,returnByValue:true})).result?.value;
  await until(async()=>await evaluate(`(()=>{
    const button=document.querySelector('[data-testid=plugin-sidebar-${pluginId}-foundation]');
    if(!button)return false;
    button.click();return true;
  })()`),'open Approval Fixture');
  const row = await until(async()=>{
    const content=await evaluate(`[...document.querySelectorAll('div')].find(n=>n.childElementCount===0&&n.textContent.trim()==='Operation '+${JSON.stringify(operationId)})?.parentElement?.innerText`);
    return content?.includes('Completed')&&content;
  },'completed operation from prior Desktop process');
  const after = await audit();
  assert.equal(after.filter(event=>event.method==='apply').length,before.filter(event=>event.method==='apply').length);
  assert.ok(after.slice(before.length).some(event=>event.method==='status'&&event.operationId===operationId));
  await fs.writeFile(join(base,'cold-reopen.json'),JSON.stringify({operationId,row,applyResent:false,
    statusAudit:after.slice(before.length)},null,2));
  console.log('PASS Desktop cold reopen recovered operation via Status only');
} finally {
  if(call)try{await Promise.race([call('Browser.close'),sleep(900)]);}catch{}
  socket?.close();
  await Promise.race([exited,sleep(4500)]);
  if(desktop.exitCode===null&&desktop.signalCode===null){desktop.kill('SIGTERM');await exited;}
  try{await exec(cli,['--home',home,'daemon','stop'],{timeout:10000});}catch{}
  const status=JSON.parse((await exec(cli,['--home',home,'status','--json'])).stdout);
  assert.equal(status.localDaemon,'stopped');
  assert.equal(status.pid,null);
  await fs.writeFile(join(base,'cold-reopen-cleanup.json'),JSON.stringify({desktopExited:true,status},null,2));
}
