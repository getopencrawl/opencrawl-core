import type {Pool,PoolClient} from 'pg';
import {onlineMigrationBindingId,onlineMigrationReference} from './binding.mjs';
import type {OnlineMigrationAdapter,OnlineMigrationBinding,OnlineMigrationCheckpoint,OnlineMigrationPage,OnlineMigrationProgress,OnlineMigrationReference} from './types.mjs';
const unsafe=():never=>{throw Object.assign(Error('Online migration scope or checkpoint is invalid'),{code:'ONLINE_MIGRATION_UNSAFE'});};
const sequence=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const cursor=(value:unknown):value is string|null=>value===null||typeof value==='string'&&Buffer.byteLength(value)<=8192&&value.length>0;
const safeCount=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export function createOnlineMigrationController({database,binding:input,adapter,pageSize=64}:{database:{pool:Pool;namespace:string};binding:OnlineMigrationBinding;adapter:OnlineMigrationAdapter;pageSize?:number}){
 const binding=Object.freeze({...input}),bindingId=onlineMigrationBindingId(binding),namespace=database.namespace;
 if(!namespace||namespace.length>2048||(database.pool.options.max??10)<2||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>64)unsafe();
 let preparing:Promise<void>|undefined;
 function reference(value:OnlineMigrationReference){
  if(!value||Object.keys(value).sort().join(',')!=='bindingId,shard'||value.bindingId!==bindingId||!Number.isSafeInteger(value.shard)||value.shard<0||value.shard>=binding.shards)unsafe();
  return onlineMigrationReference(binding,value.shard);
 }
 async function ready(){
  preparing??=(async()=>{const client=await database.pool.connect();try{
   await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-migration:schema',0))");
   await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_migration_runs(
    namespace text NOT NULL,binding_id text NOT NULL CHECK(binding_id~'^[a-f0-9]{64}$'),shard integer NOT NULL CHECK(shard>=0 AND shard<256),
    epoch uuid NOT NULL,source_id text NOT NULL,target_id text NOT NULL,shards integer NOT NULL CHECK(shards>0 AND shards<=256 AND shard<shards),
    phase text NOT NULL CHECK(phase IN ('backfill','replay','parity','caught-up')),cursor text CHECK(octet_length(cursor)<=8192),
    through_sequence bigint CHECK(through_sequence>=0),replayed_sequence bigint NOT NULL DEFAULT 0 CHECK(replayed_sequence>=0),
    pending_cursor bigint CHECK(pending_cursor>=0),pending_sample_count integer NOT NULL DEFAULT 0 CHECK(pending_sample_count>=0 AND pending_sample_count<=8),
    revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(namespace,binding_id,shard),CHECK((phase='backfill' AND through_sequence IS NULL) OR (phase<>'backfill' AND through_sequence IS NOT NULL AND replayed_sequence<=through_sequence)),
    CHECK(phase NOT IN ('parity','caught-up') OR replayed_sequence=through_sequence),CHECK(phase<>'caught-up' OR cursor IS NULL))`);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}})().catch(error=>{preparing=undefined;throw error;});await preparing;
 }
 const keys=(ref:OnlineMigrationReference)=>[namespace,bindingId,ref.shard];
 async function load(client:Pick<PoolClient,'query'>,ref:OnlineMigrationReference):Promise<OnlineMigrationCheckpoint>{
  const row=(await client.query('SELECT epoch::text,source_id,target_id,shards,phase,cursor,through_sequence::text,replayed_sequence::text,revision::text,pending_cursor::text,pending_sample_count FROM opencrawl_online_migration_runs WHERE namespace=$1 AND binding_id=$2 AND shard=$3',keys(ref))).rows[0];
  if(!row||row.epoch!==binding.epoch||row.source_id!==binding.sourceId||row.target_id!==binding.targetId||row.shards!==binding.shards||!['backfill','replay','parity','caught-up'].includes(row.phase)||!cursor(row.cursor)||!sequence(row.replayed_sequence)||row.through_sequence!==null&&!sequence(row.through_sequence)||!sequence(row.revision)||!safeCount(Number(row.revision)))unsafe();
  if(row.pending_cursor!==null&&!sequence(row.pending_cursor)||!safeCount(row.pending_sample_count)||row.pending_sample_count>8)unsafe();
  if(row.phase==='backfill'?row.through_sequence!==null:row.through_sequence===null||BigInt(row.replayed_sequence)>BigInt(row.through_sequence))unsafe();
  if(['parity','caught-up'].includes(row.phase)&&row.replayed_sequence!==row.through_sequence||row.phase==='caught-up'&&row.cursor!==null)unsafe();
  return {phase:row.phase,cursor:row.cursor,through:row.through_sequence,replayed:row.replayed_sequence,revision:Number(row.revision),pendingCursor:row.pending_cursor,pendingSampleCount:row.pending_sample_count,waiting:false,parityObserved:row.phase==='caught-up'};
 }
 function page(value:OnlineMigrationPage,previous:string|null){
  if(!value||!cursor(value.cursor)||!safeCount(value.processed)||value.processed>pageSize||value.cursor!==null&&(value.cursor===previous||value.processed===0))unsafe();
 }
 const progress=(value:OnlineMigrationCheckpoint,waiting=false):OnlineMigrationProgress=>({phase:value.phase,revision:value.revision,waiting,parityObserved:value.phase==='caught-up'&&!waiting});
 async function advance(value:OnlineMigrationReference,signal:AbortSignal):Promise<OnlineMigrationProgress>{
  const ref=reference(value);signal.throwIfAborted();await adapter.assertCurrent(signal);await ready();
  const client=await database.pool.connect(),lock=JSON.stringify(['online-migration-v1',namespace,bindingId,ref.shard]),lost=new AbortController();let locked=false,destroy=false,broken=false,failed=false;
  const onError=()=>{broken=true;lost.abort();};client.on('error',onError);
  const activeSignal=AbortSignal.any([signal,lost.signal]);
  try{
   locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lock])).rows[0]?.locked===true;
   if(!locked)return {phase:'waiting',revision:0,waiting:true,parityObserved:false};
   await client.query("INSERT INTO opencrawl_online_migration_runs(namespace,binding_id,shard,epoch,source_id,target_id,shards,phase) VALUES($1,$2,$3,$4,$5,$6,$7,'backfill') ON CONFLICT DO NOTHING",[...keys(ref),binding.epoch,binding.sourceId,binding.targetId,binding.shards]);
   const current=await load(client,ref);
   if(adapter.prepareSource){
    const prepared=await adapter.prepareSource({signal:activeSignal});
    if(!prepared||Object.keys(prepared).join(',')!=='ready'||typeof prepared.ready!=='boolean')unsafe();
    activeSignal.throwIfAborted();await adapter.assertCurrent(activeSignal);if(broken)unsafe();
    // Preparation stores its own page chain. Do not manufacture an empty
    // backfill page or overwrite an already durable replay/parity cursor.
    if(!prepared.ready)return progress(current,true);
   }
   const next={...current},common={shard:ref.shard,shards:binding.shards,limit:pageSize,signal:activeSignal};let waiting=false;
   const recovery=await adapter.reconcilePending({cursor:current.pendingCursor,limit:8,signal:activeSignal});
   if(!recovery||recovery.cursor!==null&&!sequence(recovery.cursor)||!safeCount(recovery.processed)||recovery.processed>8||!safeCount(recovery.pending)||!safeCount(recovery.settled)||recovery.pending+recovery.settled!==recovery.processed||typeof recovery.budgetExhausted!=='boolean')unsafe();
   next.pendingCursor=recovery.cursor;next.pendingSampleCount=recovery.pending;
   if(recovery.budgetExhausted){waiting=true;}
   else if(current.phase==='caught-up'){
    const state=await adapter.frontierState(activeSignal);
    if(!state||!sequence(state.closed)||!sequence(state.allocated)||typeof state.pending!=='boolean'||BigInt(state.closed)>BigInt(state.allocated)||BigInt(state.closed)<BigInt(current.through!)||!state.pending&&state.closed!==state.allocated)unsafe();
    if(BigInt(state.closed)>BigInt(current.through!)){next.through=state.closed;next.cursor=null;next.phase='replay';}
    else waiting=true;
   }else if(current.phase==='backfill'){
    const result=await adapter.backfillPage({...common,cursor:current.cursor});page(result,current.cursor);next.cursor=result.cursor;
    if(result.cursor===null){const frontier=await adapter.closedFrontier(activeSignal);if(!sequence(frontier))unsafe();next.through=frontier;next.phase='replay';}
   }else if(current.phase==='replay'){
    const result=await adapter.replayPage({...common,consumer:bindingId+'-'+ref.shard,through:current.through!});
    if(!result||!sequence(result.checkpoint)||!safeCount(result.processed)||result.processed>pageSize||typeof result.blocked!=='boolean'||BigInt(result.checkpoint)<BigInt(current.replayed)||BigInt(result.checkpoint)>BigInt(current.through!))unsafe();
    next.replayed=result.checkpoint;
    if(result.checkpoint===current.through){next.phase='parity';next.cursor=null;}
    else if(result.checkpoint===current.replayed){if(!result.blocked)unsafe();waiting=true;}
   }else{
    const result=await adapter.parityPage({...common,cursor:current.cursor,through:current.through!});page(result,current.cursor);
    if(!safeCount(result.mismatches)||result.drift!==undefined&&typeof result.drift!=='boolean')unsafe();
    if(result.drift){
     const frontier=await adapter.closedFrontier(activeSignal);if(!sequence(frontier)||BigInt(frontier)<BigInt(current.through!))unsafe();
     if(frontier===current.through)waiting=true;else{next.through=frontier;next.cursor=null;next.phase='replay';}
    }else{if(result.mismatches!==0)unsafe();next.cursor=result.cursor;if(result.cursor===null)next.phase='caught-up';}
   }
   activeSignal.throwIfAborted();await adapter.assertCurrent(activeSignal);if(broken)unsafe();
   if(current.revision>=Number.MAX_SAFE_INTEGER)unsafe();
   const changed=await client.query('UPDATE opencrawl_online_migration_runs SET phase=$4,cursor=$5,through_sequence=$6,replayed_sequence=$7,revision=revision+1,pending_cursor=$9,pending_sample_count=$10,updated_at=now() WHERE namespace=$1 AND binding_id=$2 AND shard=$3 AND revision=$8',[...keys(ref),next.phase,next.cursor,next.through,next.replayed,current.revision,next.pendingCursor,next.pendingSampleCount]);
   if(changed.rowCount!==1)unsafe();return progress(await load(client,ref),waiting);
  }catch(error){
   // A query timeout does not prove the server failed to acquire the session
   // lock. Destroy the connection on every failed step; never return uncertain
   // ownership to the pool or queue an unlock behind an outstanding query.
   failed=true;destroy=true;throw error;
  }finally{
   if(broken)destroy=true;
   if(locked&&!destroy)try{if((await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',[lock])).rows[0]?.unlocked!==true)destroy=true;}catch{destroy=true;}
   client.removeListener('error',onError);client.release(destroy);if(destroy&&!failed)throw Error('Online migration lock cleanup failed');
  }
 }
 return {binding,bindingId,connectionCapacity:database.pool.options.max??10,ready,advance};
}
export type OnlineMigrationController=ReturnType<typeof createOnlineMigrationController>;
