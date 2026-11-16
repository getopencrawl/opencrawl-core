import {Worker,NativeConnection,bundleWorkflowCode,type NativeConnectionOptions} from '@temporalio/worker';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {onlineMigrationActivities} from './activities.mjs';
import {onlineMigrationTaskQueue} from './binding.mjs';
import type {OnlineMigrationController} from './controller.mjs';
export async function buildOnlineMigrationWorkflows(path:string){
 const {code}=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('./workflows.cjs',import.meta.url))});await writeFile(path,code);
}
/** Migration-only worker: these are its entire Activity registrations. Trusted
 * controller composition owns SQL/source credentials; Workflow input does not. */
export async function createOnlineMigrationWorker({address,namespace,bundlePath,controller,concurrency=2,connectionOptions={}}:{address:string;namespace:string;bundlePath:string;controller:OnlineMigrationController;concurrency?:number;connectionOptions?:NativeConnectionOptions}){
 if(!address||!namespace||!bundlePath||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4||concurrency>=controller.connectionCapacity||!connectionOptions||typeof connectionOptions!=='object'||Array.isArray(connectionOptions)||connectionOptions.address!==undefined&&connectionOptions.address!==address)throw Error('Explicit isolated online migration worker configuration required');
 await controller.ready();
 const connection=await NativeConnection.connect({...connectionOptions,address});
 try{
  const worker=await Worker.create({connection,namespace,taskQueue:onlineMigrationTaskQueue(controller.binding),workflowBundle:{codePath:bundlePath},activities:onlineMigrationActivities(controller),maxConcurrentActivityTaskExecutions:concurrency,maxConcurrentWorkflowTaskExecutions:2,shutdownGraceTime:'30 seconds'});
  return {worker,connection};
 }catch(error){await connection.close();throw error;}
}
