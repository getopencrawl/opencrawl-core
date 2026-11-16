import {Worker,NativeConnection,bundleWorkflowCode,type NativeConnectionOptions} from '@temporalio/worker';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {onlineMigrationActivities} from './activities.mjs';
import {onlineMigrationTaskQueue,onlineMigrationSharedTaskQueue,type OnlineMigrationQueueBinding} from './binding.mjs';
import type {OnlineMigrationController} from './controller.mjs';
export async function buildOnlineMigrationWorkflows(path:string){
 const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./workflows.cjs',import.meta.url))});await writeFile(path,code);
}
/** Migration-only worker: these are its entire Activity registrations. Trusted
 * controller composition owns SQL/source credentials; Workflow input does not. */
export interface OnlineMigrationRouter {
 readonly queue:Readonly<OnlineMigrationQueueBinding>;
 readonly connectionCapacity:number;
 ready():Promise<void>;
 advance:OnlineMigrationController['advance'];
}
type Routing={controller:OnlineMigrationController;router?:never}|{controller?:never;router:OnlineMigrationRouter};
export async function createOnlineMigrationWorker({address,namespace,bundlePath,bundleCode,controller,router,concurrency=2,connectionOptions={}}:{address:string;namespace:string;bundlePath?:string;bundleCode?:string;concurrency?:number;connectionOptions?:NativeConnectionOptions}&Routing){
 const runner=router??controller;
 if(!runner||Boolean(router)===Boolean(controller)||!address||!namespace||Boolean(bundlePath)===Boolean(bundleCode)||bundleCode!==undefined&&(typeof bundleCode!=='string'||Buffer.byteLength(bundleCode)>32*1024*1024)||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4||!Number.isSafeInteger(runner.connectionCapacity)||concurrency>=runner.connectionCapacity||typeof runner.ready!=='function'||typeof runner.advance!=='function'||!connectionOptions||typeof connectionOptions!=='object'||Array.isArray(connectionOptions)||connectionOptions.address!==undefined&&connectionOptions.address!==address)throw Error('Explicit isolated online migration worker configuration required');
 const taskQueue=router?onlineMigrationSharedTaskQueue(router.queue):onlineMigrationTaskQueue(controller!.binding);
 await runner.ready();
 const connection=await NativeConnection.connect({...connectionOptions,address});
 try{
  const worker=await Worker.create({connection,namespace,taskQueue,workflowBundle:bundleCode!==undefined?{code:bundleCode}:{codePath:bundlePath!},activities:onlineMigrationActivities(runner),maxConcurrentActivityTaskExecutions:concurrency,maxConcurrentWorkflowTaskExecutions:2,shutdownGraceTime:'30 seconds'});
  return {worker,connection};
 }catch(error){await connection.close();throw error;}
}
