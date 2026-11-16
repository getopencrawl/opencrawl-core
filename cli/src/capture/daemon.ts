// Claude capture worker. Only hooks enroll sessions; the historical source
// catalogue is deliberately not an input to this worker.
import {watch,existsSync,mkdirSync,readFileSync,readdirSync,statSync,lstatSync,realpathSync,unlinkSync,renameSync,type FSWatcher} from 'node:fs';
import {join,dirname,basename,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomicJson,syncDirectory,withSessionLock} from '../session.ts';
import {captureDir,readCaptureConfig,captureTranscript,flushCaptures,refreshCaptureIdentity,recordError,type CaptureConfig} from './runtime.ts';
import {captureExcluded} from './policy.ts';
import {hash} from './parse.ts';
import {pendingLiveSince} from './live-batches.ts';

export const daemonDir=()=>join(captureDir(),'daemon');
const read=<T>(file:string,fallback:T):T=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error:any){if(error.code==='ENOENT')return fallback;throw error;}};
const names=(dir:string)=>readdirSync(dir).filter(name=>name.endsWith('.json'));
const remove=(file:string)=>{try{unlinkSync(file);syncDirectory(dirname(file));}catch(error:any){if(error.code!=='ENOENT')throw error;}};
function directories(){for(const dir of ['inbox','sessions'])mkdirSync(join(daemonDir(),dir),{recursive:true,mode:0o700});for(const dir of ['queue','rejected'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});}
type Registration={sessionId:string,path:string,cwd?:string,pid:number,endedAt?:number,at:number,api:string,owner?:Pick<CaptureConfig['owner'],'tenantId'|'userId'>};
type Notice=Registration&{event:'SessionStart'|'SessionEnd'};
const key=(session:Registration)=>hash(session.sessionId+':'+session.path);
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error:any){return error.code!=='ESRCH';}};

/** A hook durably hands off a small pointer. No network, parsing, or global
 * configuration lock, even if the worker is offline or uploading. */
export function recordDaemonHook(event:any,pid=process.ppid) {
  const config=readCaptureConfig();if(!config||config.disabled||!config.harnesses?.includes('claude-code'))return;
  if(event?.cursor_version||!['SessionStart','SessionEnd'].includes(event?.hook_event_name))return;
  if(typeof event.session_id!=='string'||!/^[\w.:-]{1,200}$/.test(event.session_id)||typeof event.transcript_path!=='string')throw Error('Invalid Claude capture registration');
  const path=resolve(event.transcript_path),root=resolve(config.roots['claude-code'],'projects')+sep;
  if(!path.startsWith(root)||basename(path)!==event.session_id+'.jsonl')throw Error('Claude transcript outside configured session');
  const cwd=typeof event.cwd==='string'?event.cwd:undefined;
  if(captureExcluded(config,{sessionId:event.session_id,cwd}))return;
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Invalid Claude process identity');
  directories();
  const notice:Notice={sessionId:event.session_id,path,cwd,pid,event:event.hook_event_name,at:Date.now(),api:config.api,...(!config.authPending?{owner:{tenantId:config.owner.tenantId,userId:config.owner.userId}}:{})};
  atomicJson(join(daemonDir(),'inbox',randomUUID()+'.json'),notice);
}

type Active={registration:Registration,watchers:Map<string,FSWatcher>,signatures:Map<string,string>,dirty:boolean,closingAt?:number,retryAt:number};
export type DaemonOptions={signal?:AbortSignal,flushMs?:number,reconcileMs?:number,settleMs?:number,retryMs?:number,onReady?:()=>void};

/** One process per capture installation. Filesystem notifications schedule
 * bounded local work; a separate upload loop cannot stall transcript recording.
 * Timed recovery checks visit only currently enrolled sessions. */
export async function runCaptureDaemon({signal,flushMs=10_000,reconcileMs=30_000,settleMs=2000,retryMs=1000,onReady}:DaemonOptions={}) {
  const initial=readCaptureConfig();if(!initial||initial.disabled)return;
  directories();
  try{return await withSessionLock('capture:daemon',async()=>{
    const active=new Map<string,Active>(),rootWatchers:FSWatcher[]=[];
    let stopped=false,wakeCapture=()=>{},wakeUpload=()=>{},inboxDirty=true,queueDirty=true;
    let nextReconcile=Date.now()+reconcileMs;
    const counters={captures:0,sessionChecks:0,uploads:0};
    const retryFile=join(daemonDir(),'retry.json');
    const generationFile=join(daemonDir(),'generation.json'),generation=read(generationFile,null);
    let retry=read(retryFile,{attempt:0,dueAt:0});
    const current=()=>{
      const config=readCaptureConfig();
      if(!config||config.disabled||config.api!==initial.api||config.installationId!==initial.installationId||config.owner.userId!==initial.owner.userId||config.owner.tenantId!==initial.owner.tenantId)return null;
      return config;
    };
    const stop=()=>{stopped=true;wakeCapture();wakeUpload();};
    signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)stop();
    const wait=(lane:'capture'|'upload',ms:number)=>new Promise<void>(done=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      const finish=()=>{if(timer)clearTimeout(timer);if(lane==='capture')wakeCapture=()=>{};else wakeUpload=()=>{};done();};
      if(lane==='capture')wakeCapture=finish;else wakeUpload=finish;
      if(Number.isFinite(ms))timer=setTimeout(finish,Math.max(1,ms));
      if(stopped)finish();
    });
    const mark=(item:Active)=>{item.dirty=true;wakeCapture();};
    const addWatch=(item:Active,path:string,recursive=false)=>{
      if(item.watchers.has(path)||!existsSync(path))return;
      try{
        const watcher=watch(path,{recursive},(_event,name)=>{
          if(recursive||!name||name.toString()===basename(item.registration.path)||name.toString()===basename(item.registration.path,'.jsonl'))mark(item);
        });
        watcher.on('error',()=>{watcher.close();item.watchers.delete(path);mark(item);});item.watchers.set(path,watcher);
      }catch{ /* The periodic check recovers filesystems without notifications. */ }
    };
    const enroll=(registration:Registration)=>{
      const config=current();
      if(!config||typeof registration.sessionId!=='string'||!(/^[\w.:-]{1,200}$/).test(registration.sessionId)||typeof registration.path!=='string'||!Number.isSafeInteger(registration.pid)||registration.pid<=0||!Number.isFinite(registration.at))throw Error('Invalid saved Claude capture registration');
      if(!resolve(registration.path).startsWith(resolve(config.roots['claude-code'],'projects')+sep)||basename(registration.path)!==registration.sessionId+'.jsonl')throw Error('Saved Claude transcript outside configured session');
      if(registration.api!==initial.api||registration.owner&&(registration.owner.tenantId!==initial.owner.tenantId||registration.owner.userId!==initial.owner.userId))throw Error('Capture registration belongs to a different destination; retained for its original owner');
      const id=key(registration),prior=active.get(id);
      if(prior){prior.registration=registration;prior.closingAt=registration.endedAt;mark(prior);return;}
      const item:Active={registration,watchers:new Map(),signatures:new Map(),dirty:true,closingAt:registration.endedAt,retryAt:0};
      active.set(id,item);addWatch(item,dirname(registration.path));
    };
    const persist=(registration:Registration)=>atomicJson(join(daemonDir(),'sessions',key(registration)+'.json'),registration);
    // One damaged local record must not prevent healthy sessions from capturing.
    // Preserve its bytes for inspection; explicit purge removes held records too.
    const hold=(file:string,error:unknown)=>{recordError(error);renameSync(file,file+'.held');syncDirectory(dirname(file));};
    const inbox=()=>{
      inboxDirty=false;
      const pending=names(join(daemonDir(),'inbox')).flatMap(name=>{
        const file=join(daemonDir(),'inbox',name);try{const notice=read<Notice|null>(file,null);return notice?[{file,notice}]:[];}catch(error){hold(file,error);return [];}
      }).sort((a,b)=>a.notice.at-b.notice.at);
      for(const {file,notice} of pending){try{
        const id=key(notice),previous=active.get(id)?.registration;
        if(previous&&previous.at>notice.at){remove(file);continue;}
        const endedAt=notice.event==='SessionEnd'?notice.at:undefined;
        const {event:_,...fields}=notice;
        const registration:Registration={...fields,...(endedAt?{endedAt}:{})};
        enroll(registration);persist(registration);remove(file);
      }catch(error){hold(file,error);}}
    };
    const transcripts=(item:Active)=>{
      const files=[item.registration.path],children=join(dirname(item.registration.path),basename(item.registration.path,'.jsonl'));
      addWatch(item,dirname(item.registration.path));
      if(!existsSync(children)||lstatSync(children).isSymbolicLink())return files;
      addWatch(item,children,true);
      // This subtree belongs to the registered session, never to its project or
      // harness history. Ignore symlinks; captureTranscript checks real paths too.
      const visit=(dir:string)=>{if(!existsSync(dir)||lstatSync(dir).isSymbolicLink())return;for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const path=join(dir,entry.name);if(entry.isDirectory())visit(path);else if(entry.isFile()&&entry.name.endsWith('.jsonl'))files.push(path);}};
      visit(join(children,'subagents'));return files;
    };
    for(const name of names(join(daemonDir(),'sessions'))){const file=join(daemonDir(),'sessions',name);try{const registration=read<Registration|null>(file,null);if(registration)enroll(registration);}catch(error){hold(file,error);}}
    for(const [path,changed] of [[join(daemonDir(),'inbox'),()=>{inboxDirty=true;wakeCapture();}],[join(captureDir(),'queue'),()=>{queueDirty=true;wakeUpload();}],[captureDir(),()=>{if(!current())stop();}]] as const){
      const watcher=watch(path,changed);watcher.on('error',stop);rootWatchers.push(watcher);
    }
    const statusFile=join(daemonDir(),'status.json');
    atomicJson(statusFile,{pid:process.pid,startedAt:new Date().toISOString(),state:'running'});onReady?.();
    const capture=async()=>{
      while(!stopped){
        const config=current();if(!config){stop();break;}
        if(config.authPending){try{await refreshCaptureIdentity(config);Object.assign(initial,config);}catch(error){recordError(error);await wait('capture',60_000);continue;}}
        if(inboxDirty)inbox();
        const now=Date.now(),reconcile=now>=nextReconcile;
        if(reconcile)nextReconcile=now+reconcileMs;
        let next=active.size?nextReconcile:Infinity;
        for(const [id,item] of active){
          if(stopped)break;
          if(reconcile)item.dirty=true;
          if(!item.dirty&&(!item.closingAt||Date.now()<item.closingAt+settleMs)){if(item.closingAt)next=Math.min(next,item.closingAt+settleMs);continue;}
          if(Date.now()<item.retryAt){next=Math.min(next,item.retryAt);continue;}
          item.dirty=false;counters.sessionChecks++;
          try{
            if(!alive(item.registration.pid)&&!item.closingAt){item.closingAt=Date.now();item.registration.endedAt=item.closingAt;persist(item.registration);}
            let changed=false,incomplete=false;
            for(const path of transcripts(item)){
              if(!existsSync(path))continue;
              const st=statSync(path),signature=[st.dev,st.ino,st.size,st.mtimeMs].join(':');
              if(item.signatures.get(path)!==signature){
                await captureTranscript(config,'claude-code',path,{session_id:item.registration.sessionId,cwd:item.registration.cwd},false,async()=>{queueDirty=true;wakeUpload();});
                item.signatures.set(path,signature);counters.captures++;changed=true;
              }
              if(item.closingAt){const state=read(join(captureDir(),'state',hash('claude-code'+realpathSync(path))+'.json'),{offset:0});if(state.offset<st.size)incomplete=true;}
            }
            if(changed&&item.closingAt)item.closingAt=Date.now();
            if(item.closingAt){
              if(!incomplete&&Date.now()>=item.closingAt+settleMs){for(const watcher of item.watchers.values())watcher.close();active.delete(id);remove(join(daemonDir(),'sessions',id+'.json'));}
              else next=Math.min(next,incomplete?nextReconcile:item.closingAt+settleMs);
            }
          }catch(error){recordError(error);item.dirty=true;item.retryAt=Date.now()+reconcileMs;next=Math.min(next,item.retryAt);}
        }
        if(inboxDirty||[...active.values()].some(item=>item.dirty&&Date.now()>=item.retryAt))continue;
        await wait('capture',next-Date.now());
      }
    };
    const queued=()=>names(join(captureDir(),'queue')).some(name=>!existsSync(join(captureDir(),'rejected',name)));
    const upload=async()=>{
      let dueAt=0;
      while(!stopped){
        if(!current()){stop();break;}
        if(queueDirty){queueDirty=false;if(queued()&&!dueAt){const since=pendingLiveSince(captureDir());dueAt=since===undefined?Date.now():Math.min(Date.now()+flushMs,since+flushMs);}}
        if(!dueAt){await wait('upload',Infinity);continue;}
        const readyAt=Math.max(dueAt,retry.dueAt);
        if(Date.now()<readyAt){await wait('upload',readyAt-Date.now());continue;}
        try{
          const result=await flushCaptures({wait:false,concurrency:1,maxBatches:8});counters.uploads+=result.uploaded;
          retry={attempt:0,dueAt:0};remove(retryFile);dueAt=queued()?Date.now()+flushMs:0;
        }catch(error){
          recordError(error);retry={attempt:retry.attempt+1,dueAt:Date.now()+Math.min(60_000,retryMs*2**Math.min(retry.attempt,6))};atomicJson(retryFile,retry);dueAt=queued()?retry.dueAt:0;
        }
      }
    };
    const generationWatch=watch(daemonDir(),(_event,name)=>{if(name?.toString()==='generation.json'&&JSON.stringify(read(generationFile,null))!==JSON.stringify(generation))stop();});
    generationWatch.on('error',stop);rootWatchers.push(generationWatch);
    const guarded=(operation:Promise<void>)=>operation.catch(error=>{stop();throw error;});
    try{const results=await Promise.allSettled([guarded(capture()),guarded(upload())]);for(const result of results)if(result.status==='rejected')throw result.reason;}
    finally{
      stop();signal?.removeEventListener('abort',stop);for(const watcher of rootWatchers)watcher.close();for(const item of active.values())for(const watcher of item.watchers.values())watcher.close();
      atomicJson(statusFile,{pid:process.pid,stoppedAt:new Date().toISOString(),state:'stopped',...counters});
    }
  },0);}catch(error:any){if(error.code!=='SESSION_BUSY')throw error;}
}
