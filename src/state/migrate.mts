import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
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

import {migrateApplicationSources,type MigrationSource,type MigrationReadback,type MigrationInventoryItem} from './migration-engine.mjs';
export interface ApplicationMigrationOptions {
  database:ApplicationDatabase;store:ObjectStore&{checkAccess():Promise<void>};source:ApplicationSourceIdentity;
  organizationId:string;url:string;secret:string;identityPath:string;registryPath:string;mode:ImportMode;
  writersStopped?:boolean;expectExisting?:boolean;connectorKey?:Uint8Array;
  eventIdentities:ReturnType<typeof createPostgresEventIdentities>;
}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fail(message:string):never{throw Object.assign(new Error(message),{code:'APPLICATION_MIGRATION_UNSAFE'});}
async function filePart(path:string){
  let info;try{info=await stat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!info.isFile())fail('Legacy SQLite source must be a regular file');
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  return {bytes:info.size,hash:hash.digest('hex')};
}
async function sqliteSource(path:string,domain:'identity'|'registry'):Promise<MigrationSource&{exists:boolean}>{
  const main=await filePart(path),wal=await filePart(path+'-wal');
  if(!main&&wal)fail('Legacy SQLite WAL exists without its database; restore the complete backup');
  return {key:'sqlite:'+domain,domain,version:null,bytes:(main?.bytes??0)+(wal?.bytes??0),hash:sha(canonical({main,wal})),exists:main!==null};
}
async function registryRecords(path:string,exists:boolean):Promise<IntegrationRecord[]>{
  if(!exists)return [];
  const source=await openLegacySqlite(path);
  try{return source.prepare('SELECT record FROM integrations ORDER BY id').all().map(row=>JSON.parse(String(row.record)) as IntegrationRecord);}finally{source.close();}
}
/** Strict single-organization adapter over the common migration engine. */
export async function migrateApplicationState(options:ApplicationMigrationOptions){
  const {database,source,store}=options;
  if(source.organizationId!==options.organizationId||!/^org_[A-Za-z0-9]+$/.test(options.organizationId))fail('Invalid application migration scope');
  return migrateApplicationSources({...options,checkAccess:()=>store.checkAccess(),sources:async()=>{
    const identity=await sqliteSource(options.identityPath,'identity'),registry=await sqliteSource(options.registryPath,'registry');
    const identityOptions={database,path:options.identityPath,organizationId:options.organizationId,url:options.url,secret:options.secret};
    const registryOptions={database,path:options.registryPath,organizationId:options.organizationId};
    const records=await registryRecords(options.registryPath,registry.exists);
    const objects=createObjectMigration({database,store,prefix:source.prefix,organizationId:options.organizationId,registryRecords:records,connectorKey:options.connectorKey,eventIdentities:options.eventIdentities});
    await objects.ready();
    const roots=[...new Set(objects.roots)].sort().filter((root,_,all)=>!all.some(other=>other!==root&&root.startsWith(other)));
    async function sqliteRead(input:typeof identity,mode:ImportMode):Promise<MigrationReadback>{
      if(!input.exists)return {source:[],target:[],rows:0};
      const report=input.domain==='identity'?await migrateIdentitySqlite({...identityOptions,mode}):await migrateRegistrySqlite({...registryOptions,mode});
      return {source:report.tables.map(table=>({table:table.table,target:table.source})),
        target:report.tables.some(table=>table.target===null)?null:report.tables.map(table=>({table:table.table,target:table.target})),
        rows:report.tables.reduce((total,table)=>total+(table.target?.rows??0),0)};
    }
    async function objectRead(key:string){
      const classification=objects.classify(key);if(!classification)fail('Mutable source no longer has a migration classification');
      const raw=await store.readVersion(key,{maxBytes:classification.maxBytes});if(!raw.data)fail('Source object disappeared during migration inventory');
      const bytes=raw.data;
      return {entry:{key,domain:classification.domain,version:raw.version===null?null:String(raw.version),hash:sha(bytes),bytes:bytes.length},readback:await objects.process(key,bytes,{write:false}),migrate:()=>objects.process(key,bytes,{write:true})};
    }
    const commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey:options.connectorKey});
    return {
      async *inventory():AsyncGenerator<MigrationInventoryItem>{
        for(const input of [await sqliteSource(options.identityPath,'identity'),await sqliteSource(options.registryPath,'registry')])
          yield {entry:input,readback:await sqliteRead(input,'check'),legacy:input.exists};
        for(const root of roots){let cursor:string|undefined;const seen=new Set<string>();
          for(;;){const page=await store.listPage(root,{maxKeys:1000,continuationToken:cursor});
            for(const key of page.keys){
              if(!key.startsWith(root))fail('Object listing escaped its source prefix');
              yield {retainedKey:canonical([root,key]),legacy:key.startsWith(source.prefix+'/')};
              if(!objects.classify(key))continue;
              yield {...await objectRead(key),legacy:true,mutableObject:true};
            }
            if(!page.nextToken)break;if(page.nextToken===cursor||seen.has(page.nextToken))fail('Source listing did not advance');seen.add(page.nextToken);cursor=page.nextToken;
          }
        }
      },
      async validateInventory(fresh:boolean){if(!identity.exists&&!fresh)fail('An existing installation has no legacy identity database; restore the complete installation backup');},
      async read(value:MigrationSource){
        if(value.key==='sqlite:identity'||value.key==='sqlite:registry'){
          const input=await sqliteSource(value.key==='sqlite:identity'?options.identityPath:options.registryPath,value.key==='sqlite:identity'?'identity':'registry');
          return {entry:input,readback:await sqliteRead(input,'check'),migrate:()=>sqliteRead(input,'migrate')};
        }
        return objectRead(value.key);
      },
      async beforeImport(){await migrateEventIdentitySource({store,prefix:source.prefix,eventIdentities:options.eventIdentities});},
      async prepareFinalization(){await commands.ready();await ensureWriteBarrierSchema(database);},
      async finalize(client:PoolClient){
        const lifecycle=await finalizeIntegrationLifecycles({client,namespace:database.namespace,environment:'selfhost',organizationId:options.organizationId,records,commands:commands.transactional});
        const {commands:queued,...transitionCounts}=lifecycle;return {lifecycle:{...transitionCounts,queued:queued.length}};
      },
    };
  }});
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
