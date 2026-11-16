import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {ObjectStore} from '../sessions/types.mjs';
import type {IntegrationRecord} from '../integrations/types.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
import type {ApplicationSourceIdentity} from './settings.mjs';
import {applicationDatabase,applicationStateSettings} from './settings.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {standaloneEventIdentities,type createPostgresEventIdentities} from '../sessions/postgres-identities.mjs';
import {migrateEventIdentitySource} from '../sessions/identity-migration.mjs';
import {migrateIdentitySqlite} from './identity-migration.mjs';
import {migrateRegistrySqlite} from './registry-migration.mjs';
import {canonical,openLegacySqlite,type ImportMode} from './sqlite-import.mjs';
import {createObjectMigration} from './object-migration.mjs';
import {createIntegrationCommands} from './integration-commands.mjs';
import {ensureWriteBarrierSchema} from './write-barriers.mjs';
import {finalizeIntegrationLifecycles} from './lifecycle-migration.mjs';

interface SourceEntry {key:string;domain:string;version:string|null;hash:string;bytes:number}
export interface ApplicationMigrationOptions {
  database:ApplicationDatabase;store:ObjectStore&{checkAccess():Promise<void>};source:ApplicationSourceIdentity;
  organizationId:string;url:string;secret:string;identityPath:string;registryPath:string;mode:ImportMode;
  writersStopped?:boolean;expectExisting?:boolean;connectorKey?:Uint8Array;
  eventIdentities:ReturnType<typeof createPostgresEventIdentities>;
}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const logicalHash=(value:unknown)=>sha(Buffer.isBuffer(value)?value:canonical(value));
function fail(message:string):never{throw Object.assign(new Error(message),{code:'APPLICATION_MIGRATION_UNSAFE'});}
async function filePart(path:string){
  let info;try{info=await stat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!info.isFile())fail('Legacy SQLite source must be a regular file');
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  return {bytes:info.size,hash:hash.digest('hex')};
}
async function sqliteSource(path:string,domain:'identity'|'registry'):Promise<SourceEntry&{exists:boolean}>{
  const main=await filePart(path),wal=await filePart(path+'-wal');
  if(!main&&wal)fail('Legacy SQLite WAL exists without its database; restore the complete backup');
  return {key:'sqlite:'+domain,domain,version:null,bytes:(main?.bytes??0)+(wal?.bytes??0),hash:sha(canonical({main,wal})),exists:main!==null};
}
async function registryRecords(path:string,exists:boolean):Promise<IntegrationRecord[]>{
  if(!exists)return [];
  const source=await openLegacySqlite(path);
  try{return source.prepare('SELECT record FROM integrations ORDER BY id').all().map(row=>JSON.parse(String(row.record)) as IntegrationRecord);}finally{source.close();}
}
const sourceColumns='source_key,domain,source_version,source_hash,source_bytes';
const entry=(row:Record<string,unknown>):SourceEntry=>({key:String(row.source_key),domain:String(row.domain),version:row.source_version===null?null:String(row.source_version),hash:String(row.source_hash),bytes:Number(row.source_bytes)});
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

/** Offline, restartable migration. Importers never modify source bytes. A durable
 * inventory precedes the first data write, and every target is read back before
 * readiness. Existing ready installations validate receipts without replaying
 * stale legacy snapshots over newer PostgreSQL state. */
export async function migrateApplicationState(options:ApplicationMigrationOptions){
  const {database,source,store,mode}=options,ns=database.namespace;
  if(!['check','migrate','verify'].includes(mode)||source.version!==1||source.organizationId!==options.organizationId||!/^org_[A-Za-z0-9]+$/.test(options.organizationId))fail('Invalid application migration scope');
  if(database.sourceIdentity&&!isDeepStrictEqual(database.sourceIdentity,source))fail('Database and migration source bindings differ');
  await store.checkAccess();await database.ready();
  const client=await database.pool.connect();let locked=false;
  try{
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[ns+':application-migration']);locked=true;
    const {rows}=await client.query('SELECT * FROM opencrawl_application_installations WHERE namespace=$1',[ns]);const existing=rows[0];
    if(existing&&!isDeepStrictEqual(existing.source_identity,source))fail('This application namespace is already bound to another source');
    if(existing?.state==='ready')return {mode,...await readyReceipt(client,ns,source),alreadyReady:true};
    if(!existing)await assertUnboundTargetEmpty(client,database);
    const identity=await sqliteSource(options.identityPath,'identity'),registry=await sqliteSource(options.registryPath,'registry');
    const identityOptions={database,path:options.identityPath,organizationId:options.organizationId,url:options.url,secret:options.secret};
    const registryOptions={database,path:options.registryPath,organizationId:options.organizationId};
    if(identity.exists)await migrateIdentitySqlite({...identityOptions,mode:'check'});
    if(registry.exists)await migrateRegistrySqlite({...registryOptions,mode:'check'});
    const records=await registryRecords(options.registryPath,registry.exists);
    const objects=createObjectMigration({database,store,prefix:source.prefix,organizationId:options.organizationId,registryRecords:records,connectorKey:options.connectorKey,eventIdentities:options.eventIdentities});
    await objects.ready();
    await client.query(`CREATE TEMP TABLE oc_application_migration_scan(source_key text PRIMARY KEY,domain text NOT NULL,source_version text,source_hash text NOT NULL,source_bytes bigint NOT NULL,verified boolean NOT NULL DEFAULT false) ON COMMIT PRESERVE ROWS`);
    const add=async(value:SourceEntry)=>{await client.query('INSERT INTO oc_application_migration_scan(source_key,domain,source_version,source_hash,source_bytes) VALUES($1,$2,$3,$4,$5)',[value.key,value.domain,value.version,value.hash,value.bytes]);};
    await add(identity);await add(registry);
    let scopedObjects=0,mutableObjects=0;const listedKeys=createHash('sha256');
    // Overlapping roots are removed, so each source key enters the inventory once.
    const roots=[...new Set(objects.roots)].sort().filter((root,_,all)=>!all.some(other=>other!==root&&root.startsWith(other)));
    for(const root of roots){let cursor:string|undefined;const seen=new Set<string>();
      for(;;){const page=await store.listPage(root,{maxKeys:1000,continuationToken:cursor});
        for(const key of page.keys){if(!key.startsWith(root))fail('Object listing escaped its source prefix');listedKeys.update(canonical([root,key])+'\n');if(key.startsWith(source.prefix+'/'))scopedObjects++;
          const classification=objects.classify(key);if(!classification)continue;
          const raw=await store.readVersion(key,{maxBytes:classification.maxBytes});if(!raw.data)fail('Source object disappeared during migration inventory');
          const result=await objects.process(key,raw.data,{write:false});
          if(!existing?.inventory_complete&&result.target!==null&&logicalHash(result.source)!==logicalHash(result.target))fail('Existing PostgreSQL state conflicts with a legacy source object');
          await add({key,domain:classification.domain,version:raw.version===null?null:String(raw.version),hash:sha(raw.data),bytes:raw.data.length});mutableObjects++;
        }
        if(!page.nextToken)break;if(page.nextToken===cursor||seen.has(page.nextToken))fail('Source listing did not advance');seen.add(page.nextToken);cursor=page.nextToken;
      }
    }
    const initial=await manifestHash(client,ns,true),initialKeys=listedKeys.digest('hex');
    if(existing?.inventory_complete){
      const saved=await manifestHash(client,ns);if(saved.hash!==initial.hash||saved.hash!==existing.source_manifest_hash)fail('Legacy source changed after migration started; restore the retained recovery point');
    }
    const fresh=!identity.exists&&!registry.exists&&!mutableObjects&&!scopedObjects;
    if(fresh&&options.expectExisting)fail('Expected an existing installation but its retained databases and objects are missing; verify mounts and restore the matched backup');
    if(!identity.exists&&!fresh)fail('An existing installation has no legacy identity database; restore the complete installation backup');
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
    async function receipt(value:SourceEntry,target:unknown,importedRows:number){
      const targetHash=logicalHash(target);
      await client.query(`INSERT INTO opencrawl_application_migrations(namespace,domain,source_key,source_version,source_hash,target_hash,imported_rows) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[ns,value.domain,value.key,value.version,value.hash,targetHash,importedRows]);
      const {rows}=await client.query('SELECT source_hash,target_hash,source_version,imported_rows FROM opencrawl_application_migrations WHERE namespace=$1 AND domain=$2 AND source_key=$3',[ns,value.domain,value.key]);
      if(rows[0]?.source_hash!==value.hash||rows[0].target_hash!==targetHash||rows[0].source_version!==value.version||Number(rows[0].imported_rows)!==importedRows)fail('Migration receipt conflicts with previously imported data');
    }
    if(mode==='migrate')await migrateEventIdentitySource({store,prefix:source.prefix,eventIdentities:options.eventIdentities});
    for(const input of [identity,registry]){
      if(input.exists){const report=input.domain==='identity'?await migrateIdentitySqlite({...identityOptions,mode}):await migrateRegistrySqlite({...registryOptions,mode});
        if(!report.verified)fail('SQLite migration target verification failed');
        await receipt(input,report.tables.map(table=>({table:table.table,target:table.target})),report.tables.reduce((total,table)=>total+(table.target?.rows??0),0));
      }else await receipt(input,[],0);
    }
    let after='';
    for(;;){const {rows}=await client.query(`SELECT ${sourceColumns} FROM oc_application_migration_scan WHERE domain NOT IN ('identity','registry') AND source_key COLLATE "C">$1 ORDER BY source_key COLLATE "C" LIMIT 100`,[after]);
      for(const row of rows){const value=entry(row),classification=objects.classify(value.key)!;
        const raw=await store.readVersion(value.key,{maxBytes:classification.maxBytes});if(!raw.data||sha(raw.data)!==value.hash||String(raw.version)!==String(value.version))fail('Source object changed after inventory');
        const result=await objects.process(value.key,raw.data,{write:mode==='migrate'});
        if(result.target===null||logicalHash(result.source)!==logicalHash(result.target))fail('Imported object did not verify against its PostgreSQL target');
        await receipt(value,result.target,result.rows);
      }
      if(rows.length<100)break;after=rows.at(-1)!.source_key;
    }
    // Read-only source and target pass after every import, including a fresh list
    // to detect added or removed keys and exact SQLite/WAL hashes.
    const currentIdentity=await sqliteSource(options.identityPath,'identity'),currentRegistry=await sqliteSource(options.registryPath,'registry');
    if(currentIdentity.hash!==identity.hash||currentRegistry.hash!==registry.hash)fail('Legacy SQLite bytes changed during migration');
    if(identity.exists)await migrateIdentitySqlite({...identityOptions,mode:'verify'});
    if(registry.exists)await migrateRegistrySqlite({...registryOptions,mode:'verify'});
    let verifiedObjects=0;const verifiedKeys=createHash('sha256');
    for(const root of roots){let cursor:string|undefined;const seen=new Set<string>();
      for(;;){const page=await store.listPage(root,{maxKeys:1000,continuationToken:cursor});
        for(const key of page.keys){if(!key.startsWith(root))fail('Object verification listing escaped its source prefix');verifiedKeys.update(canonical([root,key])+'\n');const classification=objects.classify(key);if(!classification)continue;
          const expected=await client.query(`UPDATE oc_application_migration_scan SET verified=true WHERE source_key=$1 AND NOT verified RETURNING ${sourceColumns}`,[key]);if(!expected.rows[0])fail('A mutable source object appeared or was listed twice during migration');const value=entry(expected.rows[0]);
          const raw=await store.readVersion(key,{maxBytes:classification.maxBytes});if(!raw.data||sha(raw.data)!==value.hash||String(raw.version)!==String(value.version))fail('A mutable source object changed during verification');
          const result=await objects.process(key,raw.data,{write:false});if(result.target===null||logicalHash(result.source)!==logicalHash(result.target))fail('Final PostgreSQL readback differs from source');verifiedObjects++;
        }
        if(!page.nextToken)break;if(page.nextToken===cursor||seen.has(page.nextToken))fail('Source verification listing did not advance');seen.add(page.nextToken);cursor=page.nextToken;
      }
    }
    if(verifiedObjects!==mutableObjects||verifiedKeys.digest('hex')!==initialKeys)fail('Source inventory changed during final verification');
    const commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey:options.connectorKey});
    await commands.ready();await ensureWriteBarrierSchema(database);
    await client.query('BEGIN');let lifecycle;
    try{
      await readyReceipt(client,ns,source,true);
      lifecycle=await finalizeIntegrationLifecycles({client,namespace:ns,environment:'selfhost',organizationId:options.organizationId,records,commands:commands.transactional});
      await client.query("UPDATE opencrawl_application_installations SET state='ready',verified_at=now() WHERE namespace=$1 AND state='importing'",[ns]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    const {commands:queued,...transitionCounts}=lifecycle;
    return {mode,...await readyReceipt(client,ns,source),fresh,mutableObjects,alreadyReady:false,lifecycle:{...transitionCounts,queued:queued.length}};
  }finally{
    // A dedicated session owns the advisory lock and temporary inventory. Never
    // return that session to the pool with a held lock or leftover source table.
    let destroy=false;
    try{await client.query('DROP TABLE IF EXISTS pg_temp.oc_application_migration_scan');if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[ns+':application-migration']);}catch{destroy=true;}
    client.release(destroy);
  }
}

async function main(){
  const [operation,...flags]=process.argv.slice(2);if(!['check','migrate','verify'].includes(operation)||flags.some(flag=>!['--writers-stopped','--expect-existing'].includes(flag)))throw new Error('Usage: node dist/src/state/migrate.mjs check|migrate|verify [--writers-stopped] [--expect-existing]');
  const env=process.env,settings=applicationStateSettings(env),database=applicationDatabase(env),{store}=sessionStorage(env),eventIdentities=standaloneEventIdentities(store,env);
  try{
    const required=(name:string)=>{const value=env[name];if(!value)throw new Error(name+' is required');return value;};
    const key=env.OPENCRAWL_CONNECTOR_KEY?Buffer.from(env.OPENCRAWL_CONNECTOR_KEY,'base64'):undefined;if(key&&key.length!==32)throw new Error('Invalid connector encryption key');
    const result=await migrateApplicationState({database,store,eventIdentities,source:settings.source,mode:operation as ImportMode,organizationId:required('OPENCRAWL_ORGANIZATION_ID'),url:required('OPENCRAWL_URL'),secret:required('OPENCRAWL_AUTH_SECRET'),identityPath:settings.identityPath,registryPath:settings.registryPath,connectorKey:key,writersStopped:flags.includes('--writers-stopped'),expectExisting:flags.includes('--expect-existing')});
    console.log(JSON.stringify({event:'application_state_migration',...result}));
  }finally{await Promise.all([database.close(),eventIdentities.close()]);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main().catch(error=>{
  console.error(JSON.stringify({event:'application_state_migration_failed',code:(error as {code?:string}).code==='APPLICATION_MIGRATION_UNSAFE'?'APPLICATION_MIGRATION_UNSAFE':'APPLICATION_MIGRATION_FAILED',message:(error as {code?:string}).code==='APPLICATION_MIGRATION_UNSAFE'?(error as Error).message:'Migration validation or storage access failed; keep writers stopped and retain the recovery backup.'}));process.exitCode=1;
});
