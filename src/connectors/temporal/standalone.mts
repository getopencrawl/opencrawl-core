import {openApplicationState,assertApplicationSource} from '../../state/runtime.mjs';
import type {ConnectorBinding} from '../types.mjs';
import type {RealmOptions} from '../../search/types.mjs';
import type {WorkerConnectionOptions, ConnectorActivityInput} from './types.mjs';
import {guardConnectorWrites} from '../write-barrier.mjs';
import {realmIndex} from '../../search/realm.mjs';
import {readFile} from 'node:fs/promises';
import {createObjectStore, awsCredentials} from '../../sessions/s3-store.mjs';
import {createConnectorSearch} from '../search.mjs';
import {validateBinding} from '../scope.mjs';
import {buildConnectorWorkflows, createConnectorWorker} from './worker.mjs';
import {connectorClient, ensureConnectorSchedule} from './client.mjs';

const [configPath, bundlePath] = process.argv.slice(2);
if (!configPath || !bundlePath) throw new Error('Usage: node dist/src/connectors/temporal/standalone.mjs config.json workflow-bundle.cjs');
const config = JSON.parse(await readFile(configPath, 'utf8')) as {binding: ConnectorBinding; s3: Parameters<typeof createObjectStore>[0]; search: RealmOptions; temporal: WorkerConnectionOptions};
const binding = validateBinding(config.binding);
const application=await openApplicationState(),{state}=application;
let scheduling:Awaited<ReturnType<typeof connectorClient>>|undefined;
let runtime:Awaited<ReturnType<typeof createConnectorWorker>>|undefined;
const shutdown=()=>runtime?.worker.shutdown();
try {
  const store=createObjectStore({...config.s3,credentials:awsCredentials()});
  assertApplicationSource(application.database,{bucket:store.bucket,tenantId:binding.tenantId});
  const search=createConnectorSearch({...config.search,tenantId:binding.tenantId,index:config.search.index||realmIndex('selfhost',binding.tenantId)});
  await store.checkAccess();await search.ensureIndex();
  await buildConnectorWorkflows(bundlePath);
  const resolve=async(reference:ConnectorActivityInput)=>{
    if(reference.tenantId!==binding.tenantId||reference.connectionId!==binding.connectionId)throw Object.assign(new Error('Standalone connector scope denied'),{permanent:true});
    return {binding,...guardConnectorWrites({binding,state,store,search})};
  };
  scheduling=await connectorClient(config.temporal);
  await ensureConnectorSchedule(scheduling.client,{reference:{tenantId:binding.tenantId,connectionId:binding.connectionId},taskQueue:config.temporal.taskQueue});
  runtime=await createConnectorWorker({...config.temporal,bundlePath,resolve});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,shutdown);
  await runtime.worker.run();
}finally{
  for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,shutdown);
  await Promise.all([scheduling?.connection.close(),runtime?.connection.close(),application.close()]);
}
