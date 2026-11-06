import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync, openSync, readSync, closeSync, unlinkSync, createReadStream, createWriteStream} from 'node:fs';
import {createZstdDecompress} from 'node:zlib';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {join, dirname, resolve, sep, basename} from 'node:path';
import {homedir, hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {configDir, atomicFile, atomicJson, accessToken, withSessionLock, syncDirectory} from '../session.ts';
import {removeLegacyService} from './legacy-service.ts';
import {CliError} from '../oauth.ts';
import {parseRecord, detectOrigin, hash, type Harness} from './parse.ts';
import {isClaudeDesktopTranscript,desktopNativeMessageIds} from './desktop-history.ts';

export const captureDir = () => join(configDir(),'capture');
const read = (p:string, fallback:any=null) => {try{return JSON.parse(readFileSync(p,'utf8'));}catch(e:any){if(e.code==='ENOENT')return fallback;throw e;}};
export type CaptureConfig = {disabled?:boolean,authPending?:boolean,schemaVersion:1,harnesses?:Harness[],api:string,installationId:string,owner:{tenantId:string,userId:string,name?:string,email?:string},installedAt:string,roots:Record<Harness,string>,claudeDesktopSessionsRoot?:string,command:string[]};
export const readCaptureConfig = ():CaptureConfig|null => read(join(captureDir(),'config.json'));
// `owner` in the saved schema is cached attribution, not an enrollment constraint.
export async function refreshCaptureIdentity(config:CaptureConfig) {
  const refresh=async()=>{
    const {principal}=await request(config.api,'/api/sessions/identity');
    if(!principal?.userId || !principal?.tenantId)throw new CliError('CAPTURE_IDENTITY_MISSING','Deployment does not supply capture identity');
    const previousId=config.installationId,current=readCaptureConfig();
    config.owner=principal;
    if(config.authPending){
      config.authPending=false;
      if(config.installationId==='pending')config.installationId=current?.api===config.api&&current.installationId!=='pending'?current.installationId:randomUUID();
    }
    if(current?.api===config.api && (current.installationId===previousId||previousId==='pending'))atomicJson(join(captureDir(),'config.json'),{...current,owner:principal,installationId:config.installationId,...(current.authPending?{authPending:false}:{})});
    return principal;
  };
  return config.authPending?withSessionLock('capture:identity',refresh,Infinity):refresh();
}
export async function request(api:string,path:string,init:RequestInit={},tokenOverride?:string) {
  const saved=read(join(captureDir(),'receiver-token.json'));
  const staticToken=tokenOverride || process.env.OPENCRAWL_SESSIONS_TOKEN || (saved?.api===api?saved.token:null);
  let token=staticToken || await accessToken(api);
  const method=init.method??'GET';
  // Only retry operations whose payloads are read-only or content-addressed.
  // A lost response after storage must resend the same batch/blob, not lose it.
  const retryable=method==='GET'||method==='POST'&&path==='/api/sessions/batches'||method==='PUT'&&/^\/api\/sessions\/attachments\/[a-f0-9]{64}$/.test(path);
  const send=async()=>{
    for(let attempt=0;;attempt++){
      let response:Response;
      try {response=await fetch(api+path,{...init,headers:{...init.headers,authorization:'Bearer '+token},signal:AbortSignal.timeout(20000),redirect:'error'});}
      catch(error){if(!retryable||attempt===4)throw error;await new Promise(r=>setTimeout(r,250*2**attempt));continue;}
      if(!retryable||attempt===4||![429,502,503,504].includes(response.status))return response;
      const retryAfter=response.headers.get('retry-after');
      const seconds=retryAfter===null?NaN:Number(retryAfter);
      const delay=Number.isFinite(seconds)?seconds*1000:retryAfter?Date.parse(retryAfter)-Date.now():0;
      await response.body?.cancel();
      await new Promise(r=>setTimeout(r,Math.min(30000,Math.max(250*2**attempt,Number.isFinite(delay)?delay:0))));
    }
  };
  let res=await send();
  if(res.status===401 && !staticToken){token=await accessToken(api,token);res=await send();}
  const body=await res.json().catch(()=>{throw res.status>=500||res.status===429
    ?new CliError('CAPTURE_RETRY_EXHAUSTED',`Capture endpoint ${new URL(api).hostname} is temporarily unavailable (HTTP ${res.status}). Queued data is retained; retry the approved import.`)
    :new CliError('CAPTURE_NETWORK_BLOCKED',`Capture endpoint ${new URL(api).hostname} returned HTTP ${res.status} without JSON. Check this host in your cloud environment network allowlist.`);});
  if(!res.ok)throw new CliError('CAPTURE_UPLOAD_FAILED',`Capture request failed (${res.status}): ${body.error?.code ?? 'unknown'}`);
  return body.data;
}
export function commandForSelf() {
  if(process.env.OPENCRAWL_LAUNCHER && process.env.OPENCRAWL_NODE) return [process.env.OPENCRAWL_NODE,process.env.OPENCRAWL_LAUNCHER];
  return process.argv[1]?.endsWith('.ts') ? [process.execPath,resolve(process.argv[1])] : [process.execPath];
}
export function kick(config:CaptureConfig) {
  if(!config.command.length)return;
  const child=spawn(config.command[0],[...config.command.slice(1),'collect','worker'],{
    detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,OPENCRAWL_CONFIG_HOME:dirname(configDir()),OPENCRAWL_NO_UPDATE:'1'}});
  child.on('error',()=>{});child.unref();
}
export function recordError(error:any) {
  // Status only: never include transcript content, credentials, or a provider response.
  atomicJson(join(captureDir(),'last-error.json'),{at:new Date().toISOString(),code:error?.code || 'CAPTURE_FAILED'});
}
function ensureDirectories() {for(const dir of ['queue','state','blobs','notices','sources'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});}
const under = (file:string,dir:string) => file.startsWith(dir+sep);
function transcriptAllowed(file:string, config:CaptureConfig, harness:Harness, approvedHistory=false) {
  const path=realpathSync(file);
  // Host-mirrored desktop history is accessible only through explicit backfill consent.
  if(approvedHistory&&harness==='claude-code'&&isClaudeDesktopTranscript(path,config))return path;
  let root:string;try{root=realpathSync(config.roots[harness]);}catch{throw new CliError('CAPTURE_PATH_REJECTED','Transcript outside configured harness session directories');}
  const allowed=harness==='claude-code' ? [join(root,'projects')] : [join(root,'sessions'),join(root,'archived_sessions')];
  if(!allowed.some(dir=>under(path,dir)) || !(path.endsWith('.jsonl') || harness==='codex' && path.endsWith('.jsonl.zst')))throw new CliError('CAPTURE_PATH_REJECTED','Transcript outside configured harness session directories');
  return path;
}
export function* walk(dir:string):Generator<string> {
  let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){const p=join(dir,e.name);if(e.isDirectory())yield*walk(p);else if(e.isFile()&&p.endsWith('.jsonl'))yield p;}
}
function findTranscript(config:CaptureConfig,harness:Harness,sessionId:string):string|undefined {
  const dirs=harness==='codex'?['sessions','archived_sessions']:['projects'];
  for(const d of dirs)for(const path of walk(join(config.roots[harness],d)))if(basename(path).includes(sessionId))return path;
}
function attachmentTransform(value:any, attachments:any[], cwd:string, localFiles=new Set<any>()):any {
  if(Array.isArray(value))return value.map(v=>attachmentTransform(v,attachments,cwd,localFiles));
  if(!value || typeof value!=='object')return value;
  let bytes:Buffer|undefined, path:string|undefined, mime:string|undefined, reference:string|undefined;
  if(value.type==='base64' && typeof value.data==='string'){bytes=Buffer.from(value.data,'base64');mime=value.media_type;}
  const url=typeof value.image_url==='string'?value.image_url:value.image_url?.url;
  if(typeof url==='string' && url.startsWith('data:')){const m=/^data:([^;,]+);base64,(.*)$/s.exec(url);if(m){mime=m[1];bytes=Buffer.from(m[2],'base64');}}
  if(localFiles.has(value) && ['local_image','input_file','file'].includes(value.type) && typeof value.path==='string')path=resolve(cwd,value.path);
  if(path) {
    try{if(statSync(path).size>32*1024*1024){attachments.push({path,status:'too_large'});return value;}bytes=readFileSync(path);}
    catch{attachments.push({path,status:'missing'});return value;}
  }
  if(bytes){
    if(bytes.length>32*1024*1024){attachments.push({status:'too_large',path,mimeType:mime});return {...value,data:undefined,image_url:undefined,captureStatus:'too_large'};}
    const sha256=hash(bytes),dest=join(captureDir(),'blobs',sha256);
    atomicFile(dest,bytes);
    const a={sha256,size:bytes.length,mimeType:mime??null,path:path??null,status:'captured'};attachments.push(a);
    return {type:'opencrawl_attachment',...a};
  }
  if(typeof url==='string')reference=url;
  if(value.type==='url' && typeof value.url==='string')reference=value.url;
  if(reference)attachments.push({url:reference,status:'remote_reference'});
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,attachmentTransform(v,attachments,cwd,localFiles)]));
}
function enqueue(config:CaptureConfig,meta:any,events:any[],attachments:any[]) {
  if(!events.length)return;
  if(config.authPending)throw new CliError('CAPTURE_AUTH_PENDING','Capture identity has not been authenticated yet');
  if(!meta.sessionId)throw new CliError('CAPTURE_SESSION_UNKNOWN','Transcript has no session identity');
  const batch={schemaVersion:1,owner:config.owner,installationId:config.installationId,host:hostname(),...meta,events,attachments};
  const size=Buffer.byteLength(JSON.stringify(batch));
  if(size>16*1024*1024)throw new CliError('CAPTURE_BATCH_TOO_LARGE','A capture record exceeds the upload limit; retained locally for retry');
  atomicJson(join(captureDir(),'queue',hash(JSON.stringify(batch))+'.json'),batch);
}
/** The cursor advances only after its records and attachment bytes are durably spooled. */
export async function captureTranscript(config:CaptureConfig,harness:Harness,file:string,hook:any={},reconcileHistory=false) {
  ensureDirectories();
  const path=transcriptAllowed(file,config,harness,reconcileHistory);
  const desktopAudit=harness==='claude-code'&&basename(path)==='audit.jsonl'&&isClaudeDesktopTranscript(path,config);
  const stateFile=join(captureDir(),'state',hash(harness+path)+'.json');
  return withSessionLock('capture:'+stateFile,async()=>{
    const source=statSync(path),old=read(stateFile,{offset:0});
    const compressed=path.endsWith('.jsonl.zst');
    let readPath=path;
    if(compressed) {
      if(old.archiveSize===source.size && old.archiveMtime===source.mtimeMs && old.ino===source.ino && (!reconcileHistory || old.parserVersion===2))return old.meta;
      readPath=stateFile+'.expanded.tmp';
      // The transcript lock makes an abandoned expansion safe to replace after a crash.
      try{unlinkSync(readPath);}catch(e:any){if(e.code!=='ENOENT')throw e;}
      let expanded=0;
      try {
        await pipeline(createReadStream(path),createZstdDecompress(),new Transform({transform(chunk,encoding,callback){
          expanded+=chunk.length;
          callback(expanded>256*1024*1024?new CliError('CAPTURE_ARCHIVE_TOO_LARGE','Compressed transcript exceeds the 256 MiB expanded limit; retained locally.'):null,chunk);
        }}),createWriteStream(readPath,{mode:0o600,flags:'wx'}));
      } catch(e) {try{unlinkSync(readPath);}catch{}throw e;}
    }
    const st=statSync(readPath);
    let offset=old.offset;
    if(st.size<offset || (old.ino && old.ino!==source.ino) || compressed)offset=0;
    // Parser upgrades must not silently start a historical import in hooks/sync.
    // An explicitly approved backfill may reread older cursors to recover newly
    // supported native records; unchanged event IDs remain idempotent downstream.
    if(reconcileHistory && old.parserVersion!==2)offset=0;
    const parserVersion=offset===0?2:old.parserVersion??1;
    const nativeIds=desktopAudit&&offset<st.size?desktopNativeMessageIds(path):new Set<string>();
    const fd=openSync(readPath,'r');
    let meta:any=old.meta??{harness,sessionId:hook.session_id,origin:'unknown',originEvidence:null,parentSessionId:null,sourcePath:path};
    let codexIdentityRead=false;
    function metadata(r:any) {
        const p=r.payload??r;
        if(desktopAudit){
          if(typeof r.session_id==='string'&&r.session_id){meta.sessionId=r.session_id;meta.origin='desktop';meta.originEvidence='Claude Desktop local-agent-mode-sessions audit';}
          return;
        }
        if(harness==='codex' && r.type==='session_meta') {
          // Forks include copied parent headers after their own leading header.
          // Those records are history, not a change to this transcript's owner.
          if(codexIdentityRead)return;
          codexIdentityRead=true;
          meta.sessionId=p.id;meta.parentSessionId=p.forked_from_id??p.source?.subagent?.thread_spawn?.parent_thread_id??null;
          const origin=detectOrigin(harness,r);
          meta.origin=origin.origin;meta.originEvidence=origin.evidence;
          meta.cwd=p.cwd;meta.harnessVersion=p.cli_version;
          return;
        } else if(harness==='codex') {
          if(r.type==='turn_context' && p.cwd)meta.cwd=p.cwd;
          return;
        } else if(harness==='claude-code' && r.sessionId) {
          meta.sessionId=r.agentId ? r.sessionId+':'+r.agentId : r.sessionId;
          if(r.agentId)meta.parentSessionId=r.sessionId;
        }
        const origin=detectOrigin(harness,r);
        if(harness==='claude-code' && (process.env.CLAUDE_CODE_REMOTE==='true'||origin.origin==='cloud')) {
          meta.origin='cloud';meta.originEvidence=origin.origin==='cloud'?origin.evidence:(meta.originEvidence??'CLAUDE_CODE_REMOTE=true');
          if(origin.origin==='cloud')meta.remoteSessionId=origin.evidence!.split('/').pop();
        }
        if(origin.origin!=='unknown' && meta.origin!=='cloud'){meta.origin=origin.origin;meta.originEvidence=origin.evidence;}
        if(p.cwd || r.cwd)meta.cwd=p.cwd??r.cwd;
      if(p.cli_version || r.version)meta.harnessVersion=p.cli_version??r.version;
    }
    try {
      // Metadata lives at the beginning and is inexpensive to reread, even on multi-GB rollouts.
      const head=Buffer.alloc(Math.min(st.size,65536));readSync(fd,head,0,head.length,0);
      for(const line of head.toString('utf8').split('\n')) {
        let r;try{r=JSON.parse(line);}catch{continue;}
        if(!desktopAudit)metadata(r);
      }
      while(offset<st.size) {
        let bytes=Buffer.alloc(Math.min(st.size-offset,48*1024*1024));readSync(fd,bytes,0,bytes.length,offset);
        let end=bytes.lastIndexOf(10);
        if(end<0) {
          if(bytes.length<st.size-offset)throw new CliError('CAPTURE_LINE_TOO_LARGE','Transcript line exceeds capture chunk size');
          break; // writer has not completed this record yet
        }
        bytes=bytes.subarray(0,end+1);
        const events:any[]=[],attachments:any[]=[];
        let position=offset;
        for(const line of bytes.toString('utf8').split('\n').slice(0,-1)){
          if(line.trim()){
            let record;try{record=JSON.parse(line);}catch{throw new CliError('CAPTURE_INVALID_RECORD','Invalid transcript record; cursor retained');}
            const auditMessage=!desktopAudit||['user','assistant'].includes(record.type)&&!nativeIds.has(record.uuid);
            if(desktopAudit&&auditMessage&&(!record.session_id||typeof record.session_id!=='string'))throw new CliError('CAPTURE_SESSION_UNKNOWN','Desktop audit message has no session identity');
            if(desktopAudit&&auditMessage&&meta.sessionId!==record.session_id)enqueue(config,meta,events.splice(0),attachments.splice(0));
            if(!desktopAudit||auditMessage)metadata(record);
            const parsed=auditMessage?parseRecord(harness,record,position):null;
            if(parsed&&desktopAudit){parsed.timestamp=record._audit_timestamp??record.timestamp??null;parsed.parentId=record.parent_tool_use_id??null;}
            if(parsed) {
              // Only native attachment blocks may cause file reads. A tool argument/result can
              // contain arbitrary JSON that resembles an attachment but was never opened.
              const localFiles=new Set<any>();
              function blocks(content:any) {
                if(!Array.isArray(content))return;
                for(const block of content) {
                  if(block && ['local_image','input_file','file'].includes(block.type))localFiles.add(block);
                  if(block?.type==='tool_result')blocks(block.content);
                }
              }
              if(parsed.kind==='message' || parsed.kind==='agent_message')blocks(parsed.data?.content);
              if(parsed.kind==='attachment' && parsed.data)localFiles.add(parsed.data);
              events.push(attachmentTransform(parsed,attachments,meta.cwd??dirname(path),localFiles));
            }
          }
          position+=Buffer.byteLength(line)+1;
          if(events.length>=200){enqueue(config,meta,events.splice(0),attachments.splice(0));}
        }
        enqueue(config,meta,events,attachments);
        offset+=bytes.length;atomicJson(stateFile,{offset,ino:source.ino,parserVersion,meta,...(compressed&&offset===st.size?{archiveSize:source.size,archiveMtime:source.mtimeMs}:{})});
      }
    } finally{closeSync(fd);if(compressed)try{unlinkSync(readPath);}catch{}}
    return meta;
  });
}
/** Hook work is only a durable local handoff. Never scan, parse or upload here. */
export async function captureHook(harness:Harness,event:any) {
  const config=readCaptureConfig();if(!config||config.disabled)return;
  ensureDirectories();
  const sessionId=event?.session_id;
  if(typeof sessionId!=='string' || !/^[\w.:-]{1,200}$/.test(sessionId))throw new CliError('CAPTURE_SESSION_UNKNOWN','Hook missing session ID');
  const id=randomUUID();
  atomicJson(join(captureDir(),'notices',id+'.json'),{id,at:new Date().toISOString(),harness,event});
  kick(config);
}

// The original event is kept only until its immutable batch is spooled. Its ID
// and timestamp survive a crash between enqueue and notice removal.
export async function drainCaptureNotices(config=readCaptureConfig()!) {
  ensureDirectories();
  return withSessionLock('capture:notices',async()=>{
  let processed=0,firstError:any;
  for(const name of readdirSync(join(captureDir(),'notices')).filter(n=>n.endsWith('.json'))) {
    const path=join(captureDir(),'notices',name),notice=read(path);
    if(!notice)continue;
    try {
    const {harness,event,id,at}=notice;
    const file=event.transcript_path || findTranscript(config,harness,event.session_id);
    // Persist the source BEFORE retiring the notice; a tail written after Stop
    // remains discoverable on this worker's polls and the next CLI invocation.
    const source={harness,sessionId:event.session_id,path:file??null,origin:process.env.CLAUDE_CODE_REMOTE==='true'?'cloud':'unknown'};
    atomicJson(join(captureDir(),'sources',hash(harness+':'+event.session_id+':'+(file??''))+'.json'),source);
    const meta=file && existsSync(file) ? await captureTranscript(config,harness,file,event) :
      {harness,sessionId:event.session_id,origin:source.origin,originEvidence:null,parentSessionId:null};
    if(harness==='claude-code'&&typeof event.agent_transcript_path==='string'&&event.agent_transcript_path!==file){
      const child=event.agent_transcript_path;
      atomicJson(join(captureDir(),'sources',hash(harness+':'+event.session_id+':'+child)+'.json'),{...source,path:child});
      if(existsSync(child))await captureTranscript(config,harness,child,event);
    }
    const attachments:any[]=[];
    const data=attachmentTransform(event,attachments,event.cwd??homedir());
    enqueue(config,meta,[{id,kind:'hook',timestamp:at,data}],attachments);
    unlinkSync(path);syncDirectory(dirname(path));processed++;
    }catch(error){firstError??=error;}
  }
  if(firstError)throw firstError;
  return processed;
  },Infinity);
}

async function reconcileSources(config:CaptureConfig,seen:Map<string,string>) {
  let changed=false;
  for(const name of readdirSync(join(captureDir(),'sources')).filter(n=>n.endsWith('.json'))) {
    const sourceFile=join(captureDir(),'sources',name),source=read(sourceFile);
    const path=source.path || findTranscript(config,source.harness,source.sessionId);
    if(!path || !existsSync(path))continue;
    if(!source.path){source.path=path;atomicJson(sourceFile,source);}
    const st=statSync(path),signature=JSON.stringify([st.dev,st.ino,st.size,st.mtimeMs]);
    if(seen.get(path)===signature)continue;
    await captureTranscript(config,source.harness,path,{session_id:source.sessionId});
    seen.set(path,signature);changed=true;
  }
  return changed;
}

const queuedNames=()=>readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json'));
const noticeNames=()=>readdirSync(join(captureDir(),'notices')).filter(n=>n.endsWith('.json'));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
/** One lazy worker per installation; contention is an ordinary successful wake. */
export async function captureWorker({idleMs=30_000,pollMs=1000}={}) {
  const config=readCaptureConfig();if(!config||config.disabled)return;
  ensureDirectories();
  let observedNotices:string[]=[];
  try {
    await withSessionLock('capture:worker',async()=>{
      removeLegacyService();
      const seen=new Map<string,string>();let activeAt=Date.now(),failures=0;
      while(readCaptureConfig() && !readCaptureConfig()!.disabled) {
        let captureError:any;
        try {
          if(config.authPending)await refreshCaptureIdentity(config);
          const processed=await drainCaptureNotices(config);
          const changed=await reconcileSources(config,seen);
          if(processed||changed)activeAt=Date.now();
        }catch(error){captureError=error;}
        try {
          if(queuedNames().length){const result=await flushCaptures({wait:false});if(result.uploaded)activeAt=Date.now();}
        }catch(error){captureError??=error;}
        if(captureError){recordError(captureError);failures++;}
        else {
          failures=0;
          observedNotices=noticeNames();
          if(!observedNotices.length&&!queuedNames().length&&Date.now()-activeAt>=idleMs)break;
        }
        // Retry while there is durable work, with bounded resource use. A later
        // invocation also recovers it if the host kills this process.
        await sleep(failures?Math.min(60_000,1000*2**Math.min(failures,6)):pollMs);
      }
    },0);
  } catch(error:any) {if(error?.code!=='SESSION_BUSY')throw error;return;}
  // Release-before-recheck closes the idle-exit lost-wakeup race. Hooks arriving
  // before release are seen here; hooks arriving later can acquire the lock.
  if(!readCaptureConfig()?.disabled && (queuedNames().length || noticeNames().some(n=>!observedNotices.includes(n))))kick(config);
}

export function wakeCaptures() {
  const config=readCaptureConfig();if(config&&!config.disabled)kick(config);
}
/** Explicit flush waits for capture and upload ownership, then fences current sources. */
export async function flushCaptureWork() {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  if(!config.disabled){if(config.authPending)await refreshCaptureIdentity(config);await drainCaptureNotices(config);await reconcileSources(config,new Map());}
  return flushCaptures();
}

export async function syncCaptures() {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  if(config.disabled)return {uploaded:0};
  if(config.authPending)await refreshCaptureIdentity(config);
  const errors:any[]=[];
  for(const harness of config.harnesses??['claude-code','codex'] as Harness[]) {
    const dirs=harness==='codex'?['sessions','archived_sessions']:['projects'];
    for(const dir of dirs)for(const path of walk(join(config.roots[harness],dir))) {
      // Installation enrolls new/active sessions; it never silently imports all historical conversations.
      if(statSync(path).mtimeMs<Date.parse(config.installedAt))continue;
      try{await captureTranscript(config,harness,path);}catch(e){errors.push(e);}
    }
  }
  const result=await flushCaptures();
  if(errors.length){recordError(errors[0]);throw errors[0];}
  return result;
}
export async function flushCaptures({wait=true}={}) {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  ensureDirectories();
  return withSessionLock('capture:flush',async()=>{
    const principal=await refreshCaptureIdentity(config);
    let uploaded=0;
    for(const name of readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json'))) {
      if(!wait&&readCaptureConfig()?.disabled)break;
      const path=join(captureDir(),'queue',name),batch=read(path);
      // Current authentication selects the team. Keep the recorded human; the
      // server validates authorship and membership on every upload.
      batch.owner={...batch.owner,tenantId:principal.tenantId};
      for(const a of batch.attachments)if(a.status==='captured'){
        await request(config.api,'/api/sessions/attachments/'+a.sha256,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:readFileSync(join(captureDir(),'blobs',a.sha256))});
      }
      const receipt=await request(config.api,'/api/sessions/batches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(batch)});
      if(receipt.batchId!==hash(JSON.stringify(batch)) || receipt.stored!==true)throw new CliError('CAPTURE_RECEIPT_INVALID','Server did not confirm durable capture');
      atomicJson(join(captureDir(),'last-upload.json'),{at:new Date().toISOString(),...receipt,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId});
      unlinkSync(path);uploaded++;
    }
    const referenced=new Set<string>();
    for(const name of readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json'))) {
      for(const a of read(join(captureDir(),'queue',name),{attachments:[]}).attachments)if(a.sha256)referenced.add(a.sha256);
    }
    // A grace period protects in-progress hooks between writing a blob and publishing their batch.
    for(const name of readdirSync(join(captureDir(),'blobs'))) {
      const path=join(captureDir(),'blobs',name);
      if(!referenced.has(name)&&Date.now()-statSync(path).mtimeMs>86400000)unlinkSync(path);
    }
    try{unlinkSync(join(captureDir(),'last-error.json'));}catch{}
    return {uploaded};
  },wait?Infinity:0).catch(error=>{if(!wait&&error?.code==='SESSION_BUSY')return {uploaded:0};throw error;});
}
export function captureStatus() {
  const config=readCaptureConfig();
  return {installed:Boolean(config&&!config.disabled),api:config?.api,owner:config?.authPending?null:config?.owner,authenticationPending:Boolean(config?.authPending),installationId:config?.installationId,
    queued:existsSync(join(captureDir(),'queue'))?readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json')).length:0,
    pendingHooks:existsSync(join(captureDir(),'notices'))?noticeNames().length:0,
    lastUpload:read(join(captureDir(),'last-upload.json')),lastError:read(join(captureDir(),'last-error.json'))};
}
