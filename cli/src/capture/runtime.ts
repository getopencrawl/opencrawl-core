import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync, openSync, readSync, closeSync, unlinkSync, createReadStream, createWriteStream} from 'node:fs';
import {createZstdDecompress,gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {join, dirname, resolve, sep, basename} from 'node:path';
import {homedir, hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setImmediate as yieldToOwner} from 'node:timers/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {createInterface} from 'node:readline';
import {configDir, atomicFile, atomicJson, accessToken, readSession, withSessionLock, syncDirectory} from '../session.ts';
import {CliError} from '../oauth.ts';
import {retryWindowsSharing} from '../filesystem.ts';
import {environmentToken} from '../environment-token.ts';
import {parseRecord, detectOrigin, finalizeEventIdentity, hash, readsTranscript, type Harness, type TranscriptHarness} from './parse.ts';
import {grokBotEvents, grokBotSession, grokBotTitleEvent, grokBotUnsupported, GROK_BOT_BOUNDARIES, GROK_BOT_MAX_HOOK_BYTES} from './grok-bot.ts';
import {isClaudeDesktopTranscript,desktopNativeMessageIds} from './desktop-history.ts';
import {captureExcluded, type CaptureExclusions} from './policy.ts';
import {codexTitle, codexTitleSignature} from './titles.ts';
import {redactValue,redactAttachment,MAX_REDACTION_DEPTH} from './redact.ts';

const compressBatch=promisify(gzip);
export const captureDir = () => join(configDir(),'capture');
const read = (p:string, fallback:any=null) => {try{return JSON.parse(readFileSync(p,'utf8'));}catch(e:any){if(e.code==='ENOENT')return fallback;throw e;}};
/** Bump when installed hook entries change so the next hook rewrites existing installs. */
export const HOOK_MODE='managed-v3';
export type CaptureConfig = {disabled?:boolean,authPending?:boolean,exclusions?:CaptureExclusions,schemaVersion:1,hookMode?:typeof HOOK_MODE|'managed-v2'|'managed',harnesses?:Harness[],api:string,installationId:string,owner:{tenantId:string,userId:string,name?:string,email?:string},installedAt:string,roots:Record<TranscriptHarness,string>&{'grok-bot'?:string},claudeDesktopSessionsRoot?:string,command:string[]};
export const readCaptureConfig = ():CaptureConfig|null => read(join(captureDir(),'config.json'));
/** Installations made before a harness existed have no directory for it. */
export function harnessRoot(config:CaptureConfig,harness:Harness) {
  const root=config.roots[harness];
  if(!root)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install --harness '+harness);
  return root;
}
// Enrollment and every queued payload remain bound to their original destination.
async function captureIdentity(config:CaptureConfig,token?:string,signal?:AbortSignal) {
  const {principal,capabilities}=await request(config.api,'/api/sessions/identity',{signal},token);
  signal?.throwIfAborted();
  if(!principal?.userId || !principal?.tenantId)throw new CliError('CAPTURE_IDENTITY_MISSING','Deployment does not supply capture identity');
  // Authentication may finish after uninstall or another worker initializes a
  // prepared cloud image. Serialize the identity update with reconfiguration.
  await withSessionLock('capture:configuration',async()=>{
    const current=readCaptureConfig();
    const pending=config.authPending && config.installationId==='pending';
    if(!current || current.api!==config.api || (!pending && current.installationId!==config.installationId))throw new CliError('CAPTURE_CONFIG_CHANGED','Capture configuration changed during authentication. Retry with the current configuration.');
    if(!current.authPending && (current.owner.userId!==principal.userId || current.owner.tenantId!==principal.tenantId))throw new CliError('CAPTURE_DESTINATION_CHANGED','Capture is enrolled to another account or team. Sign back into that destination; queued data has not moved. To change destination, uninstall and resolve or explicitly purge pending data before reinstalling.');
    config.owner=principal;
    if(config.authPending){
      config.installationId=current.installationId==='pending'?randomUUID():current.installationId;
      config.authPending=false;
    }
    atomicJson(join(captureDir(),'config.json'),{...current,owner:principal,installationId:config.installationId,...(current.authPending?{authPending:false}:{})});
  },20_000,signal);
  return {principal,gzip:Array.isArray(capabilities?.batchEncodings)&&capabilities.batchEncodings.includes('gzip')};
}
export async function refreshCaptureIdentity(config:CaptureConfig,token?:string,signal?:AbortSignal) {
  return (await captureIdentity(config,token,signal)).principal;
}
function staticCaptureToken(api:string) {
  const saved=read(join(captureDir(),'receiver-token.json'));
  return environmentToken('OPENCRAWL_SESSIONS_TOKEN',api) || (saved?.api===api?saved.token:null);
}
export async function request(api:string,path:string,init:RequestInit={},tokenOverride?:string,renew?:(rejected:string)=>Promise<string>) {
  const staticToken=tokenOverride || staticCaptureToken(api);
  const signal=init.signal??undefined;
  signal?.throwIfAborted();
  let token=staticToken || await accessToken(api,undefined,fetch,signal);
  const method=init.method??'GET';
  // Only retry operations whose payloads are read-only or content-addressed.
  // A lost response after storage must resend the same batch/blob, not lose it.
  const retryable=method==='GET'||method==='POST'&&['/api/sessions/batches','/api/sessions/memories'].includes(path)||method==='PUT'&&/^\/api\/sessions\/attachments\/[a-f0-9]{64}$/.test(path);
  const send=async()=>{
    for(let attempt=0;;attempt++){
      let response:Response;
      signal?.throwIfAborted();
      try {response=await fetch(api+path,{...init,headers:{...init.headers,authorization:'Bearer '+token},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),redirect:'error'});}
      catch(error){if(signal?.aborted||!retryable||attempt===4)throw error;await pause(250*2**attempt,undefined,{signal});continue;}
      if(!retryable||attempt===4||![429,502,503,504].includes(response.status))return response;
      const retryAfter=response.headers.get('retry-after');
      const seconds=retryAfter===null?NaN:Number(retryAfter);
      const delay=Number.isFinite(seconds)?seconds*1000:retryAfter?Date.parse(retryAfter)-Date.now():0;
      await response.body?.cancel();
      await pause(Math.min(30000,Math.max(250*2**attempt,Number.isFinite(delay)?delay:0)),undefined,{signal});
    }
  };
  let res=await send();
  if(res.status===401 && (renew || !staticToken)){token=renew?await renew(token):await accessToken(api,token,fetch,signal);res=await send();}
  const body=await res.json().catch(()=>{throw res.status>=500||res.status===429
    ?new CliError('CAPTURE_RETRY_EXHAUSTED',`Capture endpoint ${new URL(api).hostname} is temporarily unavailable (HTTP ${res.status}). Queued data is retained; retry the approved import.`)
    :new CliError('CAPTURE_NETWORK_BLOCKED',`Capture endpoint ${new URL(api).hostname} returned HTTP ${res.status} without JSON. Check this host in your cloud environment network allowlist.`);});
  if(!res.ok)throw Object.assign(new CliError('CAPTURE_UPLOAD_FAILED',`Capture request failed (${res.status}): ${body.error?.code ?? 'unknown'}`),{httpStatus:res.status});
  return body.data;
}
export function commandForSelf() {
  if(process.env.OPENCRAWL_LAUNCHER && process.env.OPENCRAWL_NODE) return [process.env.OPENCRAWL_NODE,process.env.OPENCRAWL_LAUNCHER];
  return /\.[cm]?[jt]s$/.test(process.argv[1]??'') ? [process.execPath,resolve(process.argv[1])] : [process.execPath];
}
export function recordError(error:any) {
  // Status only: never include transcript content, credentials, or a provider response.
  atomicJson(join(captureDir(),'last-error.json'),{at:new Date().toISOString(),code:error?.code || 'CAPTURE_FAILED'});
}
function ensureDirectories() {for(const dir of ['queue','state','blobs','notices','sources'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});}
const under = (file:string,dir:string) => file.startsWith(dir+sep);
function transcriptAllowed(file:string, config:CaptureConfig, harness:TranscriptHarness, approvedHistory=false) {
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
function findTranscript(config:CaptureConfig,harness:TranscriptHarness,sessionId:string):string|undefined {
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
    const safe=redactAttachment(bytes);
    if(safe===null){
      const a={status:'missing',path:path??null,mimeType:mime??null,redactionReason:'secret_in_binary'};attachments.push(a);
      return {type:'opencrawl_attachment',...a};
    }
    bytes=safe;
    if(bytes.length>32*1024*1024){const a={status:'too_large',path:path??null,mimeType:mime??null};attachments.push(a);return {type:'opencrawl_attachment',...a};}
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
  const current=readCaptureConfig();
  if(current && (current.api!==config.api || current.installationId!==config.installationId || current.owner.tenantId!==config.owner.tenantId || current.owner.userId!==config.owner.userId))throw new CliError('CAPTURE_CONFIG_CHANGED','Capture enrollment changed; retry with its current configuration.');
  if(captureExcluded(current??config,meta))return;
  if(config.authPending)throw new CliError('CAPTURE_AUTH_PENDING','Capture identity has not been authenticated yet');
  if(!meta.sessionId)throw new CliError('CAPTURE_SESSION_UNKNOWN','Transcript has no session identity');
  const batch=redactValue({schemaVersion:1,owner:config.owner,installationId:config.installationId,host:hostname(),...meta,events,attachments});
  // Keep the original local scope for exclusions added after enqueue. Masking a
  // credential-shaped directory name must not make an excluded project appear
  // to be another path. The egress boundary always scrubs these fields.
  if(meta.cwd!==undefined)batch.cwd=meta.cwd;
  batch.sessionId=meta.sessionId;
  batch.events=batch.events.map(finalizeEventIdentity);
  const serialized=JSON.stringify(batch),size=Buffer.byteLength(serialized);
  if(size>16*1024*1024)throw new CliError('CAPTURE_BATCH_TOO_LARGE','A capture record exceeds the upload limit; retained locally for retry');
  atomicFile(join(captureDir(),'queue',hash(serialized)+'.json'),serialized+'\n');
}

/** Every upload (including queues from older CLIs) crosses this local boundary.
 * Never trust a queue's masking/version flag. Read and scrub all blobs before
 * sending any of them. Do not rewrite original queues: exclusions still need
 * their original local paths and retries deterministically derive the same wire
 * bytes. A changed event gets a new identity to avoid immutable-ID conflicts.
 */
function prepareCaptureUpload(original:any) {
  const replacements=new Map<string,any>();
  for(const attachment of original.attachments)if(attachment.status==='captured') {
    const raw=readCaptureAttachment(attachment.sha256);
    const bytes=redactAttachment(raw);
    if(bytes===null)replacements.set(attachment.sha256,{sha256:undefined,size:undefined,status:'missing',redactionReason:'secret_in_binary'});
    else if(bytes.length>32*1024*1024)replacements.set(attachment.sha256,{sha256:undefined,size:undefined,status:'too_large'});
    else {
      const sha256=hash(bytes);
      if(sha256!==attachment.sha256){
        // Reuse the content-addressed spool instead of holding every attachment
        // in memory. Normal orphan cleanup handles a crash before acknowledgement.
        atomicFile(join(captureDir(),'blobs',sha256),bytes);
        replacements.set(attachment.sha256,{sha256,size:bytes.length});
      }
    }
  }
  function replace(value:any,depth=0):any {
    if(depth>MAX_REDACTION_DEPTH)throw new CliError('CAPTURE_REDACTION_TOO_DEEP','Capture content exceeds the supported masking depth; retained locally');
    if(Array.isArray(value))return value.map(item=>replace(item,depth+1));
    if(!value || typeof value!=='object')return value;
    const result=Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,replace(entry,depth+1)]));
    if(value.status==='captured' && replacements.has(value.sha256))Object.assign(result,replacements.get(value.sha256));
    return result;
  }
  // Redaction already clones and depth-checks the entire value. Only walk a
  // second time when an attachment digest or status actually changed.
  const batch=redactValue(replacements.size?replace(original):original);
  batch.events=batch.events.map((event:any,index:number)=>JSON.stringify(event)===JSON.stringify(original.events[index])?event:finalizeEventIdentity(event));
  return batch;
}
function readCaptureAttachment(sha256:string) {
  if(!/^[a-f0-9]{64}$/.test(sha256))throw new CliError('CAPTURE_ATTACHMENT_INVALID','Invalid queued attachment digest');
  const bytes=readFileSync(join(captureDir(),'blobs',sha256));
  if(hash(bytes)!==sha256)throw new CliError('CAPTURE_ATTACHMENT_INVALID','Queued attachment does not match its digest');
  return bytes;
}
/** The cursor advances only after its records and attachment bytes are durably spooled. */
export async function captureTranscript(config:CaptureConfig,harness:TranscriptHarness,file:string,hook:any={},reconcileHistory=false) {
  return withSessionLock('capture:spool',async()=>{
  if(readCaptureConfig()?.disabled)throw new CliError('CAPTURE_DISABLED','Capture is uninstalled. Reinstall before importing transcripts.');
  ensureDirectories();
  const path=transcriptAllowed(file,config,harness,reconcileHistory);
  const desktopAudit=harness==='claude-code'&&basename(path)==='audit.jsonl'&&isClaudeDesktopTranscript(path,config);
  const stateFile=join(captureDir(),'state',hash(harness+path)+'.json');
  return withSessionLock('capture:'+stateFile,async()=>{
    const source=statSync(path),old=read(stateFile,{offset:0});
    const compressed=path.endsWith('.jsonl.zst');
    let readPath=path;
    if(compressed) {
      if(old.archiveSize===source.size && old.archiveMtime===source.mtimeMs && old.ino===source.ino && (!reconcileHistory || old.parserVersion===2)) {
        captureCodexTitle(config, old.meta);
        atomicJson(stateFile, old);
        return old.meta;
      }
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
    let meta:any=(offset>0?old.meta:null)??{harness,sessionId:hook.session_id,origin:'unknown',originEvidence:null,parentSessionId:null,sourcePath:path};
    let codexIdentityRead=Boolean(offset>0&&old.meta?.sessionId);
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
      // Apply metadata in record order. Looking ahead at a later working
      // directory could incorrectly allow earlier records from an excluded project.
      while(offset<st.size) {
        await yieldToOwner();
        // Ordinary reads stay small even for multi-gigabyte histories. Grow only
        // when one native record spans the buffer; retain the existing line cap.
        const remaining=st.size-offset,maxRead=Math.min(remaining,48*1024*1024);
        let bytes=Buffer.alloc(Math.min(maxRead,8*1024*1024));readSync(fd,bytes,0,bytes.length,offset);
        let end=bytes.lastIndexOf(10);
        while(end<0&&bytes.length<maxRead){
          bytes=Buffer.alloc(Math.min(maxRead,bytes.length*2));readSync(fd,bytes,0,bytes.length,offset);
          end=bytes.lastIndexOf(10);
        }
        if(end<0) {
          if(bytes.length<st.size-offset)throw new CliError('CAPTURE_LINE_TOO_LARGE','Transcript line exceeds capture chunk size');
          break; // writer has not completed this record yet
        }
        bytes=bytes.subarray(0,end+1);
        const events:any[]=[],attachments:any[]=[];
        let position=offset,linesSinceYield=0,eventBytes=0;
        for(const line of bytes.toString('utf8').split('\n').slice(0,-1)){
          if(line.trim()){
            let record;try{record=JSON.parse(line);}catch{throw new CliError('CAPTURE_INVALID_RECORD','Invalid transcript record; cursor retained');}
            const auditMessage=!desktopAudit||['user','assistant'].includes(record.type)&&!nativeIds.has(record.uuid);
            if(desktopAudit&&auditMessage&&(!record.session_id||typeof record.session_id!=='string'))throw new CliError('CAPTURE_SESSION_UNKNOWN','Desktop audit message has no session identity');
            const priorMeta={...meta};
            if(!desktopAudit||auditMessage)metadata(record);
            if(priorMeta.sessionId && (meta.sessionId!==priorMeta.sessionId || meta.cwd!==priorMeta.cwd)){enqueue(config,{...priorMeta,captureMode:reconcileHistory?'history':'live'},events.splice(0),attachments.splice(0));eventBytes=0;}
            const parsed=auditMessage?parseRecord(harness,record,position):null;
            if(parsed?.kind==='session_title') {
              if(parsed.data.titleType==='custom')meta.customTitle=parsed.data.title;
              // A later automatic suggestion must not overwrite a manual rename.
              if(meta.customTitle)parsed.data={title:meta.customTitle,titleType:'custom'};
            }
            if(parsed&&desktopAudit){parsed.timestamp=record._audit_timestamp??record.timestamp??null;parsed.parentId=record.parent_tool_use_id??null;}
            if(parsed && !captureExcluded(readCaptureConfig()??config,meta)) {
              if(parsed.kind==='session_title')meta.capturedTitle=parsed.data.title;
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
              const eventAttachments:any[]=[],event=attachmentTransform(parsed,eventAttachments,meta.cwd??dirname(path),localFiles);
              const size=Buffer.byteLength(JSON.stringify(event))+Buffer.byteLength(JSON.stringify(eventAttachments));
              if(events.length&&(eventBytes+size>4*1024*1024||attachments.length+eventAttachments.length>1000)){
                enqueue(config,{...meta,captureMode:reconcileHistory?'history':'live'},events.splice(0),attachments.splice(0));eventBytes=0;
              }
              events.push(event);attachments.push(...eventAttachments);eventBytes+=size;
            }
          }
          position+=Buffer.byteLength(line)+1;
          if(++linesSinceYield===200){linesSinceYield=0;await yieldToOwner();}
          if(events.length>=(reconcileHistory?1000:200)){enqueue(config,{...meta,captureMode:reconcileHistory?'history':'live'},events.splice(0),attachments.splice(0));eventBytes=0;}
        }
        enqueue(config,{...meta,captureMode:reconcileHistory?'history':'live'},events,attachments);
        offset+=bytes.length;atomicJson(stateFile,{offset,ino:source.ino,parserVersion,meta,...(compressed&&offset===st.size?{archiveSize:source.size,archiveMtime:source.mtimeMs}:{})});
      }
    } finally{closeSync(fd);if(compressed)try{unlinkSync(readPath);}catch{}}
    if(harness==='codex' && captureCodexTitle(config,meta))atomicJson(stateFile,{...read(stateFile,old),meta});
    return meta;
  });
  },Infinity);
}

function captureCodexTitle(config:CaptureConfig,meta:any) {
  if(!meta?.sessionId || meta.harness!=='codex' || captureExcluded(readCaptureConfig()??config,meta))return false;
  const native=codexTitle(config.roots.codex,meta.sessionId);
  if(!native || meta.capturedTitle===native.title)return false;
  enqueue(config,{...meta,captureMode:'history'},[{id:hash('codex-title:'+meta.sessionId+':'+native.timestamp+':'+native.title),kind:'session_title',sequence:0,timestamp:native.timestamp,data:{title:native.title}}],[]);
  meta.capturedTitle=native.title;
  return true;
}

/** Repair names for already captured sessions without replaying conversation
 * records or enrolling any new session. Uses the existing destination/policy. */
export async function refreshCapturedTitles() {
  const config=readCaptureConfig();
  if(!config||config.disabled)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  ensureDirectories();
  await refreshCaptureIdentity(config);
  let updated=0;
  await withSessionLock('capture:spool',async()=>{
    for(const name of readdirSync(join(captureDir(),'state')).filter(n=>n.endsWith('.json'))) {
      await yieldToOwner();
      const stateFile=join(captureDir(),'state',name);
      await withSessionLock('capture:'+stateFile,async()=>{
        const state=read(stateFile),meta=state?.meta;
        if(!meta?.sessionId || !meta.sourcePath || !state.offset || !['codex','claude-code'].includes(meta.harness) || captureExcluded(readCaptureConfig()??config,meta))return;
        if(meta.harness==='codex') {
          if(captureCodexTitle(config,meta)){atomicJson(stateFile,{...state,meta});updated++;}
          return;
        }
        // Only inspect previously captured bytes of a native transcript. Ignore
        // message/tool bodies and title-shaped strings nested inside them.
        let path:string;try{path=transcriptAllowed(meta.sourcePath,config,'claude-code');}catch{return;}
        const st=statSync(path);
        if(state.ino!==st.ino || st.size<state.offset)return;
        let title:string|undefined,custom:string|undefined;
        const stream=createReadStream(path,{end:state.offset-1}),lines=createInterface({input:stream,crlfDelay:Infinity});
        try {
          for await(const line of lines) {
            if(!/"type"\s*:\s*"(?:custom-title|ai-title)"/.test(line))continue;
            let record:any;try{record=JSON.parse(line);}catch{continue;}
            if(record.sessionId!==meta.sessionId)continue;
            const parsed=parseRecord('claude-code',record,0);
            if(parsed?.kind==='session_title'){
              if(parsed.data.titleType==='custom')custom=parsed.data.title;
              title=custom??parsed.data.title;
            }
          }
        } finally {lines.close();stream.destroy();}
        if(!title||title===meta.capturedTitle)return;
        enqueue(config,{...meta,captureMode:'history'},[{id:hash('claude-title:'+meta.sessionId+':'+st.mtimeMs+':'+title),kind:'session_title',sequence:0,timestamp:st.mtime.toISOString(),data:{title,titleType:custom?'custom':'auto'}}],[]);
        meta.capturedTitle=title;if(custom)meta.customTitle=custom;
        atomicJson(stateFile,{...state,meta});updated++;
      },Infinity);
    }
  },Infinity);
  return {updated,...await flushCaptures()};
}
/** Hook work is only a durable local handoff. Never scan, parse or upload here. */
export async function captureHook(harness:Harness,event:any) {
  return withSessionLock('capture:configuration',async()=>{
  const config=readCaptureConfig();if(!config||config.disabled)return;
  ensureDirectories();
  const id=randomUUID(),at=new Date().toISOString();
  if(harness==='grok-bot') {
    if(!event||typeof event!=='object'||Array.isArray(event))throw new CliError('CAPTURE_EVENT_INVALID','Hook payload is not an object');
    // Prepared with --defer-auth and nobody has signed in: a computer whose
    // owner never opts in must not accumulate what their Bots do.
    if(config.authPending)return;
    const session=grokBotSession(event,at);
    if(captureExcluded(config,{sessionId:session.sessionId,cwd:session.cwd??undefined}))return;
    // Hook payloads carry no time or order. Microseconds since the epoch keep
    // events from separate hook processes in the order they were recorded.
    const sequence=Math.round((performance.timeOrigin+performance.now())*1000);
    const bytes=Buffer.byteLength(JSON.stringify(event));
    atomicJson(join(captureDir(),'notices',id+'.json'),{id,at,sequence,harness,event:bytes>GROK_BOT_MAX_HOOK_BYTES?grokBotUnsupported(event,'too_large',bytes):event});
    return;
  }
  const sessionId=event?.session_id;
  if(typeof sessionId!=='string' || !/^[\w.:-]{1,200}$/.test(sessionId))throw new CliError('CAPTURE_SESSION_UNKNOWN','Hook missing session ID');
  if(captureExcluded(config,{sessionId,cwd:event.cwd}))return;
  atomicJson(join(captureDir(),'notices',id+'.json'),{id,at,harness,event});
  // A Bot is waiting on a Grok Bot hook: give up on a held lock rather than queue behind it.
  },harness==='grok-bot'?2000:Infinity);
}

// The original event is kept only until its immutable batch is spooled. Its ID
// and timestamp survive a crash between enqueue and notice removal.
export async function drainCaptureNotices(config=readCaptureConfig()!,{until=Infinity}:{until?:number}={}) {
  ensureDirectories();
  return withSessionLock('capture:notices',async()=>{
  let processed=0,firstError:any;
  // Grok Bot notices are the conversation itself, not pointers to a transcript.
  // They are spooled in bounded rounds: a backlog never has to fit in memory,
  // and a hook can stop between rounds with its progress kept.
  type GrokBotNotice={path:string,notice:any};
  let round:GrokBotNotice[]=[],roundBytes=0;
  const spoolRound=async()=>{
    const groups=new Map<string,{meta:any,title:any,notices:GrokBotNotice[]}>();
    for(const item of round) {
      const session=grokBotSession(item.notice.event,item.notice.at),key=JSON.stringify([session.sessionId,session.cwd]);
      const group=groups.get(key)??{meta:{harness:'grok-bot',sessionId:session.sessionId,origin:'cloud',
        originEvidence:session.identified?'Grok Bot cloud computer hook':'Grok Bot hook without a conversation ID; grouped by workspace and UTC day',
        parentSessionId:null,...(session.conversationId?{conversationId:session.conversationId}:{}),...(session.cwd?{cwd:session.cwd}:{}),...(session.version?{harnessVersion:session.version}:{}),captureMode:'live'},
        title:session.title?grokBotTitleEvent(session.sessionId,session.title,session.day):null,notices:[]};
      group.notices.push(item);groups.set(key,group);
    }
    round=[];roundBytes=0;
    for(const group of groups.values()) {
      group.notices.sort((a,b)=>(a.notice.sequence??0)-(b.notice.sequence??0));
      // Batches stay small enough to upload within one hook pass, so a pass
      // that is cut off still delivered the batches before it.
      type Chunk={events:any[],attachments:any[],paths:string[]};
      const chunks:Chunk[]=[];let chunk:Chunk={events:[],attachments:[],paths:[]},bytes=0;
      for(const {path,notice} of group.notices) {
        let extracted:any[]=[],next:any[],size=0;
        try {
          next=grokBotEvents(notice).map(event=>attachmentTransform(event,extracted,group.meta.cwd??homedir()));
          // Reject here what the receiver or the batch format never accepts.
          next.forEach(finalizeEventIdentity);size=Buffer.byteLength(JSON.stringify(next));
          if(extracted.length>500||size>12*1024*1024)throw new CliError('CAPTURE_EVENT_INVALID','Hook payload exceeds what one batch can carry');
        } catch(error:any) {
          // A filesystem or other passing failure: leave the notice for a later pass.
          if(!['CAPTURE_EVENT_TOO_DEEP','CAPTURE_EVENT_INVALID'].includes(error?.code)){firstError??=error;continue;}
          extracted=[];next=grokBotEvents({...notice,event:grokBotUnsupported(notice.event,'unsupported',statSync(path).size)});
          size=Buffer.byteLength(JSON.stringify(next));
        }
        if(chunk.paths.length&&(chunk.paths.length>=100||bytes+size>1024*1024||chunk.attachments.length+extracted.length>8)){chunks.push(chunk);chunk={events:[],attachments:[],paths:[]};bytes=0;}
        chunk.events.push(...next);chunk.attachments.push(...extracted);chunk.paths.push(path);bytes+=size;
      }
      if(chunk.paths.length)chunks.push(chunk);
      for(const {events,attachments,paths} of chunks) {
        await yieldToOwner();
        try {
          // A notice is retired only after its batch is durably spooled.
          enqueue(config,group.meta,group.title?[group.title,...events]:events,attachments);
          for(const path of paths){unlinkSync(path);processed++;}
          syncDirectory(join(captureDir(),'notices'));
        }catch(error){firstError??=error;}
      }
    }
  };
  for(const name of readdirSync(join(captureDir(),'notices')).filter(n=>n.endsWith('.json'))) {
    await yieldToOwner();
    if(Date.now()>=until)break;
    const path=join(captureDir(),'notices',name),notice=read(path);
    if(!notice)continue;
    if(notice.harness==='grok-bot') {
      round.push({path,notice});roundBytes+=statSync(path).size;
      if(round.length>=200||roundBytes>=16*1024*1024)await spoolRound();
      continue;
    }
    try {
    const {harness,event,id,at}=notice;
    const file=event.transcript_path || findTranscript(config,harness,event.session_id);
    // Persist the source BEFORE retiring the notice; a tail written after Stop
    // remains discoverable on this worker's polls and the next CLI invocation.
    const source={harness,sessionId:event.session_id,path:file??null,cwd:typeof event.cwd==='string'?event.cwd:undefined,origin:process.env.CLAUDE_CODE_REMOTE==='true'?'cloud':'unknown'};
    atomicJson(join(captureDir(),'sources',hash(harness+':'+event.session_id+':'+(file??''))+'.json'),source);
    const meta=file && existsSync(file) ? await captureTranscript(config,harness,file,event) :
      {harness,sessionId:event.session_id,origin:source.origin,originEvidence:null,parentSessionId:null};
    if(harness==='claude-code'&&typeof event.agent_transcript_path==='string'&&event.agent_transcript_path!==file){
      const child=event.agent_transcript_path;
      atomicJson(join(captureDir(),'sources',hash(harness+':'+event.session_id+':'+child)+'.json'),{...source,path:child});
      if(existsSync(child))await captureTranscript(config,harness,child,event);
    }
    if(!captureExcluded(readCaptureConfig()??config,{...meta,cwd:meta?.cwd??event.cwd})) {
      const attachments:any[]=[];
      const data=attachmentTransform(event,attachments,event.cwd??homedir());
      enqueue(config,{...meta,cwd:meta?.cwd??event.cwd},[{id,kind:'hook',timestamp:at,data}],attachments);
    }
    unlinkSync(path);syncDirectory(dirname(path));processed++;
    }catch(error){firstError??=error;}
  }
  await spoolRound();
  if(firstError)throw firstError;
  return processed;
  },Infinity);
}

async function reconcileSources(config:CaptureConfig,seen:Map<string,string>) {
  let changed=false;
  for(const name of readdirSync(join(captureDir(),'sources')).filter(n=>n.endsWith('.json'))) {
    await yieldToOwner();
    const sourceFile=join(captureDir(),'sources',name),source=read(sourceFile);
    const path=source.path || findTranscript(config,source.harness,source.sessionId);
    if(!path || !existsSync(path))continue;
    if(!source.path){source.path=path;atomicJson(sourceFile,source);}
    const st=statSync(path),signature=JSON.stringify([st.dev,st.ino,st.size,st.mtimeMs,source.harness==='codex'?codexTitleSignature(config.roots.codex):'']);
    if(seen.get(path)===signature)continue;
    await captureTranscript(config,source.harness,path,{session_id:source.sessionId});
    seen.set(path,signature);changed=true;
  }
  return changed;
}

const queuedNames=()=>readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json'));
const noticeNames=()=>readdirSync(join(captureDir(),'notices')).filter(n=>n.endsWith('.json'));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
/** Bound the CLI process, including blocked locks, HTTP retries and large queues.
 * Durable notices/batches are the recovery boundary: an interrupted request keeps
 * its original queued bytes until a later invocation verifies the receipt.
 * This watchdog runs in the owned process; it never launches a supervisor.
 */
export async function ownedCaptureWorker({maxMs=90_000,parentPollMs=1000}={}) {
  const owner=process.ppid;
  const ownerGone=()=>{
    // A harness may itself be PID 1 inside a container.
    if(owner<=0 || process.ppid!==owner)return true;
    try{process.kill(owner,0);return false;}
    catch(error:any){return error?.code==='ESRCH';}
  };
  if(ownerGone())return;
  // An outer-loop deadline cannot interrupt an infinite lock wait or an upload.
  // Exit cleanup releases locks; the kernel also releases them after a crash.
  const deadline=setTimeout(()=>process.exit(0),maxMs);
  const parentCheck=setInterval(()=>{if(ownerGone())process.exit(0);},parentPollMs);
  try{await captureWorker();}
  finally{clearTimeout(deadline);clearInterval(parentCheck);}
}

/** One lazy worker per installation; contention is an ordinary successful wake. */
export async function captureWorker({idleMs=30_000,pollMs=1000}={}) {
  const config=readCaptureConfig();if(!config||config.disabled)return;
  ensureDirectories();
  let observedNotices:string[]=[];
  for(;;) {
  try {
    await withSessionLock('capture:worker',async()=>{
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
  if(!readCaptureConfig() || readCaptureConfig()!.disabled || (!queuedNames().length && !noticeNames().some(n=>!observedNotices.includes(n))))return;
  // Reacquire in this same owned process; never spawn a replacement.
  }
}
/** Explicit flush waits for capture and upload ownership, then fences current sources. */
export async function flushCaptureWork() {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  if(!config.disabled){if(config.authPending)await refreshCaptureIdentity(config);await drainCaptureNotices(config);await reconcileSources(config,new Map());}
  return flushCaptures();
}

/** Cursor-format hooks block the agent while they run, so they cannot host the
 * 90-second uploader. A turn boundary, or 20 seconds since the last pass, earns
 * one pass in the hook's own process, which the hook command cuts off at its
 * deadline. A failed or cut-off pass backs off: one minute, doubling to fifteen.
 * Unsent notices and batches stay queued for the next pass. */
async function hookPass(event:any,now:()=>number,work:(config:CaptureConfig)=>Promise<void>) {
  const config=readCaptureConfig();if(!config||config.disabled)return;
  ensureDirectories();
  const marker=join(captureDir(),'hook-flush.json'),last=read(marker),failures=last?.ok===false?last.failures??1:0;
  const gap=failures?Math.min(60_000*2**(failures-1),900_000):GROK_BOT_BOUNDARIES.includes(event?.hook_event_name)?0:20_000;
  if(last?.at&&now()-Date.parse(last.at)<gap)return;
  try {
    await withSessionLock('capture:worker',async()=>{
      // Marked failed first, so a pass that is cut off also backs off.
      atomicJson(marker,{at:new Date(now()).toISOString(),ok:false,failures:failures+1});
      await work(config);
      atomicJson(marker,{at:new Date(now()).toISOString(),ok:true});
    },0);
  } catch(error:any) {
    if(error?.code!=='SESSION_BUSY')throw error;
    // Another uploader normally holds this lock for seconds. Notices that have
    // waited ten minutes mean nothing is draining them: say so in status.
    const stale=noticeNames().some(name=>{try{return now()-statSync(join(captureDir(),'notices',name)).mtimeMs>600_000;}catch{return false;}});
    if(stale)throw new CliError('CAPTURE_UPLOADER_BUSY','Another capture uploader has held its lock for over ten minutes. Run opencrawl collect flush.');
  }
}
/** With --defer-auth nothing is recorded until an identity is bound. Signing in
 * later starts capture on the next hook, without reinstalling. */
export async function bindHookIdentity(event:any,{now=Date.now}={}) {
  const config=readCaptureConfig();if(!config||config.disabled||!config.authPending)return;
  // Nobody has signed in on this computer. That is a local fact, not a failing
  // receiver: look again on every hook, quietly.
  if(!staticCaptureToken(config.api)&&!readSession(config.api))return;
  return hookPass(event,now,async pending=>{await refreshCaptureIdentity(pending);});
}
export const hookFlush=(event:any,{now=Date.now}={})=>readCaptureConfig()?.authPending?Promise.resolve():hookPass(event,now,async config=>{
  let failure:any;
  // Leave half the hook's five seconds for the uploads themselves.
  try{await drainCaptureNotices(config,{until:Date.now()+2500});}catch(error){failure=error;}
  try{if(queuedNames().length)await flushCaptures({wait:false});}catch(error){failure??=error;}
  if(failure)throw failure;
});

export async function syncCaptures() {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  if(config.disabled)return {uploaded:0};
  if(config.authPending)await refreshCaptureIdentity(config);
  const errors:any[]=[];
  for(const harness of (config.harnesses??['claude-code','codex'] as Harness[]).filter(readsTranscript)) {
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
export async function flushCaptures({wait=true,concurrency,batchDelayMs=0,onUploaded}: {wait?:boolean;concurrency?:number;batchDelayMs?:number;onUploaded?:()=>void}={}) {
  const workers=concurrency??(wait?1:4);
  if(!Number.isInteger(workers)||workers<1||workers>4)throw new CliError('INVALID_USAGE','Capture upload concurrency must be between 1 and 4.',64);
  if(!Number.isInteger(batchDelayMs)||batchDelayMs<0||batchDelayMs>60000)throw new CliError('INVALID_USAGE','Capture batch delay must be between 0 and 60000 milliseconds.',64);
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  ensureDirectories();
  return withSessionLock('capture:flush',async()=>{
    // A concurrent login must not switch the identity between the initial check
    // and blob writes. If this credential expires, retain the queue for a retry.
    const staticToken=staticCaptureToken(config.api);
    let token=staticToken||await accessToken(config.api);
    const identity=await captureIdentity(config,token),principal=identity.principal;
    let useGzip=identity.gzip;
    // A long flush outlives a short-lived sign-in token. Renew before each request
    // and after a rejection, re-verifying identity whenever the token changes.
    const adopt=async(next:string)=>{
      if(next===token)return token;
      const refreshed=await captureIdentity(config,next),current=refreshed.principal;
      useGzip=refreshed.gzip;
      if(current.userId!==principal.userId)throw new CliError('CAPTURE_OWNER_MISMATCH','Signed-in user changed during upload. Sign back in as the queued author; queued data is retained.');
      if(current.tenantId!==principal.tenantId)throw new CliError('CAPTURE_DESTINATION_CHANGED','Signed-in team changed during upload. Sign back into the original destination; queued data is retained.');
      return token=next;
    };
    const current=async()=>staticToken||await adopt(await accessToken(config.api));
    const renew=staticToken?undefined:async(rejected:string)=>adopt(await accessToken(config.api,rejected));
    let uploaded=0,excluded=0,visited=0,scheduled=0,stopped=false,failure:unknown,nextUploadAt=0;
    let names=readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json'));
    if(!wait){
      // Split capacity between draining old work and making fresh activity
      // visible. Filename hashes have no useful chronological ordering.
      const dated=names.map(name=>({name,mtime:statSync(join(captureDir(),'queue',name)).mtimeMs}));
      dated.sort((a,b)=>a.mtime-b.mtime||a.name.localeCompare(b.name));
      names=[];
      for(let lo=0,hi=dated.length-1;lo<=hi;){names.push(dated[lo++].name);if(lo<=hi)names.push(dated[hi--].name);}
    }
    const deadline=wait?Infinity:Date.now()+10_000;
    const upload=async(name:string,batch:any)=>{
      const path=join(captureDir(),'queue',name);
      batch=prepareCaptureUpload(batch);
      for(const a of batch.attachments)if(a.status==='captured'){
        await request(config.api,'/api/sessions/attachments/'+a.sha256+'?'+new URLSearchParams({harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId}),{method:'PUT',headers:{'content-type':'application/octet-stream'},body:readCaptureAttachment(a.sha256)},await current(),renew);
      }
      const serialized=JSON.stringify(batch),size=Buffer.byteLength(serialized);
      let body:string|Uint8Array<ArrayBuffer>=serialized,compressed=false;
      if(useGzip&&size>=32*1024){
        const bytes=await compressBatch(serialized,{level:1});
        if(bytes.length<size*0.95){body=new Uint8Array(bytes);compressed=true;}
      }
      const sendBatch=async()=>request(config.api,'/api/sessions/batches',{method:'POST',headers:{'content-type':'application/json',...(compressed?{'content-encoding':'gzip'}:{})},body},await current(),renew);
      let receipt;
      try{receipt=await sendBatch();}
      catch(error){
        // A rolling deployment can route the upload to an older replica. Retry
        // the identical JSON once; receipts always identify uncompressed bytes.
        if(!compressed||!(error instanceof CliError)||![400,415].includes(error.httpStatus??0))throw error;
        useGzip=false;compressed=false;body=serialized;receipt=await sendBatch();
      }
      if(receipt.batchId!==hash(serialized) || receipt.stored!==true)throw new CliError('CAPTURE_RECEIPT_INVALID','Server did not confirm durable capture');
      atomicJson(join(captureDir(),'last-upload.json'),{at:new Date().toISOString(),...receipt,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId});
      retryWindowsSharing(()=>unlinkSync(path));uploaded++;onUploaded?.();
    };
    const worker=async()=>{
      try {
        while(!failure&&!stopped&&visited<names.length){
          if(!wait&&(scheduled>=32||Date.now()>=deadline))break;
          const latest=readCaptureConfig();
          if(!wait&&(!latest||latest.disabled)){stopped=true;break;}
          if(latest&&(latest.api!==config.api||latest.installationId!==config.installationId||latest.owner.userId!==principal.userId||latest.owner.tenantId!==principal.tenantId))throw new CliError('CAPTURE_DESTINATION_CHANGED','Capture destination changed during upload; queued data is retained.');
          const name=names[visited++],batch=read(join(captureDir(),'queue',name));
          // Validate before sending any attachment bytes, even on a parallel pass.
          if(batch.owner?.userId!==principal.userId)throw new CliError('CAPTURE_OWNER_MISMATCH','Queued capture belongs to another user. Sign back in as its author to upload it; queued data is retained.');
          if(batch.owner?.tenantId!==principal.tenantId)throw new CliError('CAPTURE_DESTINATION_CHANGED','Queued capture belongs to another team. Sign back into its original destination or explicitly purge local pending data.');
          if(captureExcluded(latest??config,batch)){excluded++;continue;}
          scheduled++;
          if(batchDelayMs){const start=Math.max(Date.now(),nextUploadAt);nextUploadAt=start+batchDelayMs;await pause(Math.max(0,start-Date.now()));if(failure)break;}
          await upload(name,batch);
        }
      }catch(error){failure??=error;}
    };
    // A background pass must return to notice processing. Always settle the
    // in-flight uploads before releasing ownership, including after a failure.
    await Promise.all(Array.from({length:workers},worker));
    if(failure)throw failure;
    const result=excluded?{uploaded,excluded}:{uploaded};
    if(visited<names.length||stopped)return result;
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
    return result;
  },wait?Infinity:0).catch(error=>{if(!wait&&error?.code==='SESSION_BUSY')return {uploaded:0};throw error;});
}
/** A capture failure the person must fix, or null. Uploads succeeding after
 * the recorded error make it stale; queued data is retained either way. */
export function captureAttention():string|null {
  const config=readCaptureConfig();if(!config||config.disabled)return null;
  const error=read(join(captureDir(),'last-error.json')),upload=read(join(captureDir(),'last-upload.json'));
  if(error?.code!=='AUTH_REQUIRED' || upload?.at && Date.parse(upload.at)>=Date.parse(error.at))return null;
  const queued=existsSync(join(captureDir(),'queue'))?queuedNames().length:0;
  return `OpenCrawl session capture is paused: this machine can't sign in to ${new URL(config.api).hostname} (since ${error.at}; ${queued} batch${queued===1?'':'es'} queued locally, nothing lost). Run \`opencrawl login\` here. If this machine was created from an image or snapshot, a copied sign-in is revoked when another copy renews it; give capture an upload-only OPENCRAWL_SESSIONS_TOKEN instead.`;
}
/** Harness notice for a paused capture, at most hourly per installation. */
export function captureAttentionNotice(now=Date.now()):string|null {
  const message=captureAttention();if(!message)return null;
  const marker=join(captureDir(),'attention-shown.json'),shown=read(marker);
  if(shown?.at && now-Date.parse(shown.at)<3_600_000)return null;
  atomicJson(marker,{at:new Date(now).toISOString()});
  return message;
}
/** OpenCrawl hooks Codex will not run until the person trusts them in /hooks.
 * Codex records trust per hook as `[hooks.state."<hooks.json>:<event>:<group>:<hook>"]`
 * with a trusted_hash; a missing entry means "new hook - review required".
 * We only read that state: trust is the person's decision, never written here. */
export function codexHooksAwaitingReview(config:CaptureConfig|null=readCaptureConfig()):number {
  if(!config||config.disabled||!(config.harnesses??['claude-code','codex']).includes('codex')||!config.roots.codex)return 0;
  const file=join(config.roots.codex,'hooks.json');
  let hooks:any,state:any;
  try{hooks=JSON.parse(readFileSync(file,'utf8')).hooks??{};}catch{return 0;}
  try{state=(Bun.TOML.parse(readFileSync(join(config.roots.codex,'config.toml'),'utf8')) as any)?.hooks?.state??{};}catch{state={};}
  const snake=(event:string)=>event.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
  let pending=0;
  for(const [event,groups] of Object.entries(hooks))if(Array.isArray(groups))groups.forEach((group:any,g:number)=>{
    if(Array.isArray(group?.hooks))group.hooks.forEach((hook:any,h:number)=>{
      if(hook?.statusMessage==='OpenCrawl session capture'&&!state[`${file}:${snake(event)}:${g}:${h}`]?.trusted_hash)pending++;
    });
  });
  return pending;
}
export function captureStatus() {
  const config=readCaptureConfig();
  const codexReview=codexHooksAwaitingReview(config);
  const review=codexReview?`Codex will not run ${codexReview} OpenCrawl capture hook${codexReview===1?'':'s'} until you trust them: open Codex, run /hooks (or desktop Settings > Hooks) and trust "OpenCrawl session capture", then start a new session.`:null;
  return {installed:Boolean(config&&!config.disabled),api:config?.api,owner:config?.authPending?null:config?.owner,authenticationPending:Boolean(config?.authPending),installationId:config?.installationId,
    exclusions:config?.exclusions??{projects:[],sessions:[]},
    queued:existsSync(join(captureDir(),'queue'))?readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json')).length:0,
    pendingHooks:existsSync(join(captureDir(),'notices'))?noticeNames().length:0,
    backfill:read(join(captureDir(),'backfill-progress.json')),
    lastUpload:read(join(captureDir(),'last-upload.json')),lastError:read(join(captureDir(),'last-error.json')),
    codexHooksAwaitingReview:codexReview,attention:captureAttention()??review};
}
