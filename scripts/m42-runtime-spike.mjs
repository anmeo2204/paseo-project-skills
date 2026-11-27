// Read-only target spike. All compilation, plugin installation and lock-file I/O
// live in a fresh temporary Paseo home. No production native writer is included.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { openSync, closeSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.M42_PASEO_CLI ?? '/Applications/Paseo.app/Contents/Resources/bin/paseo';
const { createHostClient } = await import(pathToFileURL(join(repo, 'node_modules/@getpaseo/client/dist/node/index.js')));
const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'm42-runtime-'))), home = join(base, 'daemon');
await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(join(home, 'runtime'), { mode: 0o700 });
await fs.mkdir(join(home, 'runtime/project-skills'), { mode: 0o700 });
const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const c = `#include <stdio.h>
#include <unistd.h>
#include <sys/file.h>
#include <fcntl.h>
int main(int argc,char**argv){if(argc>1){int fd=open(argv[1],O_RDWR|O_CREAT,0600);if(fd<0)return 2;if(flock(fd,LOCK_EX|LOCK_NB)){puts("busy");close(fd);return 0;}puts("acquired");fflush(stdout);usleep(800000);close(fd);}else printf("native-ok pid=%d\\n",getpid());return 0;}
`;
await fs.writeFile(join(base, 'probe.c'), c);
await exec('clang', ['-Wall', '-Wextra', '-o', join(base, 'probe'), join(base, 'probe.c')]);
const payload = await fs.readFile(join(base, 'probe'));
for (const id of ['a', 'b']) {
  const plugin = join(base, 'plugin-' + id); await fs.mkdir(join(plugin, 'server'), { recursive: true });
  await fs.symlink(join(repo, 'node_modules'), join(plugin, 'node_modules'));
  await fs.writeFile(join(plugin, 'paseo-plugin.json'), JSON.stringify({ id: 'm42-spike-' + id, name: 'M42 runtime spike ' + id, requirements: { paseo: '>=0.17.4' } }));
  await fs.writeFile(join(plugin, 'server/payload.ts'), `export const base64=${JSON.stringify(payload.toString('base64'))};\n`);
  await fs.writeFile(join(plugin, 'index.server.ts'), `
import {defineRpc} from '@getpaseo/plugin';
import {z} from 'zod';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {base64} from './server/payload';
const exec=promisify(execFile),key=Symbol.for('paseo.m42.spike');
(globalThis as any)[key]=((globalThis as any)[key]??0)+1;
export default function(server:any){
 server.handle(defineRpc({name:'spike.inspect',input:z.strictObject({lock:z.boolean()}),output:z.any()}),async(input:any,ctx:any)=>{
  const directory=await mkdtemp(join(tmpdir(),'m42-native-')),helper=join(directory,'probe');
  try {
   await writeFile(helper,Buffer.from(base64,'base64'),{mode:0o700});
   const result=await exec(helper,input.lock?[join(process.env.PASEO_HOME!,'runtime/project-skills/writer.lock')]:[],{timeout:3000,maxBuffer:4096});
   let cwdAssetError:string|null=null;
   try{await exec(join(process.cwd(),'native/probe'),[],{timeout:1000});}catch(e:any){cwdAssetError=e.code;}
   return {pid:process.pid,ppid:process.ppid,node:process.versions.node,electron:process.versions.electron,platform:process.platform,arch:process.arch,
    contextKeys:Object.keys(ctx).sort(),serverKeys:Object.keys(server).sort(),globalCount:(globalThis as any)[key],
    moduleUrl:import.meta.url??null,dirname:typeof __dirname==='undefined'?null:__dirname,cwd:process.cwd(),cwdAssetError,
    paseoHome:process.env.PASEO_HOME,result:result.stdout.trim()};
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 return ()=>{};
}
`);
}
await fs.writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, pluginsEnabled: true,
  daemon: { listen: '127.0.0.1:' + port, relay: { enabled: false } }, features: { voiceMode: { enabled: false } },
  plugins: Object.fromEntries(['a', 'b'].map(id => ['m42-spike-' + id, { source: 'directory', path: join(base, 'plugin-' + id), enabled: true }])) }));
const fd = openSync(join(base, 'console.log'), 'w', 0o600);
const worker = spawn(cli, ['daemon', 'run', '--home', home], { cwd: base, stdio: ['ignore', fd, fd] });
closeSync(fd);
let clients = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const { stdout } = await exec(cli, ['--home', home, 'plugin', 'ls', '--json'], { timeout: 3000 });
      const plugins = JSON.parse(stdout);
      if (['a', 'b'].every(id => plugins.some(p => p.id === 'm42-spike-' + id && p.status === 'running'))) { ready = true; break; }
      if (plugins.some(p => p.id.startsWith('m42-spike-') && p.status === 'failed')) throw new Error('Plugin failed; inspect console.log');
    } catch (error) { if (error.message.startsWith('Plugin failed')) throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'temporary daemon/plugins did not become ready');
  clients = ['one', 'two'].map(id => createHostClient('127.0.0.1:' + port, { clientId: 'm42-spike-' + id, clientType: 'cli', reconnect: { enabled: false } }));
  await Promise.all(clients.map(client => client.connect()));
  const call = (i, id, lock = false) => clients[i].invokePluginRpc('m42-spike-' + id, 'spike.inspect', { lock });
  const a = await call(0, 'a'), b = await call(0, 'b'), secondCaller = await call(1, 'a');
  assert.notEqual(a.pid, b.pid); assert.equal(a.ppid, b.ppid);
  assert.deepEqual(a.contextKeys, ['paseo']); assert.deepEqual(secondCaller.contextKeys, ['paseo']);
  assert.equal(a.globalCount, 1); assert.equal(b.globalCount, 1);
  assert.match(a.result, /^native-ok pid=/); assert.match(b.result, /^native-ok pid=/);
  assert.equal(a.paseoHome, home); assert.equal(b.paseoHome, home);
  const concurrent = await Promise.all([call(0, 'a', true), call(1, 'b', true)]);
  assert.deepEqual(concurrent.map(row => row.result).sort(), ['acquired', 'busy']);
  const afterRelease = await call(0, 'b', true); assert.equal(afterRelease.result, 'acquired');
  const result = { helperSha256: createHash('sha256').update(payload).digest('hex'), helperPackaging: 'base64 TypeScript module -> private mkdtemp -> executable 0700 -> execFile',
    a, b, secondCaller, concurrent, afterRelease };
  await fs.writeFile(join(base, 'result.json'), JSON.stringify(result, null, 2));
  console.log('PASS native executable packaging, caller-context inspection, process isolation, shared flock contention/release. Evidence: ' + base);
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  try { await exec(cli, ['--home', home, 'daemon', 'stop'], { timeout: 10000 }); }
  catch { worker.kill('SIGTERM'); }
  await fs.writeFile(join(base, 'cleanup.json'), JSON.stringify({ daemonStopRequested: true, temporaryHome: home }));
}
