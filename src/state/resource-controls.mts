import type {PoolClient} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase} from './postgres.mjs';
import type {Principal} from '../sessions/types.mjs';
import {isSessionHarness} from '../sessions/types.mjs';
import {digest,sessionScope} from '../sessions/event-identity.mjs';
import type {ControlKind,ResourceControl} from '../sessions/controls.mjs';

export interface ResourceControlIdentity {
  tenantHash: string; userHash: string; kind: ControlKind; harness: string; resourceHash: string;
}
export interface ResourceControls {
  readIdentity(identity:ResourceControlIdentity):Promise<ResourceControl|null>;
  read(owner:Principal,kind:ControlKind,harness:string,name:string):Promise<ResourceControl|null>;
  readSource(source:{tenantHash:string;userHash:string;harness:string;sessionHash:string}):Promise<ResourceControl|null>;
  update(owner:Principal,kind:ControlKind,harness:string,name:string,change:(current:ResourceControl|null)=>Omit<ResourceControl,'schemaVersion'|'updatedAt'>):Promise<ResourceControl>;
  list(owner:Principal,kind:ControlKind,harness:string):Promise<Map<string,ResourceControl>>;
}
const fail=(message:string,status=503):never=>{throw Object.assign(new Error(message),{status,permanent:status!==503});};
const where='namespace=$1 AND tenant_hash=$2 AND owner_hash=$3 AND kind=$4 AND harness=$5 AND resource_hash=$6';
function checked(value:ResourceControl):ResourceControl {
  if(value?.schemaVersion!==1||!['team','private'].includes(value.visibility)||!Number.isFinite(Date.parse(value.updatedAt))
    ||value.deletedAt!==null&&!Number.isFinite(Date.parse(value.deletedAt)))fail('Invalid resource control');
  if(value.deletion&&(!value.deletedAt||!/^[A-Za-z0-9_.:-]{1,200}$/.test(value.deletion.sessionId)||!['pending','complete'].includes(value.deletion.state)))fail('Invalid deletion control');
  return value;
}
export function resourceControlIdentity(owner:Principal,kind:ControlKind,harness:string,name:string):ResourceControlIdentity {
  sessionScope(owner);
  if(!['sessions','memories'].includes(kind)||!isSessionHarness(harness)||typeof name!=='string'||!name||name.length>2048)fail('Invalid resource control identity',400);
  return {tenantHash:digest(owner.tenantId),userHash:digest(owner.userId),kind,harness,resourceHash:digest(name)};
}
/** Hashes are first-class identities: old private/deleted sources cannot always
 * be reverse-mapped to original IDs, and migration must never invent those IDs. */
export function createPostgresControls(database:ApplicationDatabase):ResourceControls&{
  ready():Promise<void>; importControl(identity:ResourceControlIdentity,value:ResourceControl):Promise<void>;
} {
  let preparing:Promise<void>|undefined;
  function args(identity:ResourceControlIdentity){
    if(!['sessions','memories'].includes(identity.kind)||!isSessionHarness(identity.harness)
      ||![identity.tenantHash,identity.userHash,identity.resourceHash].every(value=>/^[a-f0-9]{64}$/.test(value)))fail('Invalid resource control scope',400);
    return [database.namespace,identity.tenantHash,identity.userHash,identity.kind,identity.harness,identity.resourceHash];
  }
  function decode(row:Record<string,unknown>):ResourceControl {
    return checked({schemaVersion:1,visibility:row.visibility as ResourceControl['visibility'],deletedAt:row.deleted_at as string|null,
      updatedAt:row.updated_at as string,...(row.deletion_session_id?{deletion:{sessionId:String(row.deletion_session_id),state:row.deletion_state as 'pending'|'complete'}}:{})});
  }
  async function read(client:Pick<PoolClient,'query'>,identity:ResourceControlIdentity){
    const result=await client.query(`SELECT visibility,deleted_at,updated_at,deletion_session_id,deletion_state FROM opencrawl_resource_controls WHERE ${where}`,args(identity));
    return result.rows[0]?decode(result.rows[0]):null;
  }
  async function write(client:PoolClient,identity:ResourceControlIdentity,value:ResourceControl){
    checked(value);
    await client.query(`INSERT INTO opencrawl_resource_controls(namespace,tenant_hash,owner_hash,kind,harness,resource_hash,visibility,deleted_at,updated_at,deletion_session_id,deletion_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(namespace,tenant_hash,owner_hash,kind,harness,resource_hash) DO UPDATE SET
      visibility=excluded.visibility,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at,
      deletion_session_id=excluded.deletion_session_id,deletion_state=excluded.deletion_state,revision=opencrawl_resource_controls.revision+1`,
      [...args(identity),value.visibility,value.deletedAt,value.updatedAt,value.deletion?.sessionId??null,value.deletion?.state??null]);
  }
  async function locked<T>(identity:ResourceControlIdentity,run:(client:PoolClient)=>Promise<T>){
    return database.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['resource-control',...args(identity)])]);
      return run(client);
    });
  }
  return {
    async ready(){
      preparing??=(async()=>{await database.ready();await database.transaction(async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:resource-controls:schema',0))");
        await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_resource_controls (
          namespace text NOT NULL,tenant_hash text NOT NULL CHECK(tenant_hash ~ '^[a-f0-9]{64}$'),
          owner_hash text NOT NULL CHECK(owner_hash ~ '^[a-f0-9]{64}$'),kind text NOT NULL CHECK(kind IN ('sessions','memories')),
          harness text NOT NULL,resource_hash text NOT NULL CHECK(resource_hash ~ '^[a-f0-9]{64}$'),
          visibility text NOT NULL CHECK(visibility IN ('team','private')),deleted_at text,updated_at text NOT NULL,
          deletion_session_id text,deletion_state text CHECK(deletion_state IN ('pending','complete')),
          revision bigint NOT NULL DEFAULT 1,PRIMARY KEY(namespace,tenant_hash,owner_hash,kind,harness,resource_hash),
          CHECK((deletion_session_id IS NULL AND deletion_state IS NULL) OR (deletion_session_id IS NOT NULL AND deletion_state IS NOT NULL AND deleted_at IS NOT NULL)))`);
      });})().catch(error=>{preparing=undefined;throw error;});await preparing;
    },
    readIdentity:identity=>read(database.pool,identity),
    read:(owner,kind,harness,name)=>read(database.pool,resourceControlIdentity(owner,kind,harness,name)),
    readSource:source=>read(database.pool,{...source,kind:'sessions',resourceHash:source.sessionHash}),
    async update(owner,kind,harness,name,change){
      const identity=resourceControlIdentity(owner,kind,harness,name);
      return locked(identity,async client=>{
        const current=await read(client,identity),next=checked({...change(current?structuredClone(current):null),schemaVersion:1,updatedAt:new Date().toISOString()});
        if(current?.deletedAt&&next.deletedAt!==current.deletedAt)fail('A deleted resource cannot be restored by changing its control',403);
        if(current?.deletion?.state==='complete'&&next.deletion?.state!=='complete')fail('A completed deletion cannot return to pending',403);
        await write(client,identity,next);return next;
      });
    },
    async list(owner,kind,harness){
      const identity=resourceControlIdentity(owner,kind,harness,'inventory'),values=args(identity).slice(0,5);
      const found=new Map<string,ResourceControl>();let after='';
      for(;;){
        const result=await database.pool.query(`SELECT resource_hash,visibility,deleted_at,updated_at,deletion_session_id,deletion_state FROM opencrawl_resource_controls
          WHERE namespace=$1 AND tenant_hash=$2 AND owner_hash=$3 AND kind=$4 AND harness=$5 AND resource_hash>$6 ORDER BY resource_hash LIMIT 1000`,[...values,after]);
        for(const row of result.rows)found.set(row.resource_hash,decode(row));
        if(result.rows.length<1000)return found;after=result.rows.at(-1).resource_hash;
      }
    },
    async importControl(identity,value){
      checked(value);await locked(identity,async client=>{
        const previous=await read(client,identity);
        if(previous){if(!isDeepStrictEqual(previous,checked(value)))fail('Existing resource control differs from migration source',409);return;}
        await write(client,identity,value);
      });
    },
  };
}
