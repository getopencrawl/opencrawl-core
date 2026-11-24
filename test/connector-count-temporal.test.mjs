import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,bundleWorkflowCode} from '@temporalio/worker';
import {startConnectorCounts,recoverConnectorCounts} from '../dist/src/connectors/temporal/client.mjs';

const reference={tenantId:'org_a',userId:'user_a',connectionId:'int_'+'a'.repeat(26),generation:'v6'};
const taskQueue='connector-counts-test';

test('lost-start recovery visits a bounded page of admitted requests, independently of a failed start',async()=>{
  const attempts=[];
  const start=async (type,{args,workflowIdConflictPolicy})=>{
    assert.equal(type,'materializeConnectorCountsV1');
    assert.equal(workflowIdConflictPolicy,'USE_EXISTING');
    attempts.push(args[0]);
    if(args[0].reference.tenantId==='org_b') throw new Error('Transient');
  };
  const state={listPending:async(env,n)=>{
    assert.equal(env,'production');assert.equal(n,25);
    return ['org_a','org_b'].map(tenantId=>({tenantId,userId:'user_a',integrationId:reference.connectionId,binding:'private'}));
  }};
  assert.deepEqual(await recoverConnectorCounts({workflow:{start}},{state,environment:'production',generation:'v6',taskQueue}),{attempted:2,failed:1});
  assert.deepEqual(attempts,[{reference},{reference:{...reference,tenantId:'org_b'}}]);
});

test('Temporal deduplicates demand, resumes bounded pages on replacement, and replays a prior run', {
  skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:120000,
},async t=>{
  const executable=process.env.OPENCRAWL_TEST_TEMPORAL_EXECUTABLE;
  const env=await TestWorkflowEnvironment.createLocal(executable?{server:{executable:{type:'existing-path',path:executable}}}:{});
  t.after(()=>env.teardown());
  const bundle=await bundleWorkflowCode({workflowsPath:fileURLToPath(new URL('../dist/src/connectors/temporal/count-workflows.cjs',import.meta.url))});
  const starts=await Promise.all(Array.from({length:3},()=>startConnectorCounts(env.client,reference,taskQueue)));
  assert.equal(new Set(starts.map(h=>h.firstExecutionRunId)).size,1);
  let begun=0,revision=0;
  const replacementReady=Promise.withResolvers();
  const activities={
    async beginConnectorCounts(input){assert.equal(input.generation,'v6');assert.ok(input.passId);begun++;return {generation:'count-pass',revision:0};},
    async advanceConnectorCounts(input){
      assert.deepEqual(input,{...reference,countGeneration:'count-pass',revision});
      revision++;
      if(revision===8)replacementReady.resolve();
      return {revision,done:revision===22};
    },
  };
  const options={workflowBundle:bundle,connection:env.nativeConnection,taskQueue,activities};
  const one=await Worker.create(options);
  const firstRun=one.run();
  await replacementReady.promise;
  one.shutdown();await firstRun;
  const two=await Worker.create(options);
  await two.runUntil(starts[0].result());
  assert.equal(begun,1);
  assert.equal(revision,22);
  const h=env.client.workflow.getHandle(starts[0].workflowId,starts[0].firstExecutionRunId);
  await Worker.runReplayHistory({workflowBundle:bundle},await h.fetchHistory());
});
