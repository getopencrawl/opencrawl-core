import {pathToFileURL} from 'node:url';
import type {ObjectStore} from './types.mjs';
import {sourceBatchIdentity} from './event-identity.mjs';
import {createPostgresEventIdentities,standaloneEventIdentities} from './postgres-identities.mjs';

/** Per-session commits are the restart checkpoint. Re-running scans is safe and
 * does not import ready sessions again. Include ledger-only failed uploads;
 * listing raw batches alone would silently drop their reserved identities.
 */
export async function migrateEventIdentitySource({store,prefix,eventIdentities,onProgress=()=>{}}:{
 store:ObjectStore;prefix:string;eventIdentities:ReturnType<typeof createPostgresEventIdentities>;
 onProgress?:(progress:{objects:number;sessionVisits:number})=>void;
}){
 if(!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid session source prefix');
 await eventIdentities.ready();
 const root=prefix+'/tenants/',cursors=new Set<string>();let cursor:string|null|undefined,objects=0,sessionVisits=0;
 do{
  const page=await store.listPage(root,{continuationToken:cursor,maxKeys:1000}),sources=new Set<string>();
  for(const key of page.keys){
   if(!key.startsWith(root))throw new Error('Identity migration inventory outside source');
   objects++;
   const candidate=key.endsWith('/event-identities-v1.json')?key.replace(/event-identities-v1\.json$/,'0'.repeat(64)+'.json.gz'):key;
   if(sourceBatchIdentity(prefix,candidate))sources.add(key.slice(0,key.lastIndexOf('/')+1));
  }
  for(const source of sources){await eventIdentities.migrateSession({store,prefix,source});sessionVisits++;}
  onProgress({objects,sessionVisits});
  cursor=page.nextToken;if(cursor){if(cursors.has(cursor))throw new Error('Identity migration inventory cursor did not advance');cursors.add(cursor);}
 }while(cursor);
 return {objects,sessionVisits,complete:true};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3||process.argv[2]!=='migrate')throw new Error('Usage: node dist/src/sessions/identity-migration.mjs migrate');
 const {standaloneStorage}=await import('./standalone.mjs'),{store,prefix}=standaloneStorage();
 const eventIdentities=standaloneEventIdentities(store);
 try{
  await store.checkAccess();
  console.log(JSON.stringify(await migrateEventIdentitySource({store,prefix,eventIdentities,onProgress:progress=>console.log(JSON.stringify({migration:'event-identities-postgres',...progress}))})));
 }catch{
  console.error('Event identity migration incomplete. Existing data is retained; keep old writers stopped, check database/storage access and source conflicts, then rerun.');process.exitCode=1;
 }finally{await eventIdentities.close();}
}
