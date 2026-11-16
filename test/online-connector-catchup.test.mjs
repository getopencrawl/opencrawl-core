import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,Runtime,DefaultLogger,bundleWorkflowCode} from '@temporalio/worker';
import {activateConnectorCatchup} from '../dist/src/connectors/temporal/catchup.mjs';
import {createConnectorCacheRetirements} from '../dist/src/state/connector-cache-retirements.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const source={version:1,bucket:'fixture-bucket',prefix:'sessions/v1',organizationId:'org_fixture'};
const ref={tenantId:'org_fixture',userId:'user_owner',connectionId:'int_'+'a'.repeat(26)};
const live=(name,run)=>test(name,{skip:!postgresUrl},run);
async function fixture(t){
 const database=await applicationDatabaseFixture(t,{sourceIdentity:source});
 // An admitted runtime fixture with no offline source manifest or engine rows.
 // This tests catchup after admission, not admission itself.
 await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at) VALUES($1,$2::jsonb,$3,'ready',now())",[database.namespace,JSON.stringify(source),randomUUID()]);
 const proof={namespace:database.namespace,epoch:randomUUID(),targetId:hash('target'),sourceSetHash:hash('sources'),closedFrontiersHash:hash('closed'),retirementHash:hash('retired'),authorityReceiptHash:hash('authority')};
 const starts=[],client={options:{namespace:'default'},workflow:{start:async(type,input)=>starts.push({type,...input}),getHandle:id=>({result:async()=>({cursor:null,failed:0}),describe:async()=>({status:{name:'COMPLETED'},type:'indexConnectorV1',taskQueue:'fixture-v1',runId:'run-'+id})})}};
 const options={database,client,sourceId:'fixture',taskQueue:'fixture-v1',generation:'v1',onlineHandoff:{read:async()=>proof},discover:async()=>({references:[ref],cursor:null}),resolve:async reference=>({binding:{tenantId:reference.tenantId,connectionId:reference.connectionId,workspaceId:'workspace',provider:'notion',access:'workspace-global',rawPrefix:`raw/v1/source=notion/workspace=workspace/connection=${reference.connectionId}/`},store:{bucket:source.bucket},search:{identity:'fixture-index'}})};
 return {database,proof,starts,options};
}

live('online handoff runs current connectors without fabricated offline evidence and resumes durable completion',async t=>{
 const f=await fixture(t),result=await activateConnectorCatchup(f.options);assert.equal(result.required,true);assert.equal(result.completed,true);assert.deepEqual(result.onlineHandoff,f.proof);assert.equal('migrationId' in result,false);
 assert.equal(f.starts.length,1);assert.deepEqual(f.starts[0].args,[{...ref,generation:'v1'}]);
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_application_migrations WHERE namespace=$1',[f.database.namespace])).rows[0].n,0);
 assert.deepEqual((await f.database.pool.query('SELECT source_manifest_hash,inventory_complete FROM opencrawl_application_installations WHERE namespace=$1',[f.database.namespace])).rows[0],{source_manifest_hash:null,inventory_complete:false});
 const row=(await f.database.pool.query('SELECT epoch,handoff,required_receipts FROM opencrawl_online_connector_catchups WHERE namespace=$1',[f.database.namespace])).rows[0];assert.deepEqual(row.handoff,f.proof);assert.equal(row.epoch,f.proof.epoch);assert.equal(row.required_receipts,'0');
 assert.deepEqual(await activateConnectorCatchup(f.options),result);assert.equal(f.starts.length,1);
});

live('existing offline retirements and additional obligations remain additive in online catchup',async t=>{
 const f=await fixture(t),retirement=createConnectorCacheRetirements(f.database);await retirement.ready();
 await retirement.importRetirement({version:1,kind:'object',bucket:source.bucket,key:'old-receipt',sourceHash:hash('old'),disposition:'full-temporal-connector-catchup',receipt:{pipeline:'legacy',key:'raw/object',sha256:hash('object'),records:1,sourceRecords:1}});
 f.options.additionalRequirement=async()=>({receipts:2,buckets:['other-bucket'],receiptIdentity:hash('additional')});
 await activateConnectorCatchup(f.options);assert.equal((await f.database.pool.query('SELECT required_receipts FROM opencrawl_online_connector_catchups WHERE namespace=$1',[f.database.namespace])).rows[0].required_receipts,'3');assert.equal((await retirement.required()).receipts,1);
});

live('new epoch or retirement provenance cannot reuse a prior online workflow completion',async t=>{
 const f=await fixture(t),one=await activateConnectorCatchup(f.options);
 f.options.onlineHandoff.read=async()=>({...f.proof,retirementHash:hash('tombstoned-retirement-still-requires-current-catchup')});
 const two=await activateConnectorCatchup(f.options);assert.notEqual(two.activationId,one.activationId);assert.equal(f.starts.length,2);assert.notEqual(f.starts[1].workflowId,f.starts[0].workflowId);
});

live('changed trusted handoff fails before dispatch and after workflow result without completing rows',async t=>{
 const f=await fixture(t);let reads=0;f.options.onlineHandoff.read=async()=>++reads===1?f.proof:{...f.proof,authorityReceiptHash:hash('changed')};
 await assert.rejects(activateConnectorCatchup(f.options),/handoff changed/);assert.equal(f.starts.length,0);
 f.options.onlineHandoff.read=async()=>f.proof;const get=f.options.client.workflow.getHandle;
 f.options.client.workflow.getHandle=id=>({...get(id),result:async()=>{f.proof.closedFrontiersHash=hash('new frontier');return {cursor:null,failed:0};}});
 await assert.rejects(activateConnectorCatchup(f.options),/handoff changed/);
 assert.equal((await f.database.pool.query('SELECT count(*) FILTER(WHERE completed_at IS NOT NULL)::int n FROM opencrawl_online_connector_catchup_runs WHERE namespace=$1',[f.database.namespace])).rows[0].n,0);
});

live('failed workflow resumes the same online identity, while nonterminal or partial result never completes',async t=>{
 const f=await fixture(t),get=f.options.client.workflow.getHandle;let failure=true;
 f.options.client.workflow.getHandle=id=>({...get(id),result:async()=>{if(failure)throw Error('synthetic failure');return {cursor:null,failed:0};}});
 await assert.rejects(activateConnectorCatchup(f.options),/synthetic failure/);failure=false;await activateConnectorCatchup(f.options);assert.equal(f.starts[0].workflowId,f.starts[1].workflowId);
 for(const result of [{cursor:'more',failed:0},{cursor:null,failed:1},{cursor:null,failed:0,paginationFailure:'cycle'}]){
  const g=await fixture(t),handle=g.options.client.workflow.getHandle;g.options.client.workflow.getHandle=id=>({...handle(id),result:async()=>result});
  await assert.rejects(activateConnectorCatchup(g.options),/full successful scan/);assert.equal((await g.database.pool.query('SELECT completed_at FROM opencrawl_online_connector_catchups WHERE namespace=$1',[g.database.namespace])).rows[0].completed_at,null);
 }
});

live('wrong online namespace or unready application cannot dispatch or grant catchup completion',async t=>{
 const f=await fixture(t);f.options.onlineHandoff.read=async()=>({...f.proof,namespace:'foreign'});await assert.rejects(activateConnectorCatchup(f.options),/Invalid online/);assert.equal(f.starts.length,0);
 f.options.onlineHandoff.read=async()=>f.proof;await f.database.pool.query("UPDATE opencrawl_application_installations SET state='importing' WHERE namespace=$1",[f.database.namespace]);
 await assert.rejects(activateConnectorCatchup(f.options),/incomplete/);assert.equal(f.starts.length,0);
});

test('real Temporal online handoff awaits actual full scan and reuses PostgreSQL completion',{skip:!postgresUrl||process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:120000},async t=>{
 Runtime.install({logger:new DefaultLogger('ERROR')});const f=await fixture(t),env=await TestWorkflowEnvironment.createLocal(process.env.OPENCRAWL_TEST_TEMPORAL_BINARY?{server:{executable:{type:'existing-path',path:process.env.OPENCRAWL_TEST_TEMPORAL_BINARY}}}:{});t.after(()=>env.teardown());
 const workflowBundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../dist/src/connectors/temporal/workflows.cjs',import.meta.url))});let indexed=0;
 const worker=await Worker.create({connection:env.nativeConnection,taskQueue:'fixture-v1',workflowBundle,activities:{listPage:async()=>({keys:['fixture-object'],cursor:null}),processObject:async()=>{indexed++;return {records:1};}}});
 f.options.client=env.client;const result=await worker.runUntil(()=>activateConnectorCatchup(f.options));assert.equal(result.completed,true);assert.equal(indexed,1);
 const row=(await f.database.pool.query('SELECT workflow_id,run_id FROM opencrawl_online_connector_catchup_runs WHERE namespace=$1',[f.database.namespace])).rows[0];assert.ok(row.run_id);await Worker.runReplayHistory({workflowBundle},await env.client.workflow.getHandle(row.workflow_id,row.run_id).fetchHistory());
 assert.deepEqual(await activateConnectorCatchup(f.options),result);assert.equal(indexed,1);
});


test('connector handoff destroys uncertain SQL sessions but explicitly unlocks ordinary failures',async()=>{
 for(const uncertain of [true,false]){
  const timeout=Error('synthetic SQL acquisition timeout'),queries=[],releases=[];
  const proof={namespace:'fixture',epoch:randomUUID(),targetId:hash('target'),sourceSetHash:hash('sources'),closedFrontiersHash:hash('closed'),retirementHash:hash('retired'),authorityReceiptHash:hash('authority')};
  const sql={query:async text=>{queries.push(text);if(text.includes('pg_try_advisory_lock')){if(uncertain)throw timeout;return {rows:[{locked:true}]};}return {rows:[]};},release:destroy=>releases.push(destroy)};
  const database={namespace:'fixture',pool:{query:async text=>{if(text.startsWith('SELECT * FROM opencrawl_application_installations'))return {rows:[{state:'ready',migration_id:randomUUID()}]};if(text.includes('to_regclass'))return {rows:[{table:null}]};throw Error('Unexpected pool SQL');},connect:async()=>sql},transaction:async fn=>fn({query:async()=>({rows:[]})})};
  await assert.rejects(activateConnectorCatchup({database,client:{options:{namespace:'default'}},sourceId:'fixture',taskQueue:'fixture',generation:'v1',onlineHandoff:{read:async()=>proof},discover:async()=>({references:[],cursor:null}),resolve:async()=>{throw Error('No current references');}}),error=>uncertain?error===timeout:/installation evidence is inconsistent/.test(error.message));
  assert.deepEqual(releases,[uncertain]);assert.equal(queries.filter(text=>text.includes('pg_advisory_unlock')).length,uncertain?0:1);
 }
});
