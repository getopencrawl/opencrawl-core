import {digest} from '../event-identity.mjs';
/** The producer and worker derive the same generation from their trusted index
 * and receipt configuration. No tenant-selected target enters a Temporal task. */
export function sessionIndexingGeneration(searchIdentity:string,jobId:string) {
  if(!searchIdentity||!jobId)throw new Error('Explicit indexing generation required');
  // A fresh full scan is required when retiring legacy pending/retry/cursor
  // objects. Old cutover markers remain evidence, never proof for this generation.
  return digest(JSON.stringify([searchIdentity,jobId,'postgres-app-state-v1']));
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
