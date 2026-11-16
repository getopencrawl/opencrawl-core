import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import type {createOnlineProjection} from './online-projection.mjs';
import {inventoryAccountTargetsIn} from './account-state.mjs';
import {inventoryControlTargetsIn} from './resource-controls.mjs';
import {inventoryConnectorSecretTargetsIn} from './connector-secrets.mjs';
import {inventorySetupTargetsIn} from './setup.mjs';
import {inventoryWorkloadTargetsIn} from './workloads.mjs';
import {replicasChallengeSchema} from '../identity/workload-schema.mjs';
import {inventoryValueReportTargetsIn} from './value-reports.mjs';
import {inventoryWriteFenceTargetsIn} from './write-barriers.mjs';
import {inventoryDeletionTargetsIn} from './deletion-requests.mjs';
import {inventoryBoardTargetsIn} from './board.mjs';
import {inventorySlackTargetsIn} from './slack-capture.mjs';
import {scanTargetInventoryIn,targetInventoryFailure,targetInventoryValueBytes,type OnlineOwnedInventoryItem} from './online-target-inventory-support.mjs';

/** Exact finite owner set. These are read dependencies, not a request to acquire
 * locks; the outer epoch/fleet sealer still owns writer exclusion. */
export const ONLINE_TYPED_TARGET_TABLES=Object.freeze([
 'opencrawl_capture_credentials','opencrawl_capture_generations','opencrawl_onboarding_receipts','opencrawl_role_writes',
 'opencrawl_resource_controls','opencrawl_connector_secrets','opencrawl_setup_status',
 'opencrawl_replicas_connections','opencrawl_replicas_installations','opencrawl_replicas_setup','opencrawl_value_reports',
 'opencrawl_write_fences','opencrawl_resource_writers','opencrawl_session_deletions',
 'opencrawl_board_heads','opencrawl_board_messages','opencrawl_board_search_chunks','opencrawl_board_topics','opencrawl_board_agents','opencrawl_board_participants','opencrawl_board_deliveries','opencrawl_board_delivery_messages','opencrawl_board_search_snapshots','opencrawl_board_search_pages',
 'opencrawl_slack_scopes','opencrawl_slack_catalogs','opencrawl_slack_catalog_items','opencrawl_slack_runs','opencrawl_slack_run_items','opencrawl_slack_pacing',
] as const);
export const ONLINE_TYPED_TARGET_PROOF_TABLES=Object.freeze(['opencrawl_online_projection_namespaces','opencrawl_online_projection_bindings','opencrawl_online_projection_tenants','opencrawl_online_projection_heads','opencrawl_online_projection_replicas_references','opencrawl_online_slack_pacing_proofs','opencrawl_online_connection_scope_pins','opencrawl_online_migration_journal'] as const);
export const ONLINE_TYPED_TARGET_OWNED_RELATIONS=Object.freeze([...ONLINE_TYPED_TARGET_TABLES,...ONLINE_TYPED_TARGET_PROOF_TABLES]);
export interface OnlineTargetSnapshotIdentity {backendPid:number;transactionStartedAt:string;snapshot:string;isolation:'repeatable read'|'serializable';readOnly:boolean;}
const snapshotSql="SELECT pg_backend_pid() AS pid,transaction_timestamp()::text AS stamp,pg_current_snapshot()::text AS snapshot,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only";
async function readSnapshot(client:PoolClient):Promise<OnlineTargetSnapshotIdentity>{
 const row=(await client.query(snapshotSql)).rows[0];if(!row||!Number.isSafeInteger(row.pid)||!['repeatable read','serializable'].includes(row.isolation)||!['on','off'].includes(row.read_only)||typeof row.stamp!=='string'||typeof row.snapshot!=='string')targetInventoryFailure('repeatable transaction required');
 return Object.freeze({backendPid:row.pid,transactionStartedAt:row.stamp,snapshot:row.snapshot,isolation:row.isolation,readOnly:row.read_only==='on'});
}
/** One installation-wide owner inventory. It never activates runtime authority,
 * prepares schemas, reads source storage or treats a local source subset as all. */
export function createOnlineTargetInventory({database,epoch,projections}:{database:ApplicationDatabase;epoch:string;projections:readonly ReturnType<typeof createOnlineProjection>[]} ){
 const namespace=database.namespace;if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(epoch)||!namespace||!Array.isArray(projections)||!projections.length||projections.length>100000)targetInventoryFailure('invalid installation binding');
 const owners=new Map(projections.map(projection=>{
  const binding=Object.freeze({...projection.binding});if(binding.namespace!==namespace||binding.epoch!==epoch||typeof projection.inspectOwnedTargetIn!=='function'||!binding.sourceId||Buffer.byteLength(binding.sourceId)>2048||!/^[a-f0-9]{64}$/.test(binding.bindingHash))targetInventoryFailure('projection binding differs');
  return [binding.sourceId,Object.freeze({binding,inspect:projection.inspectOwnedTargetIn.bind(projection)})] as const;
 }));
 if(owners.size!==projections.length||Buffer.byteLength(JSON.stringify([...owners.values()].map(v=>v.binding)))>8*1024*1024)targetInventoryFailure('duplicate or oversized projection roster');
 const bindings=[...owners.values()].map(v=>v.binding).sort((a,b)=>Buffer.compare(Buffer.from(a.sourceId),Buffer.from(b.sourceId))),bindingHash=createHash('sha256').update(JSON.stringify({namespace,epoch,bindings})).digest('hex');
 async function beginSnapshotIn(client:PoolClient){
  const snapshot=await readSnapshot(client);const ns=(await client.query('SELECT epoch FROM opencrawl_online_projection_namespaces WHERE namespace=$1',[namespace])).rows;if(ns.length!==1||ns[0].epoch!==epoch)targetInventoryFailure('installation projection epoch differs');
  let bound=0;for await(const row of scanTargetInventoryIn(client,'SELECT source_id,binding_hash FROM opencrawl_online_projection_bindings WHERE namespace=$1 AND epoch=$2 ORDER BY source_id COLLATE "C"',[namespace,epoch])){const owner=owners.get(String(row.source_id));if(!owner||owner.binding.bindingHash!==row.binding_hash)targetInventoryFailure('projection roster differs');bound++;}if(bound!==owners.size)targetInventoryFailure('projection roster is incomplete');
  async function* references():AsyncGenerator<OnlineOwnedInventoryItem>{
   for await(const row of scanTargetInventoryIn(client,'SELECT target_key,source_key,tenant_hash,organization_id FROM opencrawl_online_projection_replicas_references WHERE namespace=$1 AND epoch=$2 ORDER BY target_key COLLATE "C"',[namespace,epoch])){
    const identity=[String(row.tenant_hash),String(row.organization_id)];if(row.target_key!==JSON.stringify(['replicas-index',...identity]))targetInventoryFailure('alias target identity differs');yield {kind:'target',domains:['replicas-index'],identity,sourceKey:String(row.source_key),value:{organizationId:row.organization_id},maxBytes:65536};
   }
  }
  const scans=[()=>inventoryAccountTargetsIn(database,client),()=>inventoryControlTargetsIn(database,client),()=>inventoryConnectorSecretTargetsIn(database,client),()=>inventorySetupTargetsIn(database,client),()=>inventoryWorkloadTargetsIn(database,client,'replicas',replicasChallengeSchema),()=>inventoryValueReportTargetsIn(database,client),()=>inventoryWriteFenceTargetsIn(database,client),()=>inventoryDeletionTargetsIn(database,client),()=>inventoryBoardTargetsIn(database,client),()=>inventorySlackTargetsIn(database,client,epoch),references];
  let index=0,iterator:AsyncGenerator<OnlineOwnedInventoryItem>|undefined,pending:OnlineOwnedInventoryItem|undefined,invalid=false,done=false,busy=false,total=0n,unproved=0n;
  const counts:Record<string,bigint>={},digest=createHash('sha256');
  const check=async()=>{if(JSON.stringify(await readSnapshot(client))!==JSON.stringify(snapshot))targetInventoryFailure('transaction or snapshot changed');};
  async function close(){invalid=true;if(iterator){const active=iterator;iterator=undefined;await active.return(undefined);}}
  async function take():Promise<OnlineOwnedInventoryItem|null>{while(index<scans.length){iterator??=scans[index]();const entry=await iterator.next();if(!entry.done)return entry.value;iterator=undefined;index++;}return null;}
  async function next({limit=64,maxBytes=64*1024*1024}:{limit?:number;maxBytes?:number}={}){
   if(invalid||done||busy)targetInventoryFailure('reader closed, failed or concurrently used');busy=true;
   let processed=0,bytes=0,pageUnproved=0;
   try{if(!Number.isSafeInteger(limit)||limit<1||limit>64||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024)targetInventoryFailure('invalid page budget');await check();while(processed<limit){const item=pending??await take();pending=undefined;if(!item){done=true;break;}
     const size=item.kind==='target'?targetInventoryValueBytes(item.value,item.maxBytes):Buffer.byteLength(JSON.stringify(item));
     if(size>maxBytes){if(!processed)targetInventoryFailure('page budget smaller than owner value');pending=item;break;}if(bytes+size>maxBytes){pending=item;break;}
     if(item.kind==='auxiliary'){if(!item.proved){unproved++;pageUnproved++;}counts[item.owner]=(counts[item.owner]??0n)+1n;digest.update(JSON.stringify([item.owner,item.identity,item.proved])+'\n');}
     else{const keys=item.domains.map(domain=>JSON.stringify([domain,...item.identity]));const heads=(await client.query('SELECT target_key,source_id,domain,target_hash,deleted FROM opencrawl_online_projection_heads WHERE namespace=$1 AND epoch=$2 AND target_key=ANY($3::text[]) LIMIT 2',[namespace,epoch,keys])).rows;
      if(heads.length!==1||heads[0].deleted)targetInventoryFailure('unheaded, ambiguous or tombstoned typed target');const head=heads[0],owner=owners.get(head.source_id);if(!owner)targetInventoryFailure('typed target has an unknown publisher');
      const verified=await owner.inspect(client,item);if(!verified||verified.targetKey!==head.target_key||verified.targetHash!==head.target_hash)targetInventoryFailure('owning target or publisher differs');counts[head.domain]=(counts[head.domain]??0n)+1n;digest.update(JSON.stringify([head.domain,verified.targetKey,verified.targetHash])+'\n');
     }
     processed++;total++;bytes+=size;
    }await check();return {snapshotIdentity:snapshot,binding:{namespace,epoch,bindingHash},processed:String(processed),bytes:String(bytes),counts:Object.freeze(Object.fromEntries(Object.entries(counts).map(([domain,n])=>[domain,String(n)]))),unproved:String(pageUnproved),unprovedTotal:String(unproved),exhausted:done,complete:done&&unproved===0n,total:String(total),digest:digest.copy().digest('hex'),runtimeAdmission:false as const};
   }catch(error){invalid=true;await close().catch(()=>{});throw error;}finally{busy=false;}
  }
  return Object.freeze({snapshotIdentity:snapshot,binding:{namespace,epoch,bindingHash},next,close});
 }
 return Object.freeze({binding:Object.freeze({namespace,epoch,bindingHash}),beginSnapshotIn});
}
