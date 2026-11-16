import {pathToFileURL} from 'node:url';
import type {ObjectStore} from './types.mjs';
import {sourceBatchIdentity} from './event-identity.mjs';
import {createPostgresEventIdentities,standaloneEventIdentities} from './postgres-identities.mjs';

type MigrationPhase='storage-access'|'database-ready'|'list-source'|'validate-inventory'|'migrate-session';
// Fixed labels only: storage/SQL exceptions can contain credentials, raw keys,
// response bodies, or query parameters. Never print their arbitrary message.
const safeMessages=new Set([
 'Invalid session source prefix','Identity migration inventory outside source','Identity migration source inventory is not ordered','Identity migration inventory cursor did not advance',
 'Unsupported event identity database schema','Event identity database unavailable; retry the same batch','Event identity database does not match the migrated source; restore its matching backup',
 'Invalid event identity source scope','Event identity scope mismatch','Invalid legacy event identity ledger','Legacy event identity scope mismatch','Invalid legacy event identity fingerprints',
 'Invalid event identity storage version','Session source inventory outside scope','Session source unavailable during identity migration','Invalid historical session batch','Invalid historical session format',
 'Historical session owner does not match source','Session inventory cursor did not advance','Cannot identify an empty historical session','Legacy event identities changed during migration; stop all old writers and retry',
 'Object exceeds read limit','Object store omitted ETag','S3 listing omitted its continuation token','S3 listing repeated its continuation token',
]);
const safeCodes=new Set(['AccessDenied','InvalidAccessKeyId','SignatureDoesNotMatch','ExpiredToken','InvalidToken','RequestTimeTooSkewed','NoSuchBucket','NoSuchKey','SlowDown','InternalError','ServiceUnavailable','SESSION_EVENT_ID_CONFLICT','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EACCES','EPERM','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','08000','08003','08006','28P01','3D000','40001','40P01','42501','42P01','42703','42704','42P07','23503','23505','23514','53300','53400','57P01','57P02','57P03']);
export function eventIdentityMigrationFailure(error:unknown,phase:MigrationPhase){
 const value=error&&typeof error==='object'?error as {name?:unknown;code?:unknown;status?:unknown;message?:unknown}:{};
 return {migration:'event-identities-postgres',state:'failed',phase,
  errorType:typeof value.name==='string'&&['Error','TypeError','RangeError','AggregateError','AbortError','TimeoutError'].includes(value.name)?value.name:'other',
  code:typeof value.code==='string'&&safeCodes.has(value.code)?value.code:null,
  status:typeof value.status==='number'&&Number.isInteger(value.status)&&value.status>=100&&value.status<=599?value.status:null,
  reason:typeof value.message==='string'&&safeMessages.has(value.message)?value.message:null};
}

/** Per-session commits are the restart checkpoint. Re-running scans is safe and
 * does not import ready sessions again. Include ledger-only failed uploads;
 * listing raw batches alone would silently drop their reserved identities.
 */
export async function migrateEventIdentitySource({store,prefix,eventIdentities,onProgress=()=>{},onPhase=()=>{}}:{
 store:ObjectStore;prefix:string;eventIdentities:ReturnType<typeof createPostgresEventIdentities>;
 onProgress?:(progress:{objects:number;sessionVisits:number})=>void;
 onPhase?:(phase:MigrationPhase)=>void;
}){
 if(!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid session source prefix');
 onPhase('database-ready');await eventIdentities.ready();
 const root=prefix+'/tenants/',cursors=new Set<string>();let cursor:string|null|undefined,objects=0,sessionVisits=0,previousSource='';
 do{
  onPhase('list-source');const page=await store.listPage(root,{continuationToken:cursor,maxKeys:1000}),sources:string[]=[];
  onPhase('validate-inventory');
  for(const key of page.keys){
   if(!key.startsWith(root))throw new Error('Identity migration inventory outside source');
   objects++;
   const candidate=key.endsWith('/event-identities-v1.json')?key.replace(/event-identities-v1\.json$/,'0'.repeat(64)+'.json.gz'):key;
   if(sourceBatchIdentity(prefix,candidate)){
    const source=key.slice(0,key.lastIndexOf('/')+1);
    if(source<previousSource)throw new Error('Identity migration source inventory is not ordered');
    if(source!==previousSource){sources.push(source);previousSource=source;}
   }
  }
  for(let offset=0;offset<sources.length;offset+=4){
   onPhase('migrate-session');const settled=await Promise.allSettled(sources.slice(offset,offset+4).map(source=>eventIdentities.migrateSession({store,prefix,source})));
   // Successful per-session commits survive failure, but every admitted visit
   // must settle before another group or caller cleanup can begin.
   for(const result of settled){if(result.status==='rejected')throw result.reason;sessionVisits++;}
  }
  onProgress({objects,sessionVisits});
  cursor=page.nextToken;if(cursor){if(cursors.has(cursor))throw new Error('Identity migration inventory cursor did not advance');cursors.add(cursor);}
 }while(cursor);
 return {objects,sessionVisits,complete:true};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3||process.argv[2]!=='migrate')throw new Error('Usage: node dist/src/sessions/identity-migration.mjs migrate');
 const {sessionStorage}=await import('./storage.mjs'),{store,prefix}=sessionStorage();
 const eventIdentities=standaloneEventIdentities(store);let phase:MigrationPhase='storage-access';
 try{
  await store.checkAccess();
  console.log(JSON.stringify(await migrateEventIdentitySource({store,prefix,eventIdentities,onProgress:progress=>console.log(JSON.stringify({migration:'event-identities-postgres',...progress})),onPhase:value=>{phase=value;}})));
 }catch(error){
  console.error(JSON.stringify(eventIdentityMigrationFailure(error,phase)));
  console.error('Event identity migration incomplete. Existing data is retained; keep old writers stopped, check database/storage access and source conflicts, then rerun.');process.exitCode=1;
 }finally{await eventIdentities.close();}
}
