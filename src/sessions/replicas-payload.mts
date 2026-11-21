import {createHash} from 'node:crypto';
import {eventIdentityLocation} from './event-identity.mjs';
import type {Attachment,EventData,ObjectStore,Principal,SessionBatch,SessionEvent} from './types.mjs';

export const singleHistoryPageBytes=64*1024*1024;
// The archive contains both the history response and its original catalog row.
const maxPayloadBytes=singleHistoryPageBytes+16*1024*1024;
const partBytes=8*1024*1024;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
interface Payload {bytes:number;sha256:string;parts:string[]}

export function packReplicasPayload(event:SessionEvent,canonicalData:string){
  const data=Buffer.from(canonicalData);
  if(data.length>maxPayloadBytes)throw new RangeError('Replicas record exceeds attachment capacity');
  const blobs=new Map<string,Uint8Array>(),parts:string[]=[],attachments:Attachment[]=[];
  for(let offset=0;offset<data.length;offset+=partBytes){
    const part=data.subarray(offset,offset+partBytes),sha256=hash(part);
    parts.push(sha256);
    if(!blobs.has(sha256)){
      blobs.set(sha256,part);
      attachments.push({status:'captured',sha256,size:part.length,mimeType:'application/octet-stream'});
    }
  }
  const descriptor:Payload={bytes:data.length,sha256:hash(data),parts};
  return {event:{...event,data:{replicasPayloadV1:descriptor}},blobs,attachments};
}

/** The caller has authenticated the batch and its exact immutable source. Read
 * only content-addressed attachments under that same session's storage prefix. */
export async function expandReplicasPayload(store:ObjectStore,prefix:string,principal:Principal,source:string,batch:SessionBatch):Promise<SessionBatch>{
  if(batch.harness!=='replicas'||batch.captureMode!=='history'||batch.events.length!==1||
    !/^workload_replicas_[a-f0-9]{64}$/.test(batch.owner.userId))return batch;
  const event=batch.events[0]!,descriptor=event.data?.replicasPayloadV1 as Payload|undefined;
  if(!descriptor)return batch;
  const validHash=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);
  if(!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<=0||descriptor.bytes>maxPayloadBytes||!validHash(descriptor.sha256)||
    !Array.isArray(descriptor.parts)||descriptor.parts.length!==Math.ceil(descriptor.bytes/partBytes)||!descriptor.parts.every(validHash)){
    throw new Error('Invalid Replicas attachment manifest');
  }
  const location=eventIdentityLocation({prefix,principal,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId});
  if(batch.owner.tenantId!==principal.tenantId||batch.owner.userId!==principal.userId||!source.startsWith(location.source)||
     !/^[a-f0-9]{64}\.json\.gz$/.test(source.slice(location.source.length)))throw new Error('Invalid Replicas attachment source');
  const root=location.source+'attachments/';
  const manifest=new Map(batch.attachments.map(item=>[item.sha256,item]));
  const output=Buffer.allocUnsafe(descriptor.bytes);
  for(const [index,id] of descriptor.parts.entries()){
    const offset=index*partBytes,size=Math.min(partBytes,descriptor.bytes-offset);
    const item=manifest.get(id);
    if(item?.status!=='captured'||item.size!==size||item.objectKey!==root+id)throw new Error('Invalid scoped Replicas attachment');
    const data=await store.get(root+id,{maxBytes:size});
    if(!data||data.length!==size||hash(data)!==id)throw new Error('Replicas attachment is missing or changed');
    output.set(data,offset);
  }
  if(hash(output)!==descriptor.sha256)throw new Error('Replicas attachment checksum mismatch');
  const data:EventData=JSON.parse(output.toString('utf8'));
  if(!data||typeof data!=='object'||!(data.replicas||data.replicasPage))throw new Error('Invalid archived Replicas data');
  return {...batch,events:[{...event,data}]};
}
