import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {TestWorkflowEnvironment,MockActivityEnvironment} from '@temporalio/testing';
import {Worker,Runtime,DefaultLogger,bundleWorkflowCode} from '@temporalio/worker';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {createOnlineShadow} from '../dist/src/state/online-shadow.mjs';
import {createOnlineMigrationController} from '../dist/src/state/online-temporal/controller.mjs';
import {onlineMigrationActivities} from '../dist/src/state/online-temporal/activities.mjs';
import {onlineMigrationReference,onlineMigrationTaskQueue,onlineMigrationWorkflowId} from '../dist/src/state/online-temporal/binding.mjs';
import {startOnlineMigration} from '../dist/src/state/online-temporal/client.mjs';
import {dropTestSchemas,postgresUrl} from './fixtures/application-database.mjs';

test('activity failures do not export source payloads, SQL or credentials to history',async()=>{
 const env=new MockActivityEnvironment();
 const acts=onlineMigrationActivities({advance:async()=>{throw Error('password=private-token body=private-source SQL=secret');}});
 await assert.rejects(env.run(acts.advanceOnlineMigrationV1,{bindingId:'a'.repeat(64),shard:0}),e=>{assert.equal(e.message,'Online migration page failed');assert.equal(e.type,'OnlineMigrationPageFailed');assert.equal(JSON.stringify(e).includes('private-token'),false);return true;});
 const unsafe=onlineMigrationActivities({advance:async()=>{throw Object.assign(Error('private scope'),{code:'ONLINE_MIGRATION_UNSAFE'});}});
 await assert.rejects(env.run(unsafe.advanceOnlineMigrationV1,{bindingId:'a'.repeat(64),shard:0}),e=>{assert.equal(e.nonRetryable,true);assert.equal(e.message,'Online migration binding or parity verification failed');return true;});
});

test('real Temporal and PG: worker restart, bounded history, deterministic resume and no runtime cutover',{
 skip:!postgresUrl||process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:180000,
},async t=>{
 Runtime.install({logger:new DefaultLogger('ERROR')});
 const schema='oc_shadow_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:postgresUrl,max:1});await admin.query('CREATE SCHEMA '+schema);
 const pool=new Pool({connectionString:postgresUrl,max:5,options:'-c search_path='+schema+' -c statement_timeout=5000'}),database={pool,namespace:schema};
 t.after(async()=>{await pool.end();try{await dropTestSchemas(admin,[schema]);}finally{await admin.end();}});
 const executable=process.env.OPENCRAWL_TEST_TEMPORAL_BINARY;
 const env=await TestWorkflowEnvironment.createLocal(executable?{server:{executable:{type:'existing-path',path:executable}}}:{});t.after(()=>env.teardown());
 const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../dist/src/state/online-temporal/workflows.cjs',import.meta.url))});
 const binding={epoch:randomUUID(),sourceId:'dynamodb:'+'a'.repeat(64),targetId:'b'.repeat(64),shards:1},reference=onlineMigrationReference(binding,0);
 const objects=new Map(Array.from({length:35},(_,i)=>['root/state/private-key-'+String(i).padStart(2,'0'),{version:'legacy-'+i,operationId:null,revision:null,deleted:false,bytes:Buffer.from('private-body-'+i),contentType:'text/plain'}]));
 const external={read:async key=>{const x=objects.get(key);return {...x,bytes:Buffer.from(x.bytes)};},putIfVersion:async(key,version,m)=>{if(objects.get(key).version!==version)return false;objects.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType});return true;},deleteIfVersion:async()=>assert.fail('no fixture delete')};
 const listing={listPage:async({prefix,cursor,limit})=>{const keys=[...objects.keys()].filter(key=>key.startsWith(prefix)&&(!cursor||key>cursor)).sort(),page=keys.slice(0,limit);return {keys:page,cursor:keys.length>limit?page.at(-1):null};}};
 const journal=createOnlineJournal({database,epoch:binding.epoch,sourceId:binding.sourceId}),shadow=createOnlineShadow({database,binding,journal,external,listing,roots:['root/state/'],classify:()=>({maxBytes:1024}),assertCurrent:async()=>{}});await shadow.ready();
 await pool.query('CREATE TABLE physical_preparation(id boolean PRIMARY KEY,pages integer NOT NULL)');await pool.query('INSERT INTO physical_preparation VALUES(true,0)');
 const adapter={...shadow.adapter,prepareSource:async()=>{const pages=(await pool.query('SELECT pages FROM physical_preparation WHERE id')).rows[0].pages;if(pages<2){await pool.query('UPDATE physical_preparation SET pages=pages+1 WHERE id');if(pages===0)throw Error('lost committed physical inventory response');return {ready:false};}return {ready:true};}};
 let controller=createOnlineMigrationController({database,binding,adapter,pageSize:1}),worker,calls=0,observations=0,stopAtObservation=1;
 const activities=()=>{const base=onlineMigrationActivities(controller);return {advanceOnlineMigrationV1:async ref=>{const value=await base.advanceOnlineMigrationV1(ref);calls++;if(value.parityObserved)observations++;if(calls===5||value.parityObserved&&observations===stopAtObservation)worker.shutdown();return value;}};};
 const options={connection:env.nativeConnection,namespace:env.namespace,taskQueue:onlineMigrationTaskQueue(binding),workflowBundle:bundle,maxCachedWorkflows:0,shutdownGraceTime:'5 seconds'};
 const handle=await startOnlineMigration(env.client,binding,0);assert.equal(handle.workflowId,onlineMigrationWorkflowId(reference));
 worker=await Worker.create({...options,activities:activities()});await worker.run();assert.equal(calls,5);assert.equal((await pool.query('SELECT pages FROM physical_preparation')).rows[0].pages,2);
 await Worker.runReplayHistory({workflowBundle:bundle},await handle.fetchHistory());
 controller=createOnlineMigrationController({database,binding,adapter,pageSize:1});
 worker=await Worker.create({...options,activities:activities()});await worker.run();assert.equal(observations,1);assert.equal((await handle.describe()).status.name,'RUNNING','parity is a round, never Workflow completion');
 const key='root/state/private-key-00';await journal.mutate({operationId:randomUUID(),key,mutation:{kind:'put',bytes:Buffer.from('private-later-write'),contentType:'text/plain'}},external);
 stopAtObservation=2;controller=createOnlineMigrationController({database,binding,adapter,pageSize:1});
 const again=await startOnlineMigration(env.client,binding,0);assert.equal(again.workflowId,handle.workflowId);
 worker=await Worker.create({...options,activities:activities()});await worker.run();assert.equal(observations,2);
 assert.equal((await pool.query('SELECT payload FROM opencrawl_online_shadow_objects WHERE source_key=$1',[key])).rows[0].payload.toString(),'private-later-write');
 assert.equal((await handle.describe()).status.name,'RUNNING');
 worker=await Worker.create({...options,activities:activities()});await worker.runUntil(async()=>{const status=await handle.query('onlineMigrationStatus');assert.equal(status.cutoverAuthorized,false);await handle.cancel();await assert.rejects(handle.result(),error=>error.cause?.name==='CancelledFailure');});
 let runId=handle.firstExecutionRunId,runs=0;const replayed=[];
 while(runId){
  const history=await env.client.workflow.getHandle(handle.workflowId,runId).fetchHistory();await Worker.runReplayHistory({workflowBundle:bundle},history);replayed.push({runId,events:history.events.length,sha256:createHash('sha256').update(JSON.stringify(history)).digest('hex')});
  assert.equal(history.events.some(e=>e.workflowTaskFailedEventAttributes),false);
  const inspect=value=>{if(value instanceof Uint8Array){const text=Buffer.from(value).toString();assert.equal(text.includes('private-key-'),false);assert.equal(text.includes('private-body-'),false);assert.equal(text.includes('private-later-write'),false);}else if(value&&typeof value==='object')for(const child of Object.values(value))inspect(child);};inspect(history);
  const continued=history.events.find(e=>e.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
  if(continued)assert.deepEqual(JSON.parse(Buffer.from(continued.input.payloads[0].data).toString()),reference);
  runId=continued?.newExecutionRunId;assert.ok(++runs<=10);
 }
 console.log(JSON.stringify({event:'online-migration.temporal-replayed',workflowId:handle.workflowId,bundleSha256:createHash('sha256').update(bundle.code).digest('hex'),replayed,physicalPages:2,cutoverAuthorized:false}));
 assert.ok(runs>=4,'page budget must continue as new');assert.equal((await pool.query('SELECT pages FROM physical_preparation')).rows[0].pages,2,'restarts and later replay do not repeat physical enumeration');assert.equal((await pool.query("SELECT to_regclass('opencrawl_application_installations') AS relation")).rows[0].relation,null);
});
