// Stage the directory candidate in a fresh private profile. This does not start or install anything.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../',import.meta.url));
const app = process.env.M45_PASEO_APP ?? '/Applications/Paseo.app';
const cli = join(app,'Contents/Resources/bin/paseo');
assert.equal(execFileSync(cli,['--version'],{encoding:'utf8'}).trim(),'0.17.5');
const sdkVersions = [];
for (const name of ['client','plugin','protocol']) {
  const {version} = JSON.parse(await fs.readFile(join(repo,'node_modules/@getpaseo',name,'package.json'),'utf8'));
  assert.equal(version,'0.17.4');
  sdkVersions.push(version);
}
const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(),'pps-m43-local-rc-')));
const plugin = join(base,'candidate'), home = join(base,'daemon'), targetRoot = join(base,'targets'), desktop = join(base,'desktop');
for (const path of [plugin,home,targetRoot,desktop,join(home,'runtime'),join(home,'runtime/project-skills-m44')])
  await fs.mkdir(path,{mode:0o700});
for (const directory of ['client','server','shared'])
  await fs.cp(join(repo,directory),join(plugin,directory),{recursive:true});
for (const file of ['index.server.ts','index.client.tsx','paseo-plugin.json'])
  await fs.copyFile(join(repo,'release/local',file),join(plugin,file));
await fs.symlink(join(repo,'node_modules'),join(plugin,'node_modules'));
const adapter = join(plugin,'server/local-rc-profile.ts');
const types = (await fs.readFile(adapter,'utf8')).split('// Filled only')[0];
await fs.writeFile(adapter,types+'export const profile: LocalProfile = '+JSON.stringify({base,targetRoot,cli,sdkVersions})+';\n');
const server = createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const listen = '127.0.0.1:'+server.address().port;
await new Promise(resolve=>server.close(resolve));
await fs.writeFile(join(home,'config.json'),JSON.stringify({version:1,pluginsEnabled:true,
  daemon:{listen,relay:{enabled:false}},features:{voiceMode:{enabled:false}}}));
console.log(JSON.stringify({base,plugin,home,targetRoot,desktop,cli,listen},null,2));
