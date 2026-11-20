import {allowedTime,confirmedPermission,readPermission,permittedBatch,type RecordingPermission} from './recording.ts';
import {transcriptCheckpoint,transcriptIdentity,transcriptIdentityMatches} from './transcript-checkpoint.ts';
import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, fstatSync, lstatSync, realpathSync, openSync, readSync, closeSync, unlinkSync, createReadStream} from 'node:fs';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {join, dirname, resolve, relative, sep, basename} from 'node:path';
import {homedir, hostname} from 'node:os';
import {compiled,commandForBinary} from '../distribution.ts';
import {randomUUID} from 'node:crypto';
import {setImmediate as yieldToOwner} from 'node:timers/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {createInterface} from 'node:readline';
import {configDir, atomicFile, atomicJson, accessToken, readSession, withSessionLock, syncDirectory, exitAfterCredentialRotation} from '../session.ts';
import {CliError} from '../oauth.ts';
import {retryWindowsSharing} from '../filesystem.ts';
import {environmentToken} from '../environment-token.ts';
import {workspaceIdentityEnabled, workspaceToken} from '../workspace-identity.ts';
import {parseRecord, detectOrigin, finalizeEventIdentity, hash, readsTranscript, HARNESSES, type Harness, type TranscriptHarness} from './parse.ts';
import {clientAppResolver} from './client-app.ts';
import {cursorSession,cursorTranscript,cursorMessage,cursorThoughtDuplicate,cursorThoughtState} from './cursor.ts';
import {grokBotEvents, grokBotSession, grokBotTitleEvent, grokBotUnsupported, GROK_BOT_BOUNDARIES, GROK_BOT_MAX_HOOK_BYTES} from './grok-bot.ts';
import {devinEvents,devinOverflow,devinSession,devinUnsupported,DEVIN_MAX_HOOK_BYTES} from './devin.ts';
import {isClaudeDesktopTranscript,desktopNativeMessageIds} from './desktop-history.ts';
import {captureExcluded, type CaptureExclusions} from './policy.ts';
import {localCodexHookReview,codexHookReviewMessage,type CodexHookReview} from './codex-hooks.ts';
import {codexTitle, codexTitleSignature} from './titles.ts';
import {codexNativeSession} from './codex-session.ts';
import {redactValue,redactAttachment,MAX_REDACTION_DEPTH} from './redact.ts';
import {replicasAttribution,replicasEventAttribution,replicasTitle,type ReplicasTitle} from './replicas.ts';
import {enqueueLiveBatch,pendingLiveSince,isPendingLive,recoverLiveSeals,sealLiveBatches} from './live-batches.ts';
import {attachmentReceipts} from './attachment-receipts.ts';
import {archiveChunks} from './archive.ts';

const compressBatch=promisify(gzip);
export const captureDir = () => join(configDir(),'capture');
const read = (p:string, fallback:any=null) => {try{return JSON.parse(readFileSync(p,'utf8'));}catch(e:any){if(e.code==='ENOENT')return fallback;throw e;}};
/** Bump when installed hook entries change so the next hook rewrites existing installs. */
export const HOOK_MODE='native-v5';
export type CaptureConfig = {disabled?:boolean,authPending?:boolean,captureWorker?:'daemon-v1',daemonRequested?:{backgroundStartup:boolean},backgroundStartup?:boolean,claudeCapture?:'daemon-v1',exclusions?:CaptureExclusions,schemaVersion:1,hookOwnership?:'global'|'plugin',hookMode?:typeof HOOK_MODE|'native-v4'|'managed-v3'|'managed-v2'|'managed',harnesses?:Harness[],historyHarnesses?:TranscriptHarness[],api:string,installationId:string,owner:{tenantId:string,userId:string,name?:string,email?:string},installedAt:string,roots:{'claude-code':string,codex:string,'grok-bot'?:string,cursor?:string,antigravity?:string,devin?:string},claudeDesktopSessionsRoot?:string,command:string[]};
export const readCaptureConfig = ():CaptureConfig|null => read(join(captureDir(),'config.json'));
/** claudeCapture is accepted only for the first opt-in daemon pilot. */
export const captureDaemonEnabled=(config:CaptureConfig|null=readCaptureConfig())=>config?.captureWorker==='daemon-v1'||config?.claudeCapture==='daemon-v1';
/** Every selected harness below has a native event inbox adapter. */
export const captureDaemonHarnesses=(config:CaptureConfig|null=readCaptureConfig())=>(config?.harnesses??[]).filter(harness=>HARNESSES.includes(harness));
/** Installations made before a harness existed have no directory for it. */
export function harnessRoot(config:CaptureConfig,harness:Harness) {
  const root=config.roots[harness];
  if(!root)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install --harness '+harness);
  return root;
}
// Enrollment and every queued payload remain bound to their original destination.
const recordingPath=(config:Pick<CaptureConfig,'api'|'owner'>)=>join(captureDir(),'state','recording-'+hash(JSON.stringify([config.api,config.owner.tenantId,config.owner.userId]))+'.json');
export async function captureIdentity(config:CaptureConfig,token?:string,signal?:AbortSignal) {
  // Keep a refreshed workload token paired with the owner verified by identity.
  let verifiedToken=token;
  const renew=token&&workspaceIdentityEnabled()?async(rejected:string)=>verifiedToken=await workspaceToken(config.api,rejected,signal):undefined;
  const cached:RecordingPermission|undefined=config.authPending?undefined:read(recordingPath(config))??undefined;
  const {principal,capabilities,recording:response}=await request(config.api,'/api/sessions/identity',{signal,headers:{'x-opencrawl-recording':cached?.revision??'new'}},token,renew);
  const recording=readPermission(response,cached);
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
    if(recording&&(!cached||cached.revision!==recording.revision||cached.paused!==recording.paused||recording.paused))atomicJson(recordingPath(config),recording);
    if(config.authPending){
      config.installationId=current.installationId==='pending'?randomUUID():current.installationId;
      config.authPending=false;
    }
    atomicJson(join(captureDir(),'config.json'),{...current,owner:principal,installationId:config.installationId,...(current.authPending?{authPending:false}:{})});
  },20_000,signal);
  return {principal,recording,token:verifiedToken,gzip:Array.isArray(capabilities?.batchEncodings)&&capabilities.batchEncodings.includes('gzip'),cursor:capabilities?.harnesses?.includes('cursor')===true,antigravity:capabilities?.harnesses?.includes('antigravity')===true};
}
export async function refreshCaptureIdentity(config:CaptureConfig,token?:string,signal?:AbortSignal) {
  return (await captureIdentity(config,token,signal)).principal;
}
function staticCaptureToken(api:string) {
  if(workspaceIdentityEnabled())return undefined;
  const saved=read(join(captureDir(),'receiver-token.json'));
  return environmentToken('OPENCRAWL_SESSIONS_TOKEN',api) || (saved?.api===api?saved.token:null);
}
export async function request(api:string,path:string,init:RequestInit={},tokenOverride?:string,renew?:(rejected:string)=>Promise<string>) {
  const staticToken=tokenOverride || staticCaptureToken(api);
  const signal=init.signal??undefined;
  signal?.throwIfAborted();
  let token=staticToken || (workspaceIdentityEnabled()?await workspaceToken(api):await accessToken(api,undefined,fetch,signal));
  const method=init.method??'GET',pathname=new URL(path,api).pathname;
  // Only retry operations whose payloads are read-only or content-addressed.
  // A lost response after storage must resend the same batch/blob, not lose it.
  const retryable=method==='GET'||method==='POST'&&['/api/sessions/batches','/api/sessions/memories'].includes(pathname)||method==='PUT'&&/^\/api\/sessions\/attachments\/[a-f0-9]{64}$/.test(pathname);
  const permission=new Headers(init.headers).get('x-opencrawl-recording');
  const bytes=typeof init.body==='string'?Buffer.byteLength(init.body):ArrayBuffer.isView(init.body)?init.body.byteLength:0;
  const deadline=20_000;
  const send=async()=>{
    for(let attempt=0;;attempt++){
      let response:Response;
      signal?.throwIfAborted();
      try {
        // A large upload or retry may be far removed from the flush's admission.
        // Recheck without opening a payload stream. A receiver still fences the final write.
        if(permission&&bytes&&(bytes>=256*1024||attempt>0)){
          const check=await fetch(api+'/api/sessions/recording',{method:'HEAD',headers:{authorization:'Bearer '+token,'x-opencrawl-recording':permission},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),redirect:'error'});
          if(check.status!==204){
            await check.body?.cancel();
            return new Response(JSON.stringify({error:{code:'RECORDING_PERMISSION_UNAVAILABLE'}}),{status:check.ok?412:check.status});
          }
        }
        response=await fetch(api+path,{...init,headers:{...init.headers,authorization:'Bearer '+token},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(deadline)]):AbortSignal.timeout(deadline),redirect:'error'});}
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
  if(res.status===401 && (renew || !staticToken)){await res.body?.cancel();token=renew?await renew(token):workspaceIdentityEnabled()?await workspaceToken(api,token,signal):await accessToken(api,token,fetch,signal);res=await send();}
  if(res.status===413){await res.body?.cancel();throw Object.assign(new CliError('CAPTURE_UPLOAD_FAILED','Capture request failed (413): payload or session capacity exceeded'),{httpStatus:413});}
  const body=await res.json().catch(()=>{throw res.status>=500||res.status===429
    ?new CliError('CAPTURE_RETRY_EXHAUSTED',`Capture endpoint ${new URL(api).hostname} is temporarily unavailable (HTTP ${res.status}). Queued data is retained; retry the approved import.`)
    :new CliError('CAPTURE_NETWORK_BLOCKED',`Capture endpoint ${new URL(api).hostname} returned HTTP ${res.status} without JSON. Check this host in your cloud environment network allowlist.`);});
  if(!res.ok)throw Object.assign(new CliError('CAPTURE_UPLOAD_FAILED',`Capture request failed (${res.status}): ${body.error?.code ?? 'unknown'}`),{httpStatus:res.status,responseCode:body.error?.code});
  return body.data;
}
export function commandForSelf() {
  if(compiled())return [commandForBinary()];
  return /\.[cm]?[jt]s$/.test(process.argv[1]??'') ? [process.execPath,resolve(process.argv[1])] : [process.execPath];
}
export function recordError(error:any) {
  // Status only: never include transcript content, credentials, or a provider response.
  atomicJson(join(captureDir(),'last-error.json'),{at:new Date().toISOString(),code:error?.code || 'CAPTURE_FAILED'});
}
function ensureDirectories() {for(const dir of ['queue','state','blobs','notices','sources','rejected','uploads'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});}
/** Only the fixed notice header is needed for ordering. Filesystem timestamps
 * can tie on Linux; reading whole payloads here would unbound backlog memory. */
export function orderedNoticeNames() {
  return readdirSync(join(captureDir(),'notices')).filter(name=>name.endsWith('.json')).map(name=>{
    const path=join(captureDir(),'notices',name),fd=openSync(path,'r'),buffer=Buffer.alloc(256);
    try {
      const count=readSync(fd,buffer,0,buffer.length,0);
      const header=/^\{"id":"[^"]+","at":"([^"]+)"(?:,"sequence":(\d+))?,/.exec(buffer.subarray(0,count).toString('utf8'));
      const order=header?.[2]?Number(header[2]):header?Date.parse(header[1]!)*1000:statSync(path).mtimeMs*1000;
      return {name,order:Number.isFinite(order)?order:0};
    } finally {closeSync(fd);}
  }).sort((a,b)=>a.order-b.order||a.name.localeCompare(b.name)).map(item=>item.name);
}
const under = (file:string,dir:string) => file.startsWith(dir+sep);
export const ANTIGRAVITY_SURFACES = ['antigravity-cli','antigravity','antigravity-ide'] as const;
export function antigravityBrainDirs(root:string):{dir:string;origin:'cli'|'desktop';surface:string}[] {
  return [
    {dir:join(root,'antigravity-cli','brain'),origin:'cli',surface:'antigravity-cli'},
    {dir:join(root,'antigravity','brain'),origin:'desktop',surface:'antigravity'},
    {dir:join(root,'antigravity-ide','brain'),origin:'desktop',surface:'antigravity-ide'},
    {dir:join(root,'brain'),origin:basename(root)==='antigravity-cli'?'cli':'desktop',surface:basename(root)},
  ];
}
export function resolveAntigravityTranscript(file:string):string {
  if(basename(file)==='transcript.jsonl') {
    const full=join(dirname(file),'transcript_full.jsonl');
    if(existsSync(full))return full;
  }
  return file;
}
export function* walkAntigravityTranscripts(root:string):Generator<string> {
  const seen=new Set<string>();
  for(const {dir} of antigravityBrainDirs(root)) {
    let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{continue;}
    for(const entry of entries) {
      if(entry.isSymbolicLink()||!entry.isDirectory()||!/^[\w.:-]{1,200}$/.test(entry.name))continue;
      const sysDir=join(dir,entry.name,'.system_generated'),logsDir=join(sysDir,'logs');
      try{if(lstatSync(sysDir).isSymbolicLink()||!lstatSync(sysDir).isDirectory()||lstatSync(logsDir).isSymbolicLink()||!lstatSync(logsDir).isDirectory())continue;}catch{continue;}
      for(const candidate of ['transcript_full.jsonl','transcript.jsonl']) {
        const p=join(logsDir,candidate);
        try{const st=lstatSync(p);if(st.isSymbolicLink()||!st.isFile())continue;}catch{continue;}
        let real:string;try{real=realpathSync(p);}catch{continue;}
        if(!seen.has(real)){seen.add(real);yield real;}
        break; // Prefer transcript_full.jsonl over transcript.jsonl for the same conversation.
      }
    }
  }
}
export function antigravityPathMeta(path:string,environment:NodeJS.ProcessEnv=process.env):{sessionId?:string;origin:'cli'|'desktop'|'cloud';originEvidence:string} {
  const convDir=resolve(path,'..','..','..'),convId=basename(convDir),surface=basename(resolve(convDir,'..','..'));
  const sessionId=/^[\w.:-]{1,200}$/.test(convId)?convId:undefined;
  if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(environment.REPLICAS_WORKSPACE_ID??'')) {
    return {sessionId,origin:'cloud',originEvidence:'https://app.replicas.dev/workspace/'+environment.REPLICAS_WORKSPACE_ID};
  }
  const origin=surface==='antigravity-cli'?'cli':'desktop';
  const originEvidence=surface==='antigravity-cli'||surface==='antigravity-ide'||surface==='antigravity'?surface:'antigravity';
  return {sessionId,origin,originEvidence};
}
export function antigravityHookFields(event:any):{sessionId?:string;transcriptPath?:string;cwd?:string;hookEventName?:string} {
  const sessionId=typeof event?.conversationId==='string'?event.conversationId:(typeof event?.session_id==='string'?event.session_id:undefined);
  const transcriptPath=typeof event?.transcriptPath==='string'?event.transcriptPath:(typeof event?.transcript_path==='string'?event.transcript_path:undefined);
  const cwd=typeof event?.cwd==='string'&&event.cwd?event.cwd:(Array.isArray(event?.workspacePaths)&&typeof event.workspacePaths[0]==='string'&&event.workspacePaths[0]?event.workspacePaths[0]:undefined);
  const hookEventName=typeof event?.hookEventName==='string'?event.hookEventName:(typeof event?.hook_event_name==='string'?event.hook_event_name:undefined);
  return {sessionId,transcriptPath,cwd,hookEventName};
}
function transcriptAllowed(file:string, config:CaptureConfig, harness:TranscriptHarness, approvedHistory=false) {
  const target=harness==='antigravity'?resolveAntigravityTranscript(file):file;
  const path=realpathSync(target);
  // Host-mirrored desktop history is accessible only through explicit backfill consent.
  if(approvedHistory&&harness==='claude-code'&&isClaudeDesktopTranscript(path,config))return path;
  let root:string;try{root=realpathSync(harnessRoot(config,harness));}catch{throw new CliError('CAPTURE_PATH_REJECTED','Transcript outside configured harness session directories');}
  if(harness==='antigravity') {
    const matched=antigravityBrainDirs(root).find(({dir})=>under(path,dir));
    const parts=matched?relative(matched.dir,path).split(sep):[];
    if(!matched||parts.length!==4||!/^[\w.:-]{1,200}$/.test(parts[0]??'')||parts[1]!=='.system_generated'||parts[2]!=='logs'||!['transcript_full.jsonl','transcript.jsonl'].includes(parts[3]??'')) {
      throw new CliError('CAPTURE_PATH_REJECTED','Transcript outside configured harness session directories');
    }
    return path;
  }
  const allowed=harness==='claude-code' ? [join(root,'projects')] : [join(root,'sessions'),join(root,'archived_sessions')];
  if(!allowed.some(dir=>under(path,dir)) || !(path.endsWith('.jsonl') || harness==='codex' && path.endsWith('.jsonl.zst')))throw new CliError('CAPTURE_PATH_REJECTED','Transcript outside configured harness session directories');
  return path;
}
/** A daemon enrollment names one native session, not every transcript under a
 * harness root. Resolve before reading and reject redirects even within that root. */
export function assertSessionTranscriptPath(config:CaptureConfig,harness:TranscriptHarness,sessionId:string,file:string,registeredPath=file) {
  const reject=()=>{throw new CliError('CAPTURE_SESSION_PATH_REJECTED','Transcript does not belong to the registered native session');};
  if(!/^[\w.:-]{1,200}$/.test(sessionId))return reject();
  const root=resolve(harnessRoot(config,harness)),canonicalRoot=realpathSync(root);
  const exact=(input:string)=>{
    const path=resolve(input),parts=relative(root,path).split(sep);
    if(parts[0]==='..'||!under(path,root))return reject();
    const actual=realpathSync(path);
    if(actual!==resolve(canonicalRoot,...parts)||!lstatSync(path).isFile())return reject();
    return actual;
  };
  const parent=resolve(registeredPath),parts=relative(root,parent).split(sep);
  let agentId:string|undefined;
  if(harness==='claude-code'){
    if(parts.length!==3||parts[0]!=='projects'||basename(parent)!==sessionId+'.jsonl')return reject();
    exact(parent);
    if(resolve(file)!==parent){
      const children=join(dirname(parent),basename(parent,'.jsonl'),'subagents');
      if(!under(resolve(file),children))return reject();
      const match=/^agent-([\w.:-]{1,200})\.jsonl$/.exec(basename(file));
      if(!match)return reject();agentId=match[1]!;
    }
  }else if(harness==='codex'){
    if(!['sessions','archived_sessions'].includes(parts[0]??'')||!basename(parent).endsWith('-'+sessionId+'.jsonl')||resolve(file)!==parent)return reject();
  }else{
    const valid=(path:string)=>antigravityBrainDirs(root).some(({dir})=>{
      const p=relative(dir,path).split(sep);return p.length===4&&p[0]===sessionId&&p[1]==='.system_generated'&&p[2]==='logs'&&['transcript.jsonl','transcript_full.jsonl'].includes(p[3]!);
    });
    if(!valid(parent)||!valid(resolve(file))||dirname(resolve(file))!==dirname(parent))return reject();
    // Native hooks may name compact JSONL before it exists while the full
    // transcript is already available. Existing nominal paths must still match.
    let present=false;try{lstatSync(parent);present=true;}catch(error:any){if(error.code!=='ENOENT')throw error;}
    if(present)exact(parent);
  }
  return {path:exact(file),sessionId,agentId};
}
export function* walk(dir:string):Generator<string> {
  let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){const p=join(dir,e.name);if(e.isDirectory())yield*walk(p);else if(e.isFile()&&p.endsWith('.jsonl'))yield p;}
}
function findTranscript(config:CaptureConfig,harness:TranscriptHarness,sessionId:string):string|undefined {
  const root=config.roots[harness];if(!root)return undefined;
  if(harness==='antigravity') {
    if(/^[\w.:-]{1,200}$/.test(sessionId))for(const {dir} of antigravityBrainDirs(root))for(const name of ['transcript_full.jsonl','transcript.jsonl']) {
      const candidate=join(dir,sessionId,'.system_generated','logs',name);
      if(existsSync(candidate))return candidate;
    }
    for(const path of walkAntigravityTranscripts(root))if(antigravityPathMeta(path).sessionId===sessionId)return path;
    return undefined;
  }
  const dirs=harness==='codex'?['sessions','archived_sessions']:['projects'];
  for(const d of dirs)for(const path of walk(join(root,d)))if(basename(path).includes(sessionId))return path;
}
function attachmentTransform(value:any, attachments:any[], cwd:string, localFiles=new Set<any>()):any {
  if(Array.isArray(value))return value.map(v=>attachmentTransform(v,attachments,cwd,localFiles));
  if(!value || typeof value!=='object')return value;
  let bytes:Buffer|undefined, path:string|undefined, mime:string|undefined, reference:string|undefined;
  if(value.type==='base64' && typeof value.data==='string'){bytes=Buffer.from(value.data,'base64');mime=value.media_type;}
  const url=typeof value.image_url==='string'?value.image_url:value.image_url?.url;
  if(typeof url==='string' && url.startsWith('data:')){const m=/^data:([^;,]+);base64,(.*)$/s.exec(url);if(m){mime=m[1];bytes=Buffer.from(m[2],'base64');}}
  if(localFiles.has(value) && ['local_image','input_file','file'].includes(value.type) && typeof value.path==='string'){path=resolve(cwd,value.path);if(!mime&&typeof value.media_type==='string')mime=value.media_type;}
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
  if(!current || current.api!==config.api || current.installationId!==config.installationId || current.owner.tenantId!==config.owner.tenantId || current.owner.userId!==config.owner.userId)throw new CliError('CAPTURE_CONFIG_CHANGED','Capture enrollment changed; retry with its current configuration.');
  if(current.disabled||meta.captureMode!=='history'&&current.harnesses&&!current.harnesses.includes(meta.harness))throw new CliError('CAPTURE_CONSENT_CHANGED','Forward recording is no longer enabled for this client; new bytes were not queued.');
  if(captureExcluded(current,meta))return;
  if(current.authPending||config.authPending)throw new CliError('CAPTURE_AUTH_PENDING','Capture identity has not been authenticated yet');
  if(!meta.sessionId)throw new CliError('CAPTURE_SESSION_UNKNOWN','Transcript has no session identity');
  const batch=redactValue({schemaVersion:1,owner:config.owner,installationId:config.installationId,host:hostname(),...meta,events,attachments});
  // Keep the original local scope for exclusions added after enqueue. Masking a
  // credential-shaped directory name must not make an excluded project appear
  // to be another path. The egress boundary always scrubs these fields.
  if(meta.cwd!==undefined)batch.cwd=meta.cwd;
  batch.sessionId=meta.sessionId;
  batch.events=batch.events.map(({sourceTime,sourceTimeFrom,...event}:Record<string,unknown>)=>({
    ...finalizeEventIdentity(event),...sourceTime!==undefined&&{sourceTime},...sourceTimeFrom!==undefined&&{sourceTimeFrom},
  }));
  const cachedPolicy=confirmedPermission(read(recordingPath(config))??undefined);
  const permitted=permittedBatch(batch,cachedPolicy);
  if(!permitted)return;
  const serialized=JSON.stringify(permitted),size=Buffer.byteLength(serialized);
  if(size>16*1024*1024)throw new CliError('CAPTURE_BATCH_TOO_LARGE','A capture record exceeds the upload limit; retained locally for retry');
  enqueueLiveBatch(captureDir(),hash(serialized)+'.json',serialized,meta.captureMode!=='history');
}

/** Every upload (including queues from older CLIs) crosses this local boundary.
 * Never trust a queue's masking/version flag. Read and scrub all blobs before
 * sending any of them. Do not rewrite original queues: exclusions still need
 * their original local paths and retries deterministically derive the same wire
 * bytes. A changed event gets a new identity to avoid immutable-ID conflicts.
 */
function prepareCaptureUpload(original:any) {
  // Provenance bounds are local policy evidence, outside immutable wire event identity.
  original={...original,events:original.events.map(({sourceTime,sourceTimeFrom,...event}:Record<string,unknown>)=>event)};
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
function leadingCodexRecord(fd: number, size: number, required: boolean) {
  const limit = Math.min(size, 1024 * 1024);
  let header = Buffer.alloc(Math.min(limit, 4096));
  let start = 0;
  while (header.length) {
    const bytes = readSync(fd, header, start, header.length - start, start);
    const end = header.subarray(start, start + bytes).indexOf(10);
    if (end >= 0) {
      try { return JSON.parse(header.subarray(0, start + end).toString('utf8')); }
      catch (error) { if (required) throw error; return; }
    }
    if (start + bytes < header.length || header.length === limit) break;
    start = header.length;
    const larger = Buffer.alloc(Math.min(limit, start * 2));
    header.copy(larger);
    header = larger;
  }
  if (required) throw new CliError('CAPTURE_SESSION_UNKNOWN', 'The native session header is incomplete');
}

/** The cursor advances only after its records and attachment bytes are durably spooled. */
export async function captureTranscript(config:CaptureConfig,harness:TranscriptHarness,file:string,hook:any={},reconcileHistory=false,onEnqueued?:()=>Promise<void>,approvedFile?:{bytes:number;ino:number;mtimeMs:number},{sessionScoped=false,sessionPath}:{sessionScoped?:boolean,sessionPath?:string}={}) {
  return withSessionLock('capture:spool',async()=>{
  if(readCaptureConfig()?.disabled)throw new CliError('CAPTURE_DISABLED','Capture is uninstalled. Reinstall before importing transcripts.');
  ensureDirectories();
  const spool=async(meta:any,events:any[],attachments:any[])=>{
    enqueue(config,meta,events,attachments);
    await onEnqueued?.();
  };
  const path=transcriptAllowed(file,config,harness,reconcileHistory);
  const desktopAudit=harness==='claude-code'&&basename(path)==='audit.jsonl'&&isClaudeDesktopTranscript(path,config);
  const stateFile=join(captureDir(),'state',hash(harness+path)+'.json');
  return withSessionLock('capture:'+stateFile,async()=>{
    const scoped=sessionScoped?assertSessionTranscriptPath(config,harness,hook.session_id,harness==='antigravity'?resolveAntigravityTranscript(file):file,sessionPath??file):null;
    if(scoped&&scoped.path!==path)throw new CliError('CAPTURE_SESSION_PATH_REJECTED','Native transcript changed before reading');
    const source=statSync(path),old=read(stateFile,{offset:0});
    if(approvedFile&&(source.ino!==approvedFile.ino||source.size<approvedFile.bytes||path.endsWith('.zst')&&(source.size!==approvedFile.bytes||source.mtimeMs!==approvedFile.mtimeMs)))throw new CliError('BACKFILL_SOURCE_CHANGED','An approved history file was replaced or changed. Review a new import plan.');
    const compressed=path.endsWith('.jsonl.zst');
    let archiveComplete=false;
    if(compressed) {
      if(old.archiveSize===source.size && old.archiveMtime===source.mtimeMs && old.ino===source.ino && (!reconcileHistory || old.parserVersion===2)) {
        const platform=await platformTitle(config,old.meta);
        if(platform)capturePlatformTitle(config,old.meta,platform,reconcileHistory?'history':'live');else captureCodexTitle(config,old.meta,sessionScoped,reconcileHistory?'history':'live');
        atomicJson(stateFile, old);
        return old.meta;
      }
      // Retire only the previous implementation's owned, disposable expansion.
      try{unlinkSync(stateFile+'.expanded.tmp');}catch(e:any){if(e.code!=='ENOENT')throw e;}
    }
    const st={size:approvedFile&&!compressed?Math.min(source.size,approvedFile.bytes):source.size};
    let offset=old.offset;
    if(old.forwardBoundary&&compressed&&!reconcileHistory)return old.meta;
    const reset=st.size<offset || Boolean(old.ino && old.ino!==source.ino);
    let boundaryIdentity:string|undefined;
    if(old.forwardBoundary&&!reconcileHistory){
      // A rewritten source has an unknown pre-consent prefix. Preserve the
      // future-only boundary at its current end; only later appends may enter.
      const boundaryFd=openSync(path,'r'),last=Buffer.alloc(1);
      try{
        const current=fstatSync(boundaryFd);boundaryIdentity=transcriptIdentity(boundaryFd);
        if(current.ino!==source.ino||current.size!==source.size)throw new CliError('CAPTURE_SOURCE_CHANGED','Transcript changed while preserving its consent boundary; retry capture.');
        if(!transcriptIdentityMatches(old.identity,boundaryIdentity)||reset||typeof old.checkpoint!=='string'||old.checkpoint!==transcriptCheckpoint(boundaryFd,offset)){
          if(current.size)readSync(boundaryFd,last,0,1,current.size-1);
          atomicJson(stateFile,{offset:current.size,ino:current.ino,identity:boundaryIdentity,parserVersion:old.parserVersion??1,forwardBoundary:true,checkpoint:transcriptCheckpoint(boundaryFd,current.size),skipPartial:Boolean(current.size&&last[0]!==10)});
          return;
        }
      }finally{closeSync(boundaryFd);}
    }
    if(reset || compressed)offset=0;
    // Parser upgrades must not silently start a historical import in hooks/sync.
    // An explicitly approved backfill may reread older cursors to recover newly
    // supported native records; unchanged event IDs remain idempotent downstream.
    if(reconcileHistory && old.parserVersion!==2)offset=0;
    const parserVersion=offset===0?2:old.parserVersion??1;
    const nativeIds=desktopAudit&&offset<st.size?desktopNativeMessageIds(path):new Set<string>();
    const fd=compressed?undefined:openSync(path,'r');
    if(approvedFile&&fd!==undefined&&fstatSync(fd).ino!==approvedFile.ino){closeSync(fd);throw new CliError('BACKFILL_SOURCE_CHANGED','An approved history file changed before reading.');}
    const agyPath=harness==='antigravity'?antigravityPathMeta(path):null;
    const agyHook=harness==='antigravity'?antigravityHookFields(hook):null;
    let meta:any=(offset>0?old.meta:null)??(agyPath
      ? {harness,sessionId:agyHook?.sessionId??agyPath.sessionId,origin:agyPath.origin,originEvidence:agyPath.originEvidence,parentSessionId:null,sourcePath:path,...(agyHook?.cwd?{cwd:agyHook.cwd}:{})}
      : {harness,sessionId:hook.session_id,origin:'unknown',originEvidence:null,parentSessionId:null,sourcePath:path});
    if(agyHook?.cwd&&!meta.cwd)meta={...meta,cwd:agyHook.cwd};
    if(agyPath&&(!meta.origin||meta.origin==='unknown'))meta={...meta,origin:agyPath.origin,originEvidence:agyPath.originEvidence};
    const expectedSession=scoped?(scoped.agentId?scoped.sessionId+':'+scoped.agentId:scoped.sessionId):null;
    let codexIdentityRead=Boolean(offset>0&&old.meta?.sessionId);
    const resolveClientApp = clientAppResolver();
    function metadata(r:any) {
        if(harness==='antigravity')return;
        const p=r.payload??r;
        if(desktopAudit){
          if(typeof r.session_id==='string'&&r.session_id){meta.sessionId=r.session_id;meta.origin='desktop';meta.originEvidence='Claude Desktop local-agent-mode-sessions audit';}
          return;
        }
        if(harness==='codex' && r.type==='session_meta') {
          // Forks include copied parent headers after their own leading header.
          // Those records are history, not a change to this transcript's owner.
          if(codexIdentityRead)return;
          if(scoped&&p.id!==scoped.sessionId)throw new CliError('CAPTURE_SESSION_MISMATCH','Native header differs from the registered session');
          codexIdentityRead=true;
          meta.sessionId=p.id;meta.parentSessionId=p.forked_from_id??p.source?.subagent?.thread_spawn?.parent_thread_id??null;
          const origin=detectOrigin(harness,r);
          meta.origin=origin.origin;meta.originEvidence=origin.evidence;
          const app=resolveClientApp('codex',p.id,p.originator);
          if(app)meta.clientApp=app;
          meta.cwd=p.cwd;meta.harnessVersion=p.cli_version;
          return;
        } else if(harness==='codex') {
          if(r.type==='turn_context' && p.cwd)meta.cwd=p.cwd;
          return;
        } else if(harness==='claude-code' && r.sessionId) {
          if(scoped&&(r.sessionId!==scoped.sessionId||(r.agentId??undefined)!==scoped.agentId))throw new CliError('CAPTURE_SESSION_MISMATCH','Native message differs from the registered parent or child session');
          const sessionId=r.agentId ? r.sessionId+':'+r.agentId : r.sessionId;
          if(meta.sessionId!==sessionId)delete meta.clientApp;
          meta.sessionId=sessionId;
          if(typeof r.entrypoint==='string' && !(r.entrypoint==='sdk-ts' && meta.clientApp==='conductor')){
            const clientApp=resolveClientApp('claude-code',r.sessionId,r.entrypoint);
            if(clientApp)meta.clientApp=clientApp;
            else delete meta.clientApp;
          }
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
    const chunks=async function*():AsyncGenerator<Buffer>{
      if(compressed){yield* archiveChunks(path,source.size,complete=>{archiveComplete=complete;});return;}
      while(offset<st.size) {
        // Ordinary reads stay small even for multi-gigabyte histories. Grow only
        // when one native record spans the buffer; retain the existing line cap.
        const remaining=st.size-offset,maxRead=Math.min(remaining,48*1024*1024);
        let bytes=Buffer.alloc(Math.min(maxRead,8*1024*1024));readSync(fd!,bytes,0,bytes.length,offset);
        let end=bytes.lastIndexOf(10);
        while(end<0&&bytes.length<maxRead){
          bytes=Buffer.alloc(Math.min(maxRead,bytes.length*2));readSync(fd!,bytes,0,bytes.length,offset);
          end=bytes.lastIndexOf(10);
        }
        if(end<0) {
          if(bytes.length<st.size-offset)throw new CliError('CAPTURE_LINE_TOO_LARGE','Transcript line exceeds capture chunk size');
          break; // writer has not completed this record yet
        }
        yield bytes.subarray(0,end+1);
      }
    };
    try {
      // The source can be replaced between the boundary check and this open.
      // Validate the descriptor that will actually supply parser bytes too.
      if(old.forwardBoundary&&!reconcileHistory&&fd!==undefined){
        const current=fstatSync(fd);
        if(transcriptIdentity(fd)!==boundaryIdentity||current.size!==source.size||old.checkpoint!==transcriptCheckpoint(fd,offset))
          throw new CliError('CAPTURE_SOURCE_CHANGED','Transcript changed before reading its consent boundary; retry capture.');
      }
    if(scoped&&meta.sessionId&&meta.sessionId!==expectedSession&&!(scoped.agentId&&meta.sessionId===scoped.sessionId))throw new CliError('CAPTURE_SESSION_MISMATCH','Saved transcript identity differs from the registered native session');
      if(scoped&&fd!==undefined){
        if(fstatSync(fd).ino!==source.ino||assertSessionTranscriptPath(config,harness,scoped.sessionId,harness==='antigravity'?resolveAntigravityTranscript(file):file,sessionPath??file).path!==path)throw new CliError('CAPTURE_SESSION_PATH_REJECTED','Native transcript changed before reading');
      }
      // Only the leading header owns the rollout. Read it on resume to enrich
      // old cursors or retry a Conductor binding committed after the first scan.
      const recoverIdentity=old.forwardBoundary&&!reconcileHistory&&offset>0&&!meta.sessionId;
      const retryApp=offset>0&&offset<st.size&&meta.sessionId&&!meta.clientApp;
      if(harness==='codex'&&fd!==undefined&&(scoped||recoverIdentity||retryApp)){
        const native=leadingCodexRecord(fd,st.size,Boolean(scoped||recoverIdentity));
        if(scoped&&(native?.type!=='session_meta'||native.payload?.id!==scoped.sessionId))throw new CliError('CAPTURE_SESSION_MISMATCH','Native header differs from the registered session');
        if(recoverIdentity)metadata(native);
        else if(retryApp&&native?.type==='session_meta'&&native.payload?.id===meta.sessionId){
          const app=resolveClientApp('codex',meta.sessionId,native.payload.originator);
          if(app)meta.clientApp=app;
        }
      }
      let skipPartial=old.forwardBoundary&&!reconcileHistory&&old.skipPartial;
      // Apply metadata in record order. Looking ahead at a later working
      // directory could incorrectly allow earlier records from an excluded project.
      for await(const bytes of chunks()) {
        await yieldToOwner();
        const events:any[]=[],attachments:any[]=[];
        let position=offset,linesSinceYield=0,eventBytes=0;
        for(const line of bytes.toString('utf8').split('\n').slice(0,-1)){
          if(skipPartial){skipPartial=false;position+=Buffer.byteLength(line)+1;continue;}
          if(line.trim()){
            let record;try{record=JSON.parse(line);}catch{throw new CliError('CAPTURE_INVALID_RECORD','Invalid transcript record; cursor retained');}
            const auditMessage=!desktopAudit||['user','assistant'].includes(record.type)&&!nativeIds.has(record.uuid);
            if(desktopAudit&&auditMessage&&(!record.session_id||typeof record.session_id!=='string'))throw new CliError('CAPTURE_SESSION_UNKNOWN','Desktop audit message has no session identity');
            const priorMeta={...meta};
            if(!desktopAudit||auditMessage)metadata(record);
            if(priorMeta.sessionId && (meta.sessionId!==priorMeta.sessionId || meta.cwd!==priorMeta.cwd || meta.clientApp!==priorMeta.clientApp)){await spool({...priorMeta,captureMode:reconcileHistory?'history':'live'},events.splice(0),attachments.splice(0));eventBytes=0;}
            const parsed=auditMessage?parseRecord(harness,record,position):null;
            if(parsed?.kind==='session_title') {
              const platform=await platformTitle(config,meta);
              if(platform)parsed.data={title:platform.title,titleType:'custom'};
              if(parsed.data.titleType==='custom'){meta.customTitle=parsed.data.title;meta.customTitleTime=platform?.timestamp??parsed.timestamp;}
              // A later automatic suggestion must not overwrite a manual rename.
              if(meta.customTitle)parsed.data={title:meta.customTitle,titleType:'custom'};
              Object.assign(parsed,{sourceTime:meta.customTitle?meta.customTitleTime??null:parsed.timestamp});
            }
            if(parsed&&desktopAudit){parsed.timestamp=record._audit_timestamp??record.timestamp??null;parsed.parentId=record.parent_tool_use_id??null;}
            if(parsed && !captureExcluded(readCaptureConfig()??config,meta)) {
              if(harness==='claude-code'&&!record.agentId&&!record.isSidechain&&workspaceIdentityEnabled()&&process.env.REPLICAS_WORKSPACE_ID&&parsed.kind==='message'&&parsed.data?.role==='user'){
                const content=parsed.data.content;
                const input=typeof content==='string'||Array.isArray(content)&&content.some((block:any)=>block&&['text','image','document','file'].includes(block.type));
                if(input){
                  const nativeId=record.attachment?.type==='queued_command'?record.attachment.source_uuid:record.uuid;
                  const reported=await replicasAttribution(process.env.REPLICAS_WORKSPACE_ID,meta.sessionId,nativeId);
                  if(reported){
                    const {actor,profile}=replicasEventAttribution(reported);
                    Object.assign(parsed,{actor});
                    if(profile)meta.actorProfiles={...meta.actorProfiles,[profile.userId]:profile};
                  }
                }
              }
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
              // Antigravity's native GENERIC.media contains images actually returned
              // by a tool. Its arbitrary output text and tool arguments stay opaque.
              if(harness==='antigravity' && parsed.kind==='tool_result')blocks(parsed.data?.content);
              if(parsed.kind==='attachment' && parsed.data)localFiles.add(parsed.data);
              const eventAttachments:any[]=[],event=attachmentTransform(parsed,eventAttachments,meta.cwd??dirname(path),localFiles);
              const size=Buffer.byteLength(JSON.stringify(event))+Buffer.byteLength(JSON.stringify(eventAttachments));
              if(events.length&&(eventBytes+size>4*1024*1024||attachments.length+eventAttachments.length>1000)){
                await spool({...meta,captureMode:reconcileHistory?'history':'live'},events.splice(0),attachments.splice(0));eventBytes=0;
              }
              events.push(event);attachments.push(...eventAttachments);eventBytes+=size;
            }
          }
          position+=Buffer.byteLength(line)+1;
          if(++linesSinceYield===200){linesSinceYield=0;await yieldToOwner();}
          if(events.length>=(reconcileHistory?1000:200)){await spool({...meta,captureMode:reconcileHistory?'history':'live'},events.splice(0),attachments.splice(0));eventBytes=0;}
        }
        await spool({...meta,captureMode:reconcileHistory?'history':'live'},events,attachments);
        offset+=bytes.length;atomicJson(stateFile,{offset,ino:source.ino,parserVersion,meta,...(old.forwardBoundary&&!reconcileHistory?{forwardBoundary:true,identity:boundaryIdentity,checkpoint:transcriptCheckpoint(fd!,offset),skipPartial}: {})});
      }
      if(compressed){
        if(!archiveComplete)throw new CliError('CAPTURE_ARCHIVE_INVALID','Compressed transcript ended with an unfinished JSONL record; repair the archive and rerun the approved import.');
        const current=statSync(path);
        if(current.ino!==source.ino||current.size!==source.size||current.mtimeMs!==source.mtimeMs)throw new CliError('CAPTURE_ARCHIVE_CHANGED','Compressed transcript changed during capture; rerun the approved import.');
        atomicJson(stateFile,{offset,ino:source.ino,parserVersion,meta,archiveSize:source.size,archiveMtime:source.mtimeMs});
      }
    } finally{if(fd!==undefined)closeSync(fd);}
    const platform=await platformTitle(config,meta);
    if(platform?capturePlatformTitle(config,meta,platform,reconcileHistory?'history':'live'):harness==='codex'&&captureCodexTitle(config,meta,sessionScoped,reconcileHistory?'history':'live'))atomicJson(stateFile,{...read(stateFile,old),meta});
    return meta;
  });
  },Infinity);
}

async function platformTitle(config:CaptureConfig,meta:any,force=false) {
  if(!process.env.REPLICAS_WORKSPACE_ID||!workspaceIdentityEnabled()||meta?.parentSessionId||meta?.origin==='subagent'||!['claude-code','codex'].includes(meta?.harness)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(meta?.sessionId??'')||captureExcluded(readCaptureConfig()??config,meta))return undefined;
  return replicasTitle(process.env.REPLICAS_WORKSPACE_ID,meta.sessionId,meta.harness,force);
}
function capturePlatformTitle(config:CaptureConfig,meta:any,{title,timestamp}:ReplicasTitle,captureMode:'history'|'live'='history') {
  if(meta.capturedTitle===title)return false;
  enqueue(config,{...meta,captureMode},[{id:hash('replicas-title:'+meta.sessionId+':'+timestamp+':'+title),kind:'session_title',sequence:0,timestamp,sourceTime:timestamp,data:{title,titleType:'custom'}}],[]);
  meta.capturedTitle=title;meta.customTitle=title;meta.customTitleTime=timestamp;
  return true;
}

function captureCodexTitle(config:CaptureConfig,meta:any,sessionScoped=false,captureMode:'history'|'live'='history') {
  if(!meta?.sessionId || meta.harness!=='codex' || captureExcluded(readCaptureConfig()??config,meta))return false;
  const native=sessionScoped?codexNativeSession(config.roots.codex,meta.sessionId)?.title:codexTitle(config.roots.codex,meta.sessionId);
  if(!native || meta.capturedTitle===native.title)return false;
  enqueue(config,{...meta,captureMode},[{id:hash('codex-title:'+meta.sessionId+':'+native.timestamp+':'+native.title),kind:'session_title',sequence:0,timestamp:native.timestamp,sourceTime:native.timestamp,data:{title:native.title}}],[]);
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
        const platform=await platformTitle(config,meta,true);
        if(platform) {
          if(capturePlatformTitle(config,meta,platform)){atomicJson(stateFile,{...state,meta});updated++;}
          return;
        }
        if(meta.harness==='codex') {
          if(captureCodexTitle(config,meta)){atomicJson(stateFile,{...state,meta});updated++;}
          return;
        }
        // Only inspect previously captured bytes of a native transcript. Ignore
        // message/tool bodies and title-shaped strings nested inside them.
        let path:string;try{path=transcriptAllowed(meta.sourcePath,config,'claude-code');}catch{return;}
        const st=statSync(path);
        if(state.ino!==st.ino || st.size<state.offset)return;
        let title:string|undefined,custom:string|undefined,sourceTime:string|null=null;
        const stream=createReadStream(path,{end:state.offset-1}),lines=createInterface({input:stream,crlfDelay:Infinity});
        try {
          for await(const line of lines) {
            if(!/"type"\s*:\s*"(?:custom-title|ai-title)"/.test(line))continue;
            let record:any;try{record=JSON.parse(line);}catch{continue;}
            if(record.sessionId!==meta.sessionId)continue;
            const parsed=parseRecord('claude-code',record,0);
            if(parsed?.kind==='session_title'){
              if(!custom||parsed.data.titleType==='custom')sourceTime=parsed.timestamp;
              if(parsed.data.titleType==='custom')custom=parsed.data.title;
              title=custom??parsed.data.title;
            }
          }
        } finally {lines.close();stream.destroy();}
        if(!title||title===meta.capturedTitle)return;
        enqueue(config,{...meta,captureMode:'history'},[{id:hash('claude-title:'+meta.sessionId+':'+st.mtimeMs+':'+title),kind:'session_title',sequence:0,timestamp:st.mtime.toISOString(),sourceTime,data:{title,titleType:custom?'custom':'auto'}}],[]);
        meta.capturedTitle=title;if(custom){meta.customTitle=custom;meta.customTitleTime=sourceTime;}
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
  if(config.harnesses&&!config.harnesses.includes(harness))return;
  ensureDirectories();
  const id=randomUUID(),at=new Date().toISOString();
  if(harness==='grok-bot'||harness==='cursor'||harness==='devin') {
    if(!event||typeof event!=='object'||Array.isArray(event))throw new CliError('CAPTURE_EVENT_INVALID','Hook payload is not an object');
    // Prepared with --defer-auth and nobody has signed in: a computer whose
    // owner never opts in must not accumulate what their Bots do.
    if(config.authPending)return;
    if(!config.harnesses?.includes(harness))return;
    const session=harness==='devin'?devinSession(event):harness==='cursor'?cursorSession(event):grokBotSession(event,at);
    if(captureExcluded(config,{harness,sessionId:session.sessionId,cwd:session.cwd??undefined}))return;
    // Hook payloads carry no time or order. Microseconds since the epoch keep
    // events from separate hook processes in the order they were recorded.
    let sequence=Math.round((performance.timeOrigin+performance.now())*1000);
    if(harness==='cursor'||harness==='devin'){const clock=join(captureDir(),harness+'-sequence.json');sequence=Math.max(sequence,Number(read(clock,0))+(harness==='devin'?3:2));if(!Number.isSafeInteger(sequence+2))throw new CliError('CAPTURE_EVENT_INVALID','Native hook sequence exceeds the supported range');atomicJson(clock,sequence);}
    const bytes=Buffer.byteLength(JSON.stringify(event));
    const maxBytes=harness==='devin'?DEVIN_MAX_HOOK_BYTES:GROK_BOT_MAX_HOOK_BYTES,unsupported=harness==='devin'?devinUnsupported:grokBotUnsupported;
    const payload=bytes>maxBytes?unsupported(event,'too_large',bytes):event;
    if(Buffer.byteLength(JSON.stringify(payload))>maxBytes)throw new CliError('CAPTURE_HOOK_TOO_LARGE','Native hook metadata exceeds the local handoff limit');
    atomicJson(join(captureDir(),'notices',id+'.json'),{id,at,sequence,harness,event:payload});
    return;
  }
  if(harness==='antigravity') {
    if(!event||typeof event!=='object'||Array.isArray(event))throw new CliError('CAPTURE_EVENT_INVALID','Hook payload is not an object');
    const {sessionId,cwd}=antigravityHookFields(event);
    if(typeof sessionId!=='string' || !/^[\w.:-]{1,200}$/.test(sessionId))throw new CliError('CAPTURE_SESSION_UNKNOWN','Hook missing session ID');
    if(captureExcluded(config,{harness,sessionId,cwd}))return;
    atomicJson(join(captureDir(),'notices',id+'.json'),{id,at,harness,event});
    return;
  }
  const sessionId=event?.session_id;
  if(typeof sessionId!=='string' || !/^[\w.:-]{1,200}$/.test(sessionId))throw new CliError('CAPTURE_SESSION_UNKNOWN','Hook missing session ID');
  if(captureExcluded(config,{harness,sessionId,cwd:event.cwd}))return;
  atomicJson(join(captureDir(),'notices',id+'.json'),{id,at,harness,event});
  // Synchronous hooks (Grok Bot, Cursor, Antigravity) give up on a held lock rather than queue behind it.
  },harness==='grok-bot'||harness==='cursor'||harness==='antigravity'||harness==='devin'?2000:Infinity);
}

export type CaptureHookNotice={id:string,at:string,sequence?:number,harness:Harness,event:any};

/** Shared Cursor conversion and occurrence deduplication. The daemon calls this
 * only with the exact session and transcript supplied by a native hook. */
export async function captureCursorNotice(config:CaptureConfig,notice:CaptureHookNotice,transcriptOnly=false) {
  ensureDirectories();
  const session=cursorSession(notice.event);
  return withSessionLock('capture:cursor:'+session.sessionId,async()=>{
  const session=cursorSession(notice.event),stateFile=join(captureDir(),'state','cursor-'+hash(session.sessionId)+'.json');
  const state=read(stateFile,{offset:0,hooks:{},transcript:{},emitted:{}});
  if(!transcriptOnly&&state.lastNotice===notice.id)return;
  if(!transcriptOnly&&notice.event.hook_event_name==='sessionStart'){state.startSequence=notice.sequence;state.startAt=notice.at;}
  if(!transcriptOnly)state.thoughtHooks=cursorThoughtState(state.thoughtHooks,notice.event);
  if(session.origin!=='unknown')state.origin=session.origin;
  const meta={harness:'cursor',sessionId:session.sessionId,cwd:session.cwd,origin:state.origin??session.origin,originEvidence:session.originEvidence,parentSessionId:session.parentSessionId,captureMode:'live',harnessVersion:session.version};
  if(captureExcluded(readCaptureConfig()??config,meta))return;
  const messages=(event:any,source:'hooks'|'transcript')=>{
    let signature;
    if(event.kind==='message') {
      event.data=cursorMessage(event.data);signature=[event.data.role,event.data.content];
      // sessionStart may run only once for a conversation. Its time belongs
      // to the first prompt, never to a later resumed turn.
      if(event.data.role==='user'){delete state.startSequence;delete state.startAt;}
    } else if(event.kind==='reasoning_summary'&&Array.isArray(event.data?.summary)) {
      // Cursor also writes thought text as an ordinary assistant transcript
      // message. Keep its explicit thought hook, not a second visible reply.
      const text=event.data.summary.map((block:any)=>block.text??'').join('');
      signature=['assistant',[{type:'text',text}]];
    } else return event;
    const key=hash(JSON.stringify(signature));
    const count=(state[source][key]??0)+1;state[source][key]=count;
    if(count<=(state.emitted[key]??0))return null;
    state.emitted[key]=count;
    if(source==='transcript'){event.sequence=Math.max(event.sequence,(state.lastTranscriptSequence??0)+1);state.lastTranscriptSequence=event.sequence;}
    return event;
  };
  let events:any[]=[],attachments:any[]=[],eventBytes=0;
  const commit=()=>{
    if(events.length)enqueue(config,meta,events,attachments);
    atomicJson(stateFile,state);events=[];attachments=[];eventBytes=0;
  };
  const file=notice.event.transcript_path;
  const scanStart=new Date().toISOString(),policy=confirmedPermission(read(recordingPath(config)) as RecordingPermission|undefined);
  // Text transcript metadata is not the native JSONL fallback. Keep the
  // authoritative content hooks working without opening referenced text.
  if(typeof file==='string'&&file.endsWith('.jsonl')&&existsSync(file)) {
    const transcriptState={offset:state.offset,ino:state.ino,checkpoint:state.checkpoint,identity:state.identity};
    for(const record of cursorTranscript(harnessRoot(config,'cursor'),session.sessionId,file,transcriptState.offset,transcriptState.ino,transcriptState.checkpoint,{forwardBoundary:state.forwardBoundary===true,skipPartial:state.skipPartial===true,identity:transcriptState.identity})) {
      if(record.forwardRebased){
        state.hooks={};state.transcript={};state.emitted={};delete state.thoughtHooks;delete state.startSequence;delete state.startAt;
        recordError(new CliError('CAPTURE_CURSOR_BOUNDARY_CHANGED','Cursor rewrote a pre-consent transcript boundary; earlier bytes remain excluded. New appended records and native content hooks continue.'));
      }
      if(record.start===0&&(state.offset>0||state.ino!==undefined&&state.ino!==record.ino)){state.transcript={};state.offset=0;delete state.scannedAt;}
      if(record.data && (!policy?.windows.length || allowedTime(policy,scanStart,state.scannedAt??null))) {
        const event=messages({sourceTimeFrom:state.scannedAt??null,sourceTime:scanStart,id:hash('cursor-transcript:'+session.sessionId+':'+record.start),kind:'message',sequence:record.data.role==='user'?(state.startSequence??notice.sequence):notice.sequence,
          timestamp:record.data.role==='user'?(state.startAt??notice.at):notice.at,nativeId:null,parentId:null,turnId:notice.event.generation_id??null,agentId:null,data:record.data},'transcript');
        if(event){const transformed=attachmentTransform(event,attachments,session.cwd??homedir());events.push(transformed);eventBytes+=Buffer.byteLength(JSON.stringify(transformed));}
      }
      state.offset=record.offset;state.ino=record.ino;state.identity=record.identity;state.checkpoint=record.checkpoint;state.skipPartial=record.skipPartial;
      if(events.length>=100||attachments.length>=8||eventBytes>=1024*1024){await yieldToOwner();commit();}
    }
    // A trailing partial line may already contain bytes from the pause.
    // Only a complete, unchanged EOF proves a lower bound for the next record.
    const tail=statSync(file);
    if(state.ino===tail.ino&&state.offset===tail.size)state.scannedAt=scanStart;
  }
  for(const event of transcriptOnly?[]:grokBotEvents(notice)) {
    if(cursorThoughtDuplicate(state.thoughtHooks,notice.event))continue;
    const next=messages({...event,sourceTime:notice.at},'hooks');if(next)events.push(attachmentTransform(next,attachments,session.cwd??homedir()));
  }
  if(!transcriptOnly)state.lastNotice=notice.id;commit();
  },Infinity);
}

/** Recover records from before this fresh installation could receive hooks.
 * Never feed provider results through attachment discovery: provider tool
 * inputs are text and must not trigger filesystem reads. */
export async function captureDevinStartup(config:CaptureConfig,sessionId:string,read=request) {
  const meta={harness:'devin',sessionId,origin:'cloud',originEvidence:'Devin Cloud session events',captureMode:'live'};
  const selected=()=>{
    const current=readCaptureConfig();
    return current && !current.authPending && !current.disabled && current.hookOwnership==='plugin' &&
      current.api===config.api && current.installationId===config.installationId && current.installedAt===config.installedAt &&
      current.owner.tenantId===config.owner.tenantId && current.owner.userId===config.owner.userId &&
      current.harnesses?.includes('devin') && !captureExcluded(current,meta);
  };
  if(process.env.OPENCRAWL_AUTH!=='devin-cloud'||!selected())return;
  let result;
  try {
    result=await read(config.api,'/api/cli/workloads/devin/startup-events',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({installationId:config.installationId,through:config.installedAt})});
  } catch(error:any) {
    if(error.responseCode==='DEVIN_SESSION_PRIVATE' && selected()) {
      const {markPrivate,purgePrivateQueue}=await import('../incognito.ts');
      if(selected()){markPrivate(config,meta);await purgePrivateQueue(config,meta);}
      return;
    }
    if(error.responseCode==='DEVIN_RECORDING_CREDENTIAL_REQUIRED'||error.httpStatus===404) {
      if(selected()) {
        const code=error.httpStatus===404?'DEVIN_STARTUP_GAP':'DEVIN_RECORDING_CREDENTIAL_REQUIRED';
        recordError(new CliError(code,'Devin first-turn capture is unavailable. Check the recording credential and receiver version.'));
      }
      return;
    }
    if(error.httpStatus===403)return;
    throw error;
  }
  if(!selected())return;
  if(result?.sessionId!==sessionId || !Array.isArray(result.events) || result.events.length>1000 ||
    !result.events.every((event:any)=>event && typeof event.nativeId==='string' && /^event-[a-zA-Z0-9_-]{1,160}$/.test(event.nativeId) &&
      event.id==='devin-event:'+event.nativeId && ['message','tool_call','tool_result'].includes(event.kind) &&
      typeof event.timestamp==='string' && Number.isFinite(Date.parse(event.timestamp)) && Date.parse(event.timestamp)<=Date.parse(config.installedAt))) {
    throw new CliError('DEVIN_EVENTS_INVALID','The server returned invalid Devin startup records.');
  }
  if(result.events.length)enqueue(config,meta,result.events,[]);
  // The provider timeline may lag the native hook. Retrying the same cutoff
  // yields the same event identities. Never advance it to the retry time.
  const age=Date.now()-Date.parse(config.installedAt);
  if(age<30_000 || !result.events.length && age<300_000)throw new CliError('DEVIN_EVENTS_PENDING','Waiting for the original Devin startup events.');
  if(!result.events.length)recordError(new CliError('DEVIN_STARTUP_GAP','The provider did not return an eligible initial prompt.'));
}

/** Worker-side event conversion shares the existing redaction, attachment,
 * identity and durable spool boundaries. There is no network or source scan. */
export async function spoolDaemonEvent(config:CaptureConfig,notice:CaptureHookNotice) {
  ensureDirectories();
  if(notice.harness==='cursor')return captureCursorNotice(config,notice);
  const attachments:any[]=[];
  if(notice.harness==='devin') {
    const session=devinSession(notice.event);
    const meta={harness:notice.harness,sessionId:session.sessionId,cwd:session.cwd??undefined,origin:'cloud',
      originEvidence:'Devin Cloud native session hook',parentSessionId:null,captureMode:'live'};
    const assertCurrent=()=>{
      const current=readCaptureConfig();
      if(!current||current.authPending||current.api!==config.api||current.installationId!==config.installationId||current.owner.tenantId!==config.owner.tenantId||current.owner.userId!==config.owner.userId)
        throw new CliError('CAPTURE_CONFIG_CHANGED','Capture enrollment changed; the original Devin notice is retained.');
      if(current.disabled||!current.harnesses?.includes('devin')||captureExcluded(current,meta))
        throw new CliError('CAPTURE_CONSENT_CHANGED','Forward Devin recording is no longer enabled; the original notice is retained.');
    };
    assertCurrent();
    const overflow=await devinOverflow(notice.event);
    // Overflow recovery yields to config changes. Recheck before reading any
    // attachment or writing a batch; never bind the old notice to a new owner.
    assertCurrent();
    let events;
    try {
      events=devinEvents(notice,overflow).map(event=>attachmentTransform(event,attachments,session.cwd??homedir()));
      events.forEach(finalizeEventIdentity);
      if(attachments.length>500||Buffer.byteLength(JSON.stringify(events))>12*1024*1024)
        throw new CliError('CAPTURE_EVENT_INVALID','Devin hook payload exceeds what one batch can carry');
    } catch(error:any) {
      if(!['CAPTURE_EVENT_TOO_DEEP','CAPTURE_EVENT_INVALID'].includes(error?.code))throw error;
      attachments.length=0;
      events=devinEvents({...notice,event:devinUnsupported(notice.event,'unsupported',Buffer.byteLength(JSON.stringify(notice.event)))});
    }
    enqueue(config,meta,events,attachments);return;
  }
  if(notice.harness==='grok-bot') {
    const session=grokBotSession(notice.event,notice.at);
    const meta={harness:notice.harness,sessionId:session.sessionId,conversationId:session.conversationId,cwd:session.cwd,origin:'cloud',
      originEvidence:session.identified?'Grok Bot cloud computer hook':'Grok Bot hook without a conversation ID; grouped by workspace and UTC day',parentSessionId:null,harnessVersion:session.version,captureMode:'live'};
    const events=grokBotEvents(notice).map(event=>attachmentTransform(event,attachments,session.cwd??homedir()));
    if(session.title)events.unshift(grokBotTitleEvent(session.sessionId,session.title,session.day));
    enqueue(config,meta,events,attachments);return;
  }
  const fields=notice.harness==='antigravity'?antigravityHookFields(notice.event):{sessionId:notice.event.session_id,cwd:notice.event.cwd};
  const meta={harness:notice.harness,sessionId:fields.sessionId,cwd:fields.cwd,origin:'unknown',originEvidence:null,parentSessionId:null,captureMode:'live'};
  const data=attachmentTransform(notice.event,attachments,fields.cwd??homedir());
  enqueue(config,meta,[{id:notice.id,kind:'hook',timestamp:notice.at,data}],attachments);
}

// The original event is kept only until its immutable batch is spooled. Its ID
// and timestamp survive a crash between enqueue and notice removal.
export async function drainCaptureNotices(config=readCaptureConfig()!,{until=Infinity}:{until?:number}={}) {
  ensureDirectories();
  return withSessionLock('capture:notices',async()=>{
  let processed=0,firstError:any;const blockedCursorSessions=new Set<string>();
  // Grok Bot notices are the conversation itself, not pointers to a transcript.
  // They are spooled in bounded rounds: a backlog never has to fit in memory,
  // and a hook can stop between rounds with its progress kept.
  type GrokBotNotice={path:string,notice:any};
  let round:GrokBotNotice[]=[],roundBytes=0;
  const spoolRound=async()=>{
    const groups=new Map<string,{meta:any,title:any,notices:GrokBotNotice[]}>();
    for(const item of round) {
      const harness=item.notice.harness,session=harness==='cursor'?cursorSession(item.notice.event):grokBotSession(item.notice.event,item.notice.at),key=JSON.stringify([harness,session.sessionId,session.cwd]);
      const group=groups.get(key)??{meta:{harness,sessionId:session.sessionId,origin:harness==='cursor'?(session as ReturnType<typeof cursorSession>).origin:'cloud',
        originEvidence:harness==='cursor'?'Cursor native conversation hook':session.identified?'Grok Bot cloud computer hook':'Grok Bot hook without a conversation ID; grouped by workspace and UTC day',
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
  for(const name of orderedNoticeNames()) {
    await yieldToOwner();
    if(Date.now()>=until)break;
    const path=join(captureDir(),'notices',name),notice=read(path);
    if(!notice)continue;
    if(notice.harness==='cursor') {
      const native=notice.event?.conversation_id||notice.event?.session_id;
      if(blockedCursorSessions.has(native))continue;
      try {
        await captureCursorNotice(config,notice);
        unlinkSync(path);syncDirectory(dirname(path));processed++;
      }catch(error){firstError??=error;blockedCursorSessions.add(native);}
      continue;
    }
    if(notice.harness==='devin'){
      try{await spoolDaemonEvent(config,notice);unlinkSync(path);syncDirectory(dirname(path));processed++;}
      catch(error){firstError??=error;}
      continue;
    }
      if(notice.harness==='grok-bot') {
      round.push({path,notice});roundBytes+=statSync(path).size;
      if(round.length>=200||roundBytes>=16*1024*1024)await spoolRound();
      continue;
    }
    try {
    const {harness,event,id,at}=notice;
    const hookFields=harness==='antigravity'?antigravityHookFields(event):{sessionId:event.session_id,transcriptPath:event.transcript_path,cwd:typeof event.cwd==='string'?event.cwd:undefined};
    const rawFile=hookFields.transcriptPath || findTranscript(config,harness,hookFields.sessionId!);
    const file=harness==='antigravity'&&rawFile?resolveAntigravityTranscript(rawFile):rawFile;
    const defaultOrigin=harness==='antigravity'?(file?antigravityPathMeta(file).origin:'cli'):(process.env.CLAUDE_CODE_REMOTE==='true'?'cloud':'unknown');
    // Persist the source BEFORE retiring the notice; a tail written after Stop
    // remains discoverable on this worker's polls and the next CLI invocation.
    const source={harness,sessionId:hookFields.sessionId,path:file??null,cwd:hookFields.cwd,origin:defaultOrigin};
    atomicJson(join(captureDir(),'sources',hash(harness+':'+hookFields.sessionId+':'+(file??''))+'.json'),source);
    const meta=file && existsSync(file) ? await captureTranscript(config,harness,file,event) :
      {harness,sessionId:hookFields.sessionId,origin:source.origin,originEvidence:null,parentSessionId:null,...(hookFields.cwd?{cwd:hookFields.cwd}:{})};
    if(harness==='claude-code'&&typeof event.agent_transcript_path==='string'&&event.agent_transcript_path!==file){
      const child=event.agent_transcript_path;
      atomicJson(join(captureDir(),'sources',hash(harness+':'+hookFields.sessionId+':'+child)+'.json'),{...source,path:child});
      if(existsSync(child))await captureTranscript(config,harness,child,event);
    }
    if(!captureExcluded(readCaptureConfig()??config,{...meta,cwd:meta?.cwd??hookFields.cwd})) {
      const attachments:any[]=[];
      const data=attachmentTransform(event,attachments,hookFields.cwd??homedir());
      enqueue(config,{...meta,cwd:meta?.cwd??hookFields.cwd,captureMode:'live'},[{id,kind:'hook',timestamp:at,data}],attachments);
    }
    unlinkSync(path);syncDirectory(dirname(path));processed++;
    }catch(error){firstError??=error;}
  }
  await spoolRound();
  if(firstError)throw firstError;
  return processed;
  },Infinity);
}

async function reconcileSources(config:CaptureConfig,seen:Map<string,string>,until=Infinity) {
  let changed=false;
  const names=readdirSync(join(captureDir(),'sources')).filter(n=>n.endsWith('.json')).sort();
  const progressFile=join(captureDir(),'source-scan.json'),after=read(progressFile)?.after;
  const next=typeof after==='string'?names.findIndex(name=>name>after):0,start=next<0?0:next;
  let visited:string|undefined;
  try {for(const name of [...names.slice(start),...names.slice(0,start)]) {
    await yieldToOwner();
    // Leave the rest for a later pass without restarting at the same stale
    // entries. This scheduling cursor never advances a transcript's byte cursor.
    if(Date.now()>=until)break;
    visited=name;
    const sourceFile=join(captureDir(),'sources',name),source=read(sourceFile);
    if(captureExcluded(config,source))continue;
    const rawPath=source.path || findTranscript(config,source.harness,source.sessionId);
    const path=source.harness==='antigravity'&&rawPath?resolveAntigravityTranscript(rawPath):rawPath;
    if(!path || !existsSync(path))continue;
    if(source.path!==path){source.path=path;atomicJson(sourceFile,source);}
    const st=statSync(path),signature=JSON.stringify([st.dev,st.ino,st.size,st.mtimeMs,source.harness==='codex'?codexTitleSignature(config.roots.codex):'']);
    if(seen.get(path)===signature)continue;
    await captureTranscript(config,source.harness,path,{session_id:source.sessionId,conversationId:source.sessionId,cwd:source.cwd});
    seen.set(path,signature);changed=true;
  }}finally{if(visited!==undefined)atomicJson(progressFile,{after:visited});}
  return changed;
}

// Rejected bytes stay in the original queue for recovery and blob retention.
// A content-bound marker removes only that exact payload from automatic retries.
function rejectedCapture(name:string) {
  const marker=read(join(captureDir(),'rejected',name));
  if(marker?.status!==413)return false;
  try{return marker.digest===hash(readFileSync(join(captureDir(),'queue',name)));}
  catch(error:any){if(error.code==='ENOENT')return false;throw error;}
}
const queuedNames=(includeRejected=false)=>readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json')&&(includeRejected||!rejectedCapture(n)));
const rejectedNames=()=>existsSync(join(captureDir(),'queue'))?queuedNames(true).filter(rejectedCapture):[];
const rejectedNotice=(count:number)=>`${count} capture batch${count===1?' was':'es were'} rejected with HTTP 413 and held locally without automatic retries. Other sessions can continue uploading. Resolve the receiver payload/session limit, then run \`opencrawl collect flush --retry-rejected\`. Original queued data and attachments are retained.`;

const noticeNames=()=>readdirSync(join(captureDir(),'notices')).filter(n=>n.endsWith('.json'));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
/** Bound the CLI process, including blocked locks, HTTP retries and large queues.
 * Durable notices/batches are the recovery boundary: an interrupted request keeps
 * its original queued bytes until a later invocation verifies the receipt.
 * This watchdog runs in the owned process; it never launches a supervisor.
 */
export async function ownedCaptureWorker({maxMs=90_000,parentPollMs=1000,flushMs=LIVE_FLUSH_MS}={}) {
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
  const deadline=setTimeout(()=>exitAfterCredentialRotation(0),maxMs);
  const parentCheck=setInterval(()=>{if(ownerGone())exitAfterCredentialRotation(0);},parentPollMs);
  // Give the final locally recorded window an upload opportunity before the
  // owned process's hard deadline. A blocked upload still leaves exact bytes.
  try{await captureWorker({flushMs,flushBy:Date.now()+Math.max(0,maxMs-flushMs)});}
  finally{clearTimeout(deadline);clearInterval(parentCheck);}
}

/** One lazy worker per installation; contention is an ordinary successful wake. */
export const LIVE_FLUSH_MS=10_000;
export async function captureWorker({idleMs=30_000,pollMs=1000,flushMs=LIVE_FLUSH_MS,flushBy=Infinity}={}) {
  if(!Number.isFinite(flushMs)||flushMs<0)throw new CliError('INVALID_USAGE','Invalid live capture flush interval');
  const config=readCaptureConfig();if(!config||config.disabled)return;
  ensureDirectories();
  let observedNotices:string[]=[];
  for(;;) {
  try {
    await withSessionLock('capture:worker',async()=>{
      const seen=new Map<string,string>();let activeAt=Date.now(),failures=0;
      const windowFile=join(captureDir(),'live-window.json');
      const liveWindow=()=>{
        const pendingSince=pendingLiveSince(captureDir());
        let window=read(windowFile);
        if(pendingSince!==undefined&&!window){window={dueAt:pendingSince+flushMs};atomicJson(windowFile,window);}
        if(window&&pendingSince===undefined){unlinkSync(windowFile);window=null;}
        return {
          ready:flushMs===0||Date.now()>=flushBy||Boolean(window&&(!Number.isFinite(window.dueAt)||Date.now()>=window.dueAt)),
          until:window&&Number.isFinite(window.dueAt)?window.dueAt:Infinity,
        };
      };
      const flushQueued=async(maxBatches?:number)=>{
        const {ready}=liveWindow();
        if(queuedNames().some(name=>ready||!isPendingLive(captureDir(),name))){
          const result=await flushCaptures({wait:false,liveReady:ready,maxBatches});if(result.uploaded)activeAt=Date.now();
          if(ready&&existsSync(windowFile))unlinkSync(windowFile);
        }
      };
      while(readCaptureConfig() && !readCaptureConfig()!.disabled) {
        let captureError:any;
        try {
          if(config.authPending)await refreshCaptureIdentity(config);
          // Existing due bytes must not wait behind a catalogue scan. Keep this
          // first upload wave bounded so new local notices also make progress.
          await flushQueued(4);
          const until=Math.min(flushBy,liveWindow().until,Date.now()+LIVE_FLUSH_MS);
          const processed=await drainCaptureNotices(config,{until});
          // New notices may have opened an earlier live window. Yield before
          // another source at either that window or the owned flush deadline.
          const changed=await reconcileSources(config,seen,Math.min(until,liveWindow().until));
          if(processed||changed)activeAt=Date.now();
        }catch(error){captureError=error;}
        try {
          await flushQueued();
        }catch(error){captureError??=error;}
        if(captureError){recordError(captureError);failures++;}
        else {
          failures=0;
          observedNotices=noticeNames();
          if(!observedNotices.length&&!queuedNames().length&&!existsSync(windowFile)&&Date.now()-activeAt>=idleMs)break;
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
/** Metadata only: capture ingress is distinct from startup tasks and held work. */
export function daemonIngressStatus(){
  const names=(part:string)=>{const directory=join(captureDir(),'daemon',part);try{return readdirSync(directory);}catch(error:any){if(error.code==='ENOENT')return [];throw error;}};
  const inbox=names('inbox'),sessions=names('sessions');
  return {capture:inbox.filter(name=>name.endsWith('.json')&&!name.startsWith('startup-')).length,
    startup:inbox.filter(name=>name.endsWith('.json')&&name.startsWith('startup-')).length,
    heldCapture:inbox.filter(name=>name.endsWith('.held')&&!name.startsWith('startup-')).length,
    heldStartup:inbox.filter(name=>name.endsWith('.held')&&name.startsWith('startup-')).length,
    sessions:sessions.filter(name=>name.endsWith('.json')).length,heldSessions:sessions.filter(name=>name.endsWith('.held')).length};
}
async function flushDaemonQueue({retryRejected=false,paused=false}:{retryRejected?:boolean;paused?:boolean}={}){
  const result=paused||!existsSync(join(captureDir(),'queue'))||!queuedNames(true).length?{uploaded:0}:await flushCaptures({retryRejected});
  const daemonIngress=daemonIngressStatus(),pendingLegacyHooks=existsSync(join(captureDir(),'notices'))?noticeNames().length:0;
  return {...result,mode:'daemon-queue-only',daemonIngress,pendingHooks:pendingLegacyHooks+daemonIngress.capture,pendingLegacyHooks,
    ...(daemonIngress.capture||daemonIngress.startup?{nextStep:'Background ingress remains with the supervised worker. This command flushed only existing batches; it did not parse sessions or complete pending startup tasks.'}:{})};
}
/** Explicit flush waits for capture and upload ownership, then fences current sources. */
export async function flushCaptureWork({retryRejected=false}: {retryRejected?:boolean}={}) {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  await (await import('../incognito.ts')).retryPrivacy(config);
  if(captureDaemonEnabled(config))return flushDaemonQueue({retryRejected});
  if(!config.disabled){if(config.authPending)await refreshCaptureIdentity(config);await drainCaptureNotices(config);await reconcileSources(config,new Map());}
  return flushCaptures({retryRejected});
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
  const eventName=event?.hook_event_name??event?.hookEventName;
  const boundary=GROK_BOT_BOUNDARIES.includes(eventName)||['SessionStart','PostInvocation','Stop'].includes(eventName);
  const gap=failures?Math.min(60_000*2**(failures-1),900_000):boundary?0:20_000;
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
  if(!workspaceIdentityEnabled()&&!staticCaptureToken(config.api)&&!readSession(config.api))return;
  return hookPass(event,now,async pending=>{await refreshCaptureIdentity(pending);});
}
export const hookFlush=(event:any,{now=Date.now,reconcileTranscripts=true}={})=>readCaptureConfig()?.authPending?Promise.resolve():hookPass(event,now,async config=>{
  let failure:any;
  // Cursor-format notices already reconcile their active transcript. Those
  // hooks must not spend their five-second budget scanning other clients' old
  // sources. Transcript-only harnesses retain late-tail reconciliation.
  try{const deadline=Date.now()+2500;await drainCaptureNotices(config,{until:deadline});if(reconcileTranscripts&&Date.now()<deadline)await reconcileSources(config,new Map(),deadline);}catch(error){failure=error;}
  // One concurrent wave leaves time to checkpoint receipts before the watchdog.
  // Oldest/newest scheduling still advances both retained and current activity.
  try{if(queuedNames().length)await flushCaptures({wait:false,maxBatches:4});}catch(error){failure??=error;}
  if(failure)throw failure;
});

export async function syncCaptures() {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  if(captureDaemonEnabled(config))return flushDaemonQueue({paused:config.disabled});
  if(config.disabled)return {uploaded:0};
  if(config.authPending)await refreshCaptureIdentity(config);
  const errors:any[]=[];
  for(const harness of (config.harnesses??['claude-code','codex'] as Harness[]).filter(readsTranscript)) {
    const root=config.roots[harness];if(!root)continue;
    const paths=harness==='antigravity'?walkAntigravityTranscripts(root):(function*(){for(const dir of harness==='codex'?['sessions','archived_sessions']:['projects'])yield*walk(join(root,dir));})();
    for(const path of paths) {
      // Installation enrolls new/active sessions; it never silently imports all historical conversations.
      if(statSync(path).mtimeMs<Date.parse(config.installedAt))continue;
      try{await captureTranscript(config,harness,path);}catch(e){errors.push(e);}
    }
  }
  const result=await flushCaptures();
  if(errors.length){recordError(errors[0]);throw errors[0];}
  return result;
}
export async function flushCaptures({wait=true,concurrency,batchDelayMs=0,onUploaded,retryRejected=false,liveReady=true,maxBatches}: {wait?:boolean;concurrency?:number;batchDelayMs?:number;onUploaded?:()=>void;retryRejected?:boolean;liveReady?:boolean;maxBatches?:number}={}) {
  const workers=concurrency??(wait?1:4);
  const limit=maxBatches??(wait?Infinity:32);
  if(maxBatches!==undefined&&(!Number.isInteger(maxBatches)||maxBatches<1))throw new CliError('INVALID_USAGE','Capture batch limit must be a positive integer.',64);
  if(!Number.isInteger(workers)||workers<1||workers>4)throw new CliError('INVALID_USAGE','Capture upload concurrency must be between 1 and 4.',64);
  if(!Number.isInteger(batchDelayMs)||batchDelayMs<0||batchDelayMs>60000)throw new CliError('INVALID_USAGE','Capture batch delay must be between 0 and 60000 milliseconds.',64);
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  ensureDirectories();
  return withSessionLock('capture:flush',async()=>{
    // Local recording never waits for the network window. Only batches with a
    // never-attempted marker can be combined, and every seal completes before HTTP.
    recoverLiveSeals(captureDir());
    if(liveReady)sealLiveBatches(captureDir());
    const attachments=attachmentReceipts(join(captureDir(),'attachment-receipts-v1.json'));
    // A concurrent login must not switch the identity between the initial check
    // and blob writes. If this credential expires, retain the queue for a retry.
    const staticToken=staticCaptureToken(config.api);
    let token=staticToken||(workspaceIdentityEnabled()?await workspaceToken(config.api):await accessToken(config.api));
    const identity=await captureIdentity(config,token),principal=identity.principal;
    if(identity.recording?.paused){
      const {until,observedAt}=identity.recording;
      const remaining=until!==null && observedAt!==undefined ? Math.max(1,until-observedAt) : Infinity;
      const recordingCheckAt=Date.now()+Math.min(10_000,remaining);
      const confirmed=confirmedPermission(identity.recording);
      // Retire confirmed private bytes without reading attachment blobs. Publish a
      // sanitized replacement first so an interrupted cleanup preserves eligible events.
      if(confirmed)for(const name of queuedNames().filter(n=>!isPendingLive(captureDir(),n))){
        const path=join(captureDir(),'queue',name),batch=read(path);
        if(batch?.owner?.userId!==principal.userId||batch.owner.tenantId!==principal.tenantId)continue;
        const kept=permittedBatch(batch,confirmed);
        if(kept?.events.length===batch.events.length)continue;
        if(kept){const bytes=JSON.stringify(kept);enqueueLiveBatch(captureDir(),hash(bytes)+'.json',bytes,false);}
        retryWindowsSharing(()=>unlinkSync(path));
      }
      if(wait)throw new CliError('RECORDING_PAUSED','Your recording is paused in this workspace.');
      return {uploaded:0,recordingCheckAt};
    }
    const recordingHeaders:Record<string,string>=identity.recording?{'x-opencrawl-recording':identity.recording.revision}:{};
    token=identity.token??token;
    let useGzip=identity.gzip,cursorSupported=identity.cursor,antigravitySupported=identity.antigravity;
    // A long flush outlives a short-lived sign-in token. Renew before each request
    // and after a rejection, re-verifying identity whenever the token changes.
    const adopt=async(next:string)=>{
      if(next===token)return token;
      const refreshed=await captureIdentity(config,next),current=refreshed.principal;
      useGzip=refreshed.gzip;cursorSupported=refreshed.cursor;antigravitySupported=refreshed.antigravity;
      if(refreshed.recording?.paused||refreshed.recording?.revision!==identity.recording?.revision)throw new CliError('CAPTURE_PERMISSION_CHANGED','Recording permission changed. Recheck the queue before uploading.');
      if(current.userId!==principal.userId)throw new CliError('CAPTURE_OWNER_MISMATCH','Signed-in user changed during upload. Sign back in as the queued author; queued data is retained.');
      if(current.tenantId!==principal.tenantId)throw new CliError('CAPTURE_DESTINATION_CHANGED','Signed-in team changed during upload. Sign back into the original destination; queued data is retained.');
      return token=refreshed.token??next;
    };
    const current=async()=>staticToken||await adopt(workspaceIdentityEnabled()?await workspaceToken(config.api):await accessToken(config.api));
    const renew=staticToken?undefined:async(rejected:string)=>adopt(workspaceIdentityEnabled()?await workspaceToken(config.api,rejected):await accessToken(config.api,rejected));
    const unsupported=new Set<string>();
    let uploaded=0,excluded=0,visited=0,scheduled=0,stopped=false,failure:unknown,nextUploadAt=0;
    if(retryRejected)for(const name of rejectedNames())retryWindowsSharing(()=>unlinkSync(join(captureDir(),'rejected',name)));
    let names=queuedNames().filter(name=>!isPendingLive(captureDir(),name));
    if(!wait){
      // Split capacity between draining old work and making fresh activity
      // visible. Filename hashes have no useful chronological ordering.
      const dated=names.map(name=>({name,mtime:statSync(join(captureDir(),'queue',name)).mtimeMs}));
      dated.sort((a,b)=>a.mtime-b.mtime||a.name.localeCompare(b.name));
      names=[];
      for(let lo=0,hi=dated.length-1;lo<=hi;){names.push(dated[lo++].name);if(lo<=hi)names.push(dated[hi--].name);}
    }
    const deadline=wait?Infinity:Date.now()+10_000;
    // This file is a status snapshot. Event durability comes from the queue,
    // cursor and verified remote receipt, whose write ordering stays unchanged.
    // Coalesce status-only fsyncs to once per second and always checkpoint the
    // latest success after settling the flush, including a partially failed pass.
    let pendingReceipt:Record<string,unknown>|undefined,lastReceiptWrite=-Infinity;
    const checkpointReceipt=()=>{
      if(!pendingReceipt)return;
      atomicJson(join(captureDir(),'last-upload.json'),pendingReceipt);
      pendingReceipt=undefined;lastReceiptWrite=performance.now();
    };
    const upload=async(name:string,batch:any)=>{
      const path=join(captureDir(),'queue',name);
      batch=prepareCaptureUpload(batch);
      const serialized=JSON.stringify(batch),size=Buffer.byteLength(serialized);
      const attachmentScope={api:config.api,tenantId:principal.tenantId,userId:principal.userId,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId};
      // Honor checkpoints retained by older clients, then reuse verified blob
      // receipts across batches within the exact remote storage scope.
      const checkpoint=join(captureDir(),'uploads',hash(JSON.stringify([config.api,hash(serialized)]))+'.json');
      const saved=read(checkpoint),acknowledged=new Set<string>(Array.isArray(saved?.attachments)?saved.attachments:[]);
      for(const a of batch.attachments)if(a.status==='captured'&&!acknowledged.has(a.sha256)){
        await attachments.ensure(attachmentScope,a.sha256,async()=>{
          const bytes=readCaptureAttachment(a.sha256);
          const receipt=await request(config.api,'/api/sessions/attachments/'+a.sha256+'?'+new URLSearchParams({harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId}),{method:'PUT',headers:{'content-type':'application/octet-stream',...recordingHeaders,...identity.recording?.windows.length&&{'x-opencrawl-event-time':batch.events[0].timestamp}},body:bytes},await current(),renew);
          if(receipt?.sha256!==a.sha256||receipt.size!==bytes.length||receipt.discarded!==undefined&&receipt.discarded!=='session_deleted')throw new CliError('CAPTURE_RECEIPT_INVALID','Server did not confirm the attachment digest and size');
          return receipt.discarded===undefined;
        });
        acknowledged.add(a.sha256);
      }
      let body:string|Uint8Array<ArrayBuffer>=serialized,compressed=false;
      if(useGzip&&size>=32*1024){
        const bytes=await compressBatch(serialized,{level:1});
        if(bytes.length<size*0.95){body=new Uint8Array(bytes);compressed=true;}
      }
      const sendBatch=async()=>{
        try{return await request(config.api,'/api/sessions/batches',{method:'POST',headers:{'content-type':'application/json',...recordingHeaders,...(compressed?{'content-encoding':'gzip'}:{})},body},await current(),renew);}
        catch(error){
          // Restore can lose a previously acknowledged blob. Invalidate only
          // this batch's scoped receipts so the next attempt repairs storage.
          if(error instanceof CliError&&error.httpStatus===409){
            attachments.forget(attachmentScope,acknowledged);
            if(existsSync(checkpoint))retryWindowsSharing(()=>unlinkSync(checkpoint));
          }
          throw error;
        }
      };
      let receipt;
      try{receipt=await sendBatch();}
      catch(error){
        // A rolling deployment can route the upload to an older replica. Retry
        // the identical JSON once; receipts always identify uncompressed bytes.
        if(!compressed||!(error instanceof CliError)||![400,415].includes(error.httpStatus??0))throw error;
        useGzip=false;compressed=false;body=serialized;receipt=await sendBatch();
      }
      if(receipt.batchId!==hash(serialized) || receipt.stored!==true)throw new CliError('CAPTURE_RECEIPT_INVALID','Server did not confirm durable capture');
      if(receipt.discarded==='session_deleted')attachments.forget(attachmentScope,acknowledged);
      pendingReceipt={at:new Date().toISOString(),...receipt,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId};
      if(performance.now()-lastReceiptWrite>=1000)checkpointReceipt();
      retryWindowsSharing(()=>unlinkSync(path));
      if(existsSync(checkpoint))retryWindowsSharing(()=>unlinkSync(checkpoint));
      const rejection=join(captureDir(),'rejected',name);if(existsSync(rejection))retryWindowsSharing(()=>unlinkSync(rejection));
      uploaded++;onUploaded?.();
    };
    const worker=async()=>{
      try {
        while(!failure&&!stopped&&visited<names.length){
          if(scheduled>=limit||Date.now()>=deadline)break;
          const latest=readCaptureConfig();
          if(!wait&&(!latest||latest.disabled)){stopped=true;break;}
          if(latest&&(latest.api!==config.api||latest.installationId!==config.installationId||latest.owner.userId!==principal.userId||latest.owner.tenantId!==principal.tenantId))throw new CliError('CAPTURE_DESTINATION_CHANGED','Capture destination changed during upload; queued data is retained.');
          const name=names[visited++],batch=read(join(captureDir(),'queue',name));
          // Validate before sending any attachment bytes, even on a parallel pass.
          if(batch.owner?.userId!==principal.userId)throw new CliError('CAPTURE_OWNER_MISMATCH','Queued capture belongs to another user. Sign back in as its author to upload it; queued data is retained.');
          if(batch.owner?.tenantId!==principal.tenantId)throw new CliError('CAPTURE_DESTINATION_CHANGED','Queued capture belongs to another team. Sign back into its original destination or explicitly purge local pending data.');
          if(captureExcluded(latest??config,batch)){excluded++;continue;}
          if(batch.harness==='cursor'&&!cursorSupported){unsupported.add('cursor');continue;}
          if(batch.harness==='antigravity'&&!antigravitySupported){unsupported.add('antigravity');continue;}
          const permitted=permittedBatch(batch,identity.recording);
          if(!permitted){retryWindowsSharing(()=>unlinkSync(join(captureDir(),'queue',name)));excluded++;continue;}
          scheduled++;
          if(batchDelayMs){const start=Math.max(Date.now(),nextUploadAt);nextUploadAt=start+batchDelayMs;await pause(Math.max(0,start-Date.now()));if(failure)break;}
          try{await upload(name,permitted);}
          catch(error){
            if(!(error instanceof CliError)||error.httpStatus!==413)throw error;
            atomicJson(join(captureDir(),'rejected',name),{status:413,digest:hash(readFileSync(join(captureDir(),'queue',name))),at:new Date().toISOString()});
          }
        }
      }catch(error){failure??=error;}
    };
    // A background pass must return to notice processing. Always settle the
    // in-flight uploads before releasing ownership, including after a failure.
    await Promise.all(Array.from({length:workers},worker));
    checkpointReceipt();
    if(failure)throw failure;
    const rejected=rejectedNames().length;
    const result={uploaded,...(excluded?{excluded}:{}),...(unsupported.size?{unsupportedHarnesses:[...unsupported]}: {})};
    if(visited<names.length||stopped){if(rejected)throw new CliError('CAPTURE_BATCH_REJECTED',rejectedNotice(rejected));return result;}
    const referenced=new Set<string>();
    for(const name of readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json'))) {
      for(const a of read(join(captureDir(),'queue',name),{attachments:[]}).attachments)if(a.sha256)referenced.add(a.sha256);
    }
    // A grace period protects in-progress hooks between writing a blob and publishing their batch.
    for(const name of readdirSync(join(captureDir(),'blobs'))) {
      const path=join(captureDir(),'blobs',name);
      if(!referenced.has(name)&&Date.now()-statSync(path).mtimeMs>86400000)unlinkSync(path);
    }
    if(rejected)throw new CliError('CAPTURE_BATCH_REJECTED',rejectedNotice(rejected));
    try{unlinkSync(join(captureDir(),'last-error.json'));}catch{}
    return result;
  },wait?Infinity:0).catch(error=>{if(!wait&&error?.code==='SESSION_BUSY')return {uploaded:0};throw error;});
}
/** A capture failure the person must fix, or null. Uploads succeeding after
 * the recorded error make it stale; queued data is retained either way. */
export function captureAttention():string|null {
  const config=readCaptureConfig();if(!config||config.disabled)return null;
  const rejected=rejectedNames().length;if(rejected)return rejectedNotice(rejected);
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
export function captureStatus(nativeReview?:CodexHookReview) {
  const config=readCaptureConfig(),daemonIngress=daemonIngressStatus(),pendingLegacyHooks=existsSync(join(captureDir(),'notices'))?noticeNames().length:0;
  const codexReview=nativeReview??(config?localCodexHookReview(config.roots.codex):{state:'not_applicable' as const,total:0,pending:0,disabled:0});
  const review=codexHookReviewMessage(codexReview);
  return {installed:Boolean(config&&!config.disabled),api:config?.api,owner:config?.authPending?null:config?.owner,authenticationPending:Boolean(config?.authPending),installationId:config?.installationId,
    worker:captureDaemonEnabled(config)?{supervision:read(join(captureDir(),'daemon/service.json')),lastObserved:read(join(captureDir(),'daemon/status.json')),uploadRetry:read(join(captureDir(),'daemon/retry.json')),startupRetry:read(join(captureDir(),'daemon/startup-retry.json'))}:null,
    exclusions:config?.exclusions??{projects:[],sessions:[]},
    queued:existsSync(join(captureDir(),'queue'))?readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json')).length:0,
    rejected:rejectedNames().length,
    pendingHooks:pendingLegacyHooks+daemonIngress.capture,pendingLegacyHooks,daemonIngress,
    backfill:read(join(captureDir(),'backfill-progress.json')),
    lastUpload:read(join(captureDir(),'last-upload.json')),lastError:read(join(captureDir(),'last-error.json')),
    codexHooksAwaitingReview:codexReview.pending,codexHookReview:codexReview,attention:captureAttention()??review};
}
