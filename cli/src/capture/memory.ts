import {readdir,readFile,lstat,realpath,open} from 'node:fs/promises';
import {readFileSync,existsSync,constants} from 'node:fs';
import {join,relative,resolve,sep,isAbsolute} from 'node:path';
import {homedir,hostname} from 'node:os';
import {createHash} from 'node:crypto';
import {atomicJson,withSessionLock} from '../session.ts';
import {captureDir,readCaptureConfig,refreshCaptureIdentity,request,type CaptureConfig} from './runtime.ts';
import type {Harness} from './parse.ts';

export const MEMORY_INTERVAL_MS=6*60*60*1000;
const RETRY_MS=15*60*1000,MAX_BYTES=32*1024*1024;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
type MemoryFile={path:string,project:string,modifiedAt:string,text:string};
type Root={path:string,label:string,project:string};
type MemoryState={successAt?:number,retryAt?:number,generation?:number,contentHash?:string,roots?:string[],missing?:string[],error?:string};
const statePath=(config:CaptureConfig,harness:Harness)=>join(captureDir(),'memories',hash(JSON.stringify([config.api,config.installationId,config.owner.tenantId,config.owner.userId,harness]))+'.json');
function state(config:CaptureConfig,harness:Harness):MemoryState {try{return JSON.parse(readFileSync(statePath(config,harness),'utf8'));}catch(e:any){if(e.code==='ENOENT')return {};throw e;}}
export const memoryDue=(s:MemoryState,now=Date.now())=>!(s.successAt&&now-s.successAt<MEMORY_INTERVAL_MS)&&!(s.retryAt&&now<s.retryAt);
const check=(signal?:AbortSignal)=>signal?.throwIfAborted();
// Consolidated memories can contain facts from many projects/sessions. Until
// they have reliable provenance for every entry, exclusions must fail closed.
const excluded=(config:CaptureConfig)=>Boolean(config.exclusions?.projects?.length||config.exclusions?.sessions?.length);
const maybeStat=async(path:string)=>{try{return await lstat(path);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}};

/** Only native memory directories; never follow symlinks, links in Markdown,
 * repository-supplied custom paths, SQLite/Git state, or instruction files. */
export async function discoverMemories(config:CaptureConfig,harness:Harness,previous:MemoryState={},signal?:AbortSignal) {
  const base=await realpath(config.roots[harness]);
  const roots:Root[]=[],files:MemoryFile[]=[],seen=new Set<string>(),versions:{path:string,ino:number,size:number,mtimeMs:number}[]=[];
  const add=async(path:string,label:string,project='')=>{
    check(signal);const st=await maybeStat(path);
    if(!st)return;
    if(st.isSymbolicLink()||!st.isDirectory())throw new Error('MEMORY_ROOT_UNSAFE');
    const actual=await realpath(path);if(seen.has(actual))return;
    seen.add(actual);roots.push({path:actual,label,project});
  };
  if(harness==='codex') {
    for(const version of ['memories','memories_v2'])await add(join(base,version),version);
  }else {
    const projects=join(base,'projects');
    const ps=await maybeStat(projects);
    if(ps?.isSymbolicLink())throw new Error('MEMORY_ROOT_UNSAFE');
    if(ps)for(const entry of await readdir(projects,{withFileTypes:true}))if(entry.isDirectory())await add(join(projects,entry.name,'memory'),'projects/'+entry.name+'/memory',entry.name);
    await add(join(base,'agent-memory'),'agent-memory');
    // User-owned settings can deliberately relocate memory. Do not follow
    // arbitrary project settings or attempt to reverse lossy directory encoding.
    let settings:any;try{settings=JSON.parse(await readFile(join(base,'settings.json'),'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;}
    if(settings?.autoMemoryDirectory) {
      const path=settings.autoMemoryDirectory;
      if(typeof path!=='string'||!(isAbsolute(path)||path.startsWith('~/')))throw new Error('MEMORY_ROOT_UNSAFE');
      const target=resolve(path.startsWith('~/')?join(homedir(),path.slice(2)):path);
      if([homedir(),base,resolve('/')].includes(target))throw new Error('MEMORY_ROOT_UNSAFE');
      await add(target,'custom/'+hash(target).slice(0,16));
    }
    // Hook cwd is an enrolled project, not a Markdown instruction/import. Only
    // its fixed native subagent directories are eligible.
    const sources=join(captureDir(),'sources');
    if(existsSync(sources))for(const name of await readdir(sources))if(name.endsWith('.json')) {
      check(signal);const source=JSON.parse(await readFile(join(sources,name),'utf8'));
      if(source.harness!=='claude-code'||typeof source.cwd!=='string'||!isAbsolute(source.cwd))continue;
      const project=await realpath(source.cwd).catch(()=>null);if(!project)continue;
      const dot=await maybeStat(join(project,'.claude'));if(dot?.isSymbolicLink())continue;
      for(const dir of ['agent-memory','agent-memory-local'])await add(join(project,'.claude',dir),'project/'+hash(project).slice(0,16)+'/'+dir,project);
    }
  }
  const missing=(previous.roots??[]).filter(p=>!seen.has(p));
  // An absent store may be an unmounted volume or atomic directory replacement.
  // Require a second complete discovery before publishing its removal.
  if(missing.some(p=>!previous.missing?.includes(p)))return {files,roots:roots.map(r=>r.path),missing,incomplete:true};
  let bytes=0;
  async function visit(root:Root,dir:string) {
    check(signal);
    const before=await lstat(dir);
    if(!before.isDirectory()||before.isSymbolicLink())throw new Error('MEMORY_PATH_CHANGED');
    for(const entry of await readdir(dir,{withFileTypes:true})) {
      check(signal);if(entry.name.startsWith('.'))continue;
      const path=join(dir,entry.name);
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){await visit(root,path);continue;}
      if(!entry.isFile()||!entry.name.endsWith('.md')||['raw_memories.md','instructions.md','AGENTS.md','CLAUDE.md'].includes(entry.name))continue;
      const canonical=await realpath(path);
      if(!canonical.startsWith(root.path+sep)||canonical!==path)throw new Error('MEMORY_PATH_CHANGED');
      const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      try {
        const st=await handle.stat();
        if(!st.isFile()||st.size>2*1024*1024)throw new Error('MEMORY_FILE_LIMIT');
        const text=await handle.readFile({encoding:'utf8'}),after=await handle.stat(),current=await lstat(path);
        if(st.ino!==current.ino||current.isSymbolicLink()||st.size!==after.size||st.mtimeMs!==after.mtimeMs||await realpath(path)!==canonical)throw new Error('MEMORY_PATH_CHANGED');
        bytes+=Buffer.byteLength(text);if(bytes>MAX_BYTES-1048576||files.length>=4096)throw new Error('MEMORY_SNAPSHOT_LIMIT');
        files.push({path:root.label+'/'+relative(root.path,path).split(sep).join('/'),project:root.project,modifiedAt:st.mtime.toISOString(),text});
        versions.push({path,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs});
      }finally{await handle.close();}
    }
    const after=await lstat(dir);if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw new Error('MEMORY_PATH_CHANGED');
  }
  for(const root of roots)await visit(root,root.path);
  for(const version of versions) {
    check(signal);const st=await lstat(version.path);
    if(st.isSymbolicLink()||st.ino!==version.ino||st.size!==version.size||st.mtimeMs!==version.mtimeMs)throw new Error('MEMORY_PATH_CHANGED');
  }
  files.sort((a,b)=>a.path.localeCompare(b.path));
  return {files,roots:roots.map(r=>r.path),missing,incomplete:false};
}

/** One bounded, process-owned job. Cancellation never advances success or
 * delays a foreground command; managed hooks give pending work a longer window. */
export async function refreshMemories({signal,now=Date.now}: {signal?:AbortSignal,now?:()=>number}={}) {
  const config=readCaptureConfig();if(!config||config.disabled||config.authPending||excluded(config))return;
  if(!(config.harnesses??['codex','claude-code']).some(h=>memoryDue(state(config,h),now())))return;
  try {await withSessionLock('capture:memories',async()=>{
    check(signal);
    await refreshCaptureIdentity(config,undefined,signal);
    for(const harness of config.harnesses??['codex','claude-code'] as Harness[]) {
      check(signal);let prior=state(config,harness);if(!memoryDue(prior,now()))continue;
      try {
        const inventory=await discoverMemories(config,harness,prior,signal);check(signal);
        if(inventory.incomplete){atomicJson(statePath(config,harness),{...prior,missing:inventory.missing,retryAt:now()+RETRY_MS,error:'MEMORY_ROOT_MISSING'});continue;}
        const contentHash=hash(JSON.stringify(inventory.files));
        if(prior.contentHash!==contentHash&&(inventory.files.length>0||prior.contentHash!==undefined)) {
          const generation=Math.max(now(),(prior.generation??0)+1);
          prior={...prior,generation};atomicJson(statePath(config,harness),prior);
          const snapshot={schemaVersion:1,owner:{tenantId:config.owner.tenantId,userId:config.owner.userId},installationId:config.installationId,
            host:hostname(),harness,generation,files:inventory.files};
          const body=JSON.stringify(snapshot);
          if(Buffer.byteLength(body)>MAX_BYTES)throw new Error('MEMORY_SNAPSHOT_LIMIT');
          const receipt=await withSessionLock('capture:flush',async()=>{
            check(signal);const current=readCaptureConfig();
            if(!current||current.disabled||excluded(current)||current.api!==config.api||current.installationId!==config.installationId||
              current.owner.tenantId!==config.owner.tenantId||current.owner.userId!==config.owner.userId)throw new Error('MEMORY_ENROLLMENT_CHANGED');
            return request(config.api,'/api/sessions/memories',{method:'POST',headers:{'content-type':'application/json'},body,signal});
          },20_000,signal);
          check(signal);
          if(receipt.stored!==true||receipt.snapshotId!==hash(body)||receipt.generation!==generation)throw new Error('MEMORY_RECEIPT_INVALID');
        }
        atomicJson(statePath(config,harness),{generation:prior.generation,successAt:now(),contentHash,roots:inventory.roots});
      }catch(error:any) {
        if(signal?.aborted)throw error;
        // A session upload owns this lock too. Contention is not a failed
        // receiver: leave the snapshot due for the next ordinary invocation.
        if(error.code==='SESSION_BUSY')continue;
        atomicJson(statePath(config,harness),{...prior,retryAt:now()+RETRY_MS,error:'MEMORY_REFRESH_FAILED'});
      }
    }
  },0,signal);}catch(error:any){
    if(error.code!=='SESSION_BUSY'&&!signal?.aborted)for(const harness of config.harnesses??['codex','claude-code'] as Harness[]) {
      const prior=state(config,harness);if(memoryDue(prior,now()))atomicJson(statePath(config,harness),{...prior,retryAt:now()+RETRY_MS,error:'MEMORY_REFRESH_FAILED'});
    }
  }
}

let running:{stop:()=>void}|undefined;
export function scheduleMemoryRefresh() {
  if(running)return running;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),90_000);timeout.unref();
  const job={stop:()=>controller.abort()};running=job;
  void refreshMemories({signal:controller.signal}).catch(()=>{}).finally(()=>{clearTimeout(timeout);if(running===job)running=undefined;});
  return job;
}
