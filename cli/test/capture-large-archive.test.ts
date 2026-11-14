import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,createWriteStream,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createZstdCompress} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {atomicJson} from '../src/session.ts';
import {captureDir,captureTranscript,type CaptureConfig} from '../src/capture/runtime.ts';
import {hash} from '../src/capture/parse.ts';
import {archiveChunks} from '../src/capture/archive.ts';

test('a compressed history larger than 256 MiB streams to its final event and resumes without an expanded copy',async()=>{
 const previous=process.env.OPENCRAWL_CONFIG_HOME,dir=mkdtempSync(join(tmpdir(),'opencrawl-large-archive-'));
 process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');
 try {
  const config:CaptureConfig={schemaVersion:1,api:'https://fixture.invalid',installationId:'archive',owner:{tenantId:'test',userId:'test'},installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
  atomicJson(join(captureDir(),'config.json'),config);
  const path=join(config.roots.codex,'archived_sessions','large.jsonl.zst');mkdirSync(join(path,'..'),{recursive:true});
  const header=JSON.stringify({type:'session_meta',payload:{id:'large-archive',source:'cli'}})+'\n';
  const filler=JSON.stringify({type:'unrecognized_native_record',padding:'x'.repeat(256*1024)})+'\n';
  const tail=JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:'evidence beyond 256 MiB'}})+'\n';
  await pipeline((async function*(){yield header;for(let i=0;i<1025;i++)yield filler;yield tail;})(),createZstdCompress(),createWriteStream(path));
  const batches:any[]=[];
  const drain=async()=>{for(const name of readdirSync(join(captureDir(),'queue'))){if(!name.endsWith('.json'))continue;const file=join(captureDir(),'queue',name);batches.push(JSON.parse(readFileSync(file,'utf8')));rmSync(file);}};
  await captureTranscript(config,'codex',path,{},true,drain);
  const events=batches.flatMap(b=>b.events);
  expect(events.map(e=>e.kind)).toEqual(['session_metadata','message']);
  expect(events.at(-1).data.content).toBe('evidence beyond 256 MiB');
  expect(events.at(-1).sequence).toBe(Buffer.byteLength(header)+1025*Buffer.byteLength(filler));
  expect(readdirSync(join(captureDir(),'state')).some(name=>name.endsWith('.expanded.tmp'))).toBe(false);
  const stateFile=join(captureDir(),'state',hash('codex'+realpathSync(path))+'.json');
  expect(JSON.parse(readFileSync(stateFile,'utf8')).archiveSize).toBeGreaterThan(0);
  const before=batches.length;await captureTranscript(config,'codex',path,{},true,drain);expect(batches.length).toBe(before);
 }finally{if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;rmSync(dir,{recursive:true,force:true});}
},20000);

test('archive decoding retains incomplete tails, rejects corrupt frames and keeps the per-record limit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-archive-boundaries-'));
 try{
  const path=join(dir,'fixture.jsonl.zst');
  const consume=async(bytes:Buffer)=>{writeFileSync(path,bytes);let complete=false;const parts:Buffer[]=[];for await(const part of archiveChunks(path,bytes.length,value=>{complete=value;}))parts.push(part);return {complete,text:Buffer.concat(parts).toString()};};
  const text='{"content":"é"}\n{"unfinished":';
  expect(await consume(Buffer.from(Bun.zstdCompressSync(text)))).toEqual({complete:false,text:'{"content":"é"}\n'});
  const compressed=Buffer.from(Bun.zstdCompressSync('{"complete":true}\n'));
  await expect(consume(compressed.subarray(0,compressed.length-2))).rejects.toBeDefined();
  await pipeline((async function*(){yield '"';for(let i=0;i<49;i++)yield 'x'.repeat(1024*1024);yield '"\n';})(),createZstdCompress(),createWriteStream(path));
  const sourceBytes=readFileSync(path).length;
  await expect((async()=>{for await(const _ of archiveChunks(path,sourceBytes,()=>{})){};})()).rejects.toMatchObject({code:'CAPTURE_LINE_TOO_LARGE'});
 }finally{rmSync(dir,{recursive:true,force:true});}
},10000);
