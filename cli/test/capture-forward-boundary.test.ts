import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,readdirSync,renameSync,rmSync,statSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {atomicJson} from '../src/session.ts';
import {captureDir,captureTranscript,type CaptureConfig} from '../src/capture/runtime.ts';
import {establishForwardBoundaries} from '../src/setup/watermarks.ts';
import {hash,type TranscriptHarness} from '../src/capture/parse.ts';

type Checkpoint={offset:number;ino:number;identity?:string;parserVersion?:number;forwardBoundary?:boolean;skipPartial?:boolean;checkpoint?:string};
async function fixture(harness:TranscriptHarness,run:(f:{config:CaptureConfig;path:string;line:(text:string)=>string;header:string;capture:(history?:boolean)=>Promise<unknown>;state:()=>Checkpoint;events:()=>unknown[]})=>Promise<void>){
 const saved={...process.env},dir=mkdtempSync(join(tmpdir(),'opencrawl-forward-boundary-'));
 Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_AUTH:'',REPLICAS_WORKSPACE_ID:'',OPENCRAWL_TOKEN:'',OPENCRAWL_SESSIONS_TOKEN:''});
 try{
  const sessionId='boundary-session',config:CaptureConfig={schemaVersion:1,api:'https://boundary.invalid',installationId:'boundary-install',owner:{tenantId:'test',userId:'owner'},installedAt:new Date().toISOString(),harnesses:[harness],historyHarnesses:[],roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude'),antigravity:join(dir,'gemini')},claudeDesktopSessionsRoot:join(dir,'desktop'),command:[]};
  atomicJson(join(captureDir(),'config.json'),config);
  const path=harness==='antigravity'?join(config.roots.antigravity!,'antigravity-cli','brain',sessionId,'.system_generated','logs','transcript_full.jsonl'):harness==='codex'?join(config.roots.codex,'sessions','rollout-'+sessionId+'.jsonl'):join(config.roots['claude-code'],'projects','project',sessionId+'.jsonl');
  mkdirSync(dirname(path),{recursive:true});
  let sequence=0;
  const line=(text:string)=>JSON.stringify(harness==='antigravity'?{step_index:sequence++,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:text}:harness==='codex'?{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}:{type:'user',uuid:String(sequence++),sessionId,message:{role:'user',content:text}})+'\n';
  const header=harness==='codex'?JSON.stringify({type:'session_meta',payload:{id:sessionId,source:'cli'}})+'\n':'';
  const state=()=>JSON.parse(readFileSync(join(captureDir(),'state',hash(harness+realpathSync(path))+'.json'),'utf8')) as Checkpoint;
  const events=()=>readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json')).flatMap(n=>(JSON.parse(readFileSync(join(captureDir(),'queue',n),'utf8')) as {events:unknown[]}).events);
  const capture=(history=false)=>captureTranscript(config,harness,path,{session_id:sessionId},history,undefined,undefined,{sessionScoped:true,sessionPath:path});
  await run({config,path,line,header,capture,state,events});
 }finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}

for(const harness of ['antigravity','claude-code','codex'] as const)for(const reset of ['replace','truncate'] as const)for(const afterAppend of [false,true])
test(`${harness} forward consent survives ${reset} ${afterAppend?'after':'before'} a live checkpoint`,()=>fixture(harness,async f=>{
 writeFileSync(f.path,f.header+f.line('PRIVATE ORIGINAL '+'.'.repeat(2000)));
 establishForwardBoundaries(f.config,[harness]);
 if(afterAppend){appendFileSync(f.path,f.line('APPROVED BEFORE RESET'));await f.capture();}
 const originalInode=statSync(f.path,{bigint:true}).ino;
 if(reset==='replace')renameSync(f.path,f.path+'.retained');
 writeFileSync(f.path,f.header+f.line('PRIVATE RESET'));
 expect(statSync(f.path,{bigint:true}).ino===originalInode).toBe(reset==='truncate');
 await f.capture();
 // The parser must not turn ambiguous rewritten contents into a history import.
 expect(JSON.stringify(f.events())).not.toContain('PRIVATE');
 expect(f.state()).toMatchObject({forwardBoundary:true,offset:statSync(f.path).size,ino:statSync(f.path).ino,skipPartial:false});
 appendFileSync(f.path,f.line('APPROVED AFTER RESET'));await f.capture();
 expect(JSON.stringify(f.events())).toContain('APPROVED AFTER RESET');
 expect(JSON.stringify(f.events())).not.toContain('PRIVATE');
 expect(f.state().forwardBoundary).toBe(true);
 expect(f.config.historyHarnesses).toEqual([]);
}));

test('Antigravity rebased partial prefix is skipped but later complete records remain capturable',()=>fixture('antigravity',async f=>{
 writeFileSync(f.path,f.line('PRIVATE ORIGINAL '+'.'.repeat(2000)));establishForwardBoundaries(f.config,['antigravity']);
 const partial=f.line('PRIVATE PARTIAL');writeFileSync(f.path,partial.slice(0,-10));await f.capture();
 expect(f.state()).toMatchObject({forwardBoundary:true,skipPartial:true,offset:Buffer.byteLength(partial)-10});
 appendFileSync(f.path,partial.slice(-10)+f.line('APPROVED AFTER PARTIAL'));await f.capture();
 expect(JSON.stringify(f.events())).not.toContain('PRIVATE');expect(JSON.stringify(f.events())).toContain('APPROVED AFTER PARTIAL');
 expect(f.state()).toMatchObject({forwardBoundary:true,skipPartial:false});
}));

test('explicit Antigravity history still imports a replaced approved source',()=>fixture('antigravity',async f=>{
 writeFileSync(f.path,f.line('OLD PREFIX'));establishForwardBoundaries(f.config,['antigravity']);
 renameSync(f.path,f.path+'.retained');writeFileSync(f.path,f.line('EXPLICITLY APPROVED HISTORY'));
 await f.capture(true);expect(JSON.stringify(f.events())).toContain('EXPLICITLY APPROVED HISTORY');
 expect(f.state().forwardBoundary).toBeUndefined();
}));

test('new Antigravity sessions without a forward boundary keep ordinary capture',()=>fixture('antigravity',async f=>{
 writeFileSync(f.path,f.line('NEW SESSION'));await f.capture();
 expect(JSON.stringify(f.events())).toContain('NEW SESSION');expect(f.state().forwardBoundary).toBeUndefined();
 renameSync(f.path,f.path+'.retained');writeFileSync(f.path,f.line('ORDINARY REPLACEMENT'));await f.capture();
 expect(JSON.stringify(f.events())).toContain('ORDINARY REPLACEMENT');
}));

for(const afterAppend of [false,true])test(`Antigravity same-inode rewrite and regrowth preserves consent ${afterAppend?'after':'before'} a live checkpoint`,()=>fixture('antigravity',async f=>{
 const prefix=f.line('PRIVATE ORIGINAL');writeFileSync(f.path,prefix);establishForwardBoundaries(f.config,['antigravity']);
 if(afterAppend){appendFileSync(f.path,f.line('APPROVED ORIGINAL'));await f.capture();}
 const originalInode=statSync(f.path).ino,previous=readFileSync(f.path,'utf8');
 // Native compaction can rewrite the same inode and regrow beyond the old
 // offset before the worker observes it. Keep valid record alignment there.
 writeFileSync(f.path,previous.replaceAll('ORIGINAL','REPLACED')+f.line('PRIVATE REGROWN TAIL'));
 expect(statSync(f.path).ino).toBe(originalInode);expect(statSync(f.path).size).toBeGreaterThan(previous.length);
 const before=afterAppend?JSON.stringify(f.events()):'[]';await f.capture();
 expect(JSON.stringify(f.events())).toBe(before);
 expect(f.state()).toMatchObject({offset:statSync(f.path).size,forwardBoundary:true});
 appendFileSync(f.path,f.line('APPROVED AFTER REGROWTH'));await f.capture();
 expect(JSON.stringify(f.events())).toContain('APPROVED AFTER REGROWTH');expect(JSON.stringify(f.events())).not.toContain('PRIVATE');
}));

for(const harness of ['antigravity','claude-code','codex'] as const)test(`${harness} unchanged forward prefix accepts only appended records`,()=>fixture(harness,async f=>{
 writeFileSync(f.path,f.header+f.line('PRIVATE ORIGINAL'));establishForwardBoundaries(f.config,[harness]);
 const before=f.state();expect(before.checkpoint).toMatch(/^[a-f0-9]{64}$/);
 await f.capture();expect(f.events()).toEqual([]);expect(f.state()).toEqual(before);
 appendFileSync(f.path,f.line('APPROVED APPEND'));await f.capture();
 expect(JSON.stringify(f.events())).toContain('APPROVED APPEND');expect(JSON.stringify(f.events())).not.toContain('PRIVATE');
 expect(f.state()).toMatchObject({forwardBoundary:true,offset:statSync(f.path).size});expect(f.state().checkpoint).not.toBe(before.checkpoint);
}));

test('legacy forward boundary without a fingerprint rebases unknown contents instead of guessing consent',()=>fixture('antigravity',async f=>{
 writeFileSync(f.path,f.line('PRIVATE ORIGINAL'));establishForwardBoundaries(f.config,['antigravity']);
 const {checkpoint:_,...legacy}=f.state();atomicJson(join(captureDir(),'state',hash('antigravity'+realpathSync(f.path))+'.json'),legacy);
 appendFileSync(f.path,f.line('PRIVATE UNKNOWN LEGACY TAIL'));await f.capture();expect(f.events()).toEqual([]);
 expect(f.state()).toMatchObject({forwardBoundary:true,offset:statSync(f.path).size});expect(f.state().checkpoint).toMatch(/^[a-f0-9]{64}$/);
 appendFileSync(f.path,f.line('APPROVED AFTER LEGACY REBASE'));await f.capture();
 expect(JSON.stringify(f.events())).toContain('APPROVED AFTER LEGACY REBASE');expect(JSON.stringify(f.events())).not.toContain('PRIVATE');
}));

// Mock native fs only inside a short-lived child. The parent suite and real
// operator files never share this deterministic source-replacement seam.
for(const replacement of ['inode','contents'] as const)test(`forward boundary rejects ${replacement} replacement between validation and parser open`,()=>fixture('antigravity',async f=>{
 const prefix=f.line('PRIVATE ORIGINAL'),tail=f.line('APPROVED TAIL');writeFileSync(f.path,prefix);establishForwardBoundaries(f.config,['antigravity']);appendFileSync(f.path,tail);
 const originalState=f.state(),changed=(prefix+tail).replace('ORIGINAL','REPLACED').replace('APPROVED','PRIVATE!'),target=realpathSync(f.path);
 const code=`import {mock} from 'bun:test';import * as fs from 'node:fs';
 const open=fs.openSync,close=fs.closeSync,rename=fs.renameSync,write=fs.writeFileSync;const active=new Set();let targetOpens=0;
 mock.module('node:fs',()=>({...fs,openSync:(path,...args)=>{if(String(path)===${JSON.stringify(target)}&&++targetOpens===2){${replacement==='inode'?`rename(path,path+'.raced');`:''}write(path,${JSON.stringify(changed)});}const fd=open(path,...args);if(String(path)===${JSON.stringify(target)})active.add(fd);return fd;},closeSync:fd=>{active.delete(fd);return close(fd);}}));
 globalThis.fetch=()=>{throw Error('No network');};
 const {captureTranscript,readCaptureConfig}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dir,'../src/capture/runtime.ts')).href)});
 let errorCode=null;try{await captureTranscript(readCaptureConfig(),'antigravity',${JSON.stringify(target)},{session_id:'boundary-session'});}catch(error){errorCode=error.code??error.name;}
 process.stdout.write(JSON.stringify({errorCode,targetOpens,stillOpen:active.size}));`;
 const child=Bun.spawn([process.execPath,'-e',code],{env:process.env,stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(exit).toBe(0);expect(stderr).toBe('');expect(JSON.parse(stdout)).toEqual({errorCode:'CAPTURE_SOURCE_CHANGED',targetOpens:2,stillOpen:0});
 expect(f.state()).toEqual(originalState);expect(f.events()).toEqual([]);
 await f.capture();expect(f.events()).toEqual([]);expect(f.state().offset).toBe(statSync(f.path).size);
 appendFileSync(f.path,f.line('APPROVED AFTER RACE'));await f.capture();expect(JSON.stringify(f.events())).toContain('APPROVED AFTER RACE');expect(JSON.stringify(f.events())).not.toContain('PRIVATE');
}));

test('enrollment snapshots the opened transcript instead of stale path metadata',()=>fixture('antigravity',async f=>{
 writeFileSync(f.path,f.line('OLD'));const target=realpathSync(f.path),replacement=f.line('NEW PRECONSENT PREFIX '+'.'.repeat(100));
 const code=`import {mock} from 'bun:test';import * as fs from 'node:fs';const open=fs.openSync,close=fs.closeSync,rename=fs.renameSync,write=fs.writeFileSync;const active=new Set();let changed=false;
 mock.module('node:fs',()=>({...fs,openSync:(path,...args)=>{if(String(path)===${JSON.stringify(target)}&&!changed){changed=true;rename(path,path+'.raced');write(path,${JSON.stringify(replacement)});}const fd=open(path,...args);if(String(path)===${JSON.stringify(target)})active.add(fd);return fd;},closeSync:fd=>{active.delete(fd);return close(fd);}}));
 globalThis.fetch=()=>{throw Error('No network');};
 const {establishForwardBoundaries}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dir,'../src/setup/watermarks.ts')).href)});const {readCaptureConfig}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dir,'../src/capture/runtime.ts')).href)});
 establishForwardBoundaries(readCaptureConfig(),['antigravity']);process.stdout.write(JSON.stringify({changed,stillOpen:active.size}));`;
 const child=Bun.spawn([process.execPath,'-e',code],{env:process.env,stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(exit).toBe(0);expect(stderr).toBe('');expect(JSON.parse(stdout)).toEqual({changed:true,stillOpen:0});
 expect(f.state()).toMatchObject({offset:statSync(f.path).size,ino:statSync(f.path).ino,forwardBoundary:true});
 const checkpoint=f.state().checkpoint;await f.capture();expect(f.events()).toEqual([]);expect(f.state().checkpoint).toBe(checkpoint);
 appendFileSync(f.path,f.line('APPROVED AFTER ENROLLMENT'));await f.capture();expect(JSON.stringify(f.events())).toContain('APPROVED AFTER ENROLLMENT');expect(JSON.stringify(f.events())).not.toContain('NEW PRECONSENT');
}));


test('explicit history still resets a replaced source after an empty forward boundary reached parser version two',()=>fixture('antigravity',async f=>{
 writeFileSync(f.path,'');establishForwardBoundaries(f.config,['antigravity']);
 appendFileSync(f.path,f.line('APPROVED LIVE'));await f.capture();expect(f.state().parserVersion).toBe(2);
 renameSync(f.path,f.path+'.retained');writeFileSync(f.path,f.line('EXPLICITLY APPROVED REPLACEMENT HISTORY '+'.'.repeat(200)));
 await f.capture(true);expect(JSON.stringify(f.events())).toContain('EXPLICITLY APPROVED REPLACEMENT HISTORY');expect(f.state().forwardBoundary).toBeUndefined();
}));
