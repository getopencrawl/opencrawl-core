import {pathToFileURL} from 'node:url';
import {selfhostSettings} from './settings.mjs';
import {selfhostServices} from './services.mjs';
import {selfhostTemporalSettings} from './temporal-settings.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {applicationDatabase} from '../state/settings.mjs';
import {requireApplicationStateReady} from '../state/postgres.mjs';
import {assertApplicationSource} from '../state/runtime.mjs';
import {createApplicationState} from '../state/application.mjs';
import {createLocalIdentity} from '../identity/better-auth.mjs';
import {createConnectorCacheRetirements} from '../state/connector-cache-retirements.mjs';
import {connectorClient} from '../connectors/temporal/client.mjs';
import {activateConnectorCatchup} from '../connectors/temporal/catchup.mjs';
import {INDEXED_PROVIDERS,eligible} from '../integrations/resolver.mjs';

/** Run after current workers and Airbyte are healthy. Import readiness does not
 * prove that retired connector caches have been replaced by current indexing. */
export async function activateSelfhostConnectors(env:NodeJS.ProcessEnv=process.env){
 const settings=selfhostSettings(env),{store}=sessionStorage(env),database=applicationDatabase(env);
 const releases:Array<()=>unknown|Promise<unknown>>=[()=>database.close()];
 try{
  await database.ready();await requireApplicationStateReady(database);assertApplicationSource(database,{bucket:store.bucket,tenantId:settings.organizationId});
  const required=await createConnectorCacheRetirements(database).required();
  if(!required.receipts)return {required:false,completed:true,connections:0};
  const state=await createApplicationState({database});
  const identity=await createLocalIdentity({url:settings.url,secret:settings.authSecret,database,organizationId:settings.organizationId});releases.push(()=>identity.close());await identity.ready();
  const services=selfhostServices(settings,store,env,database,state,identity.directory);releases.push(()=>services.close());await services.ready();
  const temporal=await connectorClient(selfhostTemporalSettings(env));releases.push(()=>temporal.connection.close());
  return await activateConnectorCatchup({database,client:temporal.client,sourceId:services.integrationSourceId,
   taskQueue:env.TEMPORAL_CONNECTOR_TASK_QUEUE||'connector-indexing-v1',generation:'v1',
   async discover(cursor:{tenantId:string;integrationId:string}|null){
    const page=await services.registry.scanPage({...(cursor?{cursor}:{}),status:'active',providers:[...INDEXED_PROVIDERS]});
    return {references:page.records.filter(eligible).map(record=>({tenantId:record.tenantId,userId:record.userId,connectionId:record.integrationId})),cursor:page.cursor,rejected:page.records.filter(record=>!eligible(record)).length};
   },
   async resolve(reference){if(!services.connectors)throw new Error('Active connector catch-up requires the configured Airbyte worker');return services.connectors.resolve(reference);},
   verifyProducer:()=>requireApplicationStateReady(database),
  });
 }finally{let failure:unknown;for(const release of releases.reverse())try{await release();}catch(error){failure??=error;}if(failure)throw failure;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify({connectorCatchup:await activateSelfhostConnectors()}));}
 catch{console.error(JSON.stringify({connectorCatchup:{completed:false},error:'Connector catch-up incomplete. Repair current workers or connector bindings, then resume the supported upgrade.'}));process.exitCode=1;}
}
