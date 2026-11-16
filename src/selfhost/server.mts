import {createApplicationState} from '../state/application.mjs';
import {selfhostTemporalSettings} from './temporal-settings.mjs';
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
import {applicationDatabase} from '../state/settings.mjs';
import {requireApplicationStateReady} from '../state/postgres.mjs';
export async function startSelfhost(env:NodeJS.ProcessEnv=process.env){
  const settings=selfhostSettings(env),{store,prefix}=sessionStorage(env);
  const database=applicationDatabase(env);await database.ready();await requireApplicationStateReady(database);
  const state=await createApplicationState({database});
  await store.checkAccess();
  const eventIdentities=standaloneEventIdentities(store,env);await eventIdentities.ready();
  const identity=await createLocalIdentity({url:settings.url,secret:settings.authSecret,database,organizationId:settings.organizationId});
  await identity.ready();
  const services=selfhostServices(settings,store,env,database,state,identity.directory);await services.ready();
  const source=singleOrganizationSessionSource(settings,store,prefix,state,eventIdentities);
  const indexing=sessionIndexingScheduler({...selfhostTemporalSettings(env),taskQueue:env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1',sourceId:source.sourceId,generation:source.generation,mode:'workflow'});
  const scheduleSessionDeletion=sessionDeletionScheduler({...selfhostTemporalSettings(env),taskQueue:env.TEMPORAL_SESSION_DELETION_TASK_QUEUE||'session-deletion-v1',sourceId:'sessions-'+settings.organizationId+'-v1'});
  const {server,shutdown}=createDrainableServer(selfhostApplication({settings,state,store,eventIdentities,prefix,identity,...services,scheduleSessionDeletion,scheduleSessionIndexing:indexing.schedule}),{analytics:{async close(){services.close();identity.close();await Promise.all([eventIdentities.close(),indexing.close()]);await database.close();}}});
  server.requestTimeout=60000;server.headersTimeout=10000;
  // Keep idle upstream sockets longer than Caddy's default two minutes.
  // Header/request deadlines still bound slow clients independently.
  server.keepAliveTimeout=125000;server.keepAliveTimeoutBuffer=1000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(env.PORT||8092),env.HOST||'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});
  return {server,shutdown};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await startSelfhost();
