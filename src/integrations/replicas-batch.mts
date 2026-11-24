import type {Principal,SessionBatch,SessionEvent} from '../sessions/types.mjs';
import {packReplicasPayload} from '../sessions/replicas-payload.mjs';
import {canonical} from './replicas-events.mjs';
import {ReplicasPageError} from './replicas-api.mjs';
import {chunkSenderEvidence,type SenderEvidence} from './replicas-senders.mjs';

export type ReplicasIngest=(owner:Principal,batch:SessionBatch,gate?:undefined,blobs?:ReadonlyMap<string,Uint8Array>)=>Promise<unknown>;

/** Both sources must split and externalize the same immutable record identically. */
export async function writeReplicasEvents(ingest:ReplicasIngest,base:Omit<SessionBatch,'events'>,events:SessionEvent[],senders:SenderEvidence|undefined,
  onLarge?:(bytes:number,parts:number)=>void){
  const limit=15*1024*1024,baseBytes=Buffer.byteLength(JSON.stringify(base))+32;
  let batch:SessionEvent[]=[],bytes=baseBytes;
  async function put(records:SessionEvent[],evidence:SessionEvent[],attachments:SessionBatch['attachments']=[],blobs?:ReadonlyMap<string,Uint8Array>){
    const result=await ingest(base.owner,{...base,...chunkSenderEvidence(evidence,senders),attachments,events:records},undefined,blobs);
    if(result&&typeof result==='object'&&'discarded' in result)throw new ReplicasPageError('deleted','The session was deleted in OpenCrawl.');
  }
  async function flush(){if(batch.length)await put(batch,batch);batch=[];bytes=baseBytes;}
  for(const event of events){
    const size=Buffer.byteLength(JSON.stringify(event))+1;
    if(bytes+size>limit||batch.length===1000)await flush();
    if(baseBytes+size>limit){
      const packed=packReplicasPayload(event,canonical(event.data));
      await put([packed.event],[event],packed.attachments,packed.blobs);
      onLarge?.(size,packed.attachments.length);
    }else{batch.push(event);bytes+=size;}
  }
  await flush();
}
