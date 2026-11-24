import {Worker,NativeConnection,bundleWorkflowCode} from '@temporalio/worker';
import {fileURLToPath} from 'node:url';
import type {TeamChangeOptions} from '../team-operation.mjs';
import {teamChangeActivities} from '../team-operation.mjs';
import {writeFile} from 'node:fs/promises';
import type {NativeConnectionOptions} from '@temporalio/worker';
export async function buildTeamWorkflows(path:string) {
  const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./workflows.cjs',import.meta.url))});
  await writeFile(path,code);
}
export async function createTeamWorker(config:{address:string;namespace:string;connectionOptions?:NativeConnectionOptions},taskQueue:string,options:TeamChangeOptions,bundlePath:string) {
  const connection=await NativeConnection.connect({...config.connectionOptions,address:config.address});
  try {
    const worker=await Worker.create({connection,namespace:config.namespace,taskQueue,workflowBundle:{codePath:bundlePath},
      activities:teamChangeActivities(options),maxConcurrentActivityTaskExecutions:2,maxConcurrentWorkflowTaskExecutions:2,
      maxConcurrentWorkflowTaskPolls:2,maxConcurrentActivityTaskPolls:2,workflowThreadPoolSize:1,maxCachedWorkflows:8,shutdownGraceTime:'1 second',shutdownForceTime:'15 seconds'});
    return {worker,connection};
  } catch (error) {await connection.close();throw error;}
}
