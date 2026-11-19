import {loadContextSuggestions} from './context-suggestions.mjs';
import {selfhostTemporalSettings} from './temporal-settings.mjs';
import {hkdfSync} from 'node:crypto';
import {createReplicasImport} from '../integrations/replicas-import.mjs';
import {createSessionIngest} from '../sessions/ingest.mjs';
import {selfhostState} from './state.mjs';
import {standaloneEventIdentities} from '../sessions/postgres-identities.mjs';
import {sessionDeletionScheduler,sessionIndexingScheduler} from '../sessions/temporal/client.mjs';
import {singleOrganizationSessionSource} from './indexing.mjs';
import {pathToFileURL} from 'node:url';
import {selfhostSettings} from './settings.mjs';
import {selfhostServices} from './services.mjs';
import {selfhostApplication} from './application.mjs';
import {createLocalIdentity} from '../identity/better-auth.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {createDrainableServer} from '../application/request-lifecycle.mjs';
import {createRecordingPolicy} from '../state/recording.mjs';
import {createSetupState} from '../state/setup.mjs';
export async function startSelfhost(env:NodeJS.ProcessEnv=process.env){
  const contextSuggestions=await loadContextSuggestions(env.OPENCRAWL_CONTEXT_SUGGESTIONS_MODULE);
  const settings=selfhostSettings(env),{store,prefix}=sessionStorage(env);
  await store.checkAccess();
  const {database,state:boardState}=await selfhostState(env);
  const recording=createRecordingPolicy(database);await recording.ready();
  const setupState=createSetupState(database);await setupState.ready();
  const eventIdentities=standaloneEventIdentities(store,env);await eventIdentities.ready();
  const identity=await createLocalIdentity({url:settings.url,secret:settings.authSecret,database,organizationId:settings.organizationId});
  await identity.ready();
  const services=selfhostServices(settings,store,database,env);
  const temporal=selfhostTemporalSettings(env);
  const source=singleOrganizationSessionSource(settings,store,prefix,eventIdentities);
  const indexing=sessionIndexingScheduler({...temporal,taskQueue:env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1',sourceId:source.sourceId,generation:source.generation,mode:'workflow'});
  const scheduleSessionDeletion=sessionDeletionScheduler({...temporal,taskQueue:env.TEMPORAL_SESSION_DELETION_TASK_QUEUE||'session-deletion-v1',sourceId:'sessions-'+settings.organizationId+'-v1'});
  const replicasImport=createReplicasImport({database,schedule:indexing.scheduleReplicasImport,key:Buffer.from(hkdfSync('sha256',settings.authSecret,database.namespace,'replicas-history-credentials-v1',32)),ingest:createSessionIngest({store,eventIdentities,prefix,scheduleIndexing:indexing.schedule}).putBatch});
  const {server,shutdown}=createDrainableServer(selfhostApplication({contextSuggestions,settings,store,boardState,setupState,recording,eventIdentities,prefix,identity,...services,replicasImport,scheduleSessionDeletion,scheduleSessionIndexing:indexing.schedule}),{analytics:{async close(){services.close();await identity.close();await Promise.all([database.close(),eventIdentities.close(),indexing.close()]);}}});
  server.requestTimeout=60000;server.headersTimeout=10000;
  // Keep idle upstream sockets longer than Caddy's default two minutes.
  // Header/request deadlines still bound slow clients independently.
  server.keepAliveTimeout=125000;server.keepAliveTimeoutBuffer=1000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(env.PORT||8092),env.HOST||'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  // Recovery has the same durable create fence as an explicit Retry in the UI.
  services.recover().catch(()=>console.error(JSON.stringify({event:'integration.recovery_failed'})));
  process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
  return {server,shutdown};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await startSelfhost();
