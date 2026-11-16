import {openApplicationState,assertApplicationSource} from '../../state/runtime.mjs';
import type {ConnectorBinding} from '../types.mjs';
import type {WorkerConnectionOptions,SourceInput} from './types.mjs';
import {guardConnectorWrites} from '../write-barrier.mjs';
import {validateBinding,digest} from '../scope.mjs';
import {readFile} from 'node:fs/promises';
import {createObjectStore,awsCredentials} from '../../sessions/s3-store.mjs';
import {createSlackHttpSource} from '../slack-source-http.mjs';
import {buildSlackSourceWorkflows,createSlackSourceWorker} from './source-worker.mjs';

const [configPath,bundlePath]=process.argv.slice(2);
if(!configPath||!bundlePath)throw new Error('Usage: SLACK_TOKEN=... node dist/src/connectors/temporal/source-standalone.mjs config.json workflow-bundle.cjs');
const config=JSON.parse(await readFile(configPath,'utf8')) as {binding:ConnectorBinding;s3:Parameters<typeof createObjectStore>[0];temporal:WorkerConnectionOptions};
const binding=validateBinding(config.binding);
if(binding.provider!=='slack')throw new Error('Slack source worker requires a Slack binding');
const application=await openApplicationState(),{state}=application;
let runtime:Awaited<ReturnType<typeof createSlackSourceWorker>>|undefined;
const stop=()=>{if(runtime?.worker.getState()==='RUNNING')runtime.worker.shutdown();};
try {
 const store=createObjectStore({...config.s3,credentials:awsCredentials()});
 assertApplicationSource(application.database,{bucket:store.bucket,tenantId:binding.tenantId});await store.checkAccess();
 const source=createSlackHttpSource({token:process.env.SLACK_TOKEN,workspaceId:binding.workspaceId});
 const sourceIdentity=digest([binding,store.bucket]);
 const resolve=async(reference:SourceInput)=>{
  if(reference.tenantId!==binding.tenantId||reference.connectionId!==binding.connectionId)throw Object.assign(new Error('Standalone Slack source scope denied'),{permanent:true});
  const guarded=guardConnectorWrites({binding,state,store});
  if((await guarded.writeBarrier.inspect()).closed)throw Object.assign(new Error('Slack source admission is closed'),{permanent:true});
  return {binding,...guarded,...source,sourceIdentity};
 };
 await buildSlackSourceWorkflows(bundlePath);
 runtime=await createSlackSourceWorker({...config.temporal,bundlePath,resolve});
 process.once('SIGINT',stop);process.once('SIGTERM',stop);await runtime.worker.run();
} finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await runtime?.connection.close();await application.close();}
