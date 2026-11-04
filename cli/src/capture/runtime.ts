import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync, openSync, readSync, closeSync, unlinkSync} from 'node:fs';
import {join, dirname, resolve, sep, basename} from 'node:path';
import {homedir, hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {configDir, atomicJson, accessToken, withSessionLock} from '../session.ts';
import {CliError} from '../oauth.ts';
import {parseRecord, detectOrigin, hash, type Harness} from './parse.ts';

export const captureDir = () => join(configDir(),'capture');
const read = (p:string, fallback:any=null) => {try{return JSON.parse(readFileSync(p,'utf8'));}catch(e:any){if(e.code==='ENOENT')return fallback;throw e;}};
export type CaptureConfig = {disabled?:boolean,schemaVersion:1,api:string,installationId:string,owner:{tenantId:string,userId:string,name?:string,email?:string},installedAt:string,roots:Record<Harness,string>,command:string[]};
export const readCaptureConfig = ():CaptureConfig|null => read(join(captureDir(),'config.json'));
export async function request(api:string,path:string,init:RequestInit={},tokenOverride?:string) {
  const saved=read(join(captureDir(),'receiver-token.json'));
  const staticToken=tokenOverride || process.env.OPENCRAWL_SESSIONS_TOKEN || (saved?.api===api?saved.token:null);
  let token=staticToken || await accessToken(api);
  const send=()=>fetch(api+path,{...init,headers:{...init.headers,authorization:'Bearer '+token},signal:AbortSignal.timeout(20000),redirect:'error'});
  let res=await send();
  if(res.status===401 && !staticToken){token=await accessToken(api,token);res=await send();}
  const body=await res.json();
  if(!res.ok)throw new CliError('CAPTURE_UPLOAD_FAILED',`Capture request failed (${res.status}): ${body.error?.code ?? 'unknown'}`);
  return body.data;
}
export function commandForSelf() {
  if(process.env.OPENCRAWL_LAUNCHER && process.env.OPENCRAWL_NODE) return [process.env.OPENCRAWL_NODE,process.env.OPENCRAWL_LAUNCHER];
  return process.argv[1]?.endsWith('.ts') ? [process.execPath,resolve(process.argv[1])] : [process.execPath];
}
export function kick(config:CaptureConfig) {
  const child=spawn(config.command[0],[...config.command.slice(1),'collect','flush'],{
    detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,OPENCRAWL_CONFIG_HOME:dirname(configDir()),OPENCRAWL_NO_UPDATE:'1'}});
  child.on('error',()=>{});child.unref();
}
export function recordError(error:any) {
  // Status only: never include transcript content, credentials, or a provider response.
  atomicJson(join(captureDir(),'last-error.json'),{at:new Date().toISOString(),code:error?.code || 'CAPTURE_FAILED'});
}
function ensureDirectories() {for(const dir of ['queue','state','blobs'])mkdirSync(join(captureDir(),dir),{recursive:true,mode:0o700});}
const under = (file:string,dir:string) => file.startsWith(dir+sep);
function transcriptAllowed(file:string, config:CaptureConfig, harness:Harness) {
  const path=realpathSync(file);
  const root=realpathSync(config.roots[harness]);
  const allowed=harness==='claude-code' ? [join(root,'projects')] : [join(root,'sessions'),join(root,'archived_sessions')];
  if(!allowed.some(dir=>under(path,dir)) || !path.endsWith('.jsonl'))throw new CliError('CAPTURE_PATH_REJECTED','Transcript outside configured harness session directories');
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
function attachmentTransform(value:any, attachments:any[], cwd:string):any {
  if(Array.isArray(value))return value.map(v=>attachmentTransform(v,attachments,cwd));
  if(!value || typeof value!=='object')return value;
  let bytes:Buffer|undefined, path:string|undefined, mime:string|undefined, reference:string|undefined;
  if(value.type==='base64' && typeof value.data==='string'){bytes=Buffer.from(value.data,'base64');mime=value.media_type;}
  const url=typeof value.image_url==='string'?value.image_url:value.image_url?.url;
  if(typeof url==='string' && url.startsWith('data:')){const m=/^data:([^;,]+);base64,(.*)$/s.exec(url);if(m){mime=m[1];bytes=Buffer.from(m[2],'base64');}}
  if(['local_image','input_file','file'].includes(value.type) && typeof value.path==='string')path=resolve(cwd,value.path);
  if(path) {
    try{if(statSync(path).size>32*1024*1024){attachments.push({path,status:'too_large'});return value;}bytes=readFileSync(path);}
    catch{attachments.push({path,status:'missing'});return value;}
  }
  if(bytes){
    if(bytes.length>32*1024*1024){attachments.push({status:'too_large',path,mimeType:mime});return {...value,data:undefined,image_url:undefined,captureStatus:'too_large'};}
    const sha256=hash(bytes),dest=join(captureDir(),'blobs',sha256);
    try{writeFileSync(dest,bytes,{mode:0o600,flag:'wx'});}catch(e:any){if(e.code!=='EEXIST')throw e;}
    const a={sha256,size:bytes.length,mimeType:mime??null,path:path??null,status:'captured'};attachments.push(a);
    return {type:'opencrawl_attachment',...a};
  }
  if(typeof url==='string')reference=url;
  if(value.type==='url' && typeof value.url==='string')reference=value.url;
  if(reference)attachments.push({url:reference,status:'remote_reference'});
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,attachmentTransform(v,attachments,cwd)]));
}
function enqueue(config:CaptureConfig,meta:any,events:any[],attachments:any[]) {
  if(!events.length)return;
  if(!meta.sessionId)throw new CliError('CAPTURE_SESSION_UNKNOWN','Transcript has no session identity');
  const batch={schemaVersion:1,owner:config.owner,installationId:config.installationId,host:hostname(),...meta,events,attachments};
  const size=Buffer.byteLength(JSON.stringify(batch));
  if(size>16*1024*1024)throw new CliError('CAPTURE_BATCH_TOO_LARGE','A capture record exceeds the upload limit; retained locally for retry');
  atomicJson(join(captureDir(),'queue',hash(JSON.stringify(batch))+'.json'),batch);
}
/** The cursor advances only after its records and attachment bytes are durably spooled. */
export async function captureTranscript(config:CaptureConfig,harness:Harness,file:string,hook:any={}) {
  ensureDirectories();
  const path=transcriptAllowed(file,config,harness);
  const stateFile=join(captureDir(),'state',hash(harness+path)+'.json');
  return withSessionLock('capture:'+stateFile,async()=>{
    const st=statSync(path),old=read(stateFile,{offset:0});
    let offset=old.offset;
    if(st.size<offset || (old.ino && old.ino!==st.ino))offset=0;
    const fd=openSync(path,'r');
    let meta:any=old.meta??{harness,sessionId:hook.session_id,origin:'unknown',originEvidence:null,parentSessionId:null,sourcePath:path};
    function metadata(r:any) {
        const p=r.payload??r;
        if(harness==='codex' && r.type==='session_meta') {
          meta.sessionId=p.id;meta.parentSessionId=p.forked_from_id??p.source?.subagent?.thread_spawn?.parent_thread_id??null;
        } else if(harness==='claude-code' && r.sessionId) {
          meta.sessionId=r.agentId ? r.sessionId+':'+r.agentId : r.sessionId;
          if(r.agentId)meta.parentSessionId=r.sessionId;
        }
        const origin=detectOrigin(harness,r);
        if(origin.origin!=='unknown'){meta.origin=origin.origin;meta.originEvidence=origin.evidence;}
        if(p.cwd || r.cwd)meta.cwd=p.cwd??r.cwd;
      if(p.cli_version || r.version)meta.harnessVersion=p.cli_version??r.version;
    }
    try {
      // Metadata lives at the beginning and is inexpensive to reread, even on multi-GB rollouts.
      const head=Buffer.alloc(Math.min(st.size,65536));readSync(fd,head,0,head.length,0);
      for(const line of head.toString('utf8').split('\n')) {
        let r;try{r=JSON.parse(line);}catch{continue;}
        metadata(r);
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
            metadata(record);
            const parsed=parseRecord(harness,record,position);
            if(parsed)events.push(attachmentTransform(parsed,attachments,meta.cwd??dirname(path)));
          }
          position+=Buffer.byteLength(line)+1;
          if(events.length>=200){enqueue(config,meta,events.splice(0),attachments.splice(0));}
        }
        enqueue(config,meta,events,attachments);
        offset+=bytes.length;atomicJson(stateFile,{offset,ino:st.ino,meta});
      }
    } finally{closeSync(fd);}
    return meta;
  });
}
export async function captureHook(harness:Harness,event:any) {
  const config=readCaptureConfig();if(!config||config.disabled)return;
  ensureDirectories();
  const sessionId=event.session_id;
  if(typeof sessionId!=='string' || !/^[\w.:-]{1,200}$/.test(sessionId))throw new CliError('CAPTURE_SESSION_UNKNOWN','Hook missing session ID');
  const file=event.transcript_path || findTranscript(config,harness,sessionId);
  const meta=file && existsSync(file) ? await captureTranscript(config,harness,file,event) : {harness,sessionId,origin:'unknown',originEvidence:null,parentSessionId:null};
  // Hooks can carry input/results before the harness flushes its transcript. Keep both; dedupe downstream.
  const attachments:any[]=[];
  const data=attachmentTransform(event,attachments,event.cwd??homedir());
  enqueue(config,meta,[{id:randomUUID(),kind:'hook',timestamp:new Date().toISOString(),data}],attachments);
  kick(config);
}
export async function syncCaptures() {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  if(config.disabled)return {uploaded:0};
  const errors:any[]=[];
  for(const harness of ['claude-code','codex'] as Harness[]) {
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
export async function flushCaptures() {
  const config=readCaptureConfig();if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run opencrawl collect install');
  ensureDirectories();
  return withSessionLock('capture:flush',async()=>{
    const {principal}=await request(config.api,'/api/sessions/identity');
    if(principal.userId!==config.owner.userId || principal.tenantId!==config.owner.tenantId)throw new CliError('CAPTURE_OWNER_CHANGED','Sign in as the capture owner to upload queued sessions');
    let uploaded=0;
    for(const name of readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json'))) {
      const path=join(captureDir(),'queue',name),batch=read(path);
      if(batch.owner.userId!==principal.userId || batch.owner.tenantId!==principal.tenantId)throw new CliError('CAPTURE_OWNER_CHANGED','Queued sessions belong to another account');
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
  });
}
export function captureStatus() {
  const config=readCaptureConfig();
  return {installed:Boolean(config&&!config.disabled),api:config?.api,owner:config?.owner,installationId:config?.installationId,
    queued:existsSync(join(captureDir(),'queue'))?readdirSync(join(captureDir(),'queue')).filter(n=>n.endsWith('.json')).length:0,
    lastUpload:read(join(captureDir(),'last-upload.json')),lastError:read(join(captureDir(),'last-error.json'))};
}
