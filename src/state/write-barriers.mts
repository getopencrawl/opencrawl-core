import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {ensureSchemaIndex,type ApplicationDatabase} from './postgres.mjs';
import {digest} from '../connectors/scope.mjs';
import {serviceError} from '../sessions/types.mjs';

export interface ResourceWriter {
  id:string;operation:'object-put'|'search-write';phase:'writing'|'settled';startedAt:number;
  settledAt?:number;instance:string;target:string;
}
export interface WriteFenceSnapshot {closed:boolean;closedAt:number|null;pending:number;writers:ResourceWriter[]}
export interface ResourceWriteBarrier {
  key:string;scope:Readonly<{namespace:string;tenantId:string;connectionId:string}>;
  inspect():Promise<WriteFenceSnapshot>;close():Promise<WriteFenceSnapshot>;
  run<T>(operation:ResourceWriter['operation'],write:()=>T|Promise<T>,options?:{target?:string}):Promise<T>;
}
export interface LegacyWriteFence {
  version:1;namespace:string;tenantId:string;connectionId:string;closedAt:number|null;writers:ResourceWriter[];
}
const instance=randomUUID();
const pending=(message:string)=>Object.assign(new Error(message),{status:503,code:'CONNECTOR_WRITE_PENDING'});
const denied=()=>Object.assign(new Error('Resource writes are closed'),{status:403,permanent:true});
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_:-]{1,200}$/.test(v);

export async function ensureWriteBarrierSchema(database:ApplicationDatabase){
  await database.ready();await database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:write-barriers:schema',0))");
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_write_fences (
      namespace text NOT NULL,fence_key text NOT NULL,barrier_namespace text NOT NULL,tenant_id text NOT NULL,resource_id text NOT NULL,
      closed_at bigint CHECK(closed_at >= 0),PRIMARY KEY(namespace,fence_key));
      CREATE TABLE IF NOT EXISTS opencrawl_resource_writers (
      namespace text NOT NULL,fence_key text NOT NULL,writer_id text NOT NULL,
      operation text NOT NULL CHECK(operation IN ('object-put','search-write')),phase text NOT NULL CHECK(phase IN ('writing','settled')),
      started_at bigint NOT NULL CHECK(started_at >= 0),settled_at bigint,instance text NOT NULL,target text NOT NULL,
      PRIMARY KEY(namespace,fence_key,writer_id),FOREIGN KEY(namespace,fence_key) REFERENCES opencrawl_write_fences(namespace,fence_key),
      CHECK(phase <> 'settled' OR settled_at IS NOT NULL))`);
    await ensureSchemaIndex(client,{table:'opencrawl_resource_writers',name:'opencrawl_resource_writers_pending',keys:['namespace','fence_key'],predicate:{column:'phase',equals:'writing'}});
  });
}

/** Admission, uncertainty and settlement are durable rows. No lease expiry,
 * process restart or workflow cancellation can erase a possibly applied write. */
export function createPostgresWriteBarrier({database,namespace='selfhost',tenantId,connectionId,
  controlPrefix='control/connectors/write-barriers/v1/',now=Date.now}: {
  database:ApplicationDatabase;namespace?:string;tenantId:string;connectionId:string;controlPrefix?:string;now?:()=>number;
}):ResourceWriteBarrier&{importFence(fence:LegacyWriteFence):Promise<void>;exportFence():Promise<LegacyWriteFence|null>;exportFenceIn(client:PoolClient):Promise<LegacyWriteFence|null>;projectFenceIn(client:PoolClient,fence:LegacyWriteFence):Promise<void>} {
  if(![namespace,tenantId,connectionId].every(identifier)||!controlPrefix.endsWith('/')
    ||controlPrefix.slice(0,-1).split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Explicit write-fence scope is required');
  const key=controlPrefix+digest([namespace,tenantId,connectionId])+'.json',params=[database.namespace,key];
  const time=()=>{const value=now();if(!Number.isSafeInteger(value)||value<0)throw pending('Invalid write-fence clock');return value;};
  async function lockIn(client:PoolClient){
      await client.query(`INSERT INTO opencrawl_write_fences(namespace,fence_key,barrier_namespace,tenant_id,resource_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[...params,namespace,tenantId,connectionId]);
      const {rows}=await client.query('SELECT barrier_namespace,tenant_id,resource_id FROM opencrawl_write_fences WHERE namespace=$1 AND fence_key=$2 FOR UPDATE',params);
      const row=rows[0];if(!row||row.barrier_namespace!==namespace||row.tenant_id!==tenantId||row.resource_id!==connectionId)throw pending('Write-fence scope mismatch');
  }
  async function locked<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>{return database.transaction(async client=>{await lockIn(client);return run(client);});}
  async function snapshot(client:Pick<PoolClient,'query'>):Promise<WriteFenceSnapshot>{
    const {rows}=await client.query(`SELECT f.closed_at,w.writer_id,w.operation,w.phase,w.started_at,w.settled_at,w.instance,w.target
      FROM opencrawl_write_fences f LEFT JOIN opencrawl_resource_writers w USING(namespace,fence_key)
      WHERE f.namespace=$1 AND f.fence_key=$2 ORDER BY w.writer_id`,params);
    const closedAt=rows[0]?.closed_at==null?null:Number(rows[0].closed_at);
    const writers:ResourceWriter[]=rows.filter(row=>row.writer_id!=null).map(row=>({id:row.writer_id,operation:row.operation,phase:row.phase,
      startedAt:Number(row.started_at),...(row.settled_at==null?{}:{settledAt:Number(row.settled_at)}),instance:row.instance,target:row.target}));
    return {closed:closedAt!==null,closedAt,pending:writers.filter(row=>row.phase==='writing').length,writers};
  }
  async function retry<T>(operation:()=>Promise<T>):Promise<T>{
    let failure:unknown;
    for(let attempt=0;attempt<3;attempt++)try{return await operation();}catch(error){
      if(serviceError(error).permanent||serviceError(error).code==='CONNECTOR_WRITE_PENDING')throw error;failure=error;
    }
    throw failure;
  }
  async function exportFenceIn(client:Pick<PoolClient,'query'>):Promise<LegacyWriteFence|null>{
      const {rows}=await client.query('SELECT barrier_namespace,tenant_id,resource_id FROM opencrawl_write_fences WHERE namespace=$1 AND fence_key=$2',params);
      if(!rows[0])return null;
      if(rows[0].barrier_namespace!==namespace||rows[0].tenant_id!==tenantId||rows[0].resource_id!==connectionId)throw pending('Write-fence scope mismatch');
      const value=await snapshot(client);return {version:1,namespace,tenantId,connectionId,closedAt:value.closedAt,writers:value.writers};
  }
  function validateFence(fence:LegacyWriteFence){
      if(fence.version!==1||fence.namespace!==namespace||fence.tenantId!==tenantId||fence.connectionId!==connectionId
        ||fence.closedAt!==null&&(!Number.isSafeInteger(fence.closedAt)||fence.closedAt<0)||!Array.isArray(fence.writers)
        ||new Set(fence.writers.map(w=>w.id)).size!==fence.writers.length)throw pending('Invalid migration write fence');
      for(const writer of fence.writers)if(!/^[A-Za-z0-9_-]{1,100}$/.test(writer.id)||!['object-put','search-write'].includes(writer.operation)
        ||!['writing','settled'].includes(writer.phase)||!Number.isSafeInteger(writer.startedAt)||writer.startedAt<0
        ||typeof writer.instance!=='string'||writer.instance.length>100||typeof writer.target!=='string'||writer.target.length>8192
        ||writer.phase==='settled'&&(!Number.isSafeInteger(writer.settledAt)||writer.settledAt!<0))throw pending('Invalid migration writer receipt');
  }
  async function projectFenceIn(client:PoolClient,fence:LegacyWriteFence){
    validateFence(fence);await lockIn(client);const before=await snapshot(client);
    if(before.closedAt!==null&&before.closedAt!==fence.closedAt)throw pending('Online projection cannot reopen or change a closed fence');
    await client.query('UPDATE opencrawl_write_fences SET closed_at=$3 WHERE namespace=$1 AND fence_key=$2',[...params,fence.closedAt]);
    // Every authoritative legacy CAS is journaled. This is a shadow snapshot,
    // never admission for new PG writers while legacy writers remain active.
    await client.query('DELETE FROM opencrawl_resource_writers WHERE namespace=$1 AND fence_key=$2',params);
    for(const writer of fence.writers)await client.query('INSERT INTO opencrawl_resource_writers(namespace,fence_key,writer_id,operation,phase,started_at,settled_at,instance,target) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...params,writer.id,writer.operation,writer.phase,writer.startedAt,writer.settledAt??null,writer.instance,writer.target]);
  }
  const reap=(client:PoolClient)=>client.query("DELETE FROM opencrawl_resource_writers WHERE namespace=$1 AND fence_key=$2 AND phase='settled'",params);
  return {
    key,scope:Object.freeze({namespace,tenantId,connectionId}),
    inspect:()=>snapshot(database.pool),
    exportFence:()=>exportFenceIn(database.pool),exportFenceIn,projectFenceIn,
    close:()=>locked(async client=>{
      await client.query('UPDATE opencrawl_write_fences SET closed_at=COALESCE(closed_at,$3) WHERE namespace=$1 AND fence_key=$2',[...params,time()]);
      await reap(client);return snapshot(client);
    }),
    async run<T>(operation:ResourceWriter['operation'],write:()=>T|Promise<T>,{target='unspecified'}={}):Promise<T>{
      if(!['object-put','search-write'].includes(operation)||typeof write!=='function'||typeof target!=='string'||target.length>8192)throw new Error('Invalid fenced write');
      const id=randomUUID();
      try{
        await retry(()=>locked(async client=>{
          const prior=await client.query('SELECT writer_id FROM opencrawl_resource_writers WHERE namespace=$1 AND fence_key=$2 AND writer_id=$3',[...params,id]);
          if(prior.rows.length)return;
          const fence=await client.query('SELECT closed_at FROM opencrawl_write_fences WHERE namespace=$1 AND fence_key=$2',params);
          if(fence.rows[0].closed_at!==null)throw denied();
          await reap(client);
          await client.query(`INSERT INTO opencrawl_resource_writers(namespace,fence_key,writer_id,operation,phase,started_at,instance,target)
            VALUES($1,$2,$3,$4,'writing',$5,$6,$7)`,[...params,id,operation,time(),instance,target]);
        }));
      }catch(error){
        // Our external call has not begun. Removing this acquisition is safe;
        // failure to confirm removal leaves conservative uncertainty behind.
        await locked(client=>client.query('DELETE FROM opencrawl_resource_writers WHERE namespace=$1 AND fence_key=$2 AND writer_id=$3',[...params,id])).catch(()=>{});
        throw error;
      }
      let result!:T,rejection:unknown;
      try{result=await write();}catch(error){
        if(serviceError(error).writeOutcome!=='not-applied')throw Object.assign(pending('Resource write outcome is uncertain; deletion requires reconciliation'),{cause:error,writeId:id});
        rejection=error;
      }
      try{
        await retry(()=>locked(async client=>{
          await client.query("UPDATE opencrawl_resource_writers SET phase='settled',settled_at=COALESCE(settled_at,$4) WHERE namespace=$1 AND fence_key=$2 AND writer_id=$3",[...params,id,time()]);
        }));
        await retry(()=>locked(reap));
      }catch(error){throw Object.assign(pending('Resource write finished but its acknowledgment needs reconciliation'),{cause:error,writeId:id});}
      if(rejection)throw rejection;return result;
    },
    async importFence(fence){
      validateFence(fence);
      await locked(async client=>{
        const before=await snapshot(client);
        if(before.closedAt!==null&&before.closedAt!==fence.closedAt)throw pending('Migrated write fence differs from target');
        await client.query('UPDATE opencrawl_write_fences SET closed_at=$3 WHERE namespace=$1 AND fence_key=$2',[...params,fence.closedAt]);
        for(const writer of fence.writers){
          const previous=before.writers.find(w=>w.id===writer.id);
          if(previous){if(!isDeepStrictEqual(previous,writer))throw pending('Migrated writer differs from target');continue;}
          await client.query(`INSERT INTO opencrawl_resource_writers(namespace,fence_key,writer_id,operation,phase,started_at,settled_at,instance,target)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[...params,writer.id,writer.operation,writer.phase,writer.startedAt,writer.settledAt??null,writer.instance,writer.target]);
        }
        if(before.writers.some(w=>!fence.writers.some(expected=>expected.id===w.id)))throw pending('Target has writers absent from migration source');
      });
    },
  };
}
