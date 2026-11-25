import {createHash} from 'node:crypto';
import type {ApplicationTransaction as PoolClient,ApplicationDatabase} from '../state/postgres.mjs';
import type {ConditionalStore,ObjectStore} from '../sessions/types.mjs';

const authorityTable='opencrawl_team_guard_authority';
export const activeTeamGuardIndex='opencrawl_team_operations_active_guard';
export type TeamGuardAuthority='object'|'paused'|'postgres';
type Reader=Pick<PoolClient,'query'>;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const isoTime=(value:unknown)=>typeof value==='string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
export async function prepareTeamGuardAuthority(db:PoolClient) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${authorityTable} (
    namespace text PRIMARY KEY,authority text NOT NULL CHECK(authority IN ('paused','postgres')),
    source_count integer,source_digest text,
    CHECK((authority='paused' AND source_count IS NULL AND source_digest IS NULL) OR
      (authority='postgres' AND source_count IS NOT NULL AND source_count>=0 AND source_digest IS NOT NULL AND source_digest ~ '^[a-f0-9]{64}$')))`);
  const relation=await db.query('SELECT to_regclass($1) AS index',[activeTeamGuardIndex]);
  if (!relation.rows[0].index) await db.query(`CREATE UNIQUE INDEX ${activeTeamGuardIndex} ON opencrawl_team_operations(namespace,organization)
    WHERE phase IN ('guarded','dispatching','applied')`);
  const definition=await db.query("SELECT pg_get_indexdef(indexrelid) AS sql, indisvalid AND indisready AND indislive AS ready FROM pg_index WHERE indexrelid=to_regclass($1) AND indrelid='opencrawl_team_operations'::regclass",[activeTeamGuardIndex]);
  const index=definition.rows[0];
  if (!index?.ready || !/^CREATE UNIQUE INDEX opencrawl_team_operations_active_guard ON \S+\.opencrawl_team_operations USING btree \(namespace, organization\) WHERE \(phase = ANY \(ARRAY\['guarded'::text, 'dispatching'::text, 'applied'::text\]\)\)$/.test(index.sql)) throw Error('Incompatible team guard uniqueness index');
}

export async function readTeamGuardAuthority(db:Reader,namespace:string,expectedDigest?:string):Promise<TeamGuardAuthority> {
  const {rows}=await db.query(`SELECT authority,source_count,source_digest FROM ${authorityTable} WHERE namespace=$1`,[namespace]);
  if(!rows.length)return 'object';
  const row=rows[0];
  if(rows.length===1 && row.authority==='paused' && row.source_count===null && row.source_digest===null)return 'paused';
  if(rows.length===1 && row.authority==='postgres' && Number.isInteger(row.source_count) && row.source_count>=0 && /^[a-f0-9]{64}$/.test(row.source_digest)){
    if(expectedDigest!==undefined && row.source_digest!==expectedDigest)throw Error('Team guard receipt binding changed');
    return 'postgres';
  }
  throw Error('Unrecognized team guard authority receipt');
}
export function teamGuardLock(namespace:string) {return JSON.stringify(['team-guard-authority',namespace]);}
async function exclusive(db:PoolClient,namespace:string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[teamGuardLock(namespace)]);
}
export async function pauseLegacyTeamGuards(database:ApplicationDatabase) {
  await database.transaction(async db=>{
    await exclusive(db,database.namespace);
    if (await readTeamGuardAuthority(db,database.namespace)==='postgres') throw Error('PostgreSQL team authority is already active');
    await db.query(`INSERT INTO ${authorityTable}(namespace,authority) VALUES($1,'paused') ON CONFLICT DO NOTHING`,[database.namespace]);
  });
}
/** Before activation only. Restore legacy writer permissions before resuming role changes. */
export async function resumeLegacyTeamGuards(database:ApplicationDatabase) {
  await database.transaction(async db=>{
    await exclusive(db,database.namespace);
    if (await readTeamGuardAuthority(db,database.namespace)==='postgres') throw Error('PostgreSQL team authority is already active');
    await db.query(`DELETE FROM ${authorityTable} WHERE namespace=$1 AND authority='paused'`,[database.namespace]);
  });
}
function classify(data:Buffer|null):'held'|'idle'|'unknown' {
  try {
    const row=JSON.parse(data?.toString('utf8')??'null');
    if (row?.schemaVersion!==1) return 'unknown';
    if (row.state==='held') return 'held';
    if (row.state==='idle' && uuid.test(row.operationId) && isoTime(row.completedAt) &&
        Object.keys(row).sort().join(',')==='completedAt,operationId,schemaVersion,state') return 'idle';
  } catch { /* Preserve malformed or missing source objects. */ }
  return 'unknown';
}
export async function inventoryTeamGuards(store:Pick<ObjectStore,'readVersion'|'listPage'>,prefix:string) {
  const directory=prefix+'/organization-role-writes/',digest=createHash('sha256'),seen=new Set<string>();
  const counts={idle:0,held:0,unknown:0};
  let token:string|null=null,previous='';
  do {
    const page=await store.listPage(directory,{continuationToken:token,maxKeys:1000});
    for(const key of page.keys) {
      if (!key.startsWith(directory) || previous && Buffer.compare(Buffer.from(previous),Buffer.from(key))>=0) throw Error('Invalid team guard listing order');
      previous=key;
      let source;
      try {source=await store.readVersion(key,{maxBytes:4096});}
      catch(error){
        if((error as {code?:string})?.code!=='ObjectReadLimitExceeded' && !(error instanceof Error && error.message==='Object exceeds read limit'))throw error;
        counts.unknown++;digest.update(JSON.stringify([key,'oversize'])+'\n');continue;
      }
      const {version,data}=source;
      const state=/^org_[a-zA-Z0-9]+\.json$/.test(key.slice(directory.length)) && version!==null?classify(data):'unknown';
      counts[state]++;
      digest.update(JSON.stringify([key,version,data?createHash('sha256').update(data).digest('hex'):null])+'\n');
    }
    token=page.nextToken;
    if (token && seen.has(token)) throw Error('Invalid team guard continuation');
    if (token) seen.add(token);
  } while(token);
  return {...counts,digest:digest.digest('hex')};
}
async function requireDrained(db:PoolClient,namespace:string) {
  const active=await db.query("SELECT 1 FROM opencrawl_team_operations WHERE namespace=$1 AND phase NOT IN ('queued','done') LIMIT 1",[namespace]);
  if(active.rowCount) throw Error('Active or uncertain team operations require reconciliation');
}
async function setPostgres(db:PoolClient,namespace:string,count:number,digest:string) {
  await db.query(`INSERT INTO ${authorityTable}(namespace,authority,source_count,source_digest) VALUES($1,'postgres',$2,$3)
    ON CONFLICT(namespace) DO UPDATE SET authority='postgres',source_count=excluded.source_count,source_digest=excluded.source_digest`,[namespace,count,digest]);
}
/** Operator has fenced the legacy writer roles and drained earlier binaries before calling. */
export async function activateTeamGuards(database:ApplicationDatabase,store:Pick<ObjectStore,'readVersion'|'listPage'>,prefix:string,expectedDigest:string) {
  await database.transaction(async db=>{
    await exclusive(db,database.namespace);
    const mode=await readTeamGuardAuthority(db,database.namespace);
    if(mode==='postgres'){
      const saved=await db.query(`SELECT source_digest FROM ${authorityTable} WHERE namespace=$1`,[database.namespace]);
      if(saved.rows[0]?.source_digest!==expectedDigest)throw Error('Team guard receipt mismatch');
      return;
    }
    if(mode!=='paused')throw Error('Pause team changes before activating PostgreSQL');
    await requireDrained(db,database.namespace);
    const source=await inventoryTeamGuards(store,prefix);
    if(source.held || source.unknown || source.digest!==expectedDigest)throw Error('Held, unknown or changed team guards require reconciliation');
    await setPostgres(db,database.namespace,source.idle,source.digest);
  });
}

/** Self-host has exactly one configured organization. A permanent CAS marker at its
 * former guard key fences even a restarted old process. Its exact contents bind a
 * retried migration to the same database namespace and organization. */
export async function activateSelfhostTeamGuard(database:ApplicationDatabase,store:ConditionalStore,prefix:string,org:string) {
  if(!/^org_[A-Za-z0-9]+$/.test(org))throw Error('Invalid self-hosted organization');
  const key=prefix+'/organization-role-writes/'+org+'.json';
  const marker=Buffer.from(JSON.stringify({schemaVersion:1,state:'postgres',namespace:database.namespace,key}));
  const digest=createHash('sha256').update(marker).digest('hex');
  if(await readTeamGuardAuthority(database.pool,database.namespace,digest)==='postgres')return;
  await database.transaction(async db=>{
    await exclusive(db,database.namespace);
    const mode=await readTeamGuardAuthority(db,database.namespace,digest);
    if(mode==='postgres')return;
    if(mode==='paused')throw Error('Team changes are paused');
    await requireDrained(db,database.namespace);
    const old=await store.readVersion(key,{maxBytes:4096});
    if(!old.data?.equals(marker)){
      if((old.version===null)!==(old.data===null) || old.data && classify(old.data)!=='idle') throw Error('Previous team guard requires operator reconciliation');
      if(!await store.compareAndSet(key,old.version,marker)) throw Error('Previous team guard changed during migration');
    }
    await setPostgres(db,database.namespace,1,digest);
  });
}
