import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase,ApplicationTransaction} from './postgres.mjs';
import {decodeControl,MAX_CONTROL_BYTES,type ResourceControl,type ControlKind,type ResourceControls,type SourceControlIdentity} from '../sessions/controls.mjs';
import {digest,sessionScope} from '../sessions/event-identity.mjs';
import {isSessionHarness,type Principal,type StoreVersion} from '../sessions/types.mjs';

export type ControlIdentity={owner:string;kind:ControlKind;harness:string;nameHash:string};
export type RetainedControl=ControlIdentity & {control:ResourceControl;version:StoreVersion;hash:string};
export type ControlReceipt={sessions:number;memories:number;sha256:string};
export const controlsTable='opencrawl_resource_control_records';
export const authorityTable='opencrawl_resource_control_authority';
export const writesTable='opencrawl_resource_control_source_writes';
export const order='owner COLLATE "C",kind COLLATE "C",harness COLLATE "C",name_hash COLLATE "C"';
export const match='namespace=$1 AND owner=$2 AND kind=$3 AND harness=$4 AND name_hash=$5';
export const parameters=(ns:string,k:ControlIdentity)=>[ns,k.owner,k.kind,k.harness,k.nameHash];
const hex=/^[0-9a-f]{64}$/;
const ownerPattern=/^tenants\/[0-9a-f]{64}\/users\/[0-9a-f]{64}$/;
export function controlIdentities(organizationId:string|null) {
  const tenant=organizationId?'tenants/'+digest(organizationId)+'/users/':undefined;
  function owner(scope:string) {
    if(!ownerPattern.test(scope))throw Object.assign(Error('Invalid source control identity'),{status:400,permanent:true});
    if(tenant && !scope.startsWith(tenant))throw Object.assign(Error('Resource control owner scope denied'),{status:403,permanent:true});
    return scope;
  }
  function key(scope:string,kind:ControlKind,harness:string,nameHash:string):ControlIdentity {
    if(!['sessions','memories'].includes(kind) || !isSessionHarness(harness) || !hex.test(nameHash))throw Object.assign(Error('Invalid resource control identity'),{status:400,permanent:true});
    return {owner:owner(scope),kind,harness,nameHash};
  }
  return {key,owner:(p:Principal)=>owner(sessionScope(p)),resource(p:Principal,kind:ControlKind,harness:string,name:string){
    if(typeof name!=='string'||!name||name.length>2048)throw Object.assign(Error('Invalid resource control identity'),{status:400,permanent:true});
    return key(sessionScope(p),kind,harness,digest(name));
  },source(s:SourceControlIdentity){return key('tenants/'+s.tenantHash+'/users/'+s.userHash,'sessions',s.harness,s.sessionHash);}};
}

/** Refuse a new schema at the cutover boundary. Keep the original timestamp strings. */
export function checkedControl(bytes:Buffer,key:ControlIdentity) {
  const control=decodeControl(bytes);
  if(!control || bytes.length>MAX_CONTROL_BYTES || Object.keys(control).some(k=>!['schemaVersion','visibility','visibilitySource','deletedAt','updatedAt','deletion'].includes(k)) ||
      control.visibilitySource!==undefined && !['automatic','manual'].includes(control.visibilitySource) ||
      typeof control.updatedAt!=='string' || !Number.isFinite(Date.parse(control.updatedAt)) ||
      control.deletedAt!==null && typeof control.deletedAt!=='string' ||
      control.deletion!==undefined && (!control.deletion || key.kind!=='sessions' || digest(control.deletion.sessionId)!==key.nameHash ||
        Object.keys(control.deletion).some(k=>!['state','sessionId'].includes(k))))throw Error('Unsupported retained resource control');
  return control;
}

export function keepsDeletion(kind:ControlKind,prior:ResourceControl,current:ResourceControl) {
  if(!prior.deletedAt)return true;
  if(!current.deletedAt)return false;
  // A newer memory snapshot can supersede a cutoff; moving it backwards
  // would make previously deleted content visible again.
  if(kind==='memories')return Date.parse(current.deletedAt)>=Date.parse(prior.deletedAt);
  if(!prior.deletion)return true;
  return Boolean(current.deletion && (prior.deletion.state==='pending' || current.deletion.state==='complete'));
}

export async function readResourceControlSeal(db:Pick<ApplicationTransaction,'query'>,ns:string,source:ApplicationDatabase['sourceIdentity']):Promise<ControlReceipt|null>{
    const {rows:[row]}=await db.query('SELECT receipt,activated_at FROM '+authorityTable+' WHERE namespace=$1 AND source=$2::jsonb',[ns,source]);
    if(!row)throw Error('Resource control authority binding differs');
    if(row.receipt===null && row.activated_at===null)return null;
    const r=row.receipt;
    if(!row.activated_at || !r || typeof r.sha256!=='string' || !/^[0-9a-f]{64}$/.test(r.sha256) ||
       ![r.sessions,r.memories].every(v=>Number.isSafeInteger(v)&&v>=0))throw Error('Invalid resource control authority receipt');
    return r;
  }

export async function prepareControlTables(db:ApplicationTransaction) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:resource-control:schema:v1',0))");
  await db.query(`CREATE TABLE IF NOT EXISTS ${authorityTable} (
    namespace text PRIMARY KEY,source jsonb NOT NULL,receipt jsonb,activated_at timestamptz,
    CHECK ((receipt IS NULL)=(activated_at IS NULL)),
    CHECK (receipt IS NULL OR (jsonb_typeof(receipt)='object' AND receipt ?& ARRAY['sessions','memories','sha256']
      AND jsonb_typeof(receipt->'sessions')='number' AND jsonb_typeof(receipt->'memories')='number' AND receipt->>'sha256' ~ '^[a-f0-9]{64}$')));
    CREATE TABLE IF NOT EXISTS ${controlsTable} (
      namespace text NOT NULL REFERENCES ${authorityTable}(namespace),owner text COLLATE "C" NOT NULL CHECK(owner ~ '^tenants/[a-f0-9]{64}/users/[a-f0-9]{64}$'),
      kind text COLLATE "C" NOT NULL CHECK(kind IN ('sessions','memories')),harness text COLLATE "C" NOT NULL CHECK(harness ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
      name_hash text COLLATE "C" NOT NULL CHECK(name_hash ~ '^[a-f0-9]{64}$'),control jsonb NOT NULL,
      visibility text GENERATED ALWAYS AS (control->>'visibility') STORED NOT NULL CHECK(visibility IN ('private','team')),
      deleted_at text GENERATED ALWAYS AS (control->>'deletedAt') STORED,
      deletion_state text GENERATED ALWAYS AS (control#>>'{deletion,state}') STORED CHECK(deletion_state IN ('pending','complete')),
      source_version jsonb,source_hash text CHECK(source_hash ~ '^[a-f0-9]{64}$'),revision bigint NOT NULL DEFAULT 0,
      PRIMARY KEY(namespace,owner,kind,harness,name_hash),CHECK ((source_version IS NULL)=(source_hash IS NULL)),
      CHECK ((control->'schemaVersion') IS NOT DISTINCT FROM '1'::jsonb),CHECK (control ? 'deletedAt'),
      CHECK (deletion_state IS NULL OR (kind='sessions' AND deleted_at IS NOT NULL)));
    CREATE TABLE IF NOT EXISTS ${writesTable} (
      namespace text NOT NULL REFERENCES ${authorityTable}(namespace),operation uuid NOT NULL,owner text NOT NULL,kind text NOT NULL,
      harness text NOT NULL,name_hash text NOT NULL,expected_version jsonb,intended bytea NOT NULL,settled boolean NOT NULL DEFAULT false,
      PRIMARY KEY(namespace,operation));`);
}

export function postgresControlRows(database:ApplicationDatabase,ids:ReturnType<typeof controlIdentities>):ResourceControls {
  const ns=database.namespace,source=database.sourceIdentity;
  const active='a.namespace=$1 AND a.source=$2::jsonb AND a.activated_at IS NOT NULL AND a.receipt IS NOT NULL';
  function requireActive(count:number|null){if(!count)throw Error('Verified resource control authority is unavailable');}
  async function read(key:ControlIdentity) {
    const {rows}=await database.pool.query(`SELECT c.control FROM ${authorityTable} a LEFT JOIN ${controlsTable} c
      ON c.namespace=a.namespace AND c.owner=$3 AND c.kind=$4 AND c.harness=$5 AND c.name_hash=$6
      WHERE ${active}`,[ns,source,key.owner,key.kind,key.harness,key.nameHash]);
    requireActive(rows.length);return rows[0].control as ResourceControl|null;
  }
  return {
    read(owner,kind,harness,name){return read(ids.resource(owner,kind,harness,name));},
    readSource(source){return read(ids.source(source));},
    async update(owner,kind,harness,name,change){
      const key=ids.resource(owner,kind,harness,name),params=parameters(ns,key);
      return database.transaction(async db=>{
        await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        // Serialize absent rows too. Hash collisions only serialize unrelated updates.
        const guard=await db.query('SELECT pg_advisory_xact_lock(hashtextextended($3,0)) FROM '+authorityTable+' a WHERE '+active,
          [ns,source,JSON.stringify(['resource-control',...params])]);
        requireActive(guard.rowCount);
        const {rows:[row]}=await db.query('SELECT control FROM '+controlsTable+' WHERE '+match,params);
        const current:ResourceControl|null=row?.control??null;
        const next=checkedControl(Buffer.from(JSON.stringify({...current,schemaVersion:1,...change(current && structuredClone(current)),updatedAt:new Date().toISOString()})),key);
        if(row && !keepsDeletion(kind,row.control,next))throw Error('A resource deletion cannot be reversed');
        await db.query(`INSERT INTO ${controlsTable} AS c(namespace,owner,kind,harness,name_hash,control,revision) VALUES($1,$2,$3,$4,$5,$6,1)
          ON CONFLICT(namespace,owner,kind,harness,name_hash) DO UPDATE SET control=excluded.control,revision=c.revision+1`,[...params,next]);
        return next;
      });
    },
    async list(owner,kind,harness){
      const key=ids.resource(owner,kind,harness,'x');
      const {rows}=await database.pool.query(`SELECT c.name_hash,c.control FROM ${authorityTable} a LEFT JOIN LATERAL (
        SELECT name_hash,control FROM ${controlsTable} WHERE namespace=a.namespace AND owner=$3 AND kind=$4 AND harness=$5
        ORDER BY name_hash LIMIT 10001) c ON true WHERE ${active}`,[ns,source,key.owner,kind,harness]);
      requireActive(rows.length);
      if(rows.length>10000)throw Object.assign(Error('Too many resource controls'),{status:413,permanent:true});
      return new Map(rows.filter(row=>row.name_hash!==null).map(row=>[row.name_hash,row.control as ResourceControl]));
    },
    async pendingDeletions(owner){
      const {rows}=await database.pool.query(`SELECT c.harness,c.control#>>'{deletion,sessionId}' AS "sessionId" FROM ${authorityTable} a
        LEFT JOIN ${controlsTable} c ON c.namespace=a.namespace AND c.owner=$3 AND c.kind='sessions' AND c.deletion_state='pending'
        WHERE ${active} ORDER BY c.harness,c.name_hash`,[ns,source,ids.owner(owner)]);
      requireActive(rows.length);return rows.filter(row=>row.harness!==null) as Array<{harness:string;sessionId:string}>;
    },
  };
}

export async function copyControl(db:ApplicationTransaction,ns:string,item:RetainedControl) {
  const {rows:[row]}=await db.query(`INSERT INTO ${controlsTable}(namespace,owner,kind,harness,name_hash,control,source_version,source_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(namespace,owner,kind,harness,name_hash)
    DO UPDATE SET control=excluded.control,source_version=excluded.source_version,source_hash=excluded.source_hash
    RETURNING control,source_version,source_hash`,[...parameters(ns,item),item.control,JSON.stringify(item.version),item.hash]);
  if(!isDeepStrictEqual(row.control,item.control)||row.source_version!==item.version||row.source_hash!==item.hash)throw Error('Resource control readback differs');
}

/** PostgreSQL ordering is explicit so the digest is reproducible across database locales. */
export async function retainedReceipt(db:ApplicationTransaction,ns:string):Promise<ControlReceipt>{
  const result={sessions:0,memories:0,sha256:''},hash=createHash('sha256');
  let after=['','','',''];
  for(;;){
    const {rows}=await db.query(`SELECT owner,kind,harness,name_hash,source_version,source_hash FROM ${controlsTable}
      WHERE namespace=$1 AND source_hash IS NOT NULL AND (owner,kind,harness,name_hash)>($2,$3,$4,$5)
      ORDER BY ${order} LIMIT 256`,[ns,...after]);
    if(!rows.length)break;
    for(const row of rows){
      after=[row.owner,row.kind,row.harness,row.name_hash];result[row.kind as ControlKind]++;
      hash.update(JSON.stringify([...after,row.source_version,row.source_hash])+'\n');
    }
  }
  result.sha256=hash.digest('hex');return result;
}
