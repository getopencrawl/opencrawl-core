import {createReadStream,readFileSync,statSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {CliError} from '../oauth.ts';
import {atomicJson} from '../session.ts';
import {historyBlocks,historyLineChunks} from './history-snapshot.ts';
import {archiveChunks} from './archive.ts';
import {backfill,defaultHistoryRoots,inventory,selection,type HistoryFile} from './backfill.ts';
import {hash,parseRecord} from './parse.ts';
import {captureExcluded,inHistoryProject,projectPath} from './policy.ts';
import {antigravityPathMeta,captureDir,readCaptureConfig,type CaptureConfig} from './runtime.ts';

type SessionFile=HistoryFile & {sessionId:string;cwd:string|null;lastActiveAt:string;blocks:string[]};
type Plan={version:1;api:string;installationId:string;tenantId:string;userId:string;project:string|null;harness:ReturnType<typeof selection>;limit:number;files:SessionFile[]};
type Flags=Record<string,unknown>;
const invalid=(message:string)=>new CliError('INVALID_USAGE',message,64);
const changed=()=>new CliError('HISTORY_PLAN_CHANGED','A reviewed source, capture exclusion or destination changed. Run history list again.');
const planPath=(id:string)=>join(captureDir(),'history-plans',id+'.json');
async function inspect(file:HistoryFile,config:CaptureConfig|null,project:string|null):Promise<SessionFile|null> {
  if(!file.bytes)return null;
  const blocks:string[]=[];
  const archived=file.path.endsWith('.jsonl.zst');
  let complete=!archived;
  const chunks=archived?archiveChunks(file.path,file.bytes,done=>{complete=done;}):createReadStream(file.path,{end:file.bytes-1});
  let sessionId=file.harness==='antigravity'?antigravityPathMeta(file.path).sessionId:undefined;
  let cwd:string|undefined,firstCwd:string|null=null,lastTime=-Infinity,hasEvent=false;
  let checkedCwd:unknown=Symbol(),checkedId:unknown;
  const audit=file.harness==='claude-code'&&basename(file.path)==='audit.jsonl';
  for await(const chunk of historyLineChunks(historyBlocks(chunks,digest=>blocks.push(digest))))for(const line of chunk.toString('utf8').split('\n')){
    if(!line.trim())continue;
    let record;
    try{record=JSON.parse(line);}catch{return null;}
    if(!record||typeof record!=='object')return null;
    const payload=record.payload??record;
    if(file.harness==='codex'){
      if(record.type==='session_meta'){
        if(sessionId){
          // The capture parser also retains copied ancestor headers as events.
          if(!inHistoryProject(payload.cwd,project)||config&&captureExcluded(config,{harness:file.harness,sessionId,cwd:payload.cwd}))return null;
          continue;
        }
        sessionId=payload.id;
        cwd=payload.cwd;
      }else if(record.type==='turn_context'&&payload.cwd)cwd=payload.cwd;
    }else if(file.harness==='claude-code'){
      const id=audit?record.session_id:record.sessionId;
      if(id){
        const next=record.agentId?id+':'+record.agentId:id;
        if(sessionId&&next!==sessionId)return null; // Multi-session container.
        sessionId=next;
      }
      if(!audit&&(payload.cwd||record.cwd))cwd=payload.cwd??record.cwd;
      if(audit&&!['user','assistant'].includes(record.type))continue;
    }
    if(typeof cwd==='string'&&firstCwd===null)firstCwd=cwd;
    // Only records the capture adapter can ingest may make a session eligible.
    const event=parseRecord(file.harness,record,0);
    if(!event)continue;
    if(typeof sessionId!=='string'||!sessionId)return null;
    if(cwd!==checkedCwd||sessionId!==checkedId){
      if(!inHistoryProject(cwd,project)||config&&captureExcluded(config,{harness:file.harness,sessionId,cwd}))return null;
      checkedCwd=cwd;checkedId=sessionId;
    }
    hasEvent=true;
    const value=Date.parse(audit?record._audit_timestamp??event.timestamp:event.timestamp);
    if(Number.isFinite(value))lastTime=Math.max(lastTime,value);
  }
  if(!complete||!hasEvent||!sessionId)return null;
  return {...file,sessionId,cwd:firstCwd,lastActiveAt:new Date(Number.isFinite(lastTime)?lastTime:file.mtimeMs).toISOString(),blocks};
}

const summary=({harness,sessionId,cwd,lastActiveAt,bytes}:SessionFile)=>({harness,sessionId,cwd,lastActiveAt,bytes});
function owner(config:CaptureConfig) {
  return {api:config.api,installationId:config.installationId,tenantId:config.owner.tenantId,userId:config.owner.userId};
}
const usable=(config:CaptureConfig|null):config is CaptureConfig=>Boolean(config&&!config.disabled&&!config.authPending);
function validFlags(values:Flags,allowed:string[]) {
  const unexpected=Object.keys(values).find(key=>values[key]!==undefined&&!['api','json',...allowed].includes(key));
  if(unexpected)throw invalid('Unsupported history option --'+unexpected+'. Run opencrawl history --help.');
}

export async function historyCommand(action:string|undefined,api:string,values:Flags) {
  const config=readCaptureConfig();
  if(config&&config.api!==api)throw new CliError('CAPTURE_API_MISMATCH','Use the installed capture destination for this profile.');
  if(action==='list'){
    validFlags(values,['project','harness','limit']);
    if(typeof values.limit!=='string'||!/^\d+$/.test(values.limit)||!Number.isSafeInteger(Number(values.limit))||Number(values.limit)<1)throw invalid('history list requires --limit with a positive whole number.');
    if(values.project!==undefined&&(typeof values.project!=='string'||!values.project.trim()))throw invalid('Use a project directory with --project.');
    const limit=Number(values.limit),project=typeof values.project==='string'?projectPath(resolve(values.project)):null;
    const harness=selection(values.harness as string|undefined);
    const files:SessionFile[]=[];
    const candidates=inventory(config??defaultHistoryRoots(),harness).files;
    for(const file of candidates){
      const candidate=await inspect(file,config,project);
      if(candidate)files.push(candidate);
    }
    files.sort((a,b)=>b.lastActiveAt.localeCompare(a.lastActiveAt)||b.bytes-a.bytes||a.harness.localeCompare(b.harness)||a.sessionId.localeCompare(b.sessionId)||a.path.localeCompare(b.path));
    const seen=new Set<string>();
    const selected:SessionFile[]=[];
    for(const file of files){
      const key=JSON.stringify([file.harness,file.sessionId]);
      if(seen.has(key))continue;
      seen.add(key);
      if(selected.length<limit)selected.push(file);
    }
    let planId:string|null=null;
    if(usable(config)){
      const plan:Plan={version:1,...owner(config),project,harness,limit,files:selected};
      planId=hash(JSON.stringify(plan));atomicJson(planPath(planId),plan);
    }
    return {status:'preview',api,tenantId:usable(config)?config.owner.tenantId:null,project,harness,limit,filesScanned:candidates.length,eligibleSessions:seen.size,selected:selected.length,sessions:selected.map(summary),planId};
  }
  if(action!=='import')throw invalid('Use history list or history import. Run opencrawl history --help.');
  validFlags(values,['plan-id','yes']);
  const id=values['plan-id'];
  if(typeof id!=='string'||!/^[0-9a-f]{64}$/.test(id)||values.yes!==true)throw invalid('Use history import --plan-id ID --yes with the approved list result.');
  if(!usable(config))throw new CliError('CAPTURE_NOT_INSTALLED','Enroll this profile, then run history list again.');
  let plan:Plan;
  try{plan=JSON.parse(readFileSync(planPath(id),'utf8'));}catch{throw new CliError('HISTORY_PLAN_MISSING','History plan unavailable in this profile. Run history list again.');}
  if(hash(JSON.stringify(plan))!==id||plan.version!==1)throw changed();
  const checkOwner=()=>{
    const current=readCaptureConfig();
    if(!usable(current)||current.api!==plan.api||current.installationId!==plan.installationId||current.owner.tenantId!==plan.tenantId||current.owner.userId!==plan.userId)throw changed();
    return current;
  };
  checkOwner();
  const available=new Map(inventory(config,plan.harness).files.map(file=>[file.path,file]));
  const approved:HistoryFile[]=[];
  for(const file of plan.files){
    const current=available.get(file.path);
    if(!current||current.ino!==file.ino||current.bytes<file.bytes||current.harness!==file.harness||file.path.endsWith('.zst')&&(current.bytes!==file.bytes||current.mtimeMs!==file.mtimeMs))throw changed();
    const verified=await inspect(file,checkOwner(),plan.project);
    if(!verified||JSON.stringify(verified.blocks)!==JSON.stringify(file.blocks)||verified.sessionId!==file.sessionId||statSync(file.path).ino!==file.ino)throw changed();
    approved.push({...file,scope:{sessionId:file.sessionId,project:plan.project,blocks:file.blocks}});
  }
  const result=approved.length?await backfill(api,plan.harness,true,{files:approved,beforeFile:()=>{checkOwner();}}):{status:'complete',processed:0,uploaded:0};
  return {...result,planId:id,selected:plan.files.length,sessions:plan.files.map(summary)};
}
