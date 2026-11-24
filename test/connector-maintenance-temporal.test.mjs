import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker, Runtime, DefaultLogger} from '@temporalio/worker';
import {buildConnectorWorkflows,createConnectorMaintenanceWorker} from '../dist/src/connectors/temporal/worker.mjs';
import {connectorMaintenanceJob} from '../dist/src/connectors/temporal/maintenance.mjs';
import {connectorTransitionScheduler,ensureConnectorMaintenance} from '../dist/src/connectors/temporal/client.mjs';

test('Temporal resumes the disconnect deadline after worker replacement, deduplicates discovery and replays both histories', {
  skip: !process.env.OPENCRAWL_TEST_TEMPORAL, timeout:120000,
},async(t)=>{
  Runtime.install({logger:new DefaultLogger('ERROR')});
  const path=await mkdtemp(join(tmpdir(),'connector-maintenance-'));t.after(()=>rm(path,{recursive:true,force:true}));
  const bundlePath=join(path,'workflows.cjs');await buildConnectorWorkflows(bundlePath);
  const executable=process.env.OPENCRAWL_TEMPORAL_CLI;
  const env=await TestWorkflowEnvironment.createLocal(executable?{server:{executable:{type:'existing-path',path:executable}}}:undefined);
  t.after(()=>env.teardown());
  const sourceId='test',taskQueue='maintenance-test';
  await ensureConnectorMaintenance(env.client,{sourceId,taskQueue});
  await ensureConnectorMaintenance(env.client,{sourceId,taskQueue});
  const schedules=[];for await(const schedule of env.client.schedule.list())schedules.push(schedule);
  assert.equal(schedules.length,2);
  for(const schedule of schedules)await env.client.schedule.getHandle(schedule.scheduleId).pause();
  const record={tenantId:'org_test',userId:'user_1',integrationId:'int_'+'a'.repeat(26),provider:'slack',scope:'team',status:'disconnected',disconnectedAt:new Date().toISOString()};
  const {job,id}=connectorMaintenanceJob(sourceId,'v1',record);
  const submit=connectorTransitionScheduler({address:env.address,namespace:env.namespace??'default',sourceId,generation:'v1',taskQueue});
  let passes=0;
  const activities={
    listConnectorMaintenance:async()=>({jobs:[{id,job},{id,job}],failed:0,cursor:null}),
    ensureActiveConnector:async()=>assert.fail('Unexpected active reference'),
    purgeDisconnectedConnector:async()=>++passes===1?Date.now()+2000:null,
  };
  const options={connection:env.nativeConnection,namespace:env.namespace,taskQueue,bundlePath,activities};
  const first=await createConnectorMaintenanceWorker(options);
  const run=first.run();
  try {
    await Promise.all([submit(record),submit(record)]);
    const parent=await env.client.workflow.start('reconcileConnectorsV1',{workflowId:'test-discovery',taskQueue,args:[{sourceId,status:'disconnected'}]});
    await parent.result();
    const child=env.client.workflow.getHandle('connector-purge-'+id);
    for(let i=0;i<100;i++){
      if((await child.fetchHistory()).events.some(ev=>ev.timerStartedEventAttributes))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok((await child.fetchHistory()).events.some(ev=>ev.timerStartedEventAttributes));
    first.shutdown();await run;
    const replacement=await createConnectorMaintenanceWorker(options);
    await replacement.runUntil(child.result());
    assert.equal(passes,2);
    for(const handle of [parent,child])await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},await handle.fetchHistory());
  } finally {
    if(first.getState()==='RUNNING')first.shutdown();
    await run;
  }
});
