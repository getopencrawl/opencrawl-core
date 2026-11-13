import {standaloneEventIdentities} from '../postgres-identities.mjs';
import type {SessionTaskInput} from './worker.mjs';
import {pathToFileURL} from 'node:url';
import {standaloneStorage} from '../standalone.mjs';
import {createSessionSearch,searchSettings} from '../search.mjs';
import {buildSessionWorkflows,createSessionWorker} from './worker.mjs';
import {sessionClient,ensureSessionSchedule} from './client.mjs';
export function standaloneSessionResolver(env=process.env) {
  const {store,prefix}=standaloneStorage(env),settings=searchSettings(env);
  if(!settings)throw new Error('Configure OPENCRAWL_OPENSEARCH_URL for the session worker');
  const eventIdentities=standaloneEventIdentities(store,env);
  const search=createSessionSearch({...settings,store,prefix});
  const principal={tenantId:env.OPENCRAWL_TENANT_ID||'self-hosted',userId:env.OPENCRAWL_USER_ID||'owner'};
  const sourceId=env.OPENCRAWL_SESSION_SOURCE_ID||'self-hosted-sessions-v1';
  return {sourceId,eventIdentities,resolve:async (input: SessionTaskInput)=>{
    if(input.sourceId!==sourceId)throw Object.assign(new Error('Standalone session scope denied'),{permanent:true});
    await eventIdentities.ready();
    return {store,eventIdentities,prefix,search,principal};
  }};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const bundlePath=process.argv[2];
  if(!bundlePath)throw new Error('Usage: node dist/src/sessions/temporal/standalone.mjs /path/to/session-bundle.cjs');
  const config={address:process.env.TEMPORAL_ADDRESS!,namespace:process.env.TEMPORAL_NAMESPACE!,taskQueue:process.env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1'};
  if(process.argv.includes('--build')){await buildSessionWorkflows(bundlePath);process.exit(0);}
  const {sourceId,resolve,eventIdentities}=standaloneSessionResolver();
  const {worker,connection}=await createSessionWorker({...config,bundlePath,resolve});
  const scheduling=await sessionClient(config);
  await ensureSessionSchedule(scheduling.client,{sourceId,taskQueue:config.taskQueue});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>worker.shutdown());
  try {await worker.run();}finally {await scheduling.connection.close();await connection.close();await eventIdentities.close();}
}
