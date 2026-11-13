import {test,expect} from 'bun:test';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,utimesSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installCapture} from '../src/capture/install.ts';
import {captureDir,readCaptureConfig,flushCaptures,captureHook,captureWorker} from '../src/capture/runtime.ts';
import {hash} from '../src/capture/parse.ts';

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('condition timed out');await sleep(10);}}
async function fixture(run:(f:any)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-fairness-')),saved={...process.env};
 const owner={tenantId:'fixture',userId:'fixture'},payloads:string[]=[];
 let active=0,maxActive=0;
 let handle:((raw:string,res:ServerResponse)=>Promise<void>)|undefined;
 const server=createServer(async(req,res)=>{
  if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:owner}}));return;}
  const parts=[];for await(const c of req)parts.push(c);const raw=Buffer.concat(parts).toString();
  if(req.url!=='/api/sessions/batches'){res.writeHead(404);res.end();return;}
  payloads.push(raw);active++;maxActive=Math.max(maxActive,active);
  try{if(handle)await handle(raw,res);if(!res.writableEnded)res.end(JSON.stringify({data:{stored:true,batchId:hash(raw)}}));}
  finally{active--;}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=api;
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_SESSIONS_TOKEN:'synthetic',CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex')});
  await installCapture(api,{background:false,home:dir,command:[]});
  const config=readCaptureConfig()!;
  const enqueue=(n:number,sessionId='session')=>{
   const path=join(captureDir(),'queue',String(n).padStart(4,'0')+'.json');
   writeFileSync(path,JSON.stringify({schemaVersion:1,owner,installationId:config.installationId,sessionId,harness:'codex',origin:'cli',events:[{id:'event-'+n,kind:'hook',data:{n}}],attachments:[]}));
   utimesSync(path,1700000000+n,1700000000+n);return path;
  };
  await run({config,enqueue,payloads,get active(){return active;},get maxActive(){return maxActive;},set handle(fn:typeof handle){handle=fn;}});
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}

test('background passes bound concurrency and work while serving fresh captures and draining old ones',async()=>fixture(async f=>{
 for(let n=0;n<80;n++)f.enqueue(n);
 const error=join(captureDir(),'last-error.json');writeFileSync(error,'{"code":"earlier-error"}');
 const blob=join(captureDir(),'blobs','unreferenced');writeFileSync(blob,'old blob');utimesSync(blob,1,1);
 const held:Array<()=>void>=[];
 f.handle=async()=>{if(f.payloads.length<=4)await new Promise<void>(r=>held.push(r));else await sleep(5);};
 const first=flushCaptures({wait:false});
 await until(()=>held.length===4);expect(f.active).toBe(4);
 held.forEach(r=>r());expect(await first).toEqual({uploaded:32});
 expect(f.maxActive).toBe(4);expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(48);
 expect(existsSync(error)).toBe(true);expect(existsSync(blob)).toBe(true);
 f.enqueue(1000,'fresh');f.handle=async()=>{await sleep(5);};
 const before=f.payloads.length;
 expect(await flushCaptures({wait:false})).toEqual({uploaded:32});
 expect(f.payloads.slice(before,before+4).map((p:string)=>JSON.parse(p).sessionId)).toContain('fresh');
 // Foreground flush remains a complete drain, rather than silently stopping at a budget.
 expect(await flushCaptures()).toEqual({uploaded:17});
 expect(new Set(f.payloads).size).toBe(81);expect(f.payloads).toHaveLength(81);
 expect(existsSync(error)).toBe(false);expect(existsSync(blob)).toBe(false);
}));

test('excluded captures do not consume the background upload budget or get deleted',async()=>fixture(async f=>{
 writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...f.config,exclusions:{projects:[],sessions:['excluded']}}));
 for(let n=0;n<100;n++)f.enqueue(n,n<80?'excluded':'included');
 expect(await flushCaptures({wait:false})).toEqual({uploaded:20,excluded:80});
 expect(f.payloads.every((p:string)=>JSON.parse(p).sessionId==='included')).toBe(true);
 expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(80);
}));

test('a hook arriving during a large flush reaches the receiver before the old backlog drains',async()=>fixture(async f=>{
 for(let n=0;n<80;n++)f.enqueue(n);
 const held:Array<()=>void>=[];
 f.handle=async()=>{if(f.payloads.length<=4)await new Promise<void>(r=>held.push(r));else await sleep(5);};
 const working=captureWorker({flushMs:0,idleMs:20,pollMs:5});await until(()=>held.length===4);
 const path=join(f.config.roots['claude-code'],'projects','fresh','session.jsonl');mkdirSync(join(path,'..'),{recursive:true});
 writeFileSync(path,JSON.stringify({type:'user',uuid:'fresh-event',sessionId:'fresh',message:{role:'user',content:'new work during backlog'}})+'\n');
 await captureHook('claude-code',{session_id:'fresh',transcript_path:path,hook_event_name:'Stop'});
 held.forEach(r=>r());await working;
 const position=f.payloads.findIndex((p:string)=>JSON.parse(p).events.some((e:any)=>e.nativeId==='fresh-event'));
 expect(position).toBeGreaterThanOrEqual(32);expect(position).toBeLessThan(40);
 expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(0);
 expect(new Set(f.payloads).size).toBe(f.payloads.length);
}));

test('a failed parallel upload retains exact bytes and holds ownership until all in-flight requests settle',async()=>fixture(async f=>{
 for(let n=0;n<12;n++)f.enqueue(n);
 const held:Array<()=>void>=[];
 f.handle=async(raw:string,res:ServerResponse)=>{await new Promise<void>(r=>held.push(r));if(raw===f.payloads[0])res.end(JSON.stringify({data:{stored:false,batchId:hash(raw)}}));};
 let settled=false;const first=flushCaptures({wait:false}).then(()=>{settled=true;return null;},e=>{settled=true;return e;});
 await until(()=>held.length===4);held[0]();await sleep(30);
 expect(settled).toBe(false);expect(await flushCaptures({wait:false})).toEqual({uploaded:0});
 held.slice(1).forEach(r=>r());expect(await first).toMatchObject({code:'CAPTURE_RECEIPT_INVALID'});
 expect(f.payloads).toHaveLength(4);expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(9);
 const failed=f.payloads[0];expect(readFileSync(join(captureDir(),'queue','0000.json'),'utf8')).toBe(failed);
 f.handle=undefined;expect(await flushCaptures({wait:false})).toEqual({uploaded:9});
 expect(f.payloads.filter((p:string)=>p===failed)).toHaveLength(2);
 expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(0);
}));

test('disabling capture lets only already in-flight uploads finish and retains the remaining queue',async()=>fixture(async f=>{
 for(let n=0;n<12;n++)f.enqueue(n);
 const held:Array<()=>void>=[];f.handle=async()=>{await new Promise<void>(r=>held.push(r));};
 const first=flushCaptures({wait:false});await until(()=>held.length===4);
 writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...f.config,disabled:true}));
 held.forEach(r=>r());expect(await first).toEqual({uploaded:4});
 expect(f.payloads).toHaveLength(4);expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(8);
}));
