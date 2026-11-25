import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {challengeSchema,scope,uuid,type ReplicasConnection,type ReplicasChallenge} from '../identity/replicas-schema.mjs';
import type {StoreVersion} from '../sessions/types.mjs';
import {ensureSchemaIndex,type ApplicationDatabase} from './postgres.mjs';
import {checkedConnection,codeHash,objectReplicasState,tenantHash,type ReplicasObjects,type ReplicasRepository} from './replicas-objects.mjs';

const table='opencrawl_replicas_approvals';
const authority='opencrawl_replicas_authority';
const pending='opencrawl_replicas_pending_source_writes';
type Kind='organization'|'setup';
type RecordValue=ReplicasConnection|ReplicasChallenge;
export interface ReplicasImportReceipt {organizations:number;setupCodes:number;tenantIndexes:number;sha256:string}

export function createReplicasState(database:ApplicationDatabase,store:ReplicasObjects & {bucket?:string},prefix:string) {
  const source=database.sourceIdentity;
  if (!source || !store.bucket || source.bucket!==store.bucket || source.prefix!==prefix)
    throw new Error('Replicas storage must match the application database source');
  const ns=database.namespace,lock=JSON.stringify(['replicas-approvals-v1',ns]);
  const objects=objectReplicasState(store,prefix);
  function checkTenant(tenant:string) {
    scope.parse(tenant);
    if (source?.organizationId && tenant!==source.organizationId) throw new Error('Replicas source tenant mismatch');
  }
  let prepared:Promise<void>|undefined;
  let switched=false;
  function ready() {
    prepared??=database.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:replicas-approvals:schema',0))");
      await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
        namespace text NOT NULL,kind text NOT NULL CHECK(kind IN ('organization','setup')),id text NOT NULL,
        tenant_id text NOT NULL,record jsonb NOT NULL,revision uuid NOT NULL,PRIMARY KEY(namespace,kind,id),
        CHECK ((record->>'tenantId') IS NOT DISTINCT FROM tenant_id));
        CREATE TABLE IF NOT EXISTS ${pending} (
          namespace text NOT NULL,operation uuid NOT NULL,kind text NOT NULL,id text NOT NULL,
          started_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,operation));
        CREATE TABLE IF NOT EXISTS ${authority} (
          namespace text PRIMARY KEY,source jsonb NOT NULL,receipt jsonb NOT NULL,activated_at timestamptz NOT NULL DEFAULT now())`);
      await ensureSchemaIndex(client,{table,name:'opencrawl_replicas_approvals_tenant',keys:['namespace','tenant_id','id'],predicate:{column:'kind',equals:'organization'}});
    }).catch(error=>{prepared=undefined;throw error;});
    return prepared;
  }
  async function receipt(client:Pick<PoolClient,'query'>):Promise<ReplicasImportReceipt|null> {
    const {rows}=await client.query(`SELECT source,receipt FROM ${authority} WHERE namespace=$1`,[ns]);
    if (!rows.length) return null;
    if (!isDeepStrictEqual(rows[0].source,source)) throw new Error('Replicas source binding changed');
    return rows[0].receipt;
  }
  async function active() {
    if (!switched) {
      await ready();
      if (await receipt(database.pool)) switched=true;
    }
    return switched;
  }
  async function read(id:string,kind:Kind) {
    const {rows}=await database.pool.query(`SELECT record,revision FROM ${table} WHERE namespace=$1 AND kind=$2 AND id=$3`,[ns,kind,id]);
    return rows[0] ? {record:rows[0].record,version:'pg:'+rows[0].revision} : {record:null,version:null};
  }
  async function save(id:string,kind:Kind,version:StoreVersion|null,value:RecordValue,legacy:()=>Promise<boolean>) {
    checkTenant(value.tenantId);
    if (!switched) {
      await ready();
      const operation=randomUUID();
      const alreadyActive=await database.transaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[lock]);
        if (await receipt(client)) return true;
        await client.query(`INSERT INTO ${pending}(namespace,operation,kind,id) VALUES($1,$2,$3,$4)`,[ns,operation,kind,id]);
        return false;
      });
      if (!alreadyActive) {
        // A timed-out S3 write can still commit after its caller exits. Record
        // intent before issuing it; only a definite outcome permits activation.
        const ok=await legacy();
        await database.pool.query(`DELETE FROM ${pending} WHERE namespace=$1 AND operation=$2`,[ns,operation]);
        return ok;
      }
      switched=true;
    }
    const args=[ns,kind,id,value.tenantId,JSON.stringify(value),randomUUID()];
    if (version===null) {
      const result=await database.pool.query(`INSERT INTO ${table}(namespace,kind,id,tenant_id,record,revision)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,args);
      return result.rowCount===1;
    }
    // An S3 ETag can arrive from an operation that straddled cutover.
    if (typeof version!=='string'||!/^pg:[a-f0-9-]{36}$/.test(version)) return false;
    const result=await database.pool.query(`UPDATE ${table} SET record=$5,revision=$6
      WHERE namespace=$1 AND kind=$2 AND id=$3 AND tenant_id=$4 AND revision=$7`,[...args,version.slice(3)]);
    return result.rowCount===1;
  }
  const repository:ReplicasRepository={
    async readConnection(id) {
      uuid.parse(id);
      if (!await active()) return objects.readConnection(id);
      const {record,version}=await read(id,'organization');
      return {record:record && checkedConnection(id,record),version};
    },
    saveConnection(id,version,input) {
      const record=checkedConnection(id,input);
      return save(id,'organization',version,record,()=>objects.saveConnection(id,version,record));
    },
    async listConnections(tenant) {
      checkTenant(tenant);
      if (!await active()) return objects.listConnections(tenant);
      const {rows}=await database.pool.query(`SELECT id,record FROM ${table} WHERE namespace=$1 AND kind='organization'
        AND tenant_id=$2 AND record->>'revokedAt' IS NULL ORDER BY id LIMIT 10001`,[ns,tenant]);
      if (rows.length>10000) throw new Error('Replicas connection listing exceeds limit');
      return rows.map(row=>checkedConnection(row.id,row.record));
    },
    async readSetup(hash) {
      codeHash(hash);
      if (!await active()) return objects.readSetup(hash);
      const {record,version}=await read(hash,'setup');
      return {record:record && challengeSchema.parse(record),version};
    },
    saveSetup(hash,version,input) {
      const record=challengeSchema.parse(input);
      return save(codeHash(hash),'setup',version,record,()=>objects.saveSetup(hash,version,record));
    },
  };

  /** All older, unguarded writers must be drained before this one-way handoff.
   * The DB commits the imported rows and their verified authority together.
   * Later runs return the receipt without reading or replaying frozen S3 data. */
  async function migrate(mode:'check'|'activate') {
    await ready();
    return database.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
      const saved=await receipt(client);
      if (saved) return {backend:'postgres' as const,receipt:saved};
      const inFlight=await client.query(`SELECT 1 FROM ${pending} WHERE namespace=$1 LIMIT 1`,[ns]);
      if (inFlight.rowCount) throw new Error('Unsettled Replicas source writes; wait for completion or reconcile before activation');
      if ((await client.query(`SELECT 1 FROM ${table} WHERE namespace=$1 LIMIT 1`,[ns])).rowCount)
        throw new Error('Unactivated Replicas target contains records');
      const root=prefix+'/identity/replicas-v1/';
      const counts={organizations:0,setupCodes:0,tenantIndexes:0};
      const indexes=new Set<string>(),expected=new Set<string>(),hash=createHash('sha256');
      let token:string|undefined;
      const tokens=new Set<string>();
      do {
        const listed=await store.listPage(root,{maxKeys:250,continuationToken:token});
        for (const key of listed.keys) {
          if (!key.startsWith(root)) throw new Error('Replicas inventory escaped its source');
          const path=key.slice(root.length);
          const match=/^(organizations|setup)\/([a-f0-9-]+)\.json$/.exec(path);
          if (!match) {
            if (!/^tenants\/[a-f0-9]{64}\/[a-f0-9-]{36}\.json$/.test(path)||indexes.has(path))
              throw new Error('Unexpected Replicas source object');
            const bytes=await store.get(key,{maxBytes:1024});
            const id=uuid.parse(path.slice(path.lastIndexOf('/')+1,-5));
            if (!bytes || !isDeepStrictEqual(JSON.parse(bytes.toString()),{organizationId:id})) throw new Error('Invalid Replicas tenant index');
            hash.update(JSON.stringify([path,createHash('sha256').update(bytes).digest('hex')])+'\n');
            indexes.add(path);counts.tenantIndexes++;
            continue;
          }
          const folder=match[1]!,id=match[2]!;
          const kind=folder==='organizations'?'organization':'setup';
          const bytes=await store.get(key,{maxBytes:kind==='organization'?65536:4096});
          if (!bytes) throw new Error('Replicas source disappeared while importing');
          const parsed:unknown=JSON.parse(bytes.toString());
          let record:RecordValue;
          if (kind==='organization') {
            record=checkedConnection(id,parsed);counts.organizations++;
            expected.add('tenants/'+tenantHash(record.tenantId)+'/'+id+'.json');
          } else {
            codeHash(id);record=challengeSchema.parse(parsed);counts.setupCodes++;
          }
          checkTenant(record.tenantId);
          if (mode==='activate') {
            await client.query(`INSERT INTO ${table}(namespace,kind,id,tenant_id,record,revision)
              VALUES($1,$2,$3,$4,$5,$6)`,[ns,kind,id,record.tenantId,JSON.stringify(record),randomUUID()]);
            const result=await client.query(`SELECT record FROM ${table} WHERE namespace=$1 AND kind=$2 AND id=$3`,[ns,kind,id]);
            if (!isDeepStrictEqual(parsed,result.rows[0]?.record)) throw new Error('Replicas import readback mismatch');
          }
          hash.update(JSON.stringify([path,createHash('sha256').update(bytes).digest('hex')])+'\n');
        }
        token=listed.nextToken??undefined;
        if (token && tokens.has(token)) throw new Error('Incomplete Replicas inventory');
        if (token) tokens.add(token);
      } while (token);
      if (!isDeepStrictEqual(indexes,expected)) throw new Error('Replicas tenant index and authoritative records disagree');
      const summary={...counts,sha256:hash.digest('hex')};
      if (mode==='check') return {backend:'objects' as const,receipt:summary};
      const total=await client.query(`SELECT count(*)::integer AS n FROM ${table} WHERE namespace=$1`,[ns]);
      if (total.rows[0]?.n!==counts.organizations+counts.setupCodes) throw new Error('Replicas target count mismatch');
      await client.query(`INSERT INTO ${authority}(namespace,source,receipt) VALUES($1,$2,$3)`,[ns,source,summary]);
      return {backend:'postgres' as const,receipt:summary};
    });
  }
  return {repository,ready,active,migrate};
}
export type {ReplicasRepository} from './replicas-objects.mjs';
export type ReplicasState=ReturnType<typeof createReplicasState>;
