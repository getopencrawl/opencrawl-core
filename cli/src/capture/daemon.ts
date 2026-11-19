// Session capture worker. Only hooks enroll sessions; the historical source
// catalogue is deliberately not an input to this worker.
import {watch,existsSync,mkdirSync,readFileSync,readdirSync,statSync,lstatSync,realpathSync,unlinkSync,renameSync,type FSWatcher} from 'node:fs';
import {join,dirname,basename} from 'node:path';
import {setImmediate as yieldToOwner} from 'node:timers/promises';
import {atomicJson,syncDirectory,withSessionLock} from '../session.ts';
import {captureDir,readCaptureConfig,captureTranscript,flushCaptures,refreshCaptureIdentity,recordError,captureDaemonEnabled,captureDaemonHarnesses,captureCursorNotice,spoolDaemonEvent,resolveAntigravityTranscript,type CaptureConfig} from './runtime.ts';
import {privacyRoot,sessionPrivate,pendingPrivacy} from '../incognito-state.ts';
import {captureExcluded} from './policy.ts';
import {hash,readsTranscript,HARNESSES} from './parse.ts';
import {recordNativeDaemonHook,daemonRegistration,daemonSubagent,daemonPathAllowed,sameDaemonBinding,daemonSession,type DaemonRegistration,type DaemonNotice} from './daemon-handoff.ts';
import {pendingLiveSince} from './live-batches.ts';
import {importLegacyDaemonNotices} from './daemon-legacy.ts';
import {version,compiled} from '../distribution.ts';

export const daemonDir=()=>join(captureDir(),'daemon');
const read=<T>(file:string,fallback:T):T=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error:any){if(error.code==='ENOENT')return fallback;throw error;}};
const names=(dir:string)=>readdirSync(dir).filter(name=>name.endsWith('.json'));
const remove=(file:string)=>{try{unlinkSync(file);syncDirectory(dirname(file));}catch(error:any){if(error.code!=='ENOENT')throw error;}};
function directories(){for(const dir of ['inbox','sessions'])mkdirSync(join(daemonDir(),dir),{recursive:true,mode:0o700});for(const dir of ['queue','rejected'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});}
type Registration=DaemonRegistration;
type LegacyNotice=Omit<Registration,'harness'>&{harness?:'claude-code',event:'SessionStart'|'SessionEnd'};
const key=(session:Registration)=>hash((session.harness==='claude-code'?'':session.harness+':')+session.sessionId+':'+session.path);
const sameBinding=sameDaemonBinding;
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error:any){return error.code!=='ESRCH';}};
export const recordDaemonHook=(event:any,pid=process.ppid)=>recordNativeDaemonHook('claude-code',event,pid);

type Active={registration:Registration,watchers:Map<string,FSWatcher>,signatures:Map<string,string>,dirty:boolean,lastActivity:number,closingAt?:number,retryAt:number};
export type SessionStartTask={kind:'session-start',id:string,at:number,api:string,installationId:string,owner:{tenantId:string,userId:string},harness:string,sessionId:string,payload:unknown};
export type DaemonOptions={signal?:AbortSignal,flushMs?:number,reconcileMs?:number,settleMs?:number,idleMs?:number,retryMs?:number,onReady?:()=>void,processStartupTask?:(config:CaptureConfig,task:SessionStartTask)=>Promise<void>};

/** One process per capture installation. Filesystem notifications schedule
 * bounded local work; a separate upload loop cannot stall transcript recording.
 * Timed recovery checks visit only the pending inbox and enrolled sessions. */
export async function runCaptureDaemon({signal,flushMs=10_000,reconcileMs=30_000,settleMs=2000,idleMs=300_000,retryMs=1000,onReady,processStartupTask}:DaemonOptions={}) {
  const initial=readCaptureConfig();if(!initial||!captureDaemonEnabled(initial)||initial.disabled&&!initial.backgroundStartup)return;
  directories();
  try{return await withSessionLock('capture:daemon',()=>withSessionLock('capture:worker',async()=>{
    const active=new Map<string,Active>(),rootWatchers:FSWatcher[]=[];
    if(initial.backgroundStartup&&!processStartupTask)throw Error('Background session startup is configured but its handler is unavailable');
    let stopped=false,wakeCapture=()=>{},wakeUpload=()=>{},wakeStartup=()=>{},inboxDirty=true,queueDirty=true,startupDirty=true;
    let nextReconcile=Date.now()+reconcileMs,inboxRetryAt=0;
    const counters={captures:0,sessionChecks:0,noticeReads:0,uploads:0,startups:0};
    const retryFile=join(daemonDir(),'retry.json');
    const generationFile=join(daemonDir(),'generation.json'),generation=read(generationFile,null);
    let retry=read(retryFile,{attempt:0,dueAt:0});
    const current=()=>{
      const config=readCaptureConfig();
      if(!config||!captureDaemonEnabled(config)||config.disabled&&!config.backgroundStartup||config.api!==initial.api||config.installationId!==initial.installationId||config.owner.userId!==initial.owner.userId||config.owner.tenantId!==initial.owner.tenantId||HARNESSES.some(harness=>config.roots[harness]!==initial.roots[harness])||JSON.stringify(read(generationFile,null))!==JSON.stringify(generation))return null;
      return config;
    };
    const stop=()=>{stopped=true;wakeCapture();wakeUpload();wakeStartup();};
    signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)stop();
    const wait=(lane:'capture'|'upload'|'startup',ms:number)=>new Promise<void>(done=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      const finish=()=>{if(timer)clearTimeout(timer);if(lane==='capture')wakeCapture=()=>{};else if(lane==='upload')wakeUpload=()=>{};else wakeStartup=()=>{};done();};
      if(lane==='capture')wakeCapture=finish;else if(lane==='upload')wakeUpload=finish;else wakeStartup=finish;
      if(Number.isFinite(ms))timer=setTimeout(finish,Math.max(1,ms));
      if(stopped)finish();
    });
    const mark=(item:Active)=>{item.dirty=true;item.lastActivity=Date.now();wakeCapture();};
    const addWatch=(item:Active,path:string,recursive=false)=>{
      if(item.watchers.has(path)||!existsSync(path))return;
      try{
        const watcher=watch(path,{recursive},(_event,name)=>{
          if(recursive||!name||name.toString()===basename(item.registration.path)||name.toString()===basename(item.registration.path,'.jsonl')||item.registration.harness==='antigravity'&&['transcript.jsonl','transcript_full.jsonl'].includes(name.toString()))mark(item);
        });
        watcher.on('error',()=>{watcher.close();item.watchers.delete(path);mark(item);});item.watchers.set(path,watcher);
      }catch{ /* The periodic check recovers filesystems without notifications. */ }
    };
    const enroll=(registration:Registration)=>{
      const config=current();
      if(!config||typeof registration.sessionId!=='string'||!(/^[\w.:-]{1,200}$/).test(registration.sessionId)||typeof registration.path!=='string'||registration.pid!==undefined&&(!Number.isSafeInteger(registration.pid)||registration.pid<=0)||!Number.isFinite(registration.at))throw Error('Invalid saved capture registration');
      if(!HARNESSES.includes(registration.harness)||!daemonPathAllowed(config,registration.harness,registration.sessionId,registration.path))throw Error('Saved transcript outside native session');
      if(!sameBinding(registration,config))throw Error('Capture registration is unbound or belongs to another installation; retained for inspection');
      const id=key(registration),prior=active.get(id);
      if(prior){prior.registration=registration;prior.closingAt=registration.endedAt;mark(prior);return;}
      const item:Active={registration,watchers:new Map(),signatures:new Map(),dirty:true,lastActivity:registration.at,closingAt:registration.endedAt,retryAt:0};
      active.set(id,item);addWatch(item,dirname(registration.path));
    };
    const persist=(registration:Registration)=>atomicJson(join(daemonDir(),'sessions',key(registration)+'.json'),registration);
    // One damaged local record must not prevent healthy sessions from capturing.
    // Preserve its bytes for inspection; explicit purge removes held records too.
    const hold=(file:string,error:unknown)=>{try{renameSync(file,file+'.held');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}recordError(error);syncDirectory(dirname(file));};
    let inboxAfter='';
    const blockedNotices=new Map<string,{name:string,attempt:number,dueAt:number}>(),noticeSessions=new Map<string,string>();
    const inbox=async()=>{
      inboxDirty=false;let nextRetry=Infinity;const finished=new Set<string>();
      const ordered=names(join(daemonDir(),'inbox')).filter(name=>!name.startsWith('startup-')).sort();
      const retained=new Set(ordered);
      for(const [name,session]of noticeSessions)if(!retained.has(name)){noticeSessions.delete(name);if(blockedNotices.get(session)?.name===name)blockedNotices.delete(session);}
      const after=ordered.findIndex(name=>name>inboxAfter),candidates=after>0?[...ordered.slice(after),...ordered.slice(0,after)]:ordered;
      inboxDirty=candidates.length>64;
      const deferred=(session:string,name:string)=>{
        const blocked=blockedNotices.get(session);if(!blocked)return false;
        nextRetry=Math.min(nextRetry,blocked.dueAt);
        return blocked.name!==name||Date.now()<blocked.dueAt;
      };
      // Read one payload at a time: 64 queued large tool results must not mean
      // 64 large objects resident in memory. Ordered filenames preserve ingress.
      for(const name of candidates.slice(0,64)){
        if(stopped)break;
        inboxAfter=name;
        const cachedSession=noticeSessions.get(name);if(cachedSession&&deferred(cachedSession,name))continue;
        const file=join(daemonDir(),'inbox',name);let notice:DaemonNotice|LegacyNotice;
        try{if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||statSync(file).size>9*1024*1024)throw Error('Capture notice exceeds limit');counters.noticeReads++;const value=read<DaemonNotice|LegacyNotice|null>(file,null);if(!value)throw Error('Invalid capture notice');notice=value;}
        catch(error){if(cachedSession&&blockedNotices.get(cachedSession)?.name===name)blockedNotices.delete(cachedSession);noticeSessions.delete(name);hold(file,error);finished.add(name);continue;}
        const config=current();if(!config){stop();return;}
        if(config.disabled)break;
        let registration:Registration|null=null,sessionKey='';
        try{
          if(!sameBinding(notice,config))throw Error('Capture notice belongs to another installation');
          if('kind' in notice&&notice.kind==='capture'){
            if(!notice.record||!HARNESSES.includes(notice.record.harness)||!Number.isFinite(notice.at))throw Error('Invalid native capture notice');
            const {harness,event,at}=notice.record,session=daemonSession(harness,event,at);
            sessionKey=harness+':'+session.sessionId;
            noticeSessions.set(name,sessionKey);
            if(deferred(sessionKey,name))continue;
            if(sessionPrivate(config,{harness,sessionId:session.sessionId})){remove(file);finished.add(name);continue;}
            if(!config.harnesses?.includes(harness)||captureExcluded(config,{harness,sessionId:session.sessionId,cwd:session.cwd??undefined})){blockedNotices.delete(sessionKey);noticeSessions.delete(name);finished.add(name);hold(file,Error('Forward capture no longer selected'));continue;}
            registration=daemonRegistration(config,notice);
          }else{
            const legacy=notice as LegacyNotice,{event,...fields}=legacy;
            registration={...fields,harness:'claude-code',...(event==='SessionEnd'?{endedAt:notice.at}:{})};
          }
        }catch(error){if(blockedNotices.get(sessionKey)?.name===name)blockedNotices.delete(sessionKey);noticeSessions.delete(name);finished.add(name);hold(file,error);continue;}
        try{
          if('kind' in notice&&notice.record.harness!=='claude-code'){
            await spoolDaemonEvent(config,notice.record);queueDirty=true;wakeUpload();
          }
          if(registration){
            const previous=active.get(key(registration))?.registration;
            if(!previous||previous.at<=registration.at){enroll(registration);persist(registration);}
          }
          if('kind' in notice){const child=daemonSubagent(config,notice);if(child){enroll(child);persist(child);}}
          remove(file);noticeSessions.delete(name);finished.add(name);if(blockedNotices.get(sessionKey)?.name===name)blockedNotices.delete(sessionKey);
        }catch(error){
          recordError(error);
          if(sessionKey){const attempt=(blockedNotices.get(sessionKey)?.attempt??0)+1,dueAt=Date.now()+Math.min(30_000,Math.max(100,retryMs)*2**Math.min(attempt-1,8));blockedNotices.set(sessionKey,{name,attempt,dueAt});}
          else nextRetry=Math.min(nextRetry,Date.now()+Math.max(100,retryMs));
        }
        await yieldToOwner();
      }
      // Retry only the failing session with capped backoff. Already deferred
      // payloads stay on disk; do not repeatedly parse their large tool bodies.
      for(const blocked of blockedNotices.values())nextRetry=Math.min(nextRetry,blocked.dueAt);
      if(Number.isFinite(nextRetry))inboxDirty=true;
      inboxRetryAt=candidates.some(name=>!finished.has(name)&&!noticeSessions.has(name))?0:Number.isFinite(nextRetry)?Math.max(Date.now()+1,nextRetry):0;
    };
    const transcripts=(item:Active)=>{
      if(item.registration.harness==='antigravity'){addWatch(item,dirname(item.registration.path));return [resolveAntigravityTranscript(item.registration.path)];}
      if(item.registration.harness!=='claude-code'){addWatch(item,dirname(item.registration.path));return [item.registration.path];}
      const files=[item.registration.path],children=join(dirname(item.registration.path),basename(item.registration.path,'.jsonl'));
      addWatch(item,dirname(item.registration.path));
      if(!existsSync(children)||lstatSync(children).isSymbolicLink())return files;
      addWatch(item,children,true);
      // This subtree belongs to the registered session, never to its project or
      // harness history. Ignore symlinks; captureTranscript checks real paths too.
      const visit=(dir:string)=>{if(!existsSync(dir)||lstatSync(dir).isSymbolicLink())return;for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const path=join(dir,entry.name);if(entry.isDirectory())visit(path);else if(entry.isFile()&&entry.name.endsWith('.jsonl'))files.push(path);}};
      visit(join(children,'subagents'));return files;
    };
    for(const name of names(join(daemonDir(),'sessions'))){const file=join(daemonDir(),'sessions',name);try{const registration=read<Registration|null>(file,null);if(registration)enroll({...registration,harness:registration.harness??'claude-code'});}catch(error){hold(file,error);}}
    for(const [path,changed] of [[join(daemonDir(),'inbox'),()=>{inboxDirty=true;inboxRetryAt=0;startupDirty=true;wakeCapture();wakeStartup();}],[join(captureDir(),'queue'),()=>{queueDirty=true;wakeUpload();wakeCapture();}]] as const){
      const watcher=watch(path,changed);watcher.on('error',stop);rootWatchers.push(watcher);
    }
    if(existsSync(join(daemonDir(),'legacy-handoff.json'))){
      const pending=join(captureDir(),'notices');mkdirSync(pending,{recursive:true,mode:0o700});
      const watcher=watch(pending,()=>{inboxDirty=true;inboxRetryAt=0;wakeCapture();});watcher.on('error',()=>{watcher.close();});rootWatchers.push(watcher);
    }
    const pendingDir=join(privacyRoot(initial),'pending');
    mkdirSync(pendingDir,{recursive:true,mode:0o700});
    const privacyWatch=watch(pendingDir,()=>wakeUpload());privacyWatch.on('error',stop);rootWatchers.push(privacyWatch);
    const configWatch=watch(captureDir(),(_event,name)=>{if(!name||name.toString()==='config.json'){if(!current())stop();else{wakeCapture();wakeUpload();startupDirty=true;wakeStartup();}}});
    configWatch.on('error',stop);rootWatchers.push(configWatch);
    const statusFile=join(daemonDir(),'status.json');
    atomicJson(statusFile,{pid:process.pid,startedAt:new Date().toISOString(),state:'running',executable:process.execPath,version,compiled:compiled()});onReady?.();
    const capture=async()=>{
      let paused=false;
      while(!stopped){
        const config=current();if(!config){stop();break;}
        const now=Date.now(),reconcile=now>=nextReconcile;
        if(reconcile){
          nextReconcile=now+reconcileMs;inboxDirty=true;
          // Native file notifications can be lost even with no active transcript.
          // Recover only this installation's pending inbox, never its history.
          if(config.backgroundStartup){startupDirty=true;wakeStartup();}
        }
        if(config.disabled){
          if(!paused)for(const item of active.values()){for(const watcher of item.watchers.values())watcher.close();item.watchers.clear();}
          paused=true;await wait('capture',nextReconcile-Date.now());continue;
        }
        if(paused){paused=false;for(const item of active.values())item.dirty=true;}
        if(config.authPending){try{await refreshCaptureIdentity(config);Object.assign(initial,config);}catch(error){recordError(error);await wait('capture',60_000);continue;}}
        if(inboxDirty&&Date.now()>=inboxRetryAt){const remaining=importLegacyDaemonNotices(config);await inbox();if(remaining)inboxDirty=true;await yieldToOwner();}
        let next=Math.min(nextReconcile,inboxDirty?inboxRetryAt||Date.now():Infinity);
        for(const [id,item] of active){
          if(stopped)break;
          const sessionConfig=current();if(!sessionConfig){stop();break;}
          if(sessionConfig.disabled){await wait('capture',nextReconcile-Date.now());break;}
          if(!sessionConfig.harnesses?.includes(item.registration.harness)||captureExcluded(sessionConfig,item.registration)){
            for(const watcher of item.watchers.values())watcher.close();active.delete(id);remove(join(daemonDir(),'sessions',id+'.json'));continue;
          }
          if(reconcile)item.dirty=true;
          // Clients with a shared host PID cannot use that PID as a session
          // lifetime. Retire idle watches; their next native hook re-enrolls the
          // exact transcript from its existing durable cursor.
          if(!item.registration.pid&&!item.closingAt){const expires=item.lastActivity+idleMs;if(Date.now()>=expires)item.closingAt=Date.now();else next=Math.min(next,expires);}
          if(!item.dirty&&(!item.closingAt||Date.now()<item.closingAt+settleMs)){if(item.closingAt)next=Math.min(next,item.closingAt+settleMs);continue;}
          if(Date.now()<item.retryAt){next=Math.min(next,item.retryAt);continue;}
          item.dirty=false;counters.sessionChecks++;
          try{
            if(item.registration.pid&&!alive(item.registration.pid)&&!item.closingAt){item.closingAt=Date.now();item.registration.endedAt=item.closingAt;persist(item.registration);}
            let changed=false,incomplete=false;
            for(const path of transcripts(item)){
              const latest=current();
              if(JSON.stringify(read(generationFile,null))!==JSON.stringify(generation)){stop();break;}
              if(!latest||latest.disabled||!sameBinding(item.registration,latest)||!latest.harnesses?.includes(item.registration.harness)||captureExcluded(latest,item.registration))break;
              if(!existsSync(path))continue;
              const st=statSync(path),signature=[st.dev,st.ino,st.size,st.mtimeMs].join(':');
              if(item.signatures.get(path)!==signature){
                const harness=item.registration.harness;
                if(harness==='cursor')await captureCursorNotice(latest,{id:'tail:'+id,at:new Date(item.registration.at).toISOString(),sequence:item.registration.at*1000,harness,event:{...item.registration.hook,conversation_id:item.registration.sessionId,transcript_path:path}},true);
                else if(readsTranscript(harness))await captureTranscript(latest,harness,path,{...item.registration.hook,session_id:item.registration.sessionId,cwd:item.registration.cwd},false,async()=>{queueDirty=true;wakeUpload();},undefined,{sessionScoped:true,sessionPath:item.registration.path});
                queueDirty=true;wakeUpload();item.lastActivity=Date.now();
                item.signatures.set(path,signature);counters.captures++;changed=true;
              }
              if(item.closingAt){const state=read(join(captureDir(),'state',(item.registration.harness==='cursor'?'cursor-'+hash(item.registration.sessionId):hash(item.registration.harness+realpathSync(path)))+'.json'),{offset:0});if(state.offset<st.size)incomplete=true;}
            }
            if(changed&&item.closingAt)item.closingAt=Date.now();
            if(item.closingAt){
              if(!incomplete&&Date.now()>=item.closingAt+settleMs){for(const watcher of item.watchers.values())watcher.close();active.delete(id);remove(join(daemonDir(),'sessions',id+'.json'));}
              else next=Math.min(next,incomplete?nextReconcile:item.closingAt+settleMs);
            }
          }catch(error){recordError(error);item.dirty=true;item.retryAt=Date.now()+reconcileMs;next=Math.min(next,item.retryAt);}
        }
        if(!captureDaemonHarnesses(config).length&&!config.backgroundStartup&&!queued()){stop();break;}
        if(inboxDirty&&Date.now()>=inboxRetryAt||[...active.values()].some(item=>item.dirty&&Date.now()>=item.retryAt))continue;
        await wait('capture',next-Date.now());
      }
    };
    const queued=()=>names(join(captureDir(),'queue')).some(name=>!existsSync(join(captureDir(),'rejected',name)));
    const upload=async()=>{
      let dueAt=0,nextPrivacy=0;
      while(!stopped){
        const config=current();if(!config){stop();break;}
        let privacyWait=Infinity;
        if(pendingPrivacy(config).length){
          if(Date.now()>=nextPrivacy){
            try{await (await import('../incognito.ts')).retryPrivacy(config);}catch(error){recordError(error);}
            nextPrivacy=Date.now()+60_000;
          }
          privacyWait=Math.max(1,nextPrivacy-Date.now());
        }
        if(config.disabled){await wait('upload',privacyWait);continue;}
        if(queueDirty){queueDirty=false;if(queued()&&!dueAt){const since=pendingLiveSince(captureDir());dueAt=since===undefined?Date.now():Math.min(Date.now()+flushMs,since+flushMs);}}
        if(!dueAt){await wait('upload',privacyWait);continue;}
        const readyAt=Math.max(dueAt,retry.dueAt);
        if(Date.now()<readyAt){await wait('upload',Math.min(privacyWait,readyAt-Date.now()));continue;}
        if(!queued()){dueAt=0;continue;}
        try{
          const result=await flushCaptures({wait:false,concurrency:1,maxBatches:8});counters.uploads+=result.uploaded;
          if('recordingCheckAt' in result){
            dueAt=result.recordingCheckAt;continue;
          }
          const pending=queued();
          // Excluded/unsupported batches and another flush owner can leave a
          // successful pass with no progress. Keep their bytes, but back off
          // just as durably as a network failure instead of authenticating
          // every second forever. A successful upload resets this delay.
          if(!result.uploaded&&pending){
            retry={attempt:retry.attempt+1,dueAt:Date.now()+Math.min(60_000,Math.max(flushMs,retryMs)*2**Math.min(retry.attempt,6))};
            atomicJson(retryFile,retry);dueAt=retry.dueAt;continue;
          }
          retry={attempt:0,dueAt:0};remove(retryFile);
          const since=pendingLiveSince(captureDir());
          dueAt=pending?(result.uploaded>0&&since===undefined?Date.now():Math.max(Date.now()+Math.min(flushMs,1000),since===undefined?0:since+flushMs)):0;
        }catch(error){
          recordError(error);retry={attempt:retry.attempt+1,dueAt:Date.now()+Math.min(60_000,retryMs*2**Math.min(retry.attempt,6))};atomicJson(retryFile,retry);dueAt=queued()?retry.dueAt:0;
        }
      }
    };
    // Board/bootstrap requests have their own lane. They share this process
    // and durable inbox but cannot block transcript recording or uploads.
    const startup=async()=>{
      const retryPath=join(daemonDir(),'startup-retry.json');let backoff=read(retryPath,{attempt:0,dueAt:0});
      while(!stopped){
        const config=current();if(!config){stop();break;}
        if(!config.backgroundStartup||!startupDirty){await wait('startup',Infinity);continue;}
        if(!processStartupTask)throw Error('Background session startup handler unavailable');
        if(Date.now()<backoff.dueAt){await wait('startup',backoff.dueAt-Date.now());continue;}
        startupDirty=false;let failed=false;
        const pending=names(join(daemonDir(),'inbox')).filter(name=>name.startsWith('startup-'));
        for(const name of pending.slice(0,16)){
          if(stopped)break;
          const file=join(daemonDir(),'inbox',name);let task:SessionStartTask;
          try{
            if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()||statSync(file).size>4096)throw Error('Background startup task must be an ordinary file of at most 4 KiB');
            task=read(file,null) as unknown as SessionStartTask;
            if(config.authPending||!task||task.kind!=='session-start'||typeof task.id!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).test(task.id)||name!=='startup-'+task.id+'.json'||!Number.isFinite(task.at)||typeof task.sessionId!=='string'||typeof task.harness!=='string'||task.api!==config.api||task.installationId!==config.installationId||task.owner?.tenantId!==config.owner.tenantId||task.owner?.userId!==config.owner.userId)throw Error('Background startup task is invalid or belongs to another profile');
          }catch(error){hold(file,error);continue;}
          try{
            const latest=current();if(!latest||!latest.backgroundStartup||JSON.stringify(read(generationFile,null))!==JSON.stringify(generation)){stop();break;}
            await processStartupTask(latest,task);
            if(stopped||!current()?.backgroundStartup||JSON.stringify(read(generationFile,null))!==JSON.stringify(generation))break;
            remove(file);counters.startups++;
          }
          catch(error){
            if(error&&typeof error==='object'&&'code' in error&&error.code==='STARTUP_BINDING_CHANGED')hold(file,error);
            else{recordError(error);failed=true;}
          }
        }
        if(failed){backoff={attempt:backoff.attempt+1,dueAt:Date.now()+Math.min(60_000,retryMs*2**Math.min(backoff.attempt,6))};atomicJson(retryPath,backoff);startupDirty=true;}
        else{backoff={attempt:0,dueAt:0};remove(retryPath);if(pending.length>16)startupDirty=true;}
        await yieldToOwner();
      }
    };
    const generationWatch=watch(daemonDir(),(_event,name)=>{if(name?.toString()==='generation.json'&&JSON.stringify(read(generationFile,null))!==JSON.stringify(generation))stop();});
    generationWatch.on('error',stop);rootWatchers.push(generationWatch);
    const guarded=(operation:Promise<void>)=>operation.catch(error=>{stop();throw error;});
    try{const results=await Promise.allSettled([guarded(capture()),guarded(upload()),guarded(startup())]);for(const result of results)if(result.status==='rejected')throw result.reason;}
    finally{
      stop();signal?.removeEventListener('abort',stop);for(const watcher of rootWatchers)watcher.close();for(const item of active.values())for(const watcher of item.watchers.values())watcher.close();
      atomicJson(statusFile,{pid:process.pid,stoppedAt:new Date().toISOString(),state:'stopped',executable:process.execPath,version,compiled:compiled(),...counters});
    }
  },60_000,signal),0);}catch(error:any){if(error.code!=='SESSION_BUSY')throw error;}
}
