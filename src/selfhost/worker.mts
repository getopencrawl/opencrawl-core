import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {selfhostSettings} from './settings.mjs';
import {selfhostServices} from './services.mjs';
import {singleOrganizationSessionSource} from './indexing.mjs';
import {standaloneStorage} from '../sessions/standalone.mjs';
import {createSessionWorker,buildSessionWorkflows} from '../sessions/temporal/worker.mjs';
import {ensureSessionSchedule} from '../sessions/temporal/client.mjs';
import {createConnectorWorker,buildConnectorWorkflows} from '../connectors/temporal/worker.mjs';
import {connectorClient,ensureConnectorSchedule} from '../connectors/temporal/client.mjs';
import {createConnectionPurger} from '../integrations/purge.mjs';
import {eligible} from '../integrations/resolver.mjs';
import {createRealm} from '../search/realm.mjs';
export async function runSelfhostWorker(env:NodeJS.ProcessEnv=process.env){
  const settings=selfhostSettings(env),{store,prefix}=standaloneStorage(env),services=selfhostServices(settings,store,env);
  const address=env.TEMPORAL_ADDRESS,namespace=env.TEMPORAL_NAMESPACE;
  if(!address||!namespace)throw new Error('Configure Temporal address and namespace');
  const config={address,namespace},taskQueue=env.TEMPORAL_CONNECTOR_TASK_QUEUE||'connector-indexing-v1',sessionQueue=env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1';
  const bundleRoot=env.OPENCRAWL_WORKFLOW_DIRECTORY||'/tmp/opencrawl-workflows';await mkdir(bundleRoot,{recursive:true});
  await buildConnectorWorkflows(bundleRoot+'/connectors.cjs');await buildSessionWorkflows(bundleRoot+'/sessions.cjs');
  const scheduling=await connectorClient(config),source=singleOrganizationSessionSource(settings,store,prefix);
  const connectors=await createConnectorWorker({...config,taskQueue,bundlePath:bundleRoot+'/connectors.cjs',resolve:services.connectors.resolve});
  const sessions=await createSessionWorker({...config,taskQueue:sessionQueue,bundlePath:bundleRoot+'/sessions.cjs',resolve:source.resolve});
  await ensureSessionSchedule(scheduling.client,{sourceId:source.sourceId,taskQueue:sessionQueue});
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
      const records=await services.registry.listTenant(settings.organizationId);
      for(const record of records.filter(r=>r.status==='active'&&eligible(r))){
        const reference={tenantId:record.tenantId,userId:record.userId,connectionId:record.integrationId,generation:'v1'};
        await services.connectors.resolve(reference);await ensureConnectorSchedule(scheduling.client,{reference,taskQueue,generation:'v1'});
      }
      await purge(records.filter(r=>r.status==='disconnected'));
      if(connectors.worker.getState()==='RUNNING'&&sessions.worker.getState()==='RUNNING')await writeFile(readiness,JSON.stringify({checkedAt:new Date().toISOString(),namespace,taskQueue,sessionQueue}));
    })().catch(async()=>{await unlink(readiness).catch(()=>{});console.error(JSON.stringify({event:'selfhost.indexing.discovery_failed'}));}).finally(()=>{inFlight=undefined;});
  };
  await unlink(readiness).catch(()=>{});const timer=setInterval(tick,30000);
  const stop=()=>{stopping=true;clearInterval(timer);for(const x of [connectors,sessions])if(x.worker.getState()==='RUNNING')x.worker.shutdown();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const runs=[connectors.worker.run(),sessions.worker.run()];tick();
  try{await Promise.all(runs);}finally{stop();await Promise.allSettled(runs);await inFlight;await unlink(readiness).catch(()=>{});await scheduling.connection.close();await connectors.connection.close();await sessions.connection.close();services.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runSelfhostWorker();
