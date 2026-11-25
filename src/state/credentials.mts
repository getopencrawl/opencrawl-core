import {randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase,ApplicationTransaction} from './postgres.mjs';
import type {ObjectStore,Principal,StoreVersion} from '../sessions/types.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';
import {credentialService,objectCredentialRepository,type CredentialRepository} from '../sessions/credentials.mjs';
import {credentialFamilies,credentialInventory,credentialPrefix,type CredentialFamily,type CredentialImportReceipt} from './credential-inventory.mjs';
import {fail} from '../errors.mjs';

const records='opencrawl_credential_records',markers='opencrawl_credential_generations';
const authority='opencrawl_credential_authority',pending='opencrawl_credential_source_writes';
type Query=Pick<ApplicationTransaction,'query'>;
type Mode='plan'|'activate'|'verify';
export type {CredentialFamily,CredentialImportReceipt} from './credential-inventory.mjs';

/** The two scopes are deliberately disjoint even when the credential hash is identical.
 * Older receivers must be drained before activate. A sealed namespace only authorizes in PG. */
export function createCredentialState(database:ApplicationDatabase, store:ObjectStore, prefix:string){
  const source=database.sourceIdentity,ns=database.namespace;
  if(!source || !store.bucket || source.bucket!==store.bucket || source.prefix!==prefix)throw Error('Credential storage binding differs');
  const lock=JSON.stringify(['credential-authority-v1',ns]);
  let preparing:Promise<void>|undefined,switched=false;
  async function binding(db:Query){
    const {rows:[row]}=await db.query(`SELECT source,receipt,activated_at FROM ${authority} WHERE namespace=$1`,[ns]);
    if(!row || !isDeepStrictEqual(row.source,source))throw Error('Credential authority binding differs');
    return row as {receipt:CredentialImportReceipt|null;activated_at:Date|null};
  }
  function ready(){
    preparing??=database.transaction(async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:credential:schema:v1',0))");
      await db.query(`CREATE TABLE IF NOT EXISTS ${authority}(
        namespace text PRIMARY KEY,source jsonb NOT NULL,receipt jsonb,activated_at timestamptz,
        CHECK ((receipt IS NULL)=(activated_at IS NULL)));
        CREATE TABLE IF NOT EXISTS ${records}(
        namespace text NOT NULL REFERENCES ${authority}(namespace),family text NOT NULL CHECK(family IN ('capture','agent')),
        id text NOT NULL CHECK(id ~ '^[a-f0-9]{64}$'),owner text NOT NULL CHECK(owner ~ '^tenants/[a-f0-9]{64}/users/[a-f0-9]{64}$'),
        record jsonb NOT NULL,source_hash text,PRIMARY KEY(namespace,family,id),
        CHECK ((record->>'id') IS NOT DISTINCT FROM id));
        CREATE TABLE IF NOT EXISTS ${markers}(
        namespace text NOT NULL REFERENCES ${authority}(namespace),family text NOT NULL CHECK(family IN ('capture','agent')),
        owner text NOT NULL CHECK(owner ~ '^tenants/[a-f0-9]{64}/users/[a-f0-9]{64}$'),
        generation text NOT NULL CHECK(generation ~ '^[a-f0-9]{64}$'),version jsonb NOT NULL,source_hash text,
        PRIMARY KEY(namespace,family,owner), CHECK(jsonb_typeof(version) IN ('string','number')));
        CREATE TABLE IF NOT EXISTS ${pending}(
        namespace text NOT NULL REFERENCES ${authority}(namespace),operation uuid NOT NULL,family text NOT NULL,
        kind text NOT NULL,object_id text NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,operation))`);
      await db.query(`INSERT INTO ${authority}(namespace,source) VALUES($1,$2) ON CONFLICT DO NOTHING`,[ns,source]);
      await binding(db);
    }).catch(error=>{preparing=undefined;throw error;});
    return preparing;
  }
  async function active(){
    if(!switched){await ready();switched=Boolean((await binding(database.pool)).receipt);}
    return switched;
  }
  async function pendingCount(db:Query){
    return Number((await db.query(`SELECT count(*) FROM ${pending} WHERE namespace=$1`,[ns])).rows[0].count);
  }
  async function status(){
    await ready();const row=await binding(database.pool);
    return {backend:row.receipt?'postgres' as const:'objects' as const,activatedAt:row.activated_at?.toISOString()??null,
      receipt:row.receipt,pendingSourceWrites:await pendingCount(database.pool)};
  }
  function owner(principal:Principal){
    const scope=sessionScope(principal);
    if(source!.organizationId && principal.tenantId!==source!.organizationId)fail(403,'Credential owner outside configured organization');
    return scope;
  }

  function credentials(family:CredentialFamily,{now=Date.now}:{now?:()=>number}={}){
    if(!credentialFamilies.includes(family))throw Error('Unknown credential family');
    const base=credentialPrefix(prefix,family),legacy=objectCredentialRepository(store,base);
    async function read<T>(objects:()=>Promise<T>,postgres:()=>Promise<T>):Promise<T>{
      if(await active())return postgres();
      let result:T;
      try{result=await objects();}catch(error){if(await active())return postgres();throw error;}
      // An object read that overlapped the handoff cannot ignore a new SQL revocation.
      return await active()?postgres():result;
    }
    async function mutate(kind:string,key:string,objects:(repository:CredentialRepository)=>Promise<void>,postgres:()=>Promise<void>){
      if(await active())return postgres();
      const operation=randomUUID();
      const admitted=await database.transaction(async db=>{
        await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[lock]);
        if((await binding(db)).receipt)return false;
        await db.query(`INSERT INTO ${pending}(namespace,operation,family,kind,object_id) VALUES($1,$2,$3,$4,$5)`,[ns,operation,family,kind,key]);
        return true;
      });
      if(!admitted){switched=true;return postgres();}
      let dispatched=false,settled=false;
      const guarded=objectCredentialRepository({...store,
        put(...args){dispatched=true;return store.put(...args);},
        compareAndSet(...args){dispatched=true;return store.compareAndSet(...args);}},base);
      try{await objects(guarded);settled=true;}
      catch(error){settled=(error as {writeOutcome?:string})?.writeOutcome==='not-applied';throw error;}
      finally{
        // Validation/owner rejection or a definite write result leaves no uncertainty.
        // A crash or transport error after dispatch must fence activation.
        if(settled || !dispatched)await database.pool.query(`DELETE FROM ${pending} WHERE namespace=$1 AND operation=$2`,[ns,operation]);
      }
    }
    const repository:CredentialRepository={
      async create(record){
        const scope=owner(record.principal);
        await mutate('issue',record.id,r=>r.create(record),async()=>{
          await database.pool.query(`INSERT INTO ${records}(namespace,family,id,owner,record)
            VALUES($1,$2,$3,$4,$5::jsonb || jsonb_build_object('generation',
              coalesce((SELECT generation FROM ${markers} WHERE namespace=$1 AND family=$2 AND owner=$4),'')))`,
            [ns,family,record.id,scope,record]);
        });
      },
      async lookup(id,at){
        const principal=await read(()=>legacy.lookup(id,at),async()=>{
          const {rows:[row]}=await database.pool.query(`SELECT c.record FROM ${records} c
            LEFT JOIN ${markers} g ON g.namespace=c.namespace AND g.family=c.family AND g.owner=c.owner
            WHERE c.namespace=$1 AND c.family=$2 AND c.id=$3 AND c.record->'revoked'='false'::jsonb
            AND coalesce(c.record->>'generation','')=coalesce(g.generation,'')`,[ns,family,id]);
          if(!row || !(Date.parse(row.record.expiresAt)>at))return null;
          return row.record.principal as Principal;
        });
        if(principal)owner(principal);
        return principal;
      },
      removalVersion(principal){
        const scope=owner(principal);
        return read(()=>legacy.removalVersion(principal),async()=>{
          const {rows:[marker]}=await database.pool.query(`SELECT version FROM ${markers} WHERE namespace=$1 AND family=$2 AND owner=$3`,[ns,family,scope]);
          return marker?.version as StoreVersion|undefined ?? null;
        });
      },
      async rotate(principal,version){
        const scope=owner(principal);
        await mutate('rotate',scope,r=>r.rotate(principal,version),async()=>{
          const values=[ns,family,scope,randomBytes(32).toString('hex'),JSON.stringify('pg:'+randomUUID())];
          if(version!=null){
            await database.pool.query(`UPDATE ${markers} SET generation=$4,version=$5::jsonb
              WHERE namespace=$1 AND family=$2 AND owner=$3 AND version=$6::jsonb`,[...values,JSON.stringify(version)]);
            return;
          }
          const conflict=version===null?'DO NOTHING':'DO UPDATE SET generation=excluded.generation,version=excluded.version';
          await database.pool.query(`INSERT INTO ${markers}(namespace,family,owner,generation,version)
            VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(namespace,family,owner) `+conflict,values);
        });
      },
      async revoke(principal,id){
        const scope=owner(principal);
        await mutate('revoke',id,r=>r.revoke(principal,id),async()=>{
          await database.transaction(async db=>{
            const {rows:[current]}=await db.query(`SELECT owner FROM ${records} WHERE namespace=$1 AND family=$2 AND id=$3 FOR UPDATE`,[ns,family,id]);
            if(!current)return;
            if(current.owner!==scope)fail(403,'Credential owner mismatch');
            await db.query(`UPDATE ${records} SET record=jsonb_set(record,'{revoked}','true')
              WHERE namespace=$1 AND family=$2 AND id=$3`,[ns,family,id]);
          });
        });
      },
    };
    return credentialService(repository,now);
  }

  async function migrate(mode:Mode,attest?:()=>Promise<void>){
    if(!['plan','activate','verify'].includes(mode))throw Error('Unknown credential migration mode');
    await ready();
    const report=await database.transaction(async db=>{
      // Issuance and revocation wait during the short authority commit. Reads are lock-free.
      const sqlLock=mode==='activate'?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared';
      await db.query('SELECT '+sqlLock+'(hashtextextended($1,0))',[lock]);
      const saved=(await binding(db)).receipt;
      if(saved && mode!=='verify')return {backend:'postgres' as const,receipt:saved};
      if(!saved && mode==='verify')throw Error('PostgreSQL credential authority is not active');
      const copy=mode==='activate';
      if(copy && await pendingCount(db))throw Error('Credential source write in flight or uncertain');
      const totals=async(imported:boolean)=>{
        const where=' WHERE namespace=$1'+(imported?' AND source_hash IS NOT NULL':'');
        const result=await db.query(`SELECT (SELECT count(*) FROM ${records}${where})+(SELECT count(*) FROM ${markers}${where}) AS n`,[ns]);
        return Number(result.rows[0].n);
      };
      if(copy && await totals(false))throw Error('Credential target must be empty before activation');
      const receipt=await credentialInventory(store,prefix,source!.organizationId,async items=>{
        if(mode==='plan')return;
        for(const item of items){
          if(item.kind==='record'){
            const key=[ns,item.family,item.id];
            if(copy)await db.query(`INSERT INTO ${records}(namespace,family,id,owner,record,source_hash) VALUES($1,$2,$3,$4,$5,$6)`,
              [...key,item.owner,item.record,item.sourceHash]);
            const {rows:[row]}=await db.query(`SELECT owner,record,source_hash FROM ${records} WHERE namespace=$1 AND family=$2 AND id=$3`,key);
            // The only legitimate mutation on an imported record is false -> true revocation.
            const expected=!copy && row?.record.revoked===true?{...item.record,revoked:true}:item.record;
            if(row?.owner!==item.owner || row.source_hash!==item.sourceHash || !isDeepStrictEqual(row.record,expected))throw Error('Retained credential verification differs');
          }else{
            const key=[ns,item.family,item.owner];
            if(copy)await db.query(`INSERT INTO ${markers}(namespace,family,owner,generation,version,source_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
              [...key,item.generation,JSON.stringify(item.version),item.sourceHash]);
            const {rows:[row]}=await db.query(`SELECT generation,version,source_hash FROM ${markers} WHERE namespace=$1 AND family=$2 AND owner=$3`,key);
            const rotated=!copy && typeof row?.version==='string' && /^pg:[a-f0-9-]{36}$/.test(row.version) && row.version!==item.version;
            if(row?.source_hash!==item.sourceHash || (!rotated && (row.version!==item.version || row.generation!==item.generation)))throw Error('Retained credential generation verification differs');
          }
        }
      });
      if(mode==='plan')return {backend:'objects' as const,receipt};
      const expected=credentialFamilies.reduce((n,family)=>n+receipt[family].records+receipt[family].generations,0);
      if(await totals(true)!==expected || saved && !isDeepStrictEqual(saved,receipt))throw Error('Credential inventory differs');
      if(copy){
        await attest?.();
        await db.query(`UPDATE ${authority} SET receipt=$2,activated_at=clock_timestamp() WHERE namespace=$1 AND receipt IS NULL`,[ns,receipt]);
      }
      return {backend:'postgres' as const,receipt};
    });
    if(report.backend==='postgres')switched=true;
    return report;
  }
  return {credentials,ready,active,status,migrate};
}
