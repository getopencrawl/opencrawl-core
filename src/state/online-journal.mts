import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

/** Explicit online migration tooling. This is never a runtime storage fallback. */
export const ONLINE_MAX_PAYLOAD_BYTES=64*1024*1024,ONLINE_MAX_PAGE_BYTES=64*1024*1024;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const decimal=/^(0|[1-9][0-9]*)$/;
export interface OnlineExternalSnapshot {
 version:string|null;operationId:string|null;revision:string|null;deleted:boolean;bytes:Buffer|null;contentType:string|null;
}
export interface OnlinePutMutation {operationId:string;revision:string;bytes:Buffer;contentType:string}
export interface OnlineDeleteMutation {operationId:string;revision:string}
/** Versions must not repeat for different operations, even identical payloads.
 * Deletes retain an operation-stamped tombstone. No physical delete/absence ABA.
 * false means a definite conditional rejection; uncertain responses must throw. */
export interface OnlineExternalStore {
 read(key:string,options:{maxBytes:number}):Promise<OnlineExternalSnapshot>;
 putIfVersion(key:string,version:string|null,mutation:OnlinePutMutation):Promise<boolean>;
 deleteIfVersion(key:string,version:string|null,mutation:OnlineDeleteMutation):Promise<boolean>;
}
export type OnlineMutation={kind:'put';bytes:Buffer;contentType:string}|{kind:'delete'};
export interface OnlineMutationRequest {operationId:string;key:string;condition?:{version:string|null};mutation:OnlineMutation}
export interface OnlineIntent {
 namespace:string;epoch:string;sourceId:string;operationId:string;key:string;sequence:string;revision:string;
 expectedVersion:string|null;mutation:OnlineMutation;state:'pending'|'applied'|'notApplied';dispatched:boolean;resultVersion:string|null;requestHash:string;
}
function fail(code:string,cause?:unknown):never{throw Object.assign(new Error('Online migration: '+code,{cause}),{code:'ONLINE_MIGRATION_'+code});}
function text(value:unknown,max:number,label:string):asserts value is string{if(typeof value!=='string'||!value.length||Buffer.byteLength(value)>max||value.includes('\0'))fail('INVALID_'+label);}
function version(value:unknown){if(value!==null)text(value,2048,'VERSION');}
function sequence(value:unknown):asserts value is string{if(typeof value!=='string'||!decimal.test(value)||BigInt(value)>9223372036854775807n)fail('INVALID_SEQUENCE');}
function mutation(value:OnlineMutation){if(value?.kind==='delete'){if(Object.keys(value).some(k=>k!=='kind'))fail('INVALID_DELETE');return;}
 if(value?.kind!=='put'||!Buffer.isBuffer(value.bytes)||value.bytes.length>ONLINE_MAX_PAYLOAD_BYTES)fail('INVALID_PAYLOAD');text(value.contentType,256,'CONTENT_TYPE');if(/[\r\n]/.test(value.contentType))fail('INVALID_CONTENT_TYPE');}
function digest(value:Uint8Array|string){return createHash('sha256').update(value).digest('hex');}
function requestHash(value:OnlineMutationRequest){return digest(JSON.stringify([value.operationId,value.key,value.condition===undefined?'unconditional':value.condition.version,value.mutation.kind,value.mutation.kind==='put'?value.mutation.contentType:null,value.mutation.kind==='put'?digest(value.mutation.bytes):null]));}
function validateSnapshot(value:OnlineExternalSnapshot){
 version(value.version);if(typeof value.deleted!=='boolean')fail('INVALID_EXTERNAL_STATE');
 if(value.version===null){if(!value.deleted||value.operationId!==null||value.revision!==null||value.bytes!==null||value.contentType!==null)fail('INVALID_ABSENCE');return;}
 if(value.operationId!==null){if(!uuid.test(value.operationId))fail('INVALID_EXTERNAL_OPERATION');sequence(value.revision);if(value.revision==='0')fail('INVALID_EXTERNAL_REVISION');}
 else if(value.revision!==null)fail('INVALID_EXTERNAL_REVISION');
 if(value.deleted){if(value.operationId===null||value.bytes!==null||value.contentType!==null)fail('INVALID_TOMBSTONE');}
 else {if(!Buffer.isBuffer(value.bytes)||value.bytes.length>ONLINE_MAX_PAYLOAD_BYTES)fail('INVALID_EXTERNAL_PAYLOAD');text(value.contentType,256,'CONTENT_TYPE');}
}
function appliedEvidence(intent:OnlineIntent,observed:OnlineExternalSnapshot){
 if(observed.operationId!==intent.operationId)return false;
 if(observed.revision!==intent.revision||observed.version===null||observed.deleted!==(intent.mutation.kind==='delete'))fail('OPERATION_EVIDENCE_CONFLICT');
 if(intent.mutation.kind==='put'&&(!observed.bytes?.equals(intent.mutation.bytes)||observed.contentType!==intent.mutation.contentType))fail('OPERATION_EVIDENCE_CONFLICT');
 return true;
}
/** Shared protocol also supports deterministic fault tests without a database.
 * dispatch MUST durably commit before the external request; finish MUST persist
 * terminal state. A timeout/old ETag/absence alone never means notApplied. */
export async function runOnlineMutationProtocol(intent:OnlineIntent,store:OnlineExternalStore,hooks:{dispatch():Promise<void>;finish(state:'applied'|'notApplied',version:string|null):Promise<OnlineIntent>}):Promise<OnlineIntent>{
 if(intent.state!=='pending')return intent;
 const read=async()=>{const value=await store.read(intent.key,{maxBytes:ONLINE_MAX_PAYLOAD_BYTES});validateSnapshot(value);return value;};
 const before=await read();
 if(appliedEvidence(intent,before))return hooks.finish('applied',before.version);
 if(before.version!==intent.expectedVersion){if(intent.dispatched)fail('UNRESOLVED_INTENT');return hooks.finish('notApplied',null);}
 const retry=intent.dispatched;
 await hooks.dispatch();
 let changed:boolean;
 try{changed=intent.mutation.kind==='put'?await store.putIfVersion(intent.key,intent.expectedVersion,{operationId:intent.operationId,revision:intent.revision,bytes:intent.mutation.bytes,contentType:intent.mutation.contentType}):await store.deleteIfVersion(intent.key,intent.expectedVersion,{operationId:intent.operationId,revision:intent.revision});}
 catch(error){fail('EXTERNAL_OUTCOME_UNCERTAIN',error);}
 if(typeof changed!=='boolean')fail('INVALID_EXTERNAL_RESULT');
 const after=await read();
 if(appliedEvidence(intent,after))return hooks.finish('applied',after.version);
 if(changed||retry)fail('EXTERNAL_OUTCOME_UNCERTAIN');
 return hooks.finish('notApplied',null);
}

const columns='namespace,epoch,source_id,operation_id,source_key,sequence,revision,expected_version,kind,payload,content_type,payload_hash,state,dispatched,result_version,request_hash';
function decode(row:Record<string,any>):OnlineIntent{
 const m:OnlineMutation=row.kind==='put'?{kind:'put',bytes:row.payload,contentType:row.content_type}:{kind:'delete'};mutation(m);
 for(const field of ['sequence','revision']){sequence(row[field]);if(row[field]==='0')fail('INVALID_STORED_REVISION');}
 if(!['put','delete'].includes(row.kind)||!['pending','applied','notApplied'].includes(row.state)||typeof row.dispatched!=='boolean'||!uuid.test(row.operation_id)||!/^[a-f0-9]{64}$/.test(row.request_hash))fail('INVALID_STORED_INTENT');
 if(m.kind==='put'?digest(m.bytes)!==row.payload_hash:row.payload!==null||row.content_type!==null||row.payload_hash!==null)fail('STORED_PAYLOAD_CHANGED');
 version(row.expected_version);version(row.result_version);
 if(row.state==='applied'&&row.result_version===null||row.state!=='applied'&&row.result_version!==null)fail('INVALID_STORED_RESULT');
 return {namespace:row.namespace,epoch:row.epoch,sourceId:row.source_id,operationId:row.operation_id,key:row.source_key,sequence:row.sequence,revision:row.revision,expectedVersion:row.expected_version,mutation:m,state:row.state,dispatched:row.dispatched,resultVersion:row.result_version,requestHash:row.request_hash};
}
export function createOnlineJournal({database,epoch,sourceId}:{database:{pool:Pool;namespace:string};epoch:string;sourceId:string}){
 text(database.namespace,2048,'NAMESPACE');text(sourceId,2048,'SOURCE');if(!uuid.test(epoch))fail('INVALID_EPOCH');
 const scope=[database.namespace,epoch,sourceId],epochLock=JSON.stringify(['online-migration',database.namespace,epoch]);
 const keyLock=(key:string)=>JSON.stringify([...scope,key]);let preparing:Promise<void>|undefined;
 async function transaction<T>(client:PoolClient,run:()=>Promise<T>){await client.query('BEGIN');try{const result=await run();await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}}
 async function locked<T>(key:string|undefined,exclusive:boolean,run:(client:PoolClient)=>Promise<T>):Promise<T>{
  if(key!==undefined)text(key,8192,'KEY');const client=await database.pool.connect();let heldEpoch=false,heldKey=false,destroy=false,broken=false;
  const onError=()=>{broken=true;};client.on('error',onError);
  try{
   await client.query(`SELECT pg_advisory_lock${exclusive?'':'_shared'}(hashtextextended($1,0))`,[epochLock]);heldEpoch=true;
   if(key!==undefined){await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[keyLock(key)]);heldKey=true;}
   const result=await run(client);if(broken)fail('LOCK_CONNECTION_LOST');return result;
  }catch(error){destroy=true;throw error;}
  finally{
   try{if(!destroy&&!broken){if(heldKey)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[keyLock(key!)]);if(heldEpoch)await client.query(`SELECT pg_advisory_unlock${exclusive?'':'_shared'}(hashtextextended($1,0))`,[epochLock]);}}catch{destroy=true;}
   client.removeListener('error',onError);client.release(destroy||broken);
  }
 }
 async function active(client:PoolClient){const row=(await client.query('SELECT state FROM opencrawl_online_migration_epochs WHERE namespace=$1 AND epoch=$2',scope.slice(0,2))).rows[0];if(row?.state!=='active')fail('EPOCH_NOT_ACTIVE');}
 async function ready(){
  preparing??=(async()=>{const client=await database.pool.connect();try{await transaction(client,async()=>{
   await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-migration:schema',0))");
   await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_migration_epochs(namespace text NOT NULL,epoch uuid NOT NULL,state text NOT NULL CHECK(state IN ('active','fenced')),PRIMARY KEY(namespace,epoch));
    CREATE TABLE IF NOT EXISTS opencrawl_online_migration_sources(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0),PRIMARY KEY(namespace,epoch,source_id));
    CREATE TABLE IF NOT EXISTS opencrawl_online_migration_heads(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,revision bigint NOT NULL CHECK(revision>0),pending_operation uuid,PRIMARY KEY(namespace,epoch,source_id,source_key));
    CREATE TABLE IF NOT EXISTS opencrawl_online_migration_journal(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,sequence bigint NOT NULL CHECK(sequence>0),operation_id uuid NOT NULL,source_key text COLLATE "C" NOT NULL,revision bigint NOT NULL CHECK(revision>0),expected_version text,kind text NOT NULL CHECK(kind IN ('put','delete')),payload bytea,content_type text,payload_hash text,state text NOT NULL CHECK(state IN ('pending','applied','notApplied')),dispatched boolean NOT NULL DEFAULT false,result_version text,request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
     PRIMARY KEY(namespace,epoch,source_id,sequence),UNIQUE(namespace,epoch,source_id,operation_id),UNIQUE(namespace,epoch,source_id,source_key,revision),
     CHECK((kind='put' AND payload IS NOT NULL AND octet_length(payload)<=67108864 AND content_type IS NOT NULL AND payload_hash IS NOT NULL AND payload_hash~'^[a-f0-9]{64}$') OR (kind='delete' AND payload IS NULL AND content_type IS NULL AND payload_hash IS NULL)),CHECK((state='applied' AND result_version IS NOT NULL) OR (state<>'applied' AND result_version IS NULL)));
    CREATE TABLE IF NOT EXISTS opencrawl_online_migration_checkpoints(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,consumer text NOT NULL,sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0),PRIMARY KEY(namespace,epoch,source_id,consumer));`);
   const {ensureSchemaIndex}=await import('./postgres.mjs');
   await ensureSchemaIndex(client,{table:'opencrawl_online_migration_journal',name:'opencrawl_online_migration_pending',keys:['namespace','epoch','source_id','sequence'],predicate:{column:'state',equals:'pending'}});
  });}finally{client.release();}
  await locked(undefined,false,client=>transaction(client,async()=>{await client.query("INSERT INTO opencrawl_online_migration_epochs(namespace,epoch,state) VALUES($1,$2,'active') ON CONFLICT DO NOTHING",scope.slice(0,2));await active(client);await client.query('INSERT INTO opencrawl_online_migration_sources(namespace,epoch,source_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',scope);}));})();
  try{await preparing;}catch(error){preparing=undefined;throw error;}
 }
 async function get(client:PoolClient,operationId:string){const row=(await client.query(`SELECT ${columns} FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND operation_id=$4`,[...scope,operationId])).rows[0];return row?decode(row):null;}
 async function finish(client:PoolClient,intent:OnlineIntent,state:'applied'|'notApplied',resultVersion:string|null){return transaction(client,async()=>{
  const updated=await client.query(`UPDATE opencrawl_online_migration_journal SET state=$5,result_version=$6 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND operation_id=$4 AND state='pending' RETURNING ${columns}`,[...scope,intent.operationId,state,resultVersion]);if(updated.rows.length!==1)fail('INTENT_STATE_CHANGED');
  const head=await client.query('UPDATE opencrawl_online_migration_heads SET pending_operation=NULL WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND pending_operation=$5',[...scope,intent.key,intent.operationId]);if(head.rowCount!==1)fail('KEY_HEAD_CHANGED');return decode(updated.rows[0]);
 });}
 async function process(client:PoolClient,intent:OnlineIntent,store:OnlineExternalStore){return runOnlineMutationProtocol(intent,store,{dispatch:async()=>{
  const result=await client.query("UPDATE opencrawl_online_migration_journal SET dispatched=true WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND operation_id=$4 AND state='pending'",[...scope,intent.operationId]);if(result.rowCount!==1)fail('INTENT_STATE_CHANGED');
 },finish:(state,v)=>finish(client,intent,state,v)});}
 async function mutate(request:OnlineMutationRequest,store:OnlineExternalStore){
  if(!uuid.test(request.operationId))fail('INVALID_OPERATION');text(request.key,8192,'KEY');mutation(request.mutation);if(request.condition!==undefined)version(request.condition.version);
  // Freeze caller-owned buffers before waiting for a lock or persisting intent.
  const frozen:OnlineMutationRequest={...request,...(request.condition?{condition:{...request.condition}}:{}),mutation:request.mutation.kind==='put'?{...request.mutation,bytes:Buffer.from(request.mutation.bytes)}:{kind:'delete'}},hash=requestHash(frozen);
  return locked(frozen.key,false,async client=>{
   await active(client);const previous=await get(client,frozen.operationId);if(previous){if(previous.key!==frozen.key||previous.requestHash!==hash)fail('OPERATION_ID_REUSED');return process(client,previous,store);}
   const head=(await client.query('SELECT revision,pending_operation FROM opencrawl_online_migration_heads WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4',[...scope,frozen.key])).rows[0];if(head?.pending_operation)fail('UNRESOLVED_INTENT');
   const observed=await store.read(frozen.key,{maxBytes:ONLINE_MAX_PAYLOAD_BYTES});validateSnapshot(observed);
   const permitted=frozen.condition===undefined||(frozen.condition.version===null?observed.deleted:!observed.deleted&&observed.version===frozen.condition.version);
   const intent=await transaction(client,async()=>{
    const allocated=(await client.query('UPDATE opencrawl_online_migration_sources SET sequence=sequence+1 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 RETURNING sequence',scope)).rows[0];if(!allocated)fail('SOURCE_NOT_PREPARED');
    const rev=(BigInt(head?.revision??'0')+1n).toString();sequence(rev);const m=frozen.mutation;
    const row=(await client.query(`INSERT INTO opencrawl_online_migration_journal(${columns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${columns}`,[...scope,frozen.operationId,frozen.key,allocated.sequence,rev,observed.version,m.kind,m.kind==='put'?m.bytes:null,m.kind==='put'?m.contentType:null,m.kind==='put'?digest(m.bytes):null,permitted?'pending':'notApplied',false,null,hash])).rows[0];
    await client.query('INSERT INTO opencrawl_online_migration_heads(namespace,epoch,source_id,source_key,revision,pending_operation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,epoch,source_id,source_key) DO UPDATE SET revision=EXCLUDED.revision,pending_operation=EXCLUDED.pending_operation',[...scope,frozen.key,rev,permitted?frozen.operationId:null]);return decode(row);
   });
   return process(client,intent,store);
  });
 }
 async function reconcile(key:string,store:OnlineExternalStore){return locked(key,false,async client=>{await active(client);const head=(await client.query('SELECT pending_operation FROM opencrawl_online_migration_heads WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4',[...scope,key])).rows[0];if(!head?.pending_operation)return null;const intent=await get(client,head.pending_operation);if(!intent||intent.key!==key||intent.state!=='pending')fail('KEY_HEAD_CHANGED');return process(client,intent,store);});}
 async function frontierStateIn(client:PoolClient){const row=(await client.query(`SELECT s.sequence::text AS allocated,COALESCE((SELECT min(j.sequence)-1 FROM opencrawl_online_migration_journal j WHERE j.namespace=s.namespace AND j.epoch=s.epoch AND j.source_id=s.source_id AND j.state='pending'),s.sequence)::text AS frontier FROM opencrawl_online_migration_sources s WHERE namespace=$1 AND epoch=$2 AND source_id=$3`,scope)).rows[0];if(!row)fail('SOURCE_NOT_PREPARED');sequence(row.frontier);sequence(row.allocated);return {allocated:row.allocated as string,closed:row.frontier as string,pending:row.allocated!==row.frontier};}
 async function frontier(client:PoolClient){return (await frontierStateIn(client)).closed;}
 async function frontierState(){return locked(undefined,false,frontierStateIn);}
 async function pendingPage({after='0',limit=64}:{after?:string;limit?:number}={}){sequence(after);if(!Number.isSafeInteger(limit)||limit<1||limit>64)fail('INVALID_PAGE_LIMIT');return locked(undefined,false,async client=>{const rows=(await client.query("SELECT operation_id,source_key,sequence FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND state='pending' AND sequence>$4 ORDER BY sequence LIMIT $5",[...scope,after,limit])).rows;const entries=rows.map(row=>{sequence(row.sequence);text(row.source_key,8192,'KEY');if(!uuid.test(row.operation_id))fail('INVALID_STORED_INTENT');return {operationId:row.operation_id as string,key:row.source_key as string,sequence:row.sequence as string};});return {entries,next:entries.length===limit?entries.at(-1)!.sequence:null};});}
 async function closedFrontier(){return locked(undefined,false,frontier);}
 async function replayCheckpoint(consumer:string){text(consumer,512,'CONSUMER');return locked(undefined,false,async client=>{const row=(await client.query('SELECT sequence FROM opencrawl_online_migration_checkpoints WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND consumer=$4',[...scope,consumer])).rows[0];if(!row)return null;sequence(row.sequence);return row.sequence as string;});}
 async function replayPage({consumer,through,limit=64,apply}:{consumer:string;through?:string;limit?:number;apply:(client:PoolClient,intent:OnlineIntent)=>Promise<void>}){
  text(consumer,512,'CONSUMER');if(through!==undefined)sequence(through);if(!Number.isSafeInteger(limit)||limit<1||limit>64)fail('INVALID_PAGE_LIMIT');
  return locked(undefined,false,client=>transaction(client,async()=>{
   await client.query('INSERT INTO opencrawl_online_migration_checkpoints(namespace,epoch,source_id,consumer) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...scope,consumer]);
   const cp=(await client.query('SELECT sequence FROM opencrawl_online_migration_checkpoints WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND consumer=$4 FOR UPDATE',[...scope,consumer])).rows[0];let checkpoint=String(cp.sequence);const closed=await frontier(client),target=through??closed;if(BigInt(target)>BigInt(closed))fail('FRONTIER_NOT_CLOSED');if(BigInt(checkpoint)>BigInt(target))fail('CHECKPOINT_PAST_TARGET');
   const rows=(await client.query('SELECT sequence,operation_id,state,COALESCE(octet_length(payload),0) AS bytes FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND sequence>$4 AND sequence<=$5 ORDER BY sequence LIMIT $6',[...scope,checkpoint,target,limit])).rows;
   let bytes=0,applied=0,notApplied=0;
   for(const row of rows){if(BigInt(row.sequence)!==BigInt(checkpoint)+1n)fail('JOURNAL_SEQUENCE_HOLE');if(row.state==='pending')fail('FRONTIER_CHANGED');if(bytes+row.bytes>ONLINE_MAX_PAGE_BYTES)break;bytes+=row.bytes;
    const intent=await get(client,row.operation_id);if(!intent||intent.sequence!==row.sequence||intent.state!==row.state)fail('JOURNAL_CHANGED');
    if(intent.state==='applied'){await apply(client,intent);applied++;}else if(intent.state==='notApplied')notApplied++;else fail('UNRESOLVED_INTENT');checkpoint=intent.sequence;
   }
   if(BigInt(checkpoint)<BigInt(target)&&rows.length===0)fail('JOURNAL_SEQUENCE_HOLE');
   await client.query('UPDATE opencrawl_online_migration_checkpoints SET sequence=$5 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND consumer=$4',[...scope,consumer,checkpoint]);
   const allocated=(await client.query('SELECT sequence FROM opencrawl_online_migration_sources WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope)).rows[0];
   return {checkpoint,frontier:closed,applied,notApplied,pending:BigInt(allocated.sequence)>BigInt(closed),caughtUp:checkpoint===target};
  }));
 }
 async function backfillIfUnchanged({key,apply}:{key:string;apply:(client:PoolClient)=>Promise<void>}){return locked(key,false,client=>transaction(client,async()=>{
  await active(client);const mutation=(await client.query("SELECT 1 FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND state<>'notApplied' LIMIT 1",[...scope,key])).rows.length;
  if(mutation)return {applied:false};await apply(client);return {applied:true};
 }));}
 async function observeKey<T>({key,through,read}:{key:string;through:string;read:(client:PoolClient)=>Promise<T>}):Promise<{observed:true;value:T}|{observed:false;reason:'pending'|'newer-mutation'}>{
  sequence(through);return locked(key,false,client=>transaction(client,async()=>{
   const closed=await frontier(client);if(BigInt(through)>BigInt(closed))fail('FRONTIER_NOT_CLOSED');
   const latest=(await client.query("SELECT sequence,state FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND state<>'notApplied' ORDER BY revision DESC LIMIT 1",[...scope,key])).rows[0];
   if(latest?.state==='pending')return {observed:false,reason:'pending'} as const;
   if(latest&&BigInt(latest.sequence)>BigInt(through))return {observed:false,reason:'newer-mutation'} as const;
   return {observed:true,value:await read(client)} as const;
  }));
 }
 async function fence(){return locked(undefined,true,client=>transaction(client,async()=>{
  const pending=(await client.query("SELECT 1 FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND state='pending' LIMIT 1",scope.slice(0,2))).rows.length;if(pending)fail('EPOCH_HAS_PENDING_INTENTS');
  const result=await client.query("UPDATE opencrawl_online_migration_epochs SET state='fenced' WHERE namespace=$1 AND epoch=$2",scope.slice(0,2));if(result.rowCount!==1)fail('EPOCH_NOT_PREPARED');return {frontier:await frontier(client),fenced:true as const};
 }));}
 return {binding:Object.freeze({namespace:scope[0]!,epoch,sourceId}),ready,mutate,reconcile,closedFrontier,frontierState,replayCheckpoint,pendingPage,replayPage,backfillIfUnchanged,observeKey,fence};
}
