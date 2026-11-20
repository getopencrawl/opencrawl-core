import {canonical,replicasDigest} from '../integrations/replicas-events.mjs';
import {captureKey,type CaptureLookup} from '../integrations/replicas-threads.mjs';
import {record,replicasProjection} from './replicas-record.mjs';
import type {SessionEvent,Principal} from './types.mjs';
import type {Passage} from '../search/types.mjs';
import type {SessionKey} from './session-reference.mjs';

export function messageFingerprint(event:SessionEvent){
  const message=replicasProjection(event);
  if(message.kind!=='message'||!['user','assistant'].includes(String(message.data?.role))||message.data?.content==null)return;
  // Preserve content block types, attachments, code whitespace and block order.
  const body=message.data.content;
  const block=Array.isArray(body)&&body.length===1?record(body[0]):null;
  const textType=message.data.role==='user'?'input_text':'output_text';
  const content=block&&Object.keys(block).length===2&&(block.type==='text'||block.type===textType)&&typeof block.text==='string'?block.text:body;
  return replicasDigest(canonical([message.data.role,content]));
}
export type CaptureFingerprints=(principal:Principal,hits:Passage[])=>Promise<Map<string,string>>;
export async function matchCaptures(principal:Principal,hits:Passage[],lookup:CaptureLookup,fingerprints?:CaptureFingerprints,matchMessages=true){
  const messages=new Map<string,string>(),sessions=new Map<string,string>();
  const resources=new Map<string,SessionKey>(),byResource=new Map<string,Passage[]>();
  for(const hit of hits){
    if(hit.tenantId!==principal.tenantId)throw Error('Capture search scope mismatch');
    if(!hit.userId||!hit.harness||!hit.sessionId)continue;
    const key={userId:hit.userId,harness:hit.harness,sessionId:hit.sessionId},id=captureKey(key);
    resources.set(id,key);
    const list=byResource.get(id)??[];list.push(hit);byResource.set(id,list);
  }
  const candidates=[...resources.values()];
  if(!candidates.some(k=>k.harness==='replicas')||!candidates.some(k=>['claude-code','codex'].includes(k.harness)))return {messages,sessions};
  const pairs=await lookup(principal.tenantId,candidates);
  const pending:{left:Passage;right:Passage}[]=[];
  for(const pair of pairs){
    const historyKey=captureKey(pair.history),liveKey=captureKey(pair.live);
    const history=byResource.get(historyKey),live=byResource.get(liveKey);
    if(!history||!live)continue;
    sessions.set(historyKey,liveKey);
    if(!matchMessages)continue;
    function group(rows:Passage[]){
      const map=new Map<string,Passage[]>();
      for(const row of rows){
        if(row.kind!=='message'||!row.role)continue;
        const native=typeof row.nativeId==='string'&&row.nativeId?row.nativeId:null;
        // A provider record with no native event ID requires an exact instant
        // and unambiguous content within this independently proven thread.
        const time=Date.parse(String(row.timestamp??''));
        if(!native&&!Number.isFinite(time))continue;
        const id=JSON.stringify([row.role,native,native?null:time,row.chunk??0]);
        const items=map.get(id)??[];items.push(row);map.set(id,items);
      }
      return map;
    }
    const left=group(history),right=group(live);
    for(const [id,items] of left){
      const other=right.get(id);
      if(items.length!==1||other?.length!==1)continue;
      const a=items[0]!,b=other[0]!;
      if((a.chunkCount!==1||b.chunkCount!==1)&&a.text!==b.text)continue;
      pending.push({left:a,right:b});
    }
  }
  const legacy=pending.flatMap(p=>[p.left,p.right]).filter(h=>!h.captureHash);
  const hashes=legacy.length&&fingerprints?await fingerprints(principal,legacy):new Map<string,string>();
  for(const {left,right} of pending){
    const a=left.captureHash??hashes.get(left.id),b=right.captureHash??hashes.get(right.id);
    if(typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&a===b){
      messages.set('sessions:'+left.id,'sessions:'+right.id);
    }
  }
  return {messages,sessions};
}
