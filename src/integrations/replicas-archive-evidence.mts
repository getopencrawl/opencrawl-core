import {gunzipSync} from 'node:zlib';
import type {ObjectStore,SessionBatch} from '../sessions/types.mjs';
import {parseJson} from '../sessions/types.mjs';
import {expandReplicasPayload} from '../sessions/replicas-payload.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';
import {record} from '../sessions/replicas-record.mjs';
import {replicasThread} from './replicas-threads.mjs';
import {canonical,replicasDigest} from './replicas-events.mjs';
import type {ReplicasHistory} from './replicas-api.mjs';

export type ArchiveScope={tenantId:string;organizationId:string;workspace:string;chatId:string};
export function importSession(scope:ArchiveScope){
  const owner={tenantId:scope.tenantId,userId:'workload_replicas_'+replicasDigest('history-v2:'+scope.organizationId+':'+scope.workspace)};
  return {owner,installationId:'replicas-history-v2:'+scope.organizationId,sessionId:'replicas-chat:'+scope.chatId};
}

/** Backfill exclusively from authenticated, immutable capture storage. One page
 * bounds downloads and memory. The caller commits the cursor with its evidence. */
export async function archivedReplicasEvidence(store:ObjectStore,prefix:string,scope:ArchiveScope,cursor?:string|null){
  const {owner,installationId,sessionId}=importSession(scope);
  const root=prefix+'/'+sessionScope(owner)+'/replicas/'+replicasDigest(installationId)+'/'+replicasDigest(sessionId)+'/';
  const listing=await store.listPage(root,{continuationToken:cursor,maxKeys:24});
  if(listing.nextToken&&listing.nextToken===cursor)throw Error('Replicas archive cursor did not advance');
  const rows=new Set<string>(),threads=new Map<string,NonNullable<ReturnType<typeof replicasThread>>>();
  let bytes=0,batches=0,pages=0;
  const keys=listing.keys.filter(key=>key.startsWith(root)&&/^[a-f0-9]{64}\.json\.gz$/.test(key.slice(root.length)));
  async function read(key:string){
    const zipped=await store.get(key,{maxBytes:17*1024*1024});
    if(!zipped)throw Error('Missing Replicas archive batch');
    bytes+=zipped.length;batches++;
    let batch=parseJson<SessionBatch>(gunzipSync(zipped,{maxOutputLength:17*1024*1024}));
    if(batch.owner?.tenantId!==owner.tenantId||batch.owner.userId!==owner.userId||batch.harness!=='replicas'||batch.installationId!==installationId||batch.sessionId!==sessionId)throw Error('Replicas archive ownership mismatch');
    const events=batch.events.filter(e=>e.kind==='replicas_history_page');
    batch=await expandReplicasPayload(store,prefix,owner,key,{...batch,events});
    for(const event of batch.events){
      const page=record(event.data?.replicasPage),chat=record(page?.conversation),history=record(page?.response);
      if(!chat||chat.workspace_id!==scope.workspace||chat.chat_id!==scope.chatId||!history||!Array.isArray(history.events))throw Error('Replicas archive source mismatch');
      rows.add(replicasDigest(canonical(chat)));pages++;
      const thread=replicasThread(history as ReplicasHistory);
      if(thread)threads.set(JSON.stringify(thread),thread);
    }
  }
  for(let i=0;i<keys.length;i+=3)await Promise.all(keys.slice(i,i+3).map(read));
  const thread=threads.size>1?'conflict' as const:[...threads.values()][0];
  return {thread,hashes:[...rows],next:listing.nextToken,bytes,batches,pages};
}

import {combineThreads,saveReplicasThread,type ThreadEvidence} from './replicas-threads.mjs';
import type {ApplicationDatabase} from '../state/postgres.mjs';

export async function backfillReplicasEvidence(client:Pick<ApplicationDatabase['pool'],'query'>,archive:{store:ObjectStore;prefix:string},
  scope:[namespace:string,tenant:string,importId:string],organizationId:string,now:number){
  const {rows:[snapshot]}=await client.query<{workspace:string;chat_id:string;evidence_cursor:string|null;evidence_thread:ThreadEvidence|null}>(`SELECT workspace,chat_id,evidence_cursor,evidence_thread
    FROM opencrawl_replicas_snapshots WHERE namespace=$1 AND tenant=$2 AND import_id=$3 AND NOT evidence_complete
    AND (evidence_retry_at IS NULL OR evidence_retry_at<=$4) ORDER BY workspace,chat_id LIMIT 1`,[...scope,new Date(now)]);
  if(!snapshot)return false;
  const target={tenantId:scope[1],organizationId,workspace:snapshot.workspace,chatId:snapshot.chat_id};
  const args=[...scope,target.workspace,target.chatId],where='namespace=$1 AND tenant=$2 AND import_id=$3 AND workspace=$4 AND chat_id=$5';
  let page;
  try{page=await archivedReplicasEvidence(archive.store,archive.prefix,target,snapshot.evidence_cursor);}
  catch{
    await client.query('UPDATE opencrawl_replicas_snapshots SET evidence_retry_at=$6 WHERE '+where,[...args,new Date(now+86_400_000)]);
    console.warn(JSON.stringify({event:'replicas.import.archive_retry',tenantId:scope[1],importId:scope[2],workspace:target.workspace,chatId:target.chatId}));
    return true;
  }
  if(page.hashes.length)await client.query(`INSERT INTO opencrawl_replicas_catalog_records(namespace,tenant,import_id,record_hash)
    SELECT $1,$2,$3,v FROM unnest($4::text[]) v ON CONFLICT DO NOTHING`,[...scope,page.hashes]);
  const thread=combineThreads(snapshot.evidence_thread,page.thread);
  if(!page.next&&thread){
    const resource=importSession(target);
    await saveReplicasThread(client,scope[0],scope[1],resource.owner.userId,resource.sessionId,thread);
  }
  await client.query('UPDATE opencrawl_replicas_snapshots SET evidence_complete=$6,evidence_cursor=$7,evidence_thread=$8,evidence_retry_at=NULL WHERE '+where,
    [...args,!page.next,page.next,page.next&&thread?JSON.stringify(thread):null]);
  console.info(JSON.stringify({event:'replicas.import.archive_evidence',tenantId:scope[1],importId:scope[2],workspace:target.workspace,chatId:target.chatId,
    batches:page.batches,pages:page.pages,bytes:page.bytes,complete:!page.next,matched:!!thread&&thread!=='conflict',ambiguous:thread==='conflict'}));
  return true;
}
