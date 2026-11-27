import * as fs from 'node:fs/promises';
import { runFixtureWriter } from '../server/native-writer.ts';
const request=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
await runFixtureWriter(request,{testing:true,onExtracted:async directory=>{
 const st=await fs.lstat(directory,{bigint:true});process.send?.({event:'extraction',directory,dev:String(st.dev),ino:String(st.ino),mode:Number(st.mode&0o7777n)});
},onEvent:async event=>{
 if(event.event==='barrier'){process.send?.({event:'held',helperPid:event.pid});await new Promise(()=>{});}
}});
