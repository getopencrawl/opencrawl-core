import {createReplicasImport} from '../integrations/replicas-import.mjs';
import {devinRecordingRuntime} from '../integrations/devin-recording-runtime.mjs';
import {hkdfSync} from 'node:crypto';
import {createSessionIngest} from '../sessions/ingest.mjs';
import {sessionDeletionScheduler,sessionIndexingScheduler} from '../sessions/temporal/client.mjs';
import {selfhostTemporalSettings,selfhostConnectorTransition} from './temporal-settings.mjs';
import {selfhostState} from './state.mjs';
import {standaloneEventIdentities} from '../sessions/postgres-identities.mjs';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {selfhostSettings} from './settings.mjs';
import {selfhostServices} from './services.mjs';
import {singleOrganizationSessionSource} from './indexing.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {createSessionWorker,buildSessionWorkflows} from '../sessions/temporal/worker.mjs';
import {ensureSessionSchedule,ensureSessionDeletionSchedule,activateSessionIndexing} from '../sessions/temporal/client.mjs';
import {createConnectorWorker,buildConnectorWorkflows,connectorMaintenance,createConnectorMaintenanceWorker} from '../connectors/temporal/worker.mjs';
import {connectorClient,ensureConnectorSchedule,ensureConnectorMaintenance} from '../connectors/temporal/client.mjs';
import {deleteConnectorSchedules} from '../integrations/purge.mjs';
import {INDEXED_PROVIDERS} from '../integrations/resolver.mjs';
import {createRealm} from '../search/realm.mjs';
/** A restarted Temporal frontend can be healthy before history hosts own the
 * existing schedules. Retry only transient gRPC failures during startup. */
export async function withTemporalStartupRetry<T>(run:()=>Promise<T>,{timeoutMs=60000,delayMs=1000}={}):Promise<T>{
  const deadline=performance.now()+timeoutMs;
  for(;;){
    try{return await run();}
    catch(error){
      let current:unknown=error,transient=false;
      for(let depth=0;depth<5&&current&&typeof current==='object';depth++){
        const item=current as {code?:unknown;cause?:unknown};
        if(item.code===4||item.code===14)transient=true;
        current=item.cause;
      }
      if(!transient||performance.now()>=deadline)throw error;
      await delay(Math.min(delayMs,Math.max(0,deadline-performance.now())));
    }
  }
}
export async function runSelfhostWorker(env:NodeJS.ProcessEnv=process.env){
  const {database}=await selfhostState(env);
  const settings=selfhostSettings(env),{store,prefix}=sessionStorage(env),config=selfhostTemporalSettings(env);
  const services=selfhostServices(settings,store,database,env,selfhostConnectorTransition(env,settings.organizationId,config));
  const eventIdentities=standaloneEventIdentities(store,env);await eventIdentities.ready();
  const {namespace}=config;
  const taskQueue=env.TEMPORAL_CONNECTOR_TASK_QUEUE||'connector-indexing-v1',sessionQueue=env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1',deletionQueue=env.TEMPORAL_SESSION_DELETION_TASK_QUEUE||'session-deletion-v1';
  const bundleRoot=env.OPENCRAWL_WORKFLOW_DIRECTORY||'/tmp/opencrawl-workflows';await mkdir(bundleRoot,{recursive:true});
  if(services.connectors)await buildConnectorWorkflows(bundleRoot+'/connectors.cjs');
  await buildSessionWorkflows(bundleRoot+'/sessions.cjs');
  const scheduling=await connectorClient(config),source=singleOrganizationSessionSource(settings,store,prefix,eventIdentities);
  const connectorSource='selfhost-'+settings.organizationId+'-v1';
  const resolver=services.connectors,realm=createRealm(settings.search);
  const maintenance=resolver && connectorMaintenance({
    sourceId:connectorSource,environment:'selfhost',generation:'v1',registry:services.registry,
    listPage:(status,cursor)=>services.registry.scanPage({status,cursor,providers:[...INDEXED_PROVIDERS]}),
    async ensureActive(record){
      const reference={tenantId:record.tenantId,userId:record.userId,connectionId:record.integrationId,generation:'v1'};
      await resolver.resolve(reference);
      await ensureConnectorSchedule(scheduling.client,{reference,taskQueue,generation:'v1'});
    },
    async purge(record){
      if(record.tenantId!==settings.organizationId)throw new Error('Purge scope denied');
      await deleteConnectorSchedules(record,['v1'],id=>scheduling.client.schedule.getHandle(id).delete());
      await realm.collection('connector').byQuery({tenantId:settings.organizationId},'delete',{term:{'connector.connectionId':record.integrationId}});
    },
  });
  const connectors=resolver?await createConnectorWorker({...config,taskQueue,bundlePath:bundleRoot+'/connectors.cjs',resolve:resolver.resolve}):undefined;
  const maintenanceQueue=taskQueue+'-maintenance-v1';
  const maintenanceWorker=connectors&&maintenance?await createConnectorMaintenanceWorker({namespace,taskQueue:maintenanceQueue,
    connection:connectors.connection,bundlePath:bundleRoot+'/connectors.cjs',activities:maintenance}):undefined;
  if(maintenanceWorker)await withTemporalStartupRetry(()=>ensureConnectorMaintenance(scheduling.client,{sourceId:connectorSource,taskQueue:maintenanceQueue}));
  const indexing=sessionIndexingScheduler({...config,taskQueue:sessionQueue,sourceId:source.sourceId,generation:source.generation,mode:'workflow'});
  const replicasImport=createReplicasImport({database,archive:{store,prefix},schedule:indexing.scheduleReplicasImport,key:Buffer.from(hkdfSync('sha256',settings.authSecret,database.namespace,'replicas-history-credentials-v1',32)),
    ingest:createSessionIngest({store,eventIdentities,prefix,scheduleIndexing:indexing.schedule}).putBatch});
  const devinRecording=devinRecordingRuntime({database,secret:settings.authSecret,audience:settings.url,schedule:indexing.scheduleDevinRecording,
    sessions:{...settings.search,store,prefix,eventIdentities,scheduleIndexing:indexing.schedule,
      scheduleDeletion:sessionDeletionScheduler({...config,taskQueue:deletionQueue,sourceId:source.sourceId})}});
  const sessions=await createSessionWorker({...config,taskQueue:sessionQueue,bundlePath:bundleRoot+'/sessions.cjs',resolve:source.resolve,replicasImport,devinRecording});
  const deletions=await createSessionWorker({...config,taskQueue:deletionQueue,bundlePath:bundleRoot+'/sessions.cjs',resolve:source.resolve,resolveDeletion:source.resolveDeletion,maxConcurrentActivityTaskExecutions:1});
  const runtimes=connectors?[sessions,deletions,connectors]:[sessions,deletions];
  const workers=runtimes.map(runtime=>runtime.worker);if(maintenanceWorker)workers.push(maintenanceWorker);
  // An operator sets this only after the receiver and worker rollout is complete.
  // Starting the worker first must not remove recovery for old API producers.
  const captureCutover=env.OPENCRAWL_SESSION_INDEXING_CUTOVER==='1'
    ?await withTemporalStartupRetry(()=>activateSessionIndexing(scheduling.client,{sourceId:source.sourceId,generation:source.generation,taskQueue:sessionQueue,store,prefix}))
    :undefined;
  if(!captureCutover)await withTemporalStartupRetry(()=>ensureSessionSchedule(scheduling.client,{sourceId:source.sourceId,taskQueue:sessionQueue}));
  const deletionSchedule=await withTemporalStartupRetry(()=>ensureSessionDeletionSchedule(scheduling.client,{sourceId:source.sourceId,taskQueue:deletionQueue}));
  const readiness=env.OPENCRAWL_WORKER_READY_PATH||'/tmp/opencrawl-worker-ready.json';let stopping=false,inFlight:Promise<void>|undefined;
  const tick=()=>{
    if(inFlight||stopping)return;
    inFlight=(async()=>{
      if(workers.every(x=>x.getState()==='RUNNING'))await writeFile(readiness,JSON.stringify({checkedAt:new Date().toISOString(),namespace,deletionSchedule,captureCatchup:captureCutover?.workflowId,airbyteEnabled:!!connectors,taskQueue:connectors?taskQueue:undefined,sessionQueue}));
    })().catch(async()=>{await unlink(readiness).catch(()=>{});console.error(JSON.stringify({event:'selfhost.indexing.readiness_failed'}));}).finally(()=>{inFlight=undefined;});
  };
  await unlink(readiness).catch(()=>{});const timer=setInterval(tick,30000);
  const liveStop=new AbortController();
  const live=env.OPENCRAWL_REPLICAS_LIVE_ORGANIZATION_ID
    ?replicasImport.runLiveCapture({tenantId:settings.organizationId,organizationId:env.OPENCRAWL_REPLICAS_LIVE_ORGANIZATION_ID},liveStop.signal):undefined;
  const stop=()=>{liveStop.abort();stopping=true;clearInterval(timer);for(const x of workers)if(x.getState()==='RUNNING')x.shutdown();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const runs=workers.map(x=>x.run());tick();
  try{await Promise.all(runs);}finally{stop();await live;await Promise.allSettled(runs);await inFlight;await unlink(readiness).catch(()=>{});await indexing.close();await scheduling.connection.close();await Promise.all(runtimes.map(x=>x.connection.close()));services.close();await Promise.all([database.close(),eventIdentities.close()]);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runSelfhostWorker();
