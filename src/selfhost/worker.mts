import {standaloneEventIdentities} from '../sessions/postgres-identities.mjs';
import {applicationDatabase} from '../state/settings.mjs';
import {requireApplicationStateReady} from '../state/postgres.mjs';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {selfhostSettings} from './settings.mjs';
import {selfhostServices} from './services.mjs';
import {singleOrganizationSessionSource} from './indexing.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {createSessionWorker,buildSessionWorkflows} from '../sessions/temporal/worker.mjs';
import {ensureSessionSchedule,ensureSessionDeletionSchedule,activateSessionIndexing} from '../sessions/temporal/client.mjs';
import {createConnectorWorker,buildConnectorWorkflows} from '../connectors/temporal/worker.mjs';
import {connectorClient} from '../connectors/temporal/client.mjs';
import {createApplicationState} from '../state/application.mjs';
import {createLocalIdentity} from '../identity/better-auth.mjs';
import {selfhostTemporalSettings} from './temporal-settings.mjs';
import {buildIntegrationWorkflows,createIntegrationWorker} from '../integrations/temporal/worker.mjs';
import {ensureIntegrationRecoverySchedule,ensureIntegrationDiscoverySchedule} from '../integrations/temporal/client.mjs';
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
  const settings=selfhostSettings(env),{store,prefix}=sessionStorage(env),database=applicationDatabase(env);
  const releases:Array<()=>unknown|Promise<unknown>>=[()=>database.close()];
  let failure:unknown;
  try {
    await database.ready();await requireApplicationStateReady(database);
    const state=await createApplicationState({database});
    const identity=await createLocalIdentity({url:settings.url,secret:settings.authSecret,database,organizationId:settings.organizationId});releases.push(()=>identity.close());await identity.ready();
    const services=selfhostServices(settings,store,env,database,state,identity.directory);releases.push(()=>services.close());await services.ready();
    const eventIdentities=standaloneEventIdentities(store,env);releases.push(()=>eventIdentities.close());await eventIdentities.ready();
    const config=selfhostTemporalSettings(env),{namespace}=config;
    const taskQueue=env.TEMPORAL_CONNECTOR_TASK_QUEUE||'connector-indexing-v1',sessionQueue=env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1',deletionQueue=env.TEMPORAL_SESSION_DELETION_TASK_QUEUE||'session-deletion-v1',integrationQueue=env.TEMPORAL_INTEGRATION_TASK_QUEUE||'integration-lifecycle-v1';
    const bundleRoot=env.OPENCRAWL_WORKFLOW_DIRECTORY||'/tmp/opencrawl-workflows';await mkdir(bundleRoot,{recursive:true});
    if(services.connectors)await buildConnectorWorkflows(bundleRoot+'/connectors.cjs');
    if(services.lifecycleActivities)await buildIntegrationWorkflows(bundleRoot+'/integrations.cjs');
    await buildSessionWorkflows(bundleRoot+'/sessions.cjs');
    const scheduling=await connectorClient(config);
    releases.push(()=>scheduling.connection.close());
    const source=singleOrganizationSessionSource(settings,store,prefix,state,eventIdentities);
    const workers:Awaited<ReturnType<typeof createSessionWorker>>[]=[];
    const runs:Promise<void>[]=[];
    const readiness=env.OPENCRAWL_WORKER_READY_PATH||'/tmp/opencrawl-worker-ready.json';
    let timer:ReturnType<typeof setInterval>|undefined,inFlight:Promise<void>|undefined,stopping=false;
    const stop=()=>{stopping=true;clearInterval(timer);for(const runtime of workers)if(runtime.worker.getState()==='RUNNING')runtime.worker.shutdown();};
    const start=(runtime:Awaited<ReturnType<typeof createSessionWorker>>)=>{
      workers.push(runtime);
      const run=runtime.worker.run();runs.push(run);
      // Register rejection handling immediately, including while later workers
      // initialize. Every native worker gets a run/drain lifecycle.
      void run.catch(stop);
    };
    try {
      // This cutover remains operator controlled until every producer is upgraded.
      const captureCutover=env.OPENCRAWL_SESSION_INDEXING_CUTOVER==='1'
        ?await withTemporalStartupRetry(()=>activateSessionIndexing(scheduling.client,{sourceId:source.sourceId,generation:source.generation,taskQueue:sessionQueue,state,store,prefix}))
        :undefined;
      if(!captureCutover)await withTemporalStartupRetry(()=>ensureSessionSchedule(scheduling.client,{sourceId:source.sourceId,taskQueue:sessionQueue}));
      const deletionSchedule=await withTemporalStartupRetry(()=>ensureSessionDeletionSchedule(scheduling.client,{sourceId:source.sourceId,taskQueue:deletionQueue}));
      if(services.lifecycleActivities){
        const binding={sourceId:services.integrationSourceId,taskQueue:integrationQueue};
        await withTemporalStartupRetry(()=>ensureIntegrationRecoverySchedule(scheduling.client,binding));
        await withTemporalStartupRetry(()=>ensureIntegrationDiscoverySchedule(scheduling.client,binding));
      }
      if(services.connectors)start(await createConnectorWorker({...config,taskQueue,bundlePath:bundleRoot+'/connectors.cjs',resolve:services.connectors.resolve}));
      start(await createSessionWorker({...config,taskQueue:sessionQueue,bundlePath:bundleRoot+'/sessions.cjs',resolve:source.resolve}));
      start(await createSessionWorker({...config,taskQueue:deletionQueue,bundlePath:bundleRoot+'/sessions.cjs',resolve:source.resolve,resolveDeletion:source.resolveDeletion,maxConcurrentActivityTaskExecutions:1}));
      if(services.lifecycleActivities)start(await createIntegrationWorker({...config,taskQueue:integrationQueue,bundlePath:bundleRoot+'/integrations.cjs',...services.lifecycleActivities}));
      // The only local timer reports readiness; durable discovery and cleanup run
      // on separate Temporal schedules and survive worker replacement.
      const tick=()=>{
        if(inFlight||stopping)return;
        inFlight=(async()=>{
          if(workers.every(runtime=>runtime.worker.getState()==='RUNNING'))await writeFile(readiness,JSON.stringify({checkedAt:new Date().toISOString(),namespace,deletionSchedule,captureCatchup:captureCutover?.workflowId,airbyteEnabled:!!services.connectors,taskQueue:services.connectors?taskQueue:undefined,sessionQueue}));
          else await unlink(readiness).catch(()=>{});
        })().catch(()=>{}).finally(()=>{inFlight=undefined;});
      };
      await unlink(readiness).catch(()=>{});timer=setInterval(tick,30000);
      process.once('SIGTERM',stop);process.once('SIGINT',stop);
      tick();await Promise.all(runs);
    } finally {
      stop();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
      await Promise.allSettled(runs);
      await inFlight;await unlink(readiness).catch(()=>{});
      await Promise.all(workers.map(runtime=>runtime.connection.close()));
    }
  } catch(error) {failure=error;throw error;}
  finally {
    const results=await Promise.allSettled(releases.reverse().map(release=>Promise.resolve().then(release)));
    const failed=results.find(result=>result.status==='rejected');if(!failure&&failed?.status==='rejected')throw failed.reason;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runSelfhostWorker();
