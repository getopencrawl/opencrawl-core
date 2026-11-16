import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {onlineApplicationAdmissionHash,readApplicationAdmission,validateOnlineApplicationAdmission,verifyOnlineAdmissionSchemaIn,type OnlineApplicationAdmission} from './application-admission.mjs';
import type {createOnlineWriteAuthority} from './online-authority.mjs';

export interface OnlineAdmissionSnapshot {
 backendPid:number;transactionStartedAt:string;snapshot:string;
 isolation:'repeatable read'|'serializable';readOnly:boolean;
}
function fail(code:string):never{throw Object.assign(new Error('Online admission write: '+code),{code:'ONLINE_ADMISSION_'+code});}

/** The final verifier captures this identity after taking all writer locks.
 * It is an observation, never proof that coverage or parity has been checked. */
export async function readOnlineAdmissionSnapshotIn(client:PoolClient):Promise<Readonly<OnlineAdmissionSnapshot>>{
 const row=(await client.query(`SELECT pg_backend_pid() AS backend_pid,transaction_timestamp()::text AS transaction_started_at,
  pg_current_snapshot()::text AS snapshot,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only`)).rows[0];
 if(!row||!Number.isSafeInteger(row.backend_pid)||typeof row.transaction_started_at!=='string'||typeof row.snapshot!=='string'||!['repeatable read','serializable'].includes(row.isolation)||!['on','off'].includes(row.read_only))fail('SNAPSHOT_REQUIRED');
 return Object.freeze({backendPid:row.backend_pid,transactionStartedAt:row.transaction_started_at,snapshot:row.snapshot,isolation:row.isolation,readOnly:row.read_only==='on'});
}

async function requireExclusiveGateIn(client:PoolClient,key:string){
 const row=(await client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
  AND granted AND mode='ExclusiveLock' AND objsubid=1
  AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295)
  AND objid::bigint=(hashtextextended($1,0)&4294967295)) AS held`,[key])).rows[0];
 if(row?.held!==true)fail('EXCLUSIVE_GATE_REQUIRED');
}

/** Internal terminal write for the owning final sealer. NOT a parity verifier:
 * the caller must finish every concrete source reader and the global owning
 * inventory in this exact snapshot while retaining all target writer locks.
 * This module deliberately has no public package export or CLI. It never begins
 * or commits a transaction, prepares schema, imports data, or reopens writers.
 * A lost COMMIT acknowledgement must be reconciled under the authority gate. */
export async function writeOnlineApplicationAdmissionIn(client:PoolClient,{proof:input,snapshot:inputSnapshot}:{proof:OnlineApplicationAdmission;snapshot:OnlineAdmissionSnapshot}){
 const proof=validateOnlineApplicationAdmission(input),snapshot=Object.freeze({...inputSnapshot}),receiptHash=onlineApplicationAdmissionHash(proof);
 if(snapshot.readOnly||!isDeepStrictEqual(await readOnlineAdmissionSnapshotIn(client),snapshot))fail('SNAPSHOT_CHANGED');
 await requireExclusiveGateIn(client,JSON.stringify(['online-write-authority',proof.namespace]));
 await requireExclusiveGateIn(client,JSON.stringify(['online-migration',proof.namespace,proof.epoch]));
 await verifyOnlineAdmissionSchemaIn(client);
 // These terminal rows are never adopted or replaced. Conflicts, including a
 // previous offline import, require the owning operator to resolve the target.
 if((await client.query('SELECT 1 FROM opencrawl_application_installations WHERE namespace=$1 UNION ALL SELECT 1 FROM opencrawl_online_application_admissions WHERE namespace=$1 LIMIT 1',[proof.namespace])).rows.length)fail('TARGET_ALREADY_ADMITTED');
 const authority=(await client.query('SELECT epoch,protocol,mode,preparation_receipt_hash,enrollment_receipt_hash,target_receipt_hash FROM opencrawl_online_write_authorities WHERE namespace=$1 FOR UPDATE',[proof.namespace])).rows[0];
 if(!authority||authority.epoch!==proof.epoch||authority.protocol!==proof.protocol||authority.mode!=='journal'||authority.preparation_receipt_hash!==proof.preparationReceiptHash||authority.enrollment_receipt_hash!==proof.enrollmentReceiptHash||authority.target_receipt_hash!==null)fail('AUTHORITY_CHANGED');
 const epoch=(await client.query('SELECT state FROM opencrawl_online_migration_epochs WHERE namespace=$1 AND epoch=$2 FOR UPDATE',[proof.namespace,proof.epoch])).rows[0];
 if(epoch?.state!=='active')fail('EPOCH_NOT_ACTIVE');
 const rows=(await client.query(`SELECT
  (SELECT count(*) FROM opencrawl_online_migration_sources WHERE namespace=$1 AND epoch=$2)::text AS sources,
  EXISTS(SELECT 1 FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND state='pending') AS pending,
  EXISTS(SELECT 1 FROM opencrawl_online_migration_heads WHERE namespace=$1 AND epoch=$2 AND pending_operation IS NOT NULL) AS pending_head,
  EXISTS(SELECT 1 FROM opencrawl_online_legacy_inflight WHERE namespace=$1) AS legacy_inflight`,[proof.namespace,proof.epoch])).rows[0];
 if(!rows||rows.sources!==String(proof.sourceCount)||rows.pending!==false||rows.pending_head!==false||rows.legacy_inflight!==false)fail('FRONTIER_NOT_CLOSED');
 await client.query('INSERT INTO opencrawl_online_application_admissions(namespace,epoch,receipt_hash,proof) VALUES($1,$2,$3,$4::jsonb)',[proof.namespace,proof.epoch,receiptHash,JSON.stringify(proof)]);
 await client.query(`INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at,source_manifest_hash,inventory_complete,admission_kind,online_epoch,online_receipt_hash)
  VALUES($1,$2::jsonb,NULL,'ready',$3,NULL,false,'online',$4,$5)`,[proof.namespace,JSON.stringify(proof.source),proof.sealedAt,proof.epoch,receiptHash]);
 const fenced=await client.query("UPDATE opencrawl_online_migration_epochs SET state='fenced' WHERE namespace=$1 AND epoch=$2 AND state='active'",[proof.namespace,proof.epoch]);
 if(fenced.rowCount!==1)fail('EPOCH_CHANGED');
 const admitted=await client.query("UPDATE opencrawl_online_write_authorities SET mode='target',target_receipt_hash=$5 WHERE namespace=$1 AND epoch=$2 AND mode='journal' AND preparation_receipt_hash=$3 AND enrollment_receipt_hash=$4 AND target_receipt_hash IS NULL",[proof.namespace,proof.epoch,proof.preparationReceiptHash,proof.enrollmentReceiptHash,receiptHash]);
 if(admitted.rowCount!==1)fail('AUTHORITY_CHANGED');
 const readback=await readApplicationAdmission({pool:client,namespace:proof.namespace,sourceIdentity:proof.source,onlineTargetId:proof.targetId});
 if(readback.kind!=='online'||readback.receiptHash!==receiptHash)fail('READBACK_CHANGED');
 return Object.freeze({receiptHash,proof,committed:false as const});
}

/** Reconcile only after the original connection no longer holds authority.
 * Unknown outcomes throw; they never authorize restarting legacy writers.
 * A confirmed abort leaves the already compatible journal path unchanged. */
export async function reconcileOnlineApplicationAdmission(authority:ReturnType<typeof createOnlineWriteAuthority>,input:OnlineApplicationAdmission){
 const proof=validateOnlineApplicationAdmission(input),receiptHash=onlineApplicationAdmissionHash(proof);
 if(authority.binding.namespace!==proof.namespace||authority.binding.epoch!==proof.epoch||authority.binding.protocol!==proof.protocol)fail('AUTHORITY_CHANGED');
 return authority.withFinalizationRecovery(proof,async(client,state,alive)=>{
  if(state.mode==='target'){
   const value=await readApplicationAdmission({pool:client,namespace:proof.namespace,sourceIdentity:proof.source,onlineTargetId:proof.targetId});alive();
   if(value.kind!=='online'||value.receiptHash!==receiptHash||state.targetReceiptHash!==receiptHash)fail('DIFFERENT_ADMISSION');
   return Object.freeze({status:'committed' as const,receiptHash,proof:value.proof});
  }
  const rows=(await client.query('SELECT 1 FROM opencrawl_application_installations WHERE namespace=$1 UNION ALL SELECT 1 FROM opencrawl_online_application_admissions WHERE namespace=$1 LIMIT 1',[proof.namespace])).rows;
  const epoch=(await client.query('SELECT state FROM opencrawl_online_migration_epochs WHERE namespace=$1 AND epoch=$2',[proof.namespace,proof.epoch])).rows[0];alive();
  if(rows.length||epoch?.state!=='active')fail('OUTCOME_UNRESOLVED');
  return Object.freeze({status:'not-admitted' as const,authority:'journal' as const});
 });
}
