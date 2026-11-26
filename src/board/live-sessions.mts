import {createHash} from 'node:crypto';
import type {BoardRepository} from '../state/board.mjs';
import type {ResourceControls} from '../sessions/controls.mjs';
import type {createRecentSessions} from '../sessions/recent.mjs';
import {parseSessionReference} from '../sessions/session-reference.mjs';
import {boardIdentity} from './identity.mjs';
import {onlineWindow} from './inbox.mjs';

export interface LiveRecipient {
  agent:string; name:string; captureRef?:string;
  source?:{userId:string; harness:string; sessionId:string};
}
export interface LiveContext extends LiveRecipient {
  firstUserPrompt:string|null; latestUserPrompt:string|null; latestAssistantMessage:string|null;
}

const author='system:opencrawl';
/** Internal, workspace-bound capability. Reads use ordinary team visibility,
 * including the pending privacy review on the original capture batch. */
export function liveSessionBoard(tenantId:string,board:BoardRepository,recent:Pick<ReturnType<typeof createRecentSessions>,'read'>,
  controls:Pick<ResourceControls,'read'>,now=Date.now) {
  if(!tenantId.trim())throw Error('A workspace is required');
  const principal={tenantId,userId:author};
  const key=createHash('sha256').update(tenantId).digest('hex');
  async function shared(target:LiveRecipient) {
    if(!target.source)return true;
    const {userId,harness,sessionId}=target.source;
    const control=await controls.read({tenantId,userId},'sessions',harness,sessionId);
    return !control?.deletedAt && control?.visibility!=='private';
  }
  async function list() {
    return board.read(key,async tx=>{
      const peers=await tx.onlinePeers('',now()-onlineWindow);
      const hidden=new Set(await tx.blockedPublications(peers.map(p=>p.agent)));
      return peers.filter(p=>p.name && !hidden.has(p.agent)).map(({agent,name,captureRef})=>({agent,name,captureRef}));
    });
  }
  async function context(peer:LiveRecipient):Promise<LiveContext|null> {
    const empty={...peer,firstUserPrompt:null,latestUserPrompt:null,latestAssistantMessage:null};
    if(!peer.captureRef)return empty;
    const [tenant,owner,,,id]=parseSessionReference(peer.captureRef,true);
    if(tenant!==tenantId || owner===author || boardIdentity(owner,id)!==peer.agent)return null;
    const [row]=await recent.read(principal,{id:peer.captureRef,field:'context',presenceRef:true});
    if(!row)return empty;
    if(row.userId!==owner || row.sessionId!==id)return null;
    return {...peer,source:{userId:owner,harness:row.harness,sessionId:id},firstUserPrompt:row.firstUserMessage?.text??null,
      latestUserPrompt:row.lastUserMessage?.text??null,latestAssistantMessage:row.latestAssistantMessage?.text??null};
  }
  async function current(peers:LiveRecipient[]) {
    if(!(await Promise.all(peers.map(shared))).every(Boolean))return false;
    return board.read(key,tx=>reachable(tx,peers));
  }
  async function reachable(tx:import('../state/board.mjs').BoardReader,peers:LiveRecipient[]) {
    if((await tx.blockedPublications(peers.map(p=>p.agent))).length)return false;
    for(const peer of peers){
      const p=await tx.participant(peer.agent);
      if(!p || p.left || p.seen<=now()-onlineWindow || p.name!==peer.name || p.captureRef!==peer.captureRef)return false;
    }
    return true;
  }
  async function notify(pair:readonly [LiveRecipient,LiveRecipient],requestId:string,text:string,channel:string) {
    if(pair[0].agent===pair[1].agent || !requestId || requestId.length>80 || !text.trim() ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(channel) || channel==='opencrawl')throw Error('Invalid pair notification');
    if(!(await Promise.all(pair.map(shared))).every(Boolean))return null;
    return board.transaction(key,async tx=>{
      if(!await reachable(tx,[...pair]))return null;
      const sender={userId:author,agent:author,name:'System',registered:false};
      const prior=await tx.publication({...sender,requestId});
      const mentions=pair.map(p=>p.agent);
      if(prior){
        if(prior.topic!==channel || prior.text!==text || JSON.stringify(prior.mentions)!==JSON.stringify(mentions))throw Error('Conflicting pair notification retry');
        return prior.id;
      }
      return (await tx.append({agent:author,author,name:sender.name,topic:channel,requestId,text,timestamp:now(),
        mentions,mentionNames:pair.map(p=>p.name)})).id;
    });
  }
  return {list,context,current,notify};
}
