import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicJson} from '../src/session.ts';
import {captureDir,captureTranscript,type CaptureConfig} from '../src/capture/runtime.ts';

test('bounded history reads grow for a large UTF-8 record and resume an incomplete tail at its exact byte offset',async()=>{
 const saved={...process.env},dir=mkdtempSync(join(tmpdir(),'opencrawl-bounded-read-'));
 process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');
 try{
  const config:CaptureConfig={schemaVersion:1,api:'https://benchmark.invalid',installationId:'bounded-read',owner:{tenantId:'test',userId:'owner'},installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
  atomicJson(join(captureDir(),'config.json'),config);
  const path=join(config.roots.codex,'sessions','large.jsonl');mkdirSync(join(path,'..'),{recursive:true});
  const header=JSON.stringify({type:'session_meta',payload:{id:'large',source:'cli'}})+'\n';
  // This complete native record spans the ordinary read size, including multibyte text.
  const text='é'.repeat(5*1024*1024)+' final evidence';
  const large=JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:text}})+'\n';
  const tail=JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:'resumed tail'}})+'\n';
  writeFileSync(path,header+large+tail.slice(0,30));
  await captureTranscript(config,'codex',path,{},true);
  const queued=()=>readdirSync(join(captureDir(),'queue')).filter(name=>name.endsWith('.json')).sort();
  const events=()=>queued().flatMap(name=>JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8')).events).sort((a,b)=>a.sequence-b.sequence);
  expect(events().map(e=>e.sequence)).toEqual([0,Buffer.byteLength(header)]);
  expect(events()[1].data.content).toBe(text);
  const before=queued();await captureTranscript(config,'codex',path,{},true);expect(queued()).toEqual(before);
  appendFileSync(path,tail.slice(30));await captureTranscript(config,'codex',path,{},true);
  expect(events().map(e=>e.sequence)).toEqual([0,Buffer.byteLength(header),Buffer.byteLength(header+large)]);
  expect(events().at(-1).data.content).toBe('resumed tail');
  const complete=queued();await captureTranscript(config,'codex',path,{},true);expect(queued()).toEqual(complete);
 }finally{
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
 }
},20000);
