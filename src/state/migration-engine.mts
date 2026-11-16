import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import type {ApplicationSourceIdentity} from './settings.mjs';
import {canonical,type ImportMode} from './sqlite-import.mjs';
import {createPostgresIndexingReceipts,importSessionReceiptBatch,readSessionReceiptBatch,validateSessionReceiptImport,MIGRATION_RECEIPT_BATCH_SIZE,type SessionReceiptImport} from './indexing-receipts.mjs';
export type {SessionIndexingReceipt,SessionReceiptImport} from './indexing-receipts.mjs';

export interface MigrationSource {key:string;domain:string;version:string|null;hash:string;bytes:number}
export interface MigrationReadback {source:unknown;target:unknown|null;rows:number}
type MigrationEntry={entry:MigrationSource;readback:MigrationReadback}|{entry:MigrationSource;sessionReceipt:SessionReceiptImport};
export type MigrationOperation=
  | {entry:MigrationSource;readback:MigrationReadback;migrate():Promise<MigrationReadback>}
  | {entry:MigrationSource;sessionReceipt:SessionReceiptImport};
export type MigrationInventoryItem=
  | (MigrationEntry&{legacy:boolean;mutableObject?:boolean})
  | {retainedKey:string;legacy:boolean};
export interface MigrationSources<Result extends object> {
  /** Every listed key contributes to the full snapshot, including immutable raw
   * data. Mutable entries also carry a strict typed source/target comparison. */
  inventory():AsyncIterable<MigrationInventoryItem>;
  validateInventory(fresh:boolean):Promise<void>;
  read(entry:MigrationSource):Promise<MigrationOperation>;
  /** Only contiguous session-indexing entries use this bounded ordered reader.
   * Every returned descriptor is checked before any operation in its page. */
  readMany?(entries:readonly MigrationSource[]):Promise<MigrationOperation[]>;
  beforeImport?():Promise<void>;
  prepareFinalization?():Promise<void>;
  /** Desired commands and readiness commit in this same transaction. */
  finalize(client:PoolClient):Promise<Result>;
}
export interface ApplicationMigrationEngineOptions<Result extends object> {
  database:ApplicationDatabase;source:ApplicationSourceIdentity;mode:ImportMode;
  writersStopped?:boolean;expectExisting?:boolean;expectedManifest?:string;
  /** Reviewed adapter inputs whose exact hashes must also match on ready reruns. */
  boundInputs?:readonly {key:string;hash:string}[];
  checkAccess():Promise<void>;
  sources():Promise<MigrationSources<Result>>;
}
export const migrationHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const migrationLogicalHash=(value:unknown)=>migrationHash(Buffer.isBuffer(value)?value:canonical(value));
function fail(message:string):never{throw Object.assign(new Error(message),{code:'APPLICATION_MIGRATION_UNSAFE'});}
const sourceColumns='source_key,domain,source_version,source_hash,source_bytes';
const entry=(row:Record<string,unknown>):MigrationSource=>({key:String(row.source_key),domain:String(row.domain),version:row.source_version===null?null:String(row.source_version),hash:String(row.source_hash),bytes:Number(row.source_bytes)});
async function assertUnboundTargetEmpty(client:PoolClient,database:ApplicationDatabase){
  const {rows}=await client.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='namespace' AND table_name LIKE 'opencrawl_%' ORDER BY table_name");
  for(const {table_name:name} of rows){
    // Event identities already lived in PostgreSQL before this release. Their
    // matching source/database UUID is checked by that domain's offline reader.
    if(!/^opencrawl_[a-z_]+$/.test(name)||name.startsWith('opencrawl_event_identit'))continue;
    const exists=await client.query(`SELECT 1 FROM "${name}" WHERE namespace=$1 LIMIT 1`,[database.namespace]);
    if(exists.rowCount)fail('Unbound PostgreSQL application data conflicts with migration; use an empty namespace or restore its original binding');
  }
  const tables=await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[database.identitySchema]);
  for(const {tablename:name} of tables.rows){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))fail('Unknown identity table requires a reviewed migration');
    if((await client.query(`SELECT 1 FROM "${database.identitySchema}"."${name}" LIMIT 1`)).rowCount)fail('Unbound PostgreSQL identity data conflicts with migration; restore its original binding');
  }
}
async function manifestHash(client:PoolClient,namespace:string,temporary=false){
  const hash=createHash('sha256');let after='';let count=0;
  for(;;){const {rows}=await client.query(`SELECT ${sourceColumns} FROM ${temporary?'oc_application_migration_scan':'opencrawl_application_migration_sources'} WHERE ${temporary?'':'namespace=$1 AND '}source_key COLLATE "C">$${temporary?1:2} ORDER BY source_key COLLATE "C" LIMIT 256`,temporary?[after]:[namespace,after]);
    for(const row of rows){hash.update(canonical(entry(row))+'\n');count++;}if(rows.length<256)break;after=rows.at(-1)!.source_key;
  }
  return {hash:hash.digest('hex'),count};
}
async function readyReceipt(client:PoolClient,namespace:string,source:ApplicationSourceIdentity,allowImporting=false){
  const {rows}=await client.query('SELECT * FROM opencrawl_application_installations WHERE namespace=$1',[namespace]);const installation=rows[0];
  if(!installation||!isDeepStrictEqual(installation.source_identity,source))fail('Application-state source binding differs; restore or use a reviewed migration');
  if(!installation.inventory_complete||!allowImporting&&(installation.state!=='ready'||!installation.verified_at))fail('Application-state migration is incomplete; keep writers stopped');
  const manifest=await manifestHash(client,namespace);
  if(manifest.hash!==installation.source_manifest_hash)fail('Application-state source manifest is incomplete or changed');
  const {rows:coverage}=await client.query(`SELECT count(*) AS missing FROM opencrawl_application_migration_sources s LEFT JOIN opencrawl_application_migrations m ON m.namespace=s.namespace AND m.source_key=s.source_key AND m.domain=s.domain WHERE s.namespace=$1 AND (m.source_key IS NULL OR m.source_hash<>s.source_hash OR m.source_version IS DISTINCT FROM s.source_version OR m.target_hash !~ '^[a-f0-9]{64}$')`,[namespace]);
  const {rows:extra}=await client.query(`SELECT count(*) AS extra FROM opencrawl_application_migrations m LEFT JOIN opencrawl_application_migration_sources s ON s.namespace=m.namespace AND s.source_key=m.source_key AND s.domain=m.domain WHERE m.namespace=$1 AND s.source_key IS NULL`,[namespace]);
  if(Number(coverage[0].missing)||Number(extra[0].extra))fail('Application-state migration receipts do not cover the source manifest');
  return {migrationId:String(installation.migration_id),sources:manifest.count,manifest:manifest.hash,ready:true};
}

async function boundInputsMatch(client:PoolClient,namespace:string,inputs:readonly {key:string;hash:string}[]){
  for(const input of inputs){
    const {rows}=await client.query('SELECT source_hash FROM opencrawl_application_migration_sources WHERE namespace=$1 AND source_key=$2',[namespace,input.key]);
    if(rows[0]?.source_hash!==input.hash)fail('Reviewed migration input differs from its original binding');
  }
}
function sameSource(a:MigrationSource,b:MigrationSource){return a.key===b.key&&a.domain===b.domain&&a.version===b.version&&a.hash===b.hash&&a.bytes===b.bytes;}
function validSource(value:MigrationSource){
  if(!value.key||value.key.includes('\0')||!value.domain||value.domain.includes('\0')||!Number.isSafeInteger(value.bytes)||value.bytes<0||!/^[a-f0-9]{64}$/.test(value.hash)||value.version!==null&&typeof value.version!=='string')fail('Invalid migration source descriptor');
}
function validReadback(value:MigrationReadback){if(!Number.isSafeInteger(value.rows)||value.rows<0)fail('Invalid migration target row count');}
type SessionEntry={entry:MigrationSource;sessionReceipt:SessionReceiptImport};
function validSessionEntry(item:SessionEntry){
  validSource(item.entry);
  if(item.entry.domain!=='session-indexing'||item.entry.bytes>32768)fail('Invalid session receipt migration domain');
  validateSessionReceiptImport(item.sessionReceipt);
}
function scanRows(items:readonly SessionEntry[]){return JSON.stringify(items.map(({entry:value})=>({source_key:value.key,domain:value.domain,source_version:value.version,source_hash:value.hash,source_bytes:value.bytes})));}
function uniqueSessionBatch(items:readonly SessionEntry[]){
  if(!items.length||items.length>MIGRATION_RECEIPT_BATCH_SIZE||new Set(items.map(item=>item.entry.key)).size!==items.length)fail('Invalid session receipt migration batch');
  for(const item of items)validSessionEntry(item);
}

/** One offline engine owns locking, snapshot inventory, resumable receipts and
 * final readiness for every runtime. Adapters only interpret their own sources. */
export async function migrateApplicationSources<Result extends object>(options:ApplicationMigrationEngineOptions<Result>){
  const {database,source,mode}=options,ns=database.namespace,inputs=options.boundInputs??[];
  if(!['check','migrate','verify'].includes(mode)||source.version!==1)fail('Invalid application migration scope');
  if(database.sourceIdentity&&!isDeepStrictEqual(database.sourceIdentity,source))fail('Database and migration source bindings differ');
  if(options.expectedManifest!==undefined&&!/^[a-f0-9]{64}$/.test(options.expectedManifest))fail('Invalid expected migration manifest');
  if(new Set(inputs.map(value=>value.key)).size!==inputs.length||inputs.some(value=>!value.key||!/^[a-f0-9]{64}$/.test(value.hash)))fail('Invalid reviewed migration input binding');
  await options.checkAccess();await database.ready();
  const client=await database.pool.connect();let locked=false;
  try{
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[ns+':application-migration']);locked=true;
    const {rows}=await client.query('SELECT * FROM opencrawl_application_installations WHERE namespace=$1',[ns]);const existing=rows[0];
    if(existing&&!isDeepStrictEqual(existing.source_identity,source))fail('This application namespace is already bound to another source');
    if(existing?.state==='ready'){
      const receipt=await readyReceipt(client,ns,source);
      if(options.expectedManifest&&receipt.manifest!==options.expectedManifest)fail('Migration manifest differs from the retained backup');
      await boundInputsMatch(client,ns,inputs);
      return {mode,...receipt,alreadyReady:true};
    }
    if(!existing)await assertUnboundTargetEmpty(client,database);
    const sources=await options.sources();
    await client.query(`CREATE TEMP TABLE oc_application_migration_scan(source_key text PRIMARY KEY,domain text NOT NULL,source_version text,source_hash text NOT NULL,source_bytes bigint NOT NULL,verified boolean NOT NULL DEFAULT false) ON COMMIT PRESERVE ROWS`);
    let fresh=true,mutableObjects=0;const listedKeys=createHash('sha256');
    let initialBatch:SessionEntry[]=[];
    async function readSessionTargets(items:readonly SessionEntry[],allowMissing=false){
      uniqueSessionBatch(items);
      try{return await readSessionReceiptBatch(client,ns,items.map(item=>item.sessionReceipt));}
      catch(error){if(allowMissing&&(error as {code?:string}).code==='42P01')return new Map<string,unknown>();throw error;}
    }
    async function flushInitial(){
      if(!initialBatch.length)return;
      const batch=initialBatch,targets=await readSessionTargets(batch,true);
      if(!existing?.inventory_complete)for(const item of batch){const target=targets.get(item.sessionReceipt.key);if(target!==undefined&&migrationLogicalHash(target)!==migrationLogicalHash(item.sessionReceipt.value))fail('Existing PostgreSQL state conflicts with a legacy source object');}
      await client.query(`INSERT INTO oc_application_migration_scan(${sourceColumns}) SELECT source_key,domain,source_version,source_hash,source_bytes FROM jsonb_to_recordset($1::jsonb) AS x(source_key text,domain text,source_version text,source_hash text,source_bytes bigint)`,[scanRows(batch)]);
      initialBatch=[];
    }
    for await(const item of sources.inventory()){
      if(item.legacy)fresh=false;
      if('retainedKey' in item){listedKeys.update(canonical(item.retainedKey)+'\n');continue;}
      const value=item.entry;validSource(value);
      if(item.mutableObject)mutableObjects++;
      if('sessionReceipt' in item){validSessionEntry(item);initialBatch.push(item);if(initialBatch.length===MIGRATION_RECEIPT_BATCH_SIZE)await flushInitial();continue;}
      await flushInitial();validReadback(item.readback);
      if(!existing?.inventory_complete&&item.readback.target!==null&&migrationLogicalHash(item.readback.source)!==migrationLogicalHash(item.readback.target))fail('Existing PostgreSQL state conflicts with a legacy source object');
      await client.query('INSERT INTO oc_application_migration_scan(source_key,domain,source_version,source_hash,source_bytes) VALUES($1,$2,$3,$4,$5)',[value.key,value.domain,value.version,value.hash,value.bytes]);
    }
    await flushInitial();
    const initial=await manifestHash(client,ns,true),initialKeys=listedKeys.digest('hex');
    if(options.expectedManifest&&initial.hash!==options.expectedManifest)fail('Migration manifest differs from the retained backup');
    if(existing?.inventory_complete){const saved=await manifestHash(client,ns);if(saved.hash!==initial.hash||saved.hash!==existing.source_manifest_hash)fail('Legacy source changed after migration started; restore the retained recovery point');}
    if(fresh&&options.expectExisting)fail('Expected an existing installation but its retained databases and objects are missing; verify mounts and restore the matched backup');
    await sources.validateInventory(fresh);
    for(const input of inputs){const {rows}=await client.query('SELECT source_hash FROM oc_application_migration_scan WHERE source_key=$1',[input.key]);if(rows[0]?.source_hash!==input.hash)fail('Reviewed migration input is missing from its source inventory');}
    if(mode==='check')return {mode,ready:false,fresh,sources:initial.count,mutableObjects,manifest:initial.hash,requiresStoppedWriters:!fresh};
    if(!fresh&&!options.writersStopped)fail('Existing installation migration requires --writers-stopped after stopping every old app, worker and migration job');
    if(mode==='verify'&&!existing?.inventory_complete)fail('No completed migration inventory exists; run migrate while writers are stopped');
    if(!existing)await client.query(`INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state) VALUES($1,$2::jsonb,$3,'importing')`,[ns,JSON.stringify(source),randomUUID()]);
    if(!existing?.inventory_complete){
      await client.query('BEGIN');try{
        const count=await client.query('SELECT count(*) AS n FROM opencrawl_application_migrations WHERE namespace=$1',[ns]);if(Number(count.rows[0].n))fail('An incomplete inventory already has import receipts; restore before continuing');
        await client.query('DELETE FROM opencrawl_application_migration_sources WHERE namespace=$1',[ns]);
        await client.query(`INSERT INTO opencrawl_application_migration_sources(namespace,${sourceColumns}) SELECT $1,${sourceColumns} FROM oc_application_migration_scan`,[ns]);
        await client.query('UPDATE opencrawl_application_installations SET inventory_complete=true,source_manifest_hash=$2 WHERE namespace=$1',[ns,initial.hash]);await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
    }
    async function receipt(value:MigrationSource,readback:MigrationReadback){
      validReadback(readback);
      if(readback.target===null||migrationLogicalHash(readback.source)!==migrationLogicalHash(readback.target))fail('Imported source did not verify against its PostgreSQL target');
      const targetHash=migrationLogicalHash(readback.target);
      await client.query(`INSERT INTO opencrawl_application_migrations(namespace,domain,source_key,source_version,source_hash,target_hash,imported_rows) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[ns,value.domain,value.key,value.version,value.hash,targetHash,readback.rows]);
      const {rows}=await client.query('SELECT source_hash,target_hash,source_version,imported_rows FROM opencrawl_application_migrations WHERE namespace=$1 AND domain=$2 AND source_key=$3',[ns,value.domain,value.key]);
      if(rows[0]?.source_hash!==value.hash||rows[0].target_hash!==targetHash||rows[0].source_version!==value.version||Number(rows[0].imported_rows)!==readback.rows)fail('Migration receipt conflicts with previously imported data');
    }
    const importing=(await client.query('SELECT migration_id FROM opencrawl_application_installations WHERE namespace=$1 AND state=$2',[ns,'importing'])).rows[0];
    if(!importing)fail('Application migration is no longer importing');
    let receiptSchemaReady=false;
    async function importBatch(batch:readonly SessionEntry[]){
      uniqueSessionBatch(batch);
      if(mode==='migrate'&&!receiptSchemaReady){await createPostgresIndexingReceipts(database).ready();receiptSchemaReady=true;}
      await client.query('BEGIN');
      try{
        const current=await client.query('SELECT migration_id FROM opencrawl_application_installations WHERE namespace=$1 AND state=$2 FOR UPDATE',[ns,'importing']);
        if(current.rows[0]?.migration_id!==importing.migration_id)fail('Application migration identity changed');
        const targets=mode==='migrate'?await importSessionReceiptBatch(client,ns,batch.map(item=>item.sessionReceipt)):await readSessionTargets(batch);
        const values=batch.map(item=>{
          const target=targets.get(item.sessionReceipt.key);
          if(target===undefined)fail('Imported source did not verify against its PostgreSQL target');
          const targetHash=migrationLogicalHash(target);
          if(targetHash!==migrationLogicalHash(item.sessionReceipt.value))fail('Imported source did not verify against its PostgreSQL target');
          return {domain:item.entry.domain,source_key:item.entry.key,source_version:item.entry.version,source_hash:item.entry.hash,target_hash:targetHash,imported_rows:1};
        });
        await client.query(`INSERT INTO opencrawl_application_migrations(namespace,domain,source_key,source_version,source_hash,target_hash,imported_rows) SELECT $1,x.domain,x.source_key,x.source_version,x.source_hash,x.target_hash,x.imported_rows FROM jsonb_to_recordset($2::jsonb) AS x(domain text,source_key text,source_version text,source_hash text,target_hash text,imported_rows bigint) ON CONFLICT DO NOTHING`,[ns,JSON.stringify(values)]);
        const {rows}=await client.query('SELECT domain,source_key,source_version,source_hash,target_hash,imported_rows FROM opencrawl_application_migrations WHERE namespace=$1 AND source_key=ANY($2::text[])',[ns,values.map(value=>value.source_key)]);
        if(rows.length!==values.length)fail('Migration receipt conflicts with previously imported data');
        const found=new Map(rows.map(row=>[row.source_key,row]));
        for(const value of values){const actual=found.get(value.source_key);if(!actual||actual.domain!==value.domain||actual.source_version!==value.source_version||actual.source_hash!==value.source_hash||actual.target_hash!==value.target_hash||Number(actual.imported_rows)!==value.imported_rows)fail('Migration receipt conflicts with previously imported data');}
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}
    }
    if(mode==='migrate')await sources.beforeImport?.();
    let after='';
    for(;;){const {rows}=await client.query(`SELECT ${sourceColumns} FROM oc_application_migration_scan WHERE source_key COLLATE "C">$1 ORDER BY source_key COLLATE "C" LIMIT 100`,[after]);
      for(let offset=0;offset<rows.length;){
        const expected=[entry(rows[offset++])];
        if(expected[0].domain==='session-indexing')while(offset<rows.length&&rows[offset].domain==='session-indexing')expected.push(entry(rows[offset++]));
        const operations=expected[0].domain==='session-indexing'&&sources.readMany?await sources.readMany(expected):await (async()=>{const read:MigrationOperation[]=[];for(const value of expected)read.push(await sources.read(value));return read;})();
        if(operations.length!==expected.length)fail('Migration batch reader returned incomplete coverage');
        for(let index=0;index<expected.length;index++){const operation=operations[index];validSource(operation.entry);if(!sameSource(expected[index],operation.entry))fail('Source changed after inventory');if('sessionReceipt' in operation)validSessionEntry(operation);}
        let batch:SessionEntry[]=[];
        for(const operation of operations){
          if('sessionReceipt' in operation){batch.push(operation);continue;}
          if(batch.length){await importBatch(batch);batch=[];}
          await receipt(operation.entry,mode==='migrate'?await operation.migrate():operation.readback);
        }
        if(batch.length)await importBatch(batch);
      }
      if(rows.length<100)break;after=rows.at(-1)!.source_key;
    }
    let verified=0;const verifiedKeys=createHash('sha256');let finalBatch:SessionEntry[]=[];
    async function flushFinal(){
      if(!finalBatch.length)return;
      const batch=finalBatch,targets=await readSessionTargets(batch);
      const {rows}=await client.query(`UPDATE oc_application_migration_scan SET verified=true WHERE source_key=ANY($1::text[]) AND NOT verified RETURNING ${sourceColumns}`,[batch.map(item=>item.entry.key)]);
      if(rows.length!==batch.length)fail('A source appeared or was listed twice during migration');
      const found=new Map(rows.map(row=>[row.source_key,entry(row)]));
      for(const item of batch){
        const expected=found.get(item.entry.key);if(!expected||!sameSource(item.entry,expected))fail('A source changed during verification');
        const target=targets.get(item.sessionReceipt.key);if(target===undefined||migrationLogicalHash(target)!==migrationLogicalHash(item.sessionReceipt.value))fail('Final PostgreSQL readback differs from source');
      }
      verified+=batch.length;finalBatch=[];
    }
    for await(const item of sources.inventory()){
      if('retainedKey' in item){verifiedKeys.update(canonical(item.retainedKey)+'\n');continue;}
      const value=item.entry;validSource(value);
      if('sessionReceipt' in item){validSessionEntry(item);finalBatch.push(item);if(finalBatch.length===MIGRATION_RECEIPT_BATCH_SIZE)await flushFinal();continue;}
      await flushFinal();validReadback(item.readback);
      const expected=await client.query(`UPDATE oc_application_migration_scan SET verified=true WHERE source_key=$1 AND NOT verified RETURNING ${sourceColumns}`,[value.key]);
      if(!expected.rows[0])fail('A source appeared or was listed twice during migration');
      if(!sameSource(value,entry(expected.rows[0])))fail('A source changed during verification');
      if(item.readback.target===null||migrationLogicalHash(item.readback.source)!==migrationLogicalHash(item.readback.target))fail('Final PostgreSQL readback differs from source');verified++;
    }
    await flushFinal();
    if(verified!==initial.count||verifiedKeys.digest('hex')!==initialKeys)fail('Source inventory changed during final verification');
    await sources.prepareFinalization?.();
    await client.query('BEGIN');let result:Result;
    try{
      await readyReceipt(client,ns,source,true);await boundInputsMatch(client,ns,inputs);
      result=await sources.finalize(client);
      await client.query("UPDATE opencrawl_application_installations SET state='ready',verified_at=now() WHERE namespace=$1 AND state='importing'",[ns]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    return {mode,...await readyReceipt(client,ns,source),fresh,mutableObjects,alreadyReady:false,...result};
  }finally{
    let destroy=false;
    try{await client.query('DROP TABLE IF EXISTS pg_temp.oc_application_migration_scan');if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[ns+':application-migration']);}catch{destroy=true;}
    client.release(destroy);
  }
}
