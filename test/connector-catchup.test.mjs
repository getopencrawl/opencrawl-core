import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,Runtime,DefaultLogger,bundleWorkflowCode} from '@temporalio/worker';
import {activateConnectorCatchup} from '../dist/src/connectors/temporal/catchup.mjs';
import {createConnectorCacheRetirements} from '../dist/src/state/connector-cache-retirements.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const source={version:1,bucket:'fixture-bucket',prefix:'sessions/v1',organizationId:'org_fixture'};
const ref={tenantId:'org_fixture',userId:'user_owner',connectionId:'int_'+'a'.repeat(26)};
const resolve=async reference=>({binding:{tenantId:reference.tenantId,connectionId:reference.connectionId,workspaceId:'workspace',provider:'notion',access:'workspace-global',rawPrefix:`raw/v1/source=notion/workspace=workspace/connection=${reference.connectionId}/`},store:{bucket:source.bucket},search:{identity:'index-fixture'}});
async function fixture(t,{retired=true}={}){
 const database=await applicationDatabaseFixture(t,{sourceIdentity:source});
 await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at,inventory_complete,source_manifest_hash) VALUES($1,$2::jsonb,$3,'ready',now(),true,$4)",[database.namespace,JSON.stringify(source),randomUUID(),'a'.repeat(64)]);
 const retirement=createConnectorCacheRetirements(database);await retirement.ready();
 if(retired)await retirement.importRetirement({version:1,kind:'object',bucket:source.bucket,key:'legacy/receipt.json',sourceHash:'b'.repeat(64),disposition:'full-temporal-connector-catchup',receipt:{pipeline:'old-v1',key:'raw/retained',sha256:'c'.repeat(64),sourceRecords:1,records:1}});
 const starts=[],client={options:{namespace:'default'},workflow:{start:async(type,input)=>{starts.push({type,...input});},getHandle:workflowId=>({result:async()=>({cursor:null,failed:0}),describe:async()=>({status:{name:'COMPLETED'},type:'indexConnectorV1',taskQueue:'fixture-v1',runId:'run-'+workflowId})})}};
 const options={database,client,sourceId:'fixture',taskQueue:'fixture-v1',generation:'v1',discover:async()=>({references:[ref],cursor:null}),resolve};
 return {database,retirement,starts,options};
}
test('no retired cache returns explicit no requirement without dispatch',{skip:!postgresUrl},async t=>{
 const f=await fixture(t,{retired:false});f.options.discover=async()=>assert.fail('no inventory needed');
 assert.deepEqual(await activateConnectorCatchup(f.options),{required:false,completed:true,connections:0});assert.equal(f.starts.length,0);
});
test('full current catch-up is durable across replacement and uses reference-only current queue inputs',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),result=await activateConnectorCatchup(f.options);assert.equal(result.completed,true);assert.equal(result.connections,1);assert.equal(f.starts.length,1);
 assert.deepEqual(f.starts[0].args,[{...ref,generation:'v1'}]);assert.equal(f.starts[0].taskQueue,'fixture-v1');
 f.options.client.workflow.start=async()=>assert.fail('completed SQL evidence survives Temporal retention');assert.deepEqual(await activateConnectorCatchup(f.options),result);
 assert.equal((await f.retirement.required()).receipts,1,'completion never deletes historical audit');
});
test('failed scan remains incomplete and retries the same durable workflow identity',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);let failed=true;const handle=f.options.client.workflow.getHandle;
 f.options.client.workflow.getHandle=id=>({...handle(id),result:async()=>{if(failed)throw Error('workflow failed');return {cursor:null,failed:0};}});
 await assert.rejects(activateConnectorCatchup(f.options),/workflow failed/);assert.equal((await f.database.pool.query('SELECT completed_at FROM opencrawl_connector_catchups WHERE namespace=$1',[f.database.namespace])).rows[0].completed_at,null);
 failed=false;await activateConnectorCatchup(f.options);assert.equal(f.starts.length,2);assert.equal(f.starts[0].workflowId,f.starts[1].workflowId);
});
test('lost post-workflow SQL write resumes the existing run and never reports a partial manifest',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);let calls=0;f.options.verifyProducer=async()=>{if(++calls===3)throw Error('producer changed');};
 await assert.rejects(activateConnectorCatchup(f.options),/producer changed/);assert.equal((await f.database.pool.query('SELECT completed_at FROM opencrawl_connector_catchups WHERE namespace=$1',[f.database.namespace])).rows[0].completed_at,null);
 f.options.verifyProducer=async()=>{};await activateConnectorCatchup(f.options);assert.equal(f.starts.length,1,'saved per-reference completion is reused');
});
test('scope changes, rejected active records and pagination cycles fail closed',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);let reads=0;f.options.discover=async()=>({references:++reads===1?[ref]:[],cursor:null});
 await assert.rejects(activateConnectorCatchup(f.options),/scope changed/);
 f.options.discover=async()=>({references:[],cursor:null,rejected:1});await assert.rejects(activateConnectorCatchup(f.options),/cannot be resolved/);
 f.options.discover=async()=>({references:[],cursor:'stuck'});await assert.rejects(activateConnectorCatchup(f.options),/did not advance/);
 f.options.discover=async()=>({references:[ref],cursor:null});f.options.resolve=async input=>({...await resolve(input),binding:{...(await resolve(input)).binding,tenantId:'org_foreign'}});await assert.rejects(activateConnectorCatchup(f.options),/differs/);
});
test('concurrent activation is serialized and malformed completion is rejected',{skip:!postgresUrl},async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),gate=Promise.withResolvers();const handle=f.options.client.workflow.getHandle;
 f.options.client.workflow.getHandle=id=>({...handle(id),result:async()=>{entered.resolve();await gate.promise;return {cursor:null,failed:0};}});
 const first=activateConnectorCatchup(f.options);await entered.promise;try{await assert.rejects(activateConnectorCatchup(f.options),/already running/);}finally{gate.resolve();}await first;
 await f.database.pool.query('UPDATE opencrawl_connector_catchup_runs SET run_id=NULL WHERE namespace=$1',[f.database.namespace]);await assert.rejects(activateConnectorCatchup(f.options),/inconsistent/);
});
test('completed rows cannot authorize a forged source or installation manifest',{skip:!postgresUrl},async t=>{
 const f=await fixture(t);await activateConnectorCatchup(f.options);
 await f.database.pool.query("UPDATE opencrawl_connector_catchup_runs SET bucket='foreign' WHERE namespace=$1",[f.database.namespace]);await assert.rejects(activateConnectorCatchup(f.options),/inconsistent/);
 await f.database.pool.query('UPDATE opencrawl_connector_catchup_runs SET bucket=$2 WHERE namespace=$1',[f.database.namespace,source.bucket]);
 await f.database.pool.query("UPDATE opencrawl_connector_catchups SET task_queue='old-worker' WHERE namespace=$1",[f.database.namespace]);await assert.rejects(activateConnectorCatchup(f.options),/inconsistent/);
});
test('real Temporal full catch-up retries an activity, follows the actual workflow, replays and resumes from PG',{skip:!postgresUrl||process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:120000},async t=>{
 Runtime.install({logger:new DefaultLogger('ERROR')});const f=await fixture(t),env=await TestWorkflowEnvironment.createLocal();t.after(()=>env.teardown());
 const workflowBundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../dist/src/connectors/temporal/workflows.cjs',import.meta.url))});
 let attempts=0,processed=0;const worker=await Worker.create({connection:env.nativeConnection,taskQueue:'fixture-v1',workflowBundle,activities:{listPage:async()=>({keys:['fixture-object'],cursor:null}),processObject:async()=>{if(++attempts===1)throw Error('transient fixture failure');processed++;return {records:1};}}});
 f.options.client=env.client;const result=await worker.runUntil(()=>activateConnectorCatchup(f.options));assert.equal(result.completed,true);assert.equal(processed,1);assert.equal(attempts,2);
 const saved=(await f.database.pool.query('SELECT workflow_id,run_id FROM opencrawl_connector_catchup_runs WHERE namespace=$1',[f.database.namespace])).rows[0];
 const history=await env.client.workflow.getHandle(saved.workflow_id,saved.run_id).fetchHistory();await Worker.runReplayHistory({workflowBundle},history);
 const started=history.events.find(event=>event.workflowExecutionStartedEventAttributes).workflowExecutionStartedEventAttributes;
 assert.deepEqual(JSON.parse(Buffer.from(started.input.payloads[0].data).toString()),{...ref,generation:'v1'});
 assert.deepEqual(await activateConnectorCatchup(f.options),result);assert.equal(processed,1);
});
