import {Pool, type PoolClient, type PoolConfig} from 'pg';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {digest,eventIdentityLocation,eventFingerprints,eventIdentityConflict,sourceBatchIdentity,MAX_EVENT_LEDGER_BYTES} from './event-identity.mjs';
import {parseJson,serviceError,type EventIdentityStore,type SessionIdentity,type SessionBatch,type SessionEvent,type ObjectStore} from './types.mjs';

const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const unavailable=(message:string):never=>{throw Object.assign(new Error(message),{status:503});};
const invalid=(message:string):never=>{throw Object.assign(new Error(message),{status:409,permanent:true});};
type Where={source:string;identity?:string};
type Marker={schemaVersion:2;identity:string;database:string;namespace:string};
type Legacy={schemaVersion:1;identity:string;events:Record<string,string>};
const resource=(source:string)=>source.replace(/\/[a-f0-9]{64}\/([a-f0-9]{64})\/$/,'/$1/');

/** One row per immutable event. namespace must identify this object-store source
 * (for example a stable bucket identity), independently of credentials/URLs.
 * The existing JSON ledger is fenced by CAS after every legacy reservation is
 * durable in Postgres. A crash at any point is resumable; old CAS writers cannot
 * overwrite the fence. Pre-ledger writers still require a quiescent upgrade.
 */
export function createPostgresEventIdentities({namespace,...config}:PoolConfig&{namespace:string}) {
 if(!namespace)throw new Error('Event identity database requires a storage namespace');
 const pool=new Pool({max:4,connectionTimeoutMillis:10000,...config});
 // Idle socket failures must not crash a receiver or print database credentials.
 pool.on('error',()=>{});
 let initialized:Promise<string>|undefined;
 async function ready():Promise<string>{
  initialized??=(async()=>{
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:event-identities:schema',0))");
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_event_identity_schema (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL, database_id uuid NOT NULL);
      CREATE TABLE IF NOT EXISTS opencrawl_event_identity_sessions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      namespace text NOT NULL, source text NOT NULL, identity text NOT NULL CHECK(identity ~ '^[a-f0-9]{64}$'),
      resource text NOT NULL, state text NOT NULL CHECK(state IN ('importing','ready')), event_count bigint NOT NULL DEFAULT 0,
      UNIQUE(namespace,source));
      CREATE TABLE IF NOT EXISTS opencrawl_event_identities (
      session_id bigint NOT NULL REFERENCES opencrawl_event_identity_sessions(id) ON DELETE CASCADE,
      event_hash bytea NOT NULL CHECK(octet_length(event_hash)=32),
      content_hash bytea NOT NULL CHECK(octet_length(content_hash)=32),
      PRIMARY KEY(session_id,event_hash));
      CREATE INDEX IF NOT EXISTS opencrawl_event_identity_resource ON opencrawl_event_identity_sessions(namespace,resource);
      CREATE TABLE IF NOT EXISTS opencrawl_event_identity_deletions(namespace text NOT NULL, resource text NOT NULL, PRIMARY KEY(namespace,resource))`);
    await client.query('INSERT INTO opencrawl_event_identity_schema(singleton,version,database_id) VALUES(true,1,$1) ON CONFLICT DO NOTHING',[randomUUID()]);
    const result=await client.query<{version:number;database_id:string}>('SELECT version,database_id FROM opencrawl_event_identity_schema WHERE singleton');
    if(result.rows[0]?.version!==1)unavailable('Unsupported event identity database schema');
    await client.query('COMMIT');return result.rows[0]!.database_id;
   }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
   finally{client.release();}
  })().catch(error=>{initialized=undefined;throw error;});
  return initialized;
 }
 async function locked<T>(source:string,run:(client:PoolClient,database:string)=>Promise<T>):Promise<T>{
  const database=await ready(),client=await pool.connect();let failed=false;
  const key=JSON.stringify([namespace,resource(source)]);
  try{
   await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
   return await run(client,database);
  }catch(error){failed=true;const e=serviceError(error);if(e.status)throw e;return unavailable('Event identity database unavailable; retry the same batch');}
  finally{
   // Destroy on any failure: a disconnected/cancelled query must never return
   // an uncertain transaction or session advisory lock to the pool.
   if(!failed)try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch{failed=true;}
   client.release(failed);
  }
 }
 async function claim(client:PoolClient,where:Where,events:Map<string,string>):Promise<number>{
  if(!events.size)return 0;
  const entries=[...events],ids=entries.map(([id])=>Buffer.from(id,'hex')),hashes=entries.map(([,hash])=>Buffer.from(hash,'hex'));
  await client.query('BEGIN');
  try{
   const inserted=await client.query(`INSERT INTO opencrawl_event_identities(session_id,event_hash,content_hash)
     SELECT s.id,input.event_hash,input.content_hash FROM opencrawl_event_identity_sessions s
     CROSS JOIN unnest($3::bytea[],$4::bytea[]) AS input(event_hash,content_hash)
     WHERE s.namespace=$1 AND s.source=$2
     ON CONFLICT DO NOTHING`,[namespace,where.source,ids,hashes]);
   const mismatches=await client.query<{id:string}>(`SELECT encode(e.event_hash,'hex') AS id
     FROM opencrawl_event_identities e JOIN opencrawl_event_identity_sessions s ON s.id=e.session_id
     JOIN unnest($3::bytea[],$4::bytea[]) AS input(event_hash,content_hash) ON input.event_hash=e.event_hash
     WHERE s.namespace=$1 AND s.source=$2 AND e.content_hash<>input.content_hash`,[namespace,where.source,ids,hashes]);
   if(mismatches.rows.length)eventIdentityConflict(new Set(mismatches.rows.map(row=>row.id)));
   await client.query('UPDATE opencrawl_event_identity_sessions SET event_count=event_count+$3 WHERE namespace=$1 AND source=$2',[namespace,where.source,inserted.rowCount]);
   await client.query('COMMIT');return inserted.rowCount??0;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 }
 async function readLedger(store:ObjectStore,where:Where){
  const value=await store.readVersion(where.source+'event-identities-v1.json',{maxBytes:MAX_EVENT_LEDGER_BYTES});
  if(!value.data){if(value.version!==null)unavailable('Invalid event identity storage version');return {...value,ledger:null};}
  if(value.version===null||value.version===undefined)unavailable('Invalid event identity storage version');
  let ledger:Legacy|Marker;try{ledger=parseJson(value.data);}catch{invalid('Invalid legacy event identity ledger');}
  if(!ledger!||!hex(ledger!.identity)||where.identity&&ledger!.identity!==where.identity||![1,2].includes(ledger!.schemaVersion))invalid('Legacy event identity scope mismatch');
  if(ledger!.schemaVersion===1&&(!ledger!.events||typeof ledger!.events!=='object'||Array.isArray(ledger!.events)||Object.entries(ledger!.events).some(([id,hash])=>!hex(id)||!hex(hash))))invalid('Invalid legacy event identity fingerprints');
  return {...value,ledger:ledger!};
 }
 async function migrate(client:PoolClient,database:string,store:ObjectStore,prefix:string,where:Where){
  const path=sourceBatchIdentity(prefix,where.source+'0'.repeat(64)+'.json.gz');
  if(!path)invalid('Invalid event identity source scope');
  const deleted=await client.query('SELECT 1 FROM opencrawl_event_identity_deletions WHERE namespace=$1 AND resource=$2',[namespace,resource(where.source)]);
  if(deleted.rowCount)throw Object.assign(new Error('Session was deleted'),{status:410,permanent:true});
  const existing=await client.query<{identity:string;state:string;event_count:string}>('SELECT identity,state,event_count FROM opencrawl_event_identity_sessions WHERE namespace=$1 AND source=$2',[namespace,where.source]);
  if(existing.rows[0]){
   if(where.identity&&where.identity!==existing.rows[0].identity)invalid('Event identity scope mismatch');
   where={...where,identity:existing.rows[0].identity};
   if(existing.rows[0].state==='ready')return;
  }
  const first=await readLedger(store,where);
  if(first.ledger?.schemaVersion===2){
   if(!existing.rows[0]||first.ledger.database!==database||first.ledger.namespace!==digest(namespace))unavailable('Event identity database does not match the migrated source; restore its matching backup');
   await client.query("UPDATE opencrawl_event_identity_sessions SET state='ready' WHERE namespace=$1 AND source=$2",[namespace,where.source]);return;
  }
  where={...where,identity:where.identity??first.ledger?.identity};
  async function ensureSession(identity:string){
   if(where.identity&&where.identity!==identity)invalid('Legacy event identity scope mismatch');
   where.identity=identity;
   await client.query("INSERT INTO opencrawl_event_identity_sessions(namespace,source,identity,resource,state) VALUES($1,$2,$3,$4,'importing') ON CONFLICT DO NOTHING",[namespace,where.source,identity,resource(where.source)]);
  }
  if(where.identity)await ensureSession(where.identity);
  // A v1 ledger is authoritative: its first CAS already bootstrapped all older
  // batches, and subsequent writers reserve before uploading. Re-reading raw
  // history would make the first PostgreSQL capture proportional to all prior
  // uploads. Only pre-ledger sources need that scan; no event/page ceiling.
  if(!first.ledger){
  let cursor:string|null|undefined;const cursors=new Set<string>();
  do{
   const page=await store.listPage(where.source,{continuationToken:cursor,maxKeys:100});
   for(const key of page.keys){
    if(!key.startsWith(where.source))invalid('Session source inventory outside scope');
    const source=sourceBatchIdentity(prefix,key);if(!source)continue;
    const bytes=await store.get(key,{maxBytes:17*1024*1024});if(!bytes)unavailable('Session source unavailable during identity migration');
    let batch:SessionBatch;try{batch=parseJson(gunzipSync(bytes!,{maxOutputLength:17*1024*1024}));}catch{invalid('Invalid historical session batch');}
    if(batch!.schemaVersion!==1)invalid('Invalid historical session format');
    const location=eventIdentityLocation({prefix,principal:batch!.owner,harness:batch!.harness,installationId:batch!.installationId,sessionId:batch!.sessionId});
    if(location.source!==where.source)invalid('Historical session owner does not match source');
    await ensureSession(location.identity);
    const conflicts=new Set<string>(),events=eventFingerprints(batch!.events,conflicts);if(conflicts.size)eventIdentityConflict(conflicts);
    await claim(client,where,events);
   }
   cursor=page.nextToken;if(cursor){if(cursors.has(cursor))unavailable('Session inventory cursor did not advance');cursors.add(cursor);}
  }while(cursor);
  }
  // CAS races with a legacy writer import its additional committed reservations
  // and retry. Imported chunks stay durable if the process is interrupted.
  for(;;){
   const current=await readLedger(store,where);
   if(current.ledger?.schemaVersion===2){
    if(current.ledger.database!==database||current.ledger.namespace!==digest(namespace))unavailable('Event identity source belongs to another database');
    break;
   }
   if(current.ledger){await ensureSession(current.ledger.identity);const entries=Object.entries(current.ledger.events);
    for(let start=0;start<entries.length;start+=1000)await claim(client,where,new Map(entries.slice(start,start+1000)));
   }
   if(!where.identity)invalid('Cannot identify an empty historical session');
   const marker:Marker={schemaVersion:2,identity:where.identity!,database,namespace:digest(namespace)};
   if(await store.compareAndSet(where.source+'event-identities-v1.json',current.version,Buffer.from(JSON.stringify(marker))))break;
  }
  await client.query("UPDATE opencrawl_event_identity_sessions SET state='ready' WHERE namespace=$1 AND source=$2",[namespace,where.source]);
 }
 const api={
  ready,
  async reserve(options:SessionIdentity&{store:ObjectStore;events:SessionEvent[]}){
   const where=eventIdentityLocation(options),conflicts=new Set<string>(),events=eventFingerprints(options.events,conflicts);
   if(conflicts.size)eventIdentityConflict(conflicts);
   return locked(where.source,async(client,database)=>{
    await migrate(client,database,options.store,options.prefix,where);
    await claim(client,where,events);
    const result=await client.query<{event_count:string}>('SELECT event_count FROM opencrawl_event_identity_sessions WHERE namespace=$1 AND source=$2',[namespace,where.source]);
    return {reservedEvents:Number(result.rows[0]!.event_count)};
   });
  },
  async migrateSession({store,prefix,source}:{store:ObjectStore;prefix:string;source:string}){
   return locked(source,async(client,database)=>{
    await migrate(client,database,store,prefix,{source});
    const result=await client.query<{event_count:string}>('SELECT event_count FROM opencrawl_event_identity_sessions WHERE namespace=$1 AND source=$2',[namespace,source]);
    return {reservedEvents:Number(result.rows[0]!.event_count)};
   });
  },
  async purgeSession(options:Pick<SessionIdentity,'prefix'|'principal'|'harness'|'sessionId'>){
   if(options.principal.captureAccess!==undefined)throw Object.assign(new Error('Session owner access required'),{status:403});
   const where=eventIdentityLocation({...options,installationId:'purge'});
   await locked(where.source,async client=>{
    await client.query('BEGIN');
    try{
     await client.query('INSERT INTO opencrawl_event_identity_deletions(namespace,resource) VALUES($1,$2) ON CONFLICT DO NOTHING',[namespace,resource(where.source)]);
     await client.query('DELETE FROM opencrawl_event_identity_sessions WHERE namespace=$1 AND resource=$2',[namespace,resource(where.source)]);
     await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
   });
  },
  async close(){await pool.end();},
 } satisfies EventIdentityStore & Record<string,unknown>;
 return api;
}

/** Operator-owned PostgreSQL; no hosted account or credentials are required. */
export function standaloneEventIdentities(store:Pick<ObjectStore,'bucket'>,env=process.env){
 const connectionString=env.OPENCRAWL_DATABASE_URL;
 if(!connectionString)throw new Error('OPENCRAWL_DATABASE_URL is required for event identities. See docs/event-identity-migration.md before upgrading existing storage.');
 const namespace=env.OPENCRAWL_EVENT_IDENTITY_NAMESPACE||store.bucket;
 if(!namespace)throw new Error('Configure a stable OPENCRAWL_EVENT_IDENTITY_NAMESPACE for this storage source');
 return createPostgresEventIdentities({connectionString,namespace});
}
