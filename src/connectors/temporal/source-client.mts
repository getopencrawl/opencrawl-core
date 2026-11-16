import type {Client} from '@temporalio/client';
import type {ConnectionReference} from './types.mjs';
import type {MessageReference} from '../capture-types.mjs';
import {WorkflowExecutionAlreadyStartedError,WorkflowIdReusePolicy} from '@temporalio/client';
import {digest} from '../scope.mjs';
export interface SlackCaptureRequest {
 reference:ConnectionReference;taskQueue:string;mode:'files'|'messages'|'references';runId:string;
 cutoff?:number;references?:MessageReference[];
}
/** Submission owns no provider/storage credentials. A connection has one running
 * standalone capture across modes; an existing run is reported, never replaced. */
export async function startSlackCapture(client:Client,request:SlackCaptureRequest):Promise<{workflowId:string;submitted:boolean}> {
 const {reference,taskQueue,mode,runId}=request;
 if(!reference||![reference.tenantId,reference.connectionId].every(value=>typeof value==='string'&&/^[A-Za-z0-9_:-]{1,200}$/.test(value))||!taskQueue||!['files','messages','references'].includes(mode)||!/^[A-Za-z0-9_-]{1,150}$/.test(runId))throw new Error('Invalid Slack capture request');
 if(reference.userId!==undefined&&!/^[A-Za-z0-9_:-]{1,200}$/.test(reference.userId))throw new Error('Invalid capture owner reference');
 const input:ConnectionReference&{runId:string;cutoff?:number;references?:MessageReference[]}={tenantId:reference.tenantId,connectionId:reference.connectionId,...(reference.userId?{userId:reference.userId}:{}),runId};
 if(mode==='references'){
  if(!Array.isArray(request.references)||!request.references.length||request.references.length>1000)throw new Error('Expected 1 to 1000 native message references');
  input.references=request.references.map(ref=>{
   if(!ref||!/^C[A-Z0-9]{1,100}$/.test(ref.channelId)||!/^\d{1,20}\.\d{1,6}$/.test(ref.ts)||ref.threadTs!==undefined&&!/^\d{1,20}\.\d{1,6}$/.test(ref.threadTs))throw new Error('Invalid native message reference');
   return {channelId:ref.channelId,ts:ref.ts,...(ref.threadTs!==undefined?{threadTs:ref.threadTs}:{})};
  });
 } else {if(!Number.isSafeInteger(request.cutoff)||request.cutoff!<0)throw new Error('A stable epoch-millisecond capture cutoff is required');input.cutoff=request.cutoff;}
 const workflowId='slack-capture-v1-'+digest([reference.tenantId,reference.connectionId]);
 const workflowType={files:'captureSlackFilesV1',messages:'captureSlackMessagesV1',references:'captureSlackMessageReferencesV1'}[mode];
 try {await client.workflow.start(workflowType,{workflowId,taskQueue,args:[input],workflowIdReusePolicy:WorkflowIdReusePolicy.ALLOW_DUPLICATE});}
 catch(error){if(!(error instanceof WorkflowExecutionAlreadyStartedError))throw error;return {workflowId,submitted:false};}
 return {workflowId,submitted:true};
}
