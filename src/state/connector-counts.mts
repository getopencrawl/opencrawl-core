import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {sourcePaginationProgress,type SourceCheckpoint} from '../connectors/workflow.mjs';
import {ensureRegistrySchema} from '../integrations/local-registry.mjs';
import type {Environment} from '../integrations/types.mjs';
import {ensureSchemaIndex, type ApplicationDatabase} from './postgres.mjs';

export interface CountScope {environment:Environment; tenantId:string; userId:string; integrationId:string; binding:string}
export const countBinding = (bucket:string, prefix:string, provider:string) =>
  createHash('sha256').update(JSON.stringify([bucket,prefix.replace(/\/+$/, '')+'/',provider])).digest('hex');
type Summary = Record<string,number>;
export interface CountProgress {snapshot:string|null; cursor:string|null; phase?:'inventory'|'parts'; scanId?:string; pagination?:SourceCheckpoint; selection?:Record<string,number|null>}
export interface CountPass {generation:string; revision:number; succeeded:number[]; progress:CountProgress|null; statePointer:string|null}

const table = 'opencrawl_connector_counts';
const owner = 'namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5';
const exact = owner+' AND binding=$6';
const minute = 60_000;
const sixHours = 360 * minute;
const environments = ['production','staging','selfhost'];
const id = /^[A-Za-z0-9_:-]{1,200}$/;
const sha = /^[a-f0-9]{64}$/;
const snapshotDigest = (value:unknown):value is string|null => value===null || typeof value==='string' && sha.test(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const nat = (v:unknown):v is number => typeof v==='number' && Number.isSafeInteger(v) && v>=0;
function check(valid:unknown,field:string):asserts valid {if(!valid) throw new Error('Invalid connector count '+field);}
function flatMap(value:unknown, nullable:boolean) {
  if (!value || typeof value!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.entries(value);
  return fields.length<=64 && fields.every(([name,v])=>/^[A-Za-z0-9_-]{1,128}$/.test(name) && (nat(v) || (nullable && v===null)));
}
function progressValid(p:CountProgress) {
  const valid=p && [Object.prototype,null].includes(Object.getPrototypeOf(p)) && Object.keys(p).every(k=>['snapshot','cursor','phase','selection','pagination','scanId'].includes(k)) &&
    snapshotDigest(p.snapshot) &&
    (p.cursor===null || typeof p.cursor==='string' && p.cursor.length>0 && p.cursor.length<=8192 && !/[\x00-\x1f]/.test(p.cursor)) &&
    (p.scanId===undefined || typeof p.scanId==='string' && uuid.test(p.scanId)) &&
    (p.phase===undefined || ['inventory','parts'].includes(p.phase)) && (p.selection===undefined || flatMap(p.selection,true)) &&
    Buffer.byteLength(JSON.stringify(p))<=16_384;
  if (!valid || p.pagination===undefined) return valid;
  if (!p.cursor || !p.pagination || Object.keys(p.pagination).some(k=>!['version','anchor','window','distance'].includes(k))) return false;
  sourcePaginationProgress(p.cursor,p.pagination);
  return true;
}

interface Demand {succeeded:number[];observed_at:string;dispatch_at:string|null;published:Summary|null;published_at:string|null}
interface Head extends Demand {
  generation:string|null;pass_id:string|null;started_at:string|null;pass_jobs:number[]|null;
  revision:number;progress:CountProgress|null;snapshot:string|null;
}
function demand(h:Demand,observed:readonly number[],at:number,running:boolean,now:number) {
  if (at<=Number(h.observed_at)) return null;
  // Airbyte success is terminal. A short/late status page cannot make a known
  // successful job provisional again. Keep a bounded set for full-refresh selection.
  const jobs=[...new Set([...h.succeeded,...observed])].sort((a,b)=>a-b).slice(-100);
  const changed=!isDeepStrictEqual(jobs,h.succeeded);
  const stale=h.published_at===null || now-Number(h.published_at)>=(running ? minute : sixHours);
  const dispatch=h.dispatch_at===null ? changed || stale : now>=Number(h.dispatch_at);
  return changed || dispatch ? {jobs,dispatch} : null;
}
// The caller prepared one bounded PUT against the ETag of the object it read.
// Under the registry and head-row locks, only the winning revision may send it.
async function writeSnapshot(previous:string|null, next:string|null, write?:()=>Promise<void>) {
  if (previous===next) return;
  check(next!==null && typeof write==='function','snapshot write');
  await write();
}
function pass(h:Head): CountPass | null {
  return h.generation && h.pass_jobs ? {generation:h.generation,revision:h.revision,succeeded:h.pass_jobs,
    progress:h.progress,statePointer:h.snapshot} : null;
}

/** Only the source card, dispatch lease and scan position live in PostgreSQL.
 * The selected exact-count snapshot is owned by the connection's object store. */
export function createConnectorCounts(database:ApplicationDatabase, legacyBucket?:string) {
  let preparing:Promise<void>|undefined;
  async function ready() {
    preparing ??= (async()=>{
      await ensureRegistrySchema(database);
      await database.transaction(async db=>{
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:connector-counts:schema',0))");
        await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
          namespace text NOT NULL, environment text NOT NULL, tenant_id text NOT NULL, user_id text NOT NULL, integration_id text NOT NULL, binding text NOT NULL,
          PRIMARY KEY(namespace,environment,tenant_id,integration_id),
          FOREIGN KEY(namespace,environment,tenant_id,integration_id) REFERENCES opencrawl_integrations(namespace,environment,tenant_id,integration_id) ON DELETE CASCADE,
          succeeded jsonb NOT NULL DEFAULT '[]', observed_at bigint NOT NULL DEFAULT -1, dispatch_at bigint,
          published jsonb, published_at bigint, snapshot text, pass_id text, started_at bigint, generation uuid, pass_jobs jsonb,
          revision integer NOT NULL DEFAULT 0, progress jsonb)`);
        await ensureSchemaIndex(db,{table,name:'opencrawl_connector_counts_dispatch',keys:['namespace','environment','dispatch_at','tenant_id','integration_id']});
      });
    })().catch(err=>{preparing=undefined;throw err;});
    return preparing;
  }
  function params(s:CountScope) {
    check(s && environments.includes(s.environment) && [s.tenantId,s.userId,s.integrationId].every(v=>typeof v==='string' && id.test(v)) && typeof s.binding==='string' && sha.test(s.binding),'scope');
    return [database.namespace,s.environment,s.tenantId,s.userId,s.integrationId,s.binding];
  }
  const bindingFields="i.provider,i.record->>'s3Bucket' AS bucket,i.record->>'s3Prefix' AS prefix";
  const matches=(r:{provider:string;bucket:string|null;prefix:string|null}|undefined,binding:string)=>
    !!r?.prefix && !!(r.bucket || legacyBucket) && countBinding(r.bucket || legacyBucket!,r.prefix,r.provider)===binding;
  const joined=`FROM ${table} h JOIN opencrawl_integrations i USING(namespace,environment,tenant_id,user_id,integration_id)`;
  async function readRow<T>(s:CountScope,columns:string): Promise<T|null> {
    const args=params(s);
    await ready();
    const {rows}=await database.pool.query(`SELECT ${columns},${bindingFields} ${joined} WHERE ${exact} AND i.status='active'`,args);
    return matches(rows[0],s.binding) ? rows[0] as T : null;
  }
  async function authorized(db:PoolClient,args:string[],inactive:boolean) {
    const allowed=inactive ? "i.status IN ('disconnecting','disconnected','abandoned')" : "i.status='active'";
    const {rows}=await db.query(`SELECT ${bindingFields} FROM opencrawl_integrations i WHERE ${owner} AND ${allowed} FOR SHARE`,args.slice(0,5));
    return matches(rows[0],args[5]);
  }
  async function locked<T>(s:CountScope,unavailable:T,run:(db:PoolClient,args:string[],h:Head)=>Promise<T>,admit=false) {
    const args=params(s);
    await ready();
    return database.transaction(async db=>{
      if (!await authorized(db,args,false)) return unavailable;
      if (admit) {
        // A registry-approved landing rotation starts cold and retires the old
        // display row atomically; a delayed activity cannot recreate its binding.
        await db.query(`INSERT INTO ${table} AS h (namespace,environment,tenant_id,user_id,integration_id,binding) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(namespace,environment,tenant_id,integration_id) DO UPDATE SET user_id=EXCLUDED.user_id,binding=EXCLUDED.binding,succeeded='[]',observed_at=-1,dispatch_at=NULL,
          published=NULL,published_at=NULL,snapshot=NULL,pass_id=NULL,started_at=NULL,generation=NULL,pass_jobs=NULL,revision=0,progress=NULL
          WHERE (h.user_id,h.binding) IS DISTINCT FROM (EXCLUDED.user_id,EXCLUDED.binding)`,args);
      }
      const h=(await db.query<Head>(`SELECT * FROM ${table} WHERE ${exact} FOR UPDATE`,args)).rows[0];
      return h ? run(db,args,h) : unavailable;
    });
  }
  const observation='h.succeeded,h.observed_at,h.dispatch_at,h.published,h.published_at';
  return {
    ready,
    async read(s:CountScope) {return (await readRow<Demand>(s,'h.published'))?.published ?? null;},
    async seed(s:CountScope,counts:Summary,statePointer:string|null=null) {
      check(flatMap(counts,false) && snapshotDigest(statePointer),'prior snapshot');
      return locked(s,false,async(db,args,h)=>{
        if (h.generation!==null) return false;
        if (h.published!==null) return h.snapshot===statePointer && isDeepStrictEqual(h.published,counts);
        await db.query(`UPDATE ${table} SET published=$7::jsonb,snapshot=$8 WHERE ${exact}`,[...args,JSON.stringify(counts),statePointer]);
        return true;
      },true);
    },
    async request(s:CountScope,jobs:readonly number[],at:number,running=false):Promise<{counts:Summary|null;dispatch:boolean}> {
      check(Array.isArray(jobs) && jobs.length<=100 && jobs.every(nat) && nat(at) && typeof running==='boolean','observation');
      const recent=await readRow<Demand>(s,observation);
      if (recent && !demand(recent,jobs,at,running,Date.now())) return {counts:recent.published,dispatch:false};
      return locked<{counts:Summary|null;dispatch:boolean}>(s,{counts:null,dispatch:false},async(db,args,h)=>{
        const now=Date.now(), next=demand(h,jobs,at,running,now);
        if (!next) return {counts:h.published,dispatch:false};
        await db.query(`UPDATE ${table} SET succeeded=$7::jsonb,observed_at=$8,dispatch_at=$9 WHERE ${exact}`,[...args,JSON.stringify(next.jobs),at,next.dispatch ? now+minute : h.dispatch_at]);
        return {counts:h.published,dispatch:next.dispatch};
      },true);
    },
    async listPending(environment:Environment,limit=25):Promise<CountScope[]> {
      check(environments.includes(environment) && Number.isInteger(limit) && limit>0 && limit<=25,'dispatch range');
      await ready();
      return database.transaction(async db=>{
        const now=Date.now(),out:CountScope[]=[];
        const {rows}=await db.query(`SELECT h.tenant_id,h.user_id,h.integration_id,h.binding,${bindingFields} ${joined}
          WHERE h.namespace=$1 AND h.environment=$2 AND h.dispatch_at<=$3 AND i.status='active'
          ORDER BY h.dispatch_at,h.tenant_id,h.integration_id LIMIT $4 FOR UPDATE OF h SKIP LOCKED`,[database.namespace,environment,now,limit]);
        for (const r of rows) if (matches(r,r.binding)) out.push({environment,tenantId:r.tenant_id,userId:r.user_id,integrationId:r.integration_id,binding:r.binding});
        if (rows.length) await db.query(`UPDATE ${table} h SET dispatch_at=q.next FROM unnest($3::text[],$4::text[],$5::bigint[]) q(tenant,integration,next)
          WHERE h.namespace=$1 AND h.environment=$2 AND h.tenant_id=q.tenant AND h.integration_id=q.integration`,
          [database.namespace,environment,rows.map(r=>r.tenant_id),rows.map(r=>r.integration_id),rows.map(r=>matches(r,r.binding)?now+minute:null)]);
        return out;
      });
    },
    async begin(s:CountScope,passId:string,startedAt:number):Promise<CountPass|null> {
      check(typeof passId==='string' && id.test(passId) && nat(startedAt),'pass');
      return locked<CountPass|null>(s,null,async(db,args,h)=>{
        if (h.dispatch_at===null) return null;
        if (h.pass_id===passId && Number(h.started_at)===startedAt) return pass(h);
        if (h.started_at!==null && (startedAt<Number(h.started_at) || startedAt===Number(h.started_at) && passId<h.pass_id!)) return null;
        const generation=randomUUID();
        // The first PUT may have reached S3 before any SQL checkpoint. Preserve
        // the scan ID already stamped on those provisional full-refresh receipts.
        const position=h.pass_jobs && h.generation && !h.progress?.scanId
          ? {...(h.progress ?? {snapshot:h.snapshot,cursor:null}),scanId:h.generation}
          : h.progress;
        // A new execution resumes the last committed scan position after failure.
        // If the previous pass finished, pin the newest observed successful jobs.
        const {rows}=await db.query<Head>(`UPDATE ${table} SET generation=$7,pass_id=$8,started_at=$9,pass_jobs=coalesce(pass_jobs,succeeded),progress=$10::jsonb
          WHERE ${exact} RETURNING *`,[...args,generation,passId,startedAt,position===null?null:JSON.stringify(position)]);
        return pass(rows[0]);
      });
    },
    async deferBudget(s:CountScope,generation:string,revision:number) {
      check(uuid.test(generation) && nat(revision),'budget deferral');
      return locked(s,false,async(db,args,h)=>{
        if (h.generation!==generation || h.pass_jobs===null || h.revision!==revision) return false;
        const now=Date.now();
        // Long leases belong to this deferral. A lost acknowledgement should
        // not keep extending one. Directly starting a worker still permits a
        // retry after an operator increases this connection's snapshot budget.
        if (Number(h.dispatch_at)<=now+minute) {
          await db.query(`UPDATE ${table} SET dispatch_at=$7 WHERE ${exact}`,[...args,now+sixHours]);
        }
        return true;
      });
    },
    async current(s:CountScope,generation:string):Promise<CountPass|null> {
      check(uuid.test(generation),'generation');
      const h=await readRow<Head>(s,'h.*');
      return h?.generation===generation ? pass(h) : null;
    },
    // A conditional PUT can succeed and its SQL transaction still roll back.
    // The activity reads and verifies the current object through the resolver;
    // adopt its actual digest and restart inventory using the receipts in it.
    async adopt(s:CountScope,generation:string,revision:number,observedDigest:string|null) {
      check(uuid.test(generation) && nat(revision) && snapshotDigest(observedDigest),'observed snapshot');
      return locked(s,false,async(db,args,h)=>{
        if (h.generation!==generation || h.pass_jobs===null) return false;
        // A takeover rotates the writer generation, not the original scan ID.
        // Reuse its receipts but never its previous cursor or selected syncs.
        const scanId=h.progress?.scanId;
        const reset=scanId && scanId!==generation ? {scanId,snapshot:observedDigest,cursor:null} : null;
        if (h.revision===revision+1) return h.snapshot===observedDigest && isDeepStrictEqual(h.progress,reset);
        if (h.revision!==revision) return false;
        if (h.snapshot===observedDigest) return true;
        await db.query(`UPDATE ${table} SET revision=revision+1,snapshot=$7,progress=$8::jsonb WHERE ${exact}`,[...args,observedDigest,reset===null?null:JSON.stringify(reset)]);
        return true;
      });
    },
    async checkpoint(s:CountScope,generation:string,revision:number,progress:CountProgress,write?:()=>Promise<void>) {
      check(uuid.test(generation) && nat(revision) && progressValid(progress),'checkpoint');
      return locked(s,false,async(db,args,h)=>{
        if (h.generation!==generation || h.pass_jobs===null) return false;
        if (h.revision===revision+1) return isDeepStrictEqual(h.progress,JSON.parse(JSON.stringify(progress)));
        if (h.revision!==revision) return false;
        await writeSnapshot(h.snapshot,progress.snapshot,write);
        await db.query(`UPDATE ${table} SET revision=revision+1,progress=$7::jsonb,snapshot=$8 WHERE ${exact}`,[...args,JSON.stringify(progress),progress.snapshot]);
        return true;
      });
    },
    async publish(s:CountScope,generation:string,revision:number,summary:Summary,statePointer:string|null,write?:()=>Promise<void>) {
      check(uuid.test(generation) && nat(revision) && flatMap(summary,false) && snapshotDigest(statePointer),'publication');
      return locked(s,false,async(db,args,h)=>{
        if (h.generation!==generation) return false;
        if (h.pass_jobs===null) return h.revision===revision+1 && h.snapshot===statePointer && isDeepStrictEqual(h.published,summary);
        if (h.revision!==revision) return false;
        await writeSnapshot(h.snapshot,statePointer,write);
        await db.query(`UPDATE ${table} SET revision=revision+1,published=$7::jsonb,published_at=$8,snapshot=$9,
          dispatch_at=CASE WHEN succeeded=pass_jobs THEN NULL ELSE 0 END,pass_jobs=NULL,progress=NULL WHERE ${exact}`,
          [...args,JSON.stringify(summary),Date.now(),statePointer]);
        return true;
      });
    },
    async erase(s:CountScope) {
      const args=params(s);await ready();
      return database.transaction(async db=>{
        if (!await authorized(db,args,true)) return false;
        await db.query(`DELETE FROM ${table} WHERE ${exact}`,args);
        return true;
      });
    },
  };
}
