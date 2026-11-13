import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enqueueLiveBatch,sealLiveBatches,recoverLiveSeals,isPendingLive} from '../src/capture/live-batches.ts';
import {hash,finalizeEventIdentity} from '../src/capture/parse.ts';

function fixture(run:(directory:string)=>void){
 const directory=mkdtempSync(join(tmpdir(),'capture-live-seals-'));
 for(const name of ['queue','live','seals'])mkdirSync(join(directory,name));
 try{run(directory);}finally{rmSync(directory,{recursive:true,force:true});}
}
function batch(id:string,sessionId='session'){
 return {schemaVersion:1,owner:{tenantId:'team',userId:'owner'},installationId:'device',harness:'codex',sessionId,origin:'cli',captureMode:'live',
  events:[finalizeEventIdentity({id,kind:'message',data:{text:'retained '+id}})],attachments:[]};
}
function queue(directory:string,value:any,live=true){const serialized=JSON.stringify(value),name=hash(serialized)+'.json';enqueueLiveBatch(directory,name,serialized,live);return {name,serialized};}
function queued(directory:string){return readdirSync(join(directory,'queue')).map(name=>({name,raw:readFileSync(join(directory,'queue',name),'utf8')}));}

test('only never-attempted live batches merge, preserving all event IDs and scope',()=>fixture(directory=>{
 const first=batch('a'),second=batch('b');queue(directory,first);queue(directory,second);
 queue(directory,batch('another-scope','other'));
 const retry=queue(directory,batch('retry'),false),history=queue(directory,{...batch('history'),captureMode:'history'},false);
 sealLiveBatches(directory);
 const output=queued(directory),merged=output.map(v=>JSON.parse(v.raw)).find(b=>b.events.length===2)!;
 expect(output).toHaveLength(4);expect(merged.events.map((e:any)=>e.id).sort()).toEqual([...first.events,...second.events].map(e=>e.id).sort());
 expect(merged.sessionId).toBe('session');
 expect(readFileSync(join(directory,'queue',retry.name),'utf8')).toBe(retry.serialized+'\n');
 expect(readFileSync(join(directory,'queue',history.name),'utf8')).toBe(history.serialized+'\n');
 for(const item of output)expect(isPendingLive(directory,item.name)).toBe(false);
 const original=new Map(output.map(item=>[item.name,item.raw]));
 queue(directory,batch('new'));sealLiveBatches(directory);
 for(const [name,bytes] of original)expect(readFileSync(join(directory,'queue',name),'utf8')).toBe(bytes);
 expect(queued(directory)).toHaveLength(5);
}));

test('a partially completed seal recovers exact output after losing source fragments',()=>fixture(directory=>{
 const values=[batch('a'),batch('b'),batch('c')],sources=values.map(value=>queue(directory,value).name);
 const merged={...values[0],events:values.flatMap(value=>value.events)},serialized=JSON.stringify(merged),name=hash(serialized)+'.json';
 const plan={schemaVersion:1,sources,name,serialized};
 writeFileSync(join(directory,'seals',name),JSON.stringify(plan));
 // Power loss after output publication and only one source retirement.
 writeFileSync(join(directory,'queue',name),serialized+'\n');
 unlinkSync(join(directory,'queue',sources[0]!));unlinkSync(join(directory,'live',sources[0]!));
 recoverLiveSeals(directory);
 expect(queued(directory)).toEqual([{name,raw:serialized+'\n'}]);
 expect(readdirSync(join(directory,'live'))).toEqual([]);expect(readdirSync(join(directory,'seals'))).toEqual([]);
 // A later recovery cannot reconstruct an acknowledged/deleted upload.
 unlinkSync(join(directory,'queue',name));recoverLiveSeals(directory);expect(queued(directory)).toEqual([]);
}));

test('live sealing respects the event bound without dropping a burst',()=>fixture(directory=>{
 for(let i=0;i<205;i++)queue(directory,batch(String(i)));
 sealLiveBatches(directory);
 const output=queued(directory).map(item=>JSON.parse(item.raw));
 expect(output).toHaveLength(2);expect(output.every(b=>b.events.length<=200)).toBe(true);
 expect(new Set(output.flatMap(b=>b.events).map((e:any)=>e.id)).size).toBe(205);
}));
