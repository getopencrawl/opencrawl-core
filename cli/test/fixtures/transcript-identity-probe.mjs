import {mock} from 'bun:test';
import * as fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const [harness,mode]=process.argv.slice(2);
if(!['claude-code','codex','antigravity','cursor'].includes(harness)||!['exact','legacy','legacy-safe','malformed'].includes(mode))throw Error('Invalid probe mode');
const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'opencrawl-exact-identity-'))),sessionId='identity-session';
const roots={'claude-code':join(root,'claude'),codex:join(root,'codex'),antigravity:join(root,'gemini'),cursor:join(root,'cursor')};
const file=harness==='cursor'?join(roots.cursor,'projects','project','agent-transcripts',sessionId,sessionId+'.jsonl'):harness==='antigravity'?join(roots.antigravity,'antigravity-cli','brain',sessionId,'.system_generated','logs','transcript_full.jsonl'):harness==='codex'?join(roots.codex,'sessions','rollout-'+sessionId+'.jsonl'):join(roots['claude-code'],'projects','project',sessionId+'.jsonl');
const native={stat:fs.statSync,fstat:fs.fstatSync,open:fs.openSync,close:fs.closeSync},descriptors=new Set(),alias=Number(9007199254740992n);
const project=stat=>typeof stat.ino==='number'?Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{ino:alias}):stat;
mock.module('node:fs',()=>({...fs,statSync:(path,...args)=>{const st=native.stat(path,...args);return String(path)===file?project(st):st;},openSync:(path,...args)=>{const fd=native.open(path,...args);if(String(path)===file)descriptors.add(fd);return fd;},fstatSync:(fd,...args)=>{const st=native.fstat(fd,...args);return descriptors.has(fd)?project(st):st;},closeSync:fd=>{descriptors.delete(fd);return native.close(fd);}}));
Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(root,'config'),OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_AUTH:'',OPENCRAWL_TOKEN:'',OPENCRAWL_SESSIONS_TOKEN:'',REPLICAS_WORKSPACE_ID:''});
let networkInvocations=0;globalThis.fetch=()=>{networkInvocations++;throw Error('Network forbidden');};
try{
 const {atomicJson}=await import('../../src/session.ts');
 const {captureDir,captureTranscript}=await import('../../src/capture/runtime.ts');
 const {establishForwardBoundaries}=await import('../../src/setup/watermarks.ts');
 const {establishCursorForwardBoundaries}=await import('../../src/setup/cursor-watermarks.ts');
 const {cursorTranscript}=await import('../../src/capture/cursor.ts');
 const config={schemaVersion:1,api:'https://identity-probe.invalid',installationId:'identity-probe',owner:{tenantId:'fixture',userId:'fixture'},installedAt:new Date().toISOString(),harnesses:[harness],historyHarnesses:[],roots,command:[]};
 atomicJson(join(captureDir(),'config.json'),config);fs.mkdirSync(dirname(file),{recursive:true});
 let sequence=0;const line=text=>JSON.stringify(harness==='cursor'?{role:'user',message:{content:[{type:'text',text}]}}:harness==='antigravity'?{step_index:sequence++,type:'USER_INPUT',source:'USER_EXPLICIT',status:'DONE',content:text}:harness==='codex'?{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}:{type:'user',uuid:String(sequence++),sessionId,message:{role:'user',content:text}})+'\n';
 const prefix=(harness==='codex'?JSON.stringify({type:'session_meta',payload:{id:sessionId,source:'cli'}})+'\n':'')+line('PRIVATE PREFIX');
 fs.writeFileSync(file,prefix);const before=native.stat(file,{bigint:true}).ino;
 const establish=async onlyUnverified=>harness==='cursor'?establishCursorForwardBoundaries(config,config,{onlyUnverified}):establishForwardBoundaries(config,[harness],{onlyUnverified});
 await establish(false);
 const digest=value=>createHash('sha256').update(value).digest('hex');
 const stateFile=join(captureDir(),'state',(harness==='cursor'?'cursor-'+digest(sessionId):digest(harness+file))+'.json');
 const state=()=>JSON.parse(fs.readFileSync(stateFile,'utf8'));
 if(state().ino!==alias)throw Error('Numeric collision not established');
 if(mode!=='exact'){const old=state();if(mode==='malformed')old.identity='not-exact';else delete old.identity;if(mode==='legacy-safe')old.ino=1;atomicJson(stateFile,old);}
 const retainedState=fs.readFileSync(stateFile,'utf8'),queue=join(captureDir(),'queue'),preserved=join(queue,'preserved.json');fs.mkdirSync(queue,{recursive:true});const queuedBefore=JSON.stringify({events:[{kind:'message',data:{content:'PREVIOUSLY APPROVED'}}]})+'\n';fs.writeFileSync(preserved,queuedBefore);
 fs.renameSync(file,file+'.retained');fs.writeFileSync(file,prefix+line('PRIVATE REPLACEMENT HISTORY'));
 if(native.stat(file,{bigint:true}).ino===before)throw Error('Replacement did not create a different native file');
 const cursorEvents=[];
 const capture=async()=>{if(harness!=='cursor')return captureTranscript(config,harness,file,{session_id:sessionId},false,undefined,undefined,{sessionScoped:true,sessionPath:file});const old=state();for(const row of cursorTranscript(roots.cursor,sessionId,file,old.offset,old.ino,old.checkpoint,{forwardBoundary:true,identity:old.identity,skipPartial:old.skipPartial})){if(row.data)cursorEvents.push(row.data);atomicJson(stateFile,{...old,offset:row.offset,ino:row.ino,identity:row.identity,checkpoint:row.checkpoint,skipPartial:row.skipPartial});}};
 let errorCode=null;try{await capture();}catch(error){errorCode=error.code;}
 const statePreservedOnRefusal=mode==='exact'||fs.readFileSync(stateFile,'utf8')===retainedState;
 if(mode!=='exact')await establish(true);
 const repairedIdentity=state().identity,repairedOffset=state().offset;
 fs.appendFileSync(file,line('APPROVED AFTER REPAIR'));await capture();
 const events=harness==='cursor'?cursorEvents:fs.readdirSync(queue).filter(n=>n.endsWith('.json')).flatMap(n=>JSON.parse(fs.readFileSync(join(queue,n),'utf8')).events);
 const text=JSON.stringify(events);
 process.stdout.write(JSON.stringify({harness,mode,physicalReplacement:true,errorCode,statePreservedOnRefusal,privateTailExcluded:!text.includes('PRIVATE'),futureAppendCaptured:text.includes('APPROVED AFTER REPAIR'),queuedBatchPreserved:fs.readFileSync(preserved,'utf8')===queuedBefore,identityExact:/^[0-9]+:[1-9][0-9]*$/.test(repairedIdentity),repairedOffset,historyUnchanged:config.historyHarnesses.length===0,networkInvocations,openDescriptors:descriptors.size})+'\n');
}finally{fs.rmSync(root,{recursive:true,force:true});}
