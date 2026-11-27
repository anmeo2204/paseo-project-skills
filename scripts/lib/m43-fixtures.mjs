import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createCanonicalPreviewHandler } from '../../server/canonical-preview.ts';
import { PreviewReceiptStore } from '../../server/preview-receipts.ts';
import { fixtureWriterRequest } from '../../server/native-writer-contract.ts';
import { catalogSource } from '../../shared/catalog-settings.ts';

export const versionEnvironment = { paseoVersion: '0.17.5', sdkVersion: '0.17.4' };
export const descriptor = (path, value, mode = '100644') => { const bytes = Buffer.from(value); return { path, bytes, mode, sizeBytes: bytes.length,
 blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }; };
export const skill = (extras = []) => ({ id: 'demo', directory: 'skills/demo', metadata: { name: 'demo', description: 'Fixture' },
 entrypoint: descriptor('SKILL.md', '---\nname: demo\ndescription: Fixture\n---\nBody\n'), supportingFiles: extras });
export async function createFixture({ extras = [], parents = false } = {}) {
 const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'pps-m43-'))), root = join(base, 'target');
 await fs.mkdir(root, { mode: 0o700 }); const coordinator = join(base, 'coordinator'); await fs.mkdir(coordinator, { mode: 0o700 });
 if (parents) await fs.mkdir(join(root, '.agents/skills/demo'), { recursive: true, mode: 0o755 });
 const put = async (path, bytes, mode = 0o644) => { await fs.mkdir(dirname(join(root,path)), { recursive:true, mode:0o755 }); await fs.writeFile(join(root,path),bytes);await fs.chmod(join(root,path),mode); };
 const data = skill(extras), sha = 'a'.repeat(40), store = new PreviewReceiptStore();
 const handler = createCanonicalPreviewHandler({read:async()=>({status:'ready',revision:'rev',values:{catalogRef:sha}})},
  {load:async()=>({schemaVersion:1,source:catalogSource,commitSha:sha,skills:[data]})},{receiptStore:store});
 const preview = async ({ providers = [], controls, lock = false } = {}) => {
  const r = await handler.handleProvidersV2({viewNonce:'fixture',intent:{schemaVersion:1,hostId:'fixture',canonicalDirectory:root,catalogSource,catalogCommitSha:sha,
   settingsRevision:'rev',selectedSkillIds:['demo'],targetProviderIds:providers,recommendationRequestId:'fixture'}},{paseo:{hosts:{list:async()=>({self:{serverId:'fixture'}})}}});
  assert.equal(r.status,'ready',JSON.stringify(r)); const retained = store.inspect({...r.receipt,hostId:'fixture',installationInstanceId:r.manifest.installationInstanceId}); assert.equal(retained.status,'ready');
  return fixtureWriterRequest({fixtureBase:base,manifest:r.manifest,planDigest:r.receipt.planDigest,sources:retained.sources,environment:versionEnvironment,
   ...(controls?{controls}:{}),...(lock?{coordinator}: {})});
 };
 return {base,root,coordinator,put,preview,data,cleanup:async()=>{await handler.dispose();await fs.rm(base,{recursive:true,force:true});}};
}
export async function fingerprint(path) { const s=await fs.lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode&0o7777n),size:String(s.size),sha256:s.isFile()?createHash('sha256').update(await fs.readFile(path)).digest('hex'):null,...(s.isSymbolicLink()?{link:await fs.readlink(path)}:{})}; }
export async function tree(path,relative='.') { const stat=await fs.lstat(path),rows=[{path:relative,type:stat.isDirectory()?'directory':stat.isFile()?'file':'symlink',mode:stat.mode&0o7777,
 ...(stat.isFile()?{sha256:createHash('sha256').update(await fs.readFile(path)).digest('hex')}:stat.isSymbolicLink()?{link:await fs.readlink(path)}:{})}];
 if(stat.isDirectory())for(const name of(await fs.readdir(path)).sort())rows.push(...await tree(join(path,name),relative+'/'+name));return rows; }
