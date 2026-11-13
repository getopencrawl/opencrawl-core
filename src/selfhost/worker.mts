import {standaloneEventIdentities} from '../sessions/postgres-identities.mjs';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {selfhostSettings} from './settings.mjs';
import {selfhostServices} from './services.mjs';
import {singleOrganizationSessionSource} from './indexing.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {createSessionWorker,buildSessionWorkflows} from '../sessions/temporal/worker.mjs';
import {ensureSessionSchedule,ensureSessionDeletionSchedule} from '../sessions/temporal/client.mjs';
import {createConnectorWorker,buildConnectorWorkflows} from '../connectors/temporal/worker.mjs';
import {connectorClient,ensureConnectorSchedule} from '../connectors/temporal/client.mjs';
import {createConnectionPurger} from '../integrations/purge.mjs';
import {eligible} from '../integrations/resolver.mjs';
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
  const settings=selfhostSettings(env),{store,prefix}=sessionStorage(env),services=selfhostServices(settings,store,env);
  const eventIdentities=standaloneEventIdentities(store,env);await eventIdentities.ready();
  const address=env.TEMPORAL_ADDRESS,namespace=env.TEMPORAL_NAMESPACE;
  if(!address||!namespace)throw new Error('Configure Temporal address and namespace');
  const config={address,namespace},taskQueue=env.TEMPORAL_CONNECTOR_TASK_QUEUE||'connector-indexing-v1',sessionQueue=env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1',deletionQueue=env.TEMPORAL_SESSION_DELETION_TASK_QUEUE||'session-deletion-v1';
  const bundleRoot=env.OPENCRAWL_WORKFLOW_DIRECTORY||'/tmp/opencrawl-workflows';await mkdir(bundleRoot,{recursive:true});
  if(services.connectors)await buildConnectorWorkflows(bundleRoot+'/connectors.cjs');
  await buildSessionWorkflows(bundleRoot+'/sessions.cjs');
  const scheduling=await connectorClient(config),source=singleOrganizationSessionSource(settings,store,prefix,eventIdentities);
  const connectors=services.connectors?await createConnectorWorker({...config,taskQueue,bundlePath:bundleRoot+'/connectors.cjs',resolve:services.connectors.resolve}):undefined;
  const sessions=await createSessionWorker({...config,taskQueue:sessionQueue,bundlePath:bundleRoot+'/sessions.cjs',resolve:source.resolve});
  const deletions=await createSessionWorker({...config,taskQueue:deletionQueue,bundlePath:bundleRoot+'/sessions.cjs',resolve:source.resolve,resolveDeletion:source.resolveDeletion,maxConcurrentActivityTaskExecutions:1});
  const workers=connectors?[sessions,deletions,connectors]:[sessions,deletions];
  await withTemporalStartupRetry(()=>ensureSessionSchedule(scheduling.client,{sourceId:source.sourceId,taskQueue:sessionQueue}));
  const deletionSchedule=await withTemporalStartupRetry(()=>ensureSessionDeletionSchedule(scheduling.client,{sourceId:source.sourceId,taskQueue:deletionQueue}));
  const realm=createRealm(settings.search),purge=createConnectionPurger({environment:'selfhost',generation:'v1',
    deleteSchedule:id=>scheduling.client.schedule.getHandle(id).delete(),
    async deleteDocuments(record){
      if(record.tenantId!==settings.organizationId)throw new Error('Purge scope denied');
      const result=await realm.collection('connector').byQuery({tenantId:settings.organizationId},'delete',{term:{'connector.connectionId':record.integrationId}});return result.changed;
    }});
  const readiness=env.OPENCRAWL_WORKER_READY_PATH||'/tmp/opencrawl-worker-ready.json';let stopping=false,inFlight:Promise<void>|undefined;
  const tick=()=>{
    if(inFlight||stopping)return;
    inFlight=(async()=>{
      if(services.connectors){
        const records=await services.registry.listTenant(settings.organizationId);
        for(const record of records.filter(r=>r.status==='active'&&eligible(r))){
          const reference={tenantId:record.tenantId,userId:record.userId,connectionId:record.integrationId,generation:'v1'};
          await services.connectors.resolve(reference);await ensureConnectorSchedule(scheduling.client,{reference,taskQueue,generation:'v1'});
        }
        await purge(records.filter(r=>r.status==='disconnected'));
      }
      if(workers.every(x=>x.worker.getState()==='RUNNING'))await writeFile(readiness,JSON.stringify({checkedAt:new Date().toISOString(),namespace,deletionSchedule,airbyteEnabled:!!connectors,taskQueue:connectors?taskQueue:undefined,sessionQueue}));
    })().catch(async()=>{await unlink(readiness).catch(()=>{});console.error(JSON.stringify({event:'selfhost.indexing.discovery_failed'}));}).finally(()=>{inFlight=undefined;});
  };
  await unlink(readiness).catch(()=>{});const timer=setInterval(tick,30000);
  const stop=()=>{stopping=true;clearInterval(timer);for(const x of workers)if(x.worker.getState()==='RUNNING')x.worker.shutdown();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const runs=workers.map(x=>x.worker.run());tick();
  try{await Promise.all(runs);}finally{stop();await Promise.allSettled(runs);await inFlight;await unlink(readiness).catch(()=>{});await scheduling.connection.close();await Promise.all(workers.map(x=>x.connection.close()));services.close();await eventIdentities.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runSelfhostWorker();
