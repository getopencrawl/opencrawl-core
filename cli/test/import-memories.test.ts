import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {importMemories} from '../src/import-memories.ts';

const scope={api:'https://self-host.invalid',workspace:'local-org',user:'owner'};
const args={host:'source',harness:'codex'};
const chunks=['before\n','😀','\nafter'];
const offsets=[0,7,9,15];
const ids=chunks.map((_,i)=>'memories:'+String(i+1).repeat(64));
const hit=(i:number)=>({id:ids[i]!,source:'memories',passage:{index:i,count:3,start:offsets[i]!,end:offsets[i+1]!},
 provenance:{userId:'owner',installationId:'install',host:'source',harness:'codex',path:'memories/note.md',snapshotId:'one',modifiedAt:'2026-01-01T00:00:00Z',chunk:i,kind:'passage'}});
const reader={search:async(input:Record<string,unknown>)=>{
 expect(input.source).toBe('memories');expect(input.filters).toMatchObject({authors:['owner']});
 return {results:[hit(1)],partial:false,windowExhausted:false,next:null,coverage:[{source:'memories',state:'ready',truncated:false}]};
},fetch:async(input:Record<string,unknown>)=>{
 const i=ids.indexOf(String(input.id)),offset=Number(input.offset),text=chunks[i]!;
 const end=Math.min(text.length,offset+1);
 if(offset)expect(input.version).toBe('v1');
 return {...hit(i),text:text.slice(offset,end),version:'v1',offset,totalChars:text.length,nextOffset:end<text.length?end:null,previousId:ids[i-1],nextId:ids[i+1]};
}};

test('imports a personal file across paged passages and preserves local changes on retry',async()=>{
 const store=realpathSync(mkdtempSync(join(tmpdir(),'oc-memories-')));
 try {
  const run=()=>importMemories('import',scope,{...args,store},reader);
  const first=await run();expect(first).toMatchObject({complete:true,outcomes:{imported:1}});
  if(!('results' in first))throw Error('missing results');
  const local=first.results![0]!.local!;
  expect(readFileSync(local,'utf8')).toBe(chunks.join(''));
  expect(await run()).toMatchObject({complete:true,outcomes:{unchanged:1}});
  writeFileSync(local,'my edit');
  expect(await run()).toMatchObject({complete:false,outcomes:{conflict:1}});
  expect(readFileSync(local,'utf8')).toBe('my edit');
 }finally{rmSync(store,{recursive:true,force:true});}
});
test('rejects foreign discoveries and stops on a changed snapshot during fetch',async()=>{
 const other=hit(1);other.provenance.userId='colleague';
 await expect(importMemories('scan',scope,{}, {...reader,search:async input=>({...await reader.search(input),results:[other]})})).rejects.toThrow('caller');
 const result=await importMemories('verify',scope,args,{...reader,fetch:async input=>{
  const part=await reader.fetch(input);part.provenance.snapshotId='replacement';return part;
 }});
 expect(result).toMatchObject({complete:false,outcomes:{failed:1}});
});
test('replays a bounded time window and reports an unresolved timestamp tie',async()=>{
 let calls=0;
 const limited={...reader,search:async(input:Record<string,unknown>)=>{
  const page=await reader.search(input);calls++;
  if(calls===3)return {...page,results:[]};
  if(calls===2)expect(input.filters).toMatchObject({before:'2026-01-01T00:00:00.000Z'});
  return {...page,windowExhausted:true};
 }};
 const result=await importMemories('scan',scope,args,limited);
 expect(result.complete).toBe(false);expect(result.discovered).toBe(1);expect(calls).toBe(3);
});
