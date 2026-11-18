import {CliError} from '../oauth.ts';

type Window = [number,number|null];
export interface RecordingPermission {revision:string; paused:boolean; until:number|null; observedAt?:number; windows:Window[]}
export function readPermission(value:unknown, previous?:RecordingPermission):RecordingPermission|undefined {
  if(value===undefined&&!previous)return undefined; // A deployment predating recording controls.
  if(!value||typeof value!=='object')throw invalid();
  const data=value as Record<string,unknown>;
  if(previous&&previous.revision!=='0'&&data.revision==='0')throw invalid();
  const windows=data.windows??(data.revision===previous?.revision?previous?.windows:undefined);
  if(typeof data.revision!=='string'||!(/^(0|[0-9a-f-]{36})$/).test(data.revision)||typeof data.paused!=='boolean'||
    !(data.until===null||typeof data.until==='number'&&Number.isSafeInteger(data.until))||!Array.isArray(windows)||
    !windows.every(w=>Array.isArray(w)&&w.length===2&&Number.isSafeInteger(w[0])&&(w[1]===null||Number.isSafeInteger(w[1])&&w[1]>=w[0])))throw invalid();
  return {revision:data.revision,paused:data.paused,until:data.until,windows,...typeof data.observedAt==='number'&&Number.isSafeInteger(data.observedAt)&&{observedAt:data.observedAt}};
}
/** A cached active pause may already have ended remotely. Exclude only the part
 * the server has observed; a fresh admission check resolves the remaining tail. */
export function confirmedPermission(policy:RecordingPermission|undefined){
  if(!policy?.paused)return policy;
  if(!policy.observedAt)return undefined;
  return {...policy,windows:policy.windows.map(([start,end]):Window=>[start,Math.min(end??Infinity,policy.observedAt!)])};
}
function invalid(){return new CliError('CAPTURE_PERMISSION_UNAVAILABLE','Recording permission could not be verified. Retry before uploading.');}
export function allowedTime(policy:RecordingPermission|undefined,timestamp:unknown,from:unknown=timestamp){
  if(!policy?.windows.length)return true;
  const t=typeof timestamp==='string'?Date.parse(timestamp):NaN;
  const earliest=typeof from==='string'?Date.parse(from):NaN;
  return Number.isFinite(t)&&Number.isFinite(earliest)&&earliest<=t&&!policy.windows.some(([start,end])=>t>=start&&(end===null||earliest<end));
}

/** Old queues can contain both sides of a pause in the same immutable batch.
 * Only attachment manifests referenced by retained events may follow them. */
export function permittedBatch<T extends {harness?:string; events:{timestamp?:unknown;sourceTime?:string|null;sourceTimeFrom?:string|null;kind?:string}[]; attachments:{sha256?:string}[]; title?:string; capturedTitle?:string; customTitle?:string; actorProfiles?:unknown;replicasSenders?:unknown}>(batch:T,policy?:RecordingPermission):T|null {
  if(!policy?.windows.length)return batch;
  const events=batch.events.filter(event=>{
    // Cursor's transcript fallback synthesizes display times at read time. Only native
    // timed records and hook receipts establish when these messages were written.
    if(!allowedTime(policy,event.timestamp))return false;
    if(batch.harness==='cursor')return allowedTime(policy,event.sourceTime,event.sourceTimeFrom);
    // Synthetic titles and cached title metadata can quote a paused first prompt.
    return event.kind!=='session_title'||allowedTime(policy,event.sourceTime);
  });
  if(!events.length)return null;
  const {title,capturedTitle,customTitle,actorProfiles,replicasSenders,...rest}=batch;
  if(events.length===batch.events.length)return {...rest,events} as T;
  const hashes=new Set<string>();
  function visit(value:unknown){
    if(!value||typeof value!=='object')return;
    if('type' in value&&value.type==='opencrawl_attachment'&&'sha256' in value&&typeof value.sha256==='string')hashes.add(value.sha256);
    else for(const child of Object.values(value))visit(child);
  }
  if(batch.attachments.length)visit(events);
  return {...rest,events,attachments:batch.attachments.filter(a=>a.sha256&&hashes.has(a.sha256))} as T;
}
