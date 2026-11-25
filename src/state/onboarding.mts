import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {retainedOwnerScopes} from '../sessions/s3-store.mjs';
import type {ObjectStore} from '../sessions/types.mjs';
import {objectOnboardingReceipts, onboardingReceiptKey, onboardingKinds, validateReceipt, validateReceiptScope,
  type OnboardingKind, type OnboardingRepository, type ReceiptMap} from '../onboarding-receipts.mjs';
import type {ApplicationDatabase, ApplicationTransaction} from './postgres.mjs';

const schemaReady=new WeakMap<ApplicationDatabase,Promise<void>>();

type Phase = 'object' | 'importing' | 'postgres';
type Source = Pick<ObjectStore,'bucket'|'put'|'get'|'listPage'>;
function fingerprint(receipts: ReceiptMap) {
  const ordered = onboardingKinds.map(kind => Object.entries(receipts[kind] ?? {}).sort(([a],[b])=>a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/** The same receiver can run before and after activation. A participating S3
 * write records a durable intent until it settles. Once importing, each owner
 * is copied at most once, before its first PostgreSQL read or mutation. */
export function createOnboardingRepository(database: ApplicationDatabase, store: Source, prefix: string) {
  const source = database.sourceIdentity, namespace = database.namespace;
  if (!store.bucket || !source || source.bucket !== store.bucket || source.prefix !== prefix)
    throw Error('Onboarding storage binding differs');
  const objects = objectOnboardingReceipts(store,prefix);
  const tenantHash=source.organizationId ? createHash('sha256').update(source.organizationId).digest('hex') : undefined;
  function authorizeOwner(owner:string) {
    validateReceiptScope(owner);
    if(tenantHash && !owner.startsWith('tenants/'+tenantHash+'/users/'))throw Error('Onboarding owner outside configured organization');
  }
  const sourceJson = JSON.stringify(source);

  function ready() {
    const existing=schemaReady.get(database);
    if(existing)return existing;
    const preparing=database.transaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:onboarding:schema:v1',0))");
      await db.query(`CREATE TABLE IF NOT EXISTS opencrawl_onboarding_authority(
        namespace text PRIMARY KEY, source jsonb NOT NULL, phase text NOT NULL CHECK(phase IN ('object','importing','postgres')));
        CREATE TABLE IF NOT EXISTS opencrawl_onboarding_source_writes(
        namespace text NOT NULL REFERENCES opencrawl_onboarding_authority(namespace),operation uuid NOT NULL,
        owner text NOT NULL,kind text NOT NULL,requested jsonb NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,operation));
        CREATE TABLE IF NOT EXISTS opencrawl_onboarding_owners(
        namespace text NOT NULL REFERENCES opencrawl_onboarding_authority(namespace),
        owner text NOT NULL CHECK(owner ~ '^tenants/[a-f0-9]{64}/users/[a-f0-9]{64}$'),
        receipts jsonb NOT NULL CHECK(jsonb_typeof(receipts)='object'), source_hash text,
        PRIMARY KEY(namespace,owner))`);
      await db.query(`INSERT INTO opencrawl_onboarding_authority(namespace,source,phase) VALUES($1,$2,'object')
        ON CONFLICT DO NOTHING`, [namespace,sourceJson]);
      await phase(db);
    }).catch(error=>{schemaReady.delete(database);throw error;});
    schemaReady.set(database,preparing);
    return preparing;
  }

  async function phase(db: ApplicationTransaction, lock: ''|'FOR SHARE'|'FOR UPDATE' = ''): Promise<Phase> {
    const {rows:[authority]}=await db.query('SELECT phase,source FROM opencrawl_onboarding_authority WHERE namespace=$1 '+lock,[namespace]);
    if (!authority || !isDeepStrictEqual(authority.source,source)) throw Error('Onboarding authority binding differs');
    return authority.phase;
  }

  const ownerQuery = 'SELECT receipts, source_hash FROM opencrawl_onboarding_owners WHERE namespace=$1 AND owner=$2';
  async function adopt(db:ApplicationTransaction, owner:string):Promise<ReceiptMap> {
    authorizeOwner(owner);
    const key=[namespace,owner];
    const prior=(await db.query(ownerQuery,key)).rows[0];
    if (prior) return prior.receipts;
    const snapshot=await objects.read(owner,onboardingKinds);
    const digest=fingerprint(snapshot);
    const {rows:[inserted]}=await db.query(`INSERT INTO opencrawl_onboarding_owners(namespace,owner,receipts,source_hash)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING receipts,source_hash`,[...key,JSON.stringify(snapshot),digest]);
    const row=inserted ?? (await db.query(ownerQuery,key)).rows[0];
    if (row?.source_hash!==digest || (inserted && !isDeepStrictEqual(row.receipts,snapshot)))
      throw Error('Retained onboarding receipts differ from their import');
    return row.receipts;
  }

  const repository:OnboardingRepository={
    async read(owner,kinds) {
      authorizeOwner(owner);await ready();
      // One query for an already-adopted owner, including a missing owner after cutover.
      const {rows:[row]}=await database.pool.query(`SELECT a.phase,o.receipts FROM opencrawl_onboarding_authority a
        LEFT JOIN opencrawl_onboarding_owners o ON o.namespace=a.namespace AND o.owner=$2
        WHERE a.namespace=$1 AND a.source=$3`,[namespace,owner,sourceJson]);
      if (!row) throw Error('Onboarding authority binding differs');
      if (row.phase==='object') return objects.read(owner,kinds);
      let receipts=row.receipts as ReceiptMap | null;
      if (!receipts && row.phase==='importing') {
        receipts=await database.transaction(async db=>{
          const current=await phase(db,'FOR SHARE');
          if(current==='object')return objects.read(owner,kinds);
          return current==='importing' ? adopt(db,owner) : (await db.query(ownerQuery,[namespace,owner])).rows[0]?.receipts ?? {};
        });
      }
      const result:ReceiptMap={};
      for(const kind of kinds) if(receipts?.[kind]) result[kind]=receipts[kind];
      return result;
    },
    async write(owner,kind,value) {
      authorizeOwner(owner);validateReceipt(value);await ready();
      if(!onboardingKinds.includes(kind))throw Error('Invalid onboarding milestone');
      const result=await database.transaction(async db=>{
        const current=await phase(db,'FOR SHARE');
        if(current==='object'){
          const operation=randomUUID();
          await db.query('INSERT INTO opencrawl_onboarding_source_writes(namespace,operation,owner,kind,requested) VALUES($1,$2,$3,$4,$5)',
            [namespace,operation,owner,kind,JSON.stringify(value)]);
          return {operation};
        }
        if(current==='importing')await adopt(db,owner);
        const missingClient=kind==='mcp' && !('client' in value);
        const first=missingClient?{...value,client:null}:value;
        const {rows:[row]}=await db.query(`INSERT INTO opencrawl_onboarding_owners AS owner(namespace,owner,receipts)
          VALUES($1,$2,jsonb_build_object($3::text,$4::jsonb))
          ON CONFLICT(namespace,owner) DO UPDATE SET receipts=owner.receipts || jsonb_build_object($3::text,
            CASE WHEN $3='completed' AND owner.receipts ? 'completed' THEN owner.receipts->'completed'
                 WHEN $5 THEN $4::jsonb || jsonb_build_object('client',owner.receipts->'mcp'->'client')
                 ELSE $4::jsonb END)
          RETURNING receipts->$3::text AS value`,[namespace,owner,kind,JSON.stringify(first),missingClient]);
        return {receipt:validateReceipt(row.value)};
      });
      if(result.receipt)return result.receipt;
      // Commit the intent before dispatch. A crash or unknown write outcome
      // prevents changing authority, even if the HTTP observer timed out.
      const receipt=await objects.write(owner,kind,value);
      await database.pool.query('DELETE FROM opencrawl_onboarding_source_writes WHERE namespace=$1 AND operation=$2',[namespace,result.operation]);
      return receipt;
    },
  };

  // One operator command per namespace. HTTP readers/writers use the authority
  // row separately, so they can continue throughout the retained scan.
  async function exclusive<T>(run:()=>Promise<T>) {
    await ready();
    const client=await database.pool.connect();
    const key=namespace+':onboarding-authority';
    let locked=false,destroy=false;
    try{
      locked=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
      if(!locked)throw Error('Another onboarding storage command is running');
      return await run();
    }finally{
      try{if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);}
      catch(error){destroy=true;throw error;}
      finally{client.release(destroy);}
    }
  }

  async function retainedReceipts(owner:string) {
    const directory=prefix+'/'+owner+'/onboarding/';
    const names=new Map(onboardingKinds.map(kind=>[onboardingReceiptKey(prefix,owner,kind),kind]));
    const kinds=new Set<OnboardingKind>(), cursors=new Set<string>();
    let cursor:string|null=null;
    do{
      const page=await store.listPage(directory,{continuationToken:cursor,maxKeys:32});
      if(page.prefixes?.length)throw Error('Unexpected retained onboarding directory');
      for(const key of page.keys){
        if(key===directory)continue; // Optional S3 directory marker.
        const kind=names.get(key);
        if(!kind || kinds.has(kind))throw Error('Unexpected or repeated retained onboarding object');
        kinds.add(kind);
      }
      cursor=page.nextToken;
      if(cursor!==null){
        if(typeof cursor!=='string' || !cursor || cursors.has(cursor))throw Error('Invalid retained onboarding cursor');
        cursors.add(cursor);
      }
    }while(cursor!==null);
    const receipts=await objects.read(owner,[...kinds]);
    if(Object.keys(receipts).length!==kinds.size)throw Error('Listed onboarding receipt disappeared');
    return {owner,receipts,source_hash:fingerprint(receipts)};
  }

  async function scan(copy:boolean) {
    let owners=0,receipts=0;
    async function batch(scopes:string[]){
      // Eight directory listings and at most 48 positive GETs in flight. The
      // operator uses a single data connection beside its lifecycle lock.
      const found=(await Promise.all(scopes.map(retainedReceipts))).filter(row=>Object.keys(row.receipts).length);
      if(!found.length)return;
      await database.transaction(async db=>{
        if(copy) {
          const {rows}=await db.query(`INSERT INTO opencrawl_onboarding_owners(namespace,owner,receipts,source_hash)
            SELECT $1,s.owner,s.receipts,s.source_hash FROM jsonb_to_recordset($2) AS s(owner text,receipts jsonb,source_hash text)
            ORDER BY s.owner ON CONFLICT DO NOTHING RETURNING owner,receipts`,[namespace,JSON.stringify(found)]);
          const inserted=new Map(rows.map(row=>[row.owner,row.receipts]));
          for(const row of found)if(inserted.has(row.owner) && !isDeepStrictEqual(inserted.get(row.owner),row.receipts))
            throw Error('Onboarding receipt copy differs from its source');
        }
        const {rows}=await db.query(`SELECT owner,receipts,source_hash FROM opencrawl_onboarding_owners
          WHERE namespace=$1 AND owner=ANY($2::text[])`,[namespace,found.map(row=>row.owner)]);
        const targets=new Map(rows.map(row=>[row.owner,row]));
        for(const row of found){
          const target=targets.get(row.owner);
          if(target?.source_hash!==row.source_hash || Object.keys(row.receipts).some(kind=>!(kind in target.receipts)) ||
             row.receipts.completed && !isDeepStrictEqual(row.receipts.completed,target.receipts.completed))
            throw Error('Retained onboarding receipts differ from their import');
          owners++;receipts+=Object.keys(row.receipts).length;
        }
      });
    }
    let scopes:string[]=[];
    for await(const owner of retainedOwnerScopes(store,prefix,tenantHash)){
      scopes.push(owner);
      if(scopes.length===8){await batch(scopes);scopes=[];}
    }
    if(scopes.length)await batch(scopes);
    const {rows:[total]}=await database.pool.query(
      'SELECT count(*) FROM opencrawl_onboarding_owners WHERE namespace=$1 AND source_hash<>$2',[namespace,fingerprint({})]);
    if(Number(total.count)!==owners)throw Error('Retained onboarding owner count differs from import');
    return {owners,receipts};
  }

  async function migrate() {
    const current=await database.transaction(async db=>{
      const original=await phase(db,'FOR UPDATE');
      if(original==='object'){
        if((await db.query('SELECT 1 FROM opencrawl_onboarding_source_writes WHERE namespace=$1 LIMIT 1',[namespace])).rows.length)
          throw Error('An onboarding object write is in flight or has an uncertain outcome; retry after it settles');
        await db.query("UPDATE opencrawl_onboarding_authority SET phase='importing' WHERE namespace=$1",[namespace]);
      }
      return original;
    });
    const result=await scan(current!=='postgres');
    if(current!=='postgres')await database.pool.query("UPDATE opencrawl_onboarding_authority SET phase='postgres' WHERE namespace=$1",[namespace]);
    return {phase:'postgres' as const,...result};
  }
  async function verify(){
    if(await status()!=='postgres')throw Error('PostgreSQL onboarding authority is not active');
    return {phase:'postgres' as const,...await scan(false)};
  }

  // Recovery for a pre-migration image. All writers stay on PostgreSQL until
  // every current value has been exported and read back; retry on interruption.
  async function restore() {
    await ready();
    return database.transaction(async db=>{
      if(await phase(db,'FOR UPDATE')==='object')return {phase:'object',owners:0,receipts:0};
      let after='', owners=0, receipts=0;
      for (;;) {
        const {rows}=await db.query(`SELECT owner,receipts FROM opencrawl_onboarding_owners
          WHERE namespace=$1 AND owner>$2 ORDER BY owner LIMIT 32`,[namespace,after]);
        if(!rows.length)break;
        for(const row of rows) {
          const snapshot=row.receipts as ReceiptMap;
          for(const kind of onboardingKinds) if(snapshot[kind]) {
            await store.put(onboardingReceiptKey(prefix,row.owner,kind),Buffer.from(JSON.stringify(snapshot[kind])),'application/json');
            receipts++;
          }
          if(!isDeepStrictEqual(await objects.read(row.owner,onboardingKinds),snapshot))throw Error('Onboarding recovery readback differs');
          after=row.owner;owners++;
        }
      }
      await db.query('DELETE FROM opencrawl_onboarding_owners WHERE namespace=$1',[namespace]);
      await db.query("UPDATE opencrawl_onboarding_authority SET phase='object' WHERE namespace=$1",[namespace]);
      return {phase:'object',owners,receipts};
    });
  }
  async function status(){await ready();return database.transaction(db=>phase(db));}
  return {repository,ready,status,migrate:()=>exclusive(migrate),verify:()=>exclusive(verify),restore:()=>exclusive(restore)};
}
