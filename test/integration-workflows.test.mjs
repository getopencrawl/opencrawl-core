import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MockActivityEnvironment,TestWorkflowEnvironment} from '@temporalio/testing';
import {Runtime,DefaultLogger,Worker} from '@temporalio/worker';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {integrationActivities} from '../dist/src/integrations/temporal/activities.mjs';
import {integrationSteps,integrationWorkflowId} from '../dist/src/integrations/temporal/contracts.mjs';
import {buildIntegrationWorkflows,createIntegrationWorker} from '../dist/src/integrations/temporal/worker.mjs';
import {startIntegrationCommand,ensureIntegrationRecoverySchedule} from '../dist/src/integrations/temporal/client.mjs';
const ref={environment:'selfhost',tenantId:'org_team',userId:'user_a',integrationId:'int_'+'a'.repeat(26),commandId:'command_1234567890123456'};
function fixture(operation='provision'){
 const command={reference:ref,operation,status:'pending',requestedBy:'user_admin'};let authorized=true,authOutage=false,terminalOutage=false,attempts=0;
 const commands={read:async input=>input.tenantId===ref.tenantId?command:null,readSecret:async()=>({apiKey:'PRIVATE_KEY'}),clearSecret:async()=>{},fail:async(_ref,reason)=>{if(terminalOutage)throw Error('PRIVATE_STORAGE_BODY');command.status='failed';command.failureReason=reason;},complete:async()=>{command.status='completed';},listPending:async()=>({commands:command.status==='pending'?[ref]:[],cursor:null})};
 const binding={commands,authorize:async()=>{attempts++;if(authOutage)throw Error('PRIVATE_DATABASE_BODY');if(!authorized)throw Object.assign(Error('denied'),{status:403});},runner:{step:async()=>({status:'done'})}};
 return {command,commands,binding,setAuth:value=>{authorized=value;},setOutage:value=>{authOutage=value;},setTerminalOutage:value=>{terminalOutage=value;},attempts:()=>attempts,options:{resolve:async()=>binding,resolveRecovery:async()=>commands}};
}
test('activity authorization revocation is terminal; lookup outages retry without clearing intent',async()=>{
 const env=new MockActivityEnvironment(),f=fixture(),activities=integrationActivities(f.options);
 f.setOutage(true);await assert.rejects(env.run(activities.describeIntegrationCommand,ref),error=>{assert.equal(error.nonRetryable,false);assert.doesNotMatch(error.message,/PRIVATE/);return true;});assert.equal(f.command.status,'pending');
 f.setOutage(false);f.setAuth(false);await assert.rejects(env.run(activities.describeIntegrationCommand,ref),{type:'IntegrationAuthorizationDenied',nonRetryable:true});assert.equal(f.command.failureReason,'authorization_denied');
});
test('accepted disconnect survives initiator revocation, and terminal-storage failures are sanitized',async()=>{
 const env=new MockActivityEnvironment(),f=fixture('disconnect');f.setAuth(false);assert.deepEqual(await env.run(integrationActivities(f.options).executeIntegrationStep,{...ref,step:'close-writers'}),{status:'done'});assert.equal(f.attempts(),0);
 const other=fixture();other.setAuth(false);other.setTerminalOutage(true);await assert.rejects(env.run(integrationActivities(other.options).describeIntegrationCommand,ref),error=>{assert.equal(error.type,'IntegrationCommandStorageFailed');assert.doesNotMatch(error.message,/PRIVATE/);return true;});
});
test('workflow identity rejects foreign malformed scope and output contains no credential payload',async()=>{
 assert.equal(integrationWorkflowId(ref),'integration-lifecycle-v1-selfhost-'+ref.commandId);assert.throws(()=>integrationWorkflowId({...ref,tenantId:'foreign'}));
 const env=new MockActivityEnvironment(),f=fixture();f.binding.runner.step=async()=>{throw Error('PRIVATE_KEY PRIVATE_PROVIDER_BODY');};await assert.rejects(env.run(integrationActivities(f.options).executeIntegrationStep,{...ref,step:'source'}),error=>{assert.equal(error.type,'IntegrationActivityFailed');assert.doesNotMatch(error.message,/PRIVATE/);assert.equal(error.cause,undefined);return true;});
});
test('real Temporal lifecycle retries, worker replacement, SQL outbox recovery and replay preserve reference-only history',{skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:180000},async t=>{
 Runtime.install({logger:new DefaultLogger('ERROR')});const directory=await mkdtemp(join(tmpdir(),'opencrawl-integration-temporal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const env=await TestWorkflowEnvironment.createLocal();t.after(()=>env.teardown());const bundlePath=join(directory,'workflows.cjs');await buildIntegrationWorkflows(bundlePath);
 const f=fixture('disconnect'),first=Promise.withResolvers();let attempts=0;const steps=[];
 f.binding.runner.step=async input=>{steps.push(input.step);if(input.step==='drain-writers'&&++attempts===1){first.resolve();throw Object.assign(Error('PRIVATE_PROVIDER_BODY'),{code:'CONNECTOR_WRITE_PENDING'});}return {status:'done'};};
 const config={address:env.address,namespace:'default',taskQueue:'integration-test',bundlePath,...f.options};
 const workflowId=await startIntegrationCommand(env.client,ref,config.taskQueue);assert.equal(await startIntegrationCommand(env.client,ref,config.taskQueue),workflowId);const handle=env.client.workflow.getHandle(workflowId);
 let runtime=await createIntegrationWorker(config);await runtime.worker.runUntil(()=>first.promise);await runtime.connection.close();assert.equal(f.command.status,'pending');
 runtime=await createIntegrationWorker(config);assert.deepEqual(await runtime.worker.runUntil(()=>handle.result()),{status:'completed'});await runtime.connection.close();assert.equal(f.command.status,'completed');assert.deepEqual([...new Set(steps)],integrationSteps.disconnect);
 const history=await handle.fetchHistory();function inspect(value){if(value instanceof Uint8Array)assert.doesNotMatch(Buffer.from(value).toString(),/PRIVATE_KEY|PRIVATE_PROVIDER_BODY/);else if(value&&typeof value==='object')for(const child of Object.values(value))inspect(child);}inspect(history);await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},history);
 // The periodic recovery discovers a persisted command whose initial dispatch was lost.
 const lost={...ref,commandId:'command_2234567890123456'};f.command.reference=lost;f.command.status='pending';f.commands.listPending=async()=>({commands:[lost],cursor:null});f.commands.read=async()=>f.command;f.binding.runner.step=async()=>({status:'done'});
 const id=await ensureIntegrationRecoverySchedule(env.client,{sourceId:'integration-test',taskQueue:config.taskQueue});assert.equal(await ensureIntegrationRecoverySchedule(env.client,{sourceId:'integration-test',taskQueue:config.taskQueue}),id);const schedule=env.client.schedule.getHandle(id);await schedule.pause('test owns execution');
 runtime=await createIntegrationWorker(config);await runtime.worker.runUntil(async()=>{for(let i=0;i<100&&f.command.status!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.command.status,'completed');});await runtime.connection.close();await schedule.delete();
});
