import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {postgresReplicasRecords} from './postgres-replicas.mjs';
export {createPostgresReplicasRepository,type ReplicasImportReceipt} from './postgres-replicas.mjs';
import {challengeSchema,uuid,type ReplicasConnection,type ReplicasChallenge} from '../identity/replicas-schema.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
import {checkedConnection,codeHash,objectReplicasState,tenantHash,type ReplicasObjects,type ReplicasRepository} from './replicas-objects.mjs';

const table='opencrawl_replicas_approvals';
const authority='opencrawl_replicas_authority';
const pending='opencrawl_replicas_pending_source_writes';
type Kind='organization'|'setup';
type RecordValue=ReplicasConnection|ReplicasChallenge;

export function createReplicasState(database:ApplicationDatabase,store:ReplicasObjects & {bucket?:string},prefix:string) {
  const source=database.sourceIdentity;
  if (!source || !store.bucket || source.bucket!==store.bucket || source.prefix!==prefix)
    throw new Error('Replicas storage must match the application database source');
  const ns=database.namespace,lock=JSON.stringify(['replicas-approvals-v1',ns]);
  const objects=objectReplicasState(store,prefix);
  const sql=postgresReplicasRecords(database);
  const {receipt,checkTenant}=sql;
  let prepared:Promise<void>|undefined,switched=false;
  function ready() {
    return prepared??=(async()=>{
      await sql.ready();
      await database.transaction(async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:replicas-approvals:schema',0))");
        await client.query(`CREATE TABLE IF NOT EXISTS ${pending} (
          namespace text NOT NULL,operation uuid NOT NULL,kind text NOT NULL,id text NOT NULL,
          started_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,operation))`);
      });
    })().catch(error=>{prepared=undefined;throw error;});
  }
  async function active() {
    if (!switched) {
      await ready();
      if (await receipt(database.pool)) switched=true;
    }
    return switched;
  }
  async function save(id:string,kind:Kind,value:RecordValue,legacy:()=>Promise<boolean>,native:()=>Promise<boolean>) {
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
    return native();
  }
  const repository:ReplicasRepository={
    async readConnection(id){return (await active()?sql.repository:objects).readConnection(id);},
    async listConnections(tenant){checkTenant(tenant);return (await active()?sql.repository:objects).listConnections(tenant);},
    async readSetup(hash){return (await active()?sql.repository:objects).readSetup(hash);},
    saveConnection(id,version,input){
      const record=checkedConnection(id,input);
      return save(id,'organization',record,()=>objects.saveConnection(id,version,record),()=>sql.repository.saveConnection(id,version,record));
    },
    saveSetup(hash,version,input){
      const record=challengeSchema.parse(input);
      return save(codeHash(hash),'setup',record,()=>objects.saveSetup(hash,version,record),()=>sql.repository.saveSetup(hash,version,record));
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
