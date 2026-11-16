import {digest} from '../event-identity.mjs';
import {onlineIndexingHandoffHash,type OnlineIndexingHandoff} from '../../state/online-indexing-handoff.mjs';
export type {OnlineIndexingHandoff,OnlineIndexingHandoffReader} from '../../state/online-indexing-handoff.mjs';
/** The producer and worker derive the same generation from their trusted index
 * and receipt configuration. No tenant-selected target enters a Temporal task. */
export function sessionIndexingGeneration(searchIdentity:string,jobId:string,onlineHandoff?:OnlineIndexingHandoff) {
  if(!searchIdentity||!jobId)throw new Error('Explicit indexing generation required');
  // A fresh full scan is required when retiring legacy pending/retry/cursor
  // objects. Old cutover markers remain evidence, never proof for this generation.
  return digest(JSON.stringify(onlineHandoff===undefined?[searchIdentity,jobId,'postgres-app-state-v1']:[searchIdentity,jobId,'online-app-state-v1',onlineIndexingHandoffHash(onlineHandoff)]));
}
export interface SessionIndexingBinding {sourceId:string;taskQueue:string;generation:string}
export function indexingBinding(input:SessionIndexingBinding) {
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(input.sourceId)||!input.taskQueue||!input.generation||input.generation.length>256)throw new Error('Invalid session indexing binding');
}
export function sessionCatchupMarker({sourceId,taskQueue,generation,prefix}:SessionIndexingBinding & {prefix:string}) {
  indexingBinding({sourceId,taskQueue,generation});
  if(!prefix||prefix.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Invalid session prefix');
  const identity=digest(JSON.stringify([sourceId,generation]));
  const workflowId='sessions-catchup-v2-'+identity;
  return {workflowId,markerKey:prefix+'/_index/temporal-cutover/'+identity+'.json',marker:{schemaVersion:1,sourceId,taskQueue,generation,workflowId,completed:true}};
}
