import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectorMaintenance} from '../dist/src/connectors/temporal/worker.mjs';
import {deleteConnectorSchedules} from '../dist/src/integrations/purge.mjs';

const start = Date.parse('2026-01-01T00:00:00Z');
const make = (tenantId, changes = {}) => ({tenantId, userId:'user_alice', integrationId:'int_'+'1'.repeat(26),
  environment:'production', provider:'slack', scope:'team', status:'disconnected', disconnectedAt:new Date(start).toISOString(), ...changes});
function fixture(rows) {
  let now = start;
  const writes = [];
  const activity = () => connectorMaintenance({sourceId:'test',environment:'production',generation:'v1',now:()=>now,
    listPage:async()=>({records:rows,cursor:null}),
    registry:{get:async(t,u,id)=>rows.find(r=>r.tenantId===t&&r.userId===u&&r.integrationId===id)??null,
      async update(row, patch, options) {
        assert.deepEqual(options,{whenStatus:['disconnected'],whenFields:{disconnectedAt:row.disconnectedAt}});
        Object.assign(row,patch);
      }},
    ensureActive:async row=>writes.push('ensure:'+row.tenantId), purge:async row=>writes.push('purge:'+row.tenantId)});
  return {writes,activity,advance:ms=>{now+=ms;}};
}
test('separate owners with colliding connection IDs settle independently and the acknowledged result survives a new worker',async()=>{
  const a=make('org_a'),b=make('org_b'),f=fixture([a,b]);
  const scan={sourceId:'test',status:'disconnected'};
  const {jobs}=await f.activity().listConnectorMaintenance(scan);
  assert.equal(jobs.length,2);
  assert.notEqual(jobs[0].id,jobs[1].id);
  assert.equal(await f.activity().purgeDisconnectedConnector(jobs[0].job),start+11*60000);
  assert.equal(a.searchPurge,undefined);
  f.advance(11*60000);
  assert.equal(await f.activity().purgeDisconnectedConnector(jobs[0].job),null);
  assert.equal(await f.activity().purgeDisconnectedConnector(jobs[0].job),null);
  assert.deepEqual(f.writes,['purge:org_a','purge:org_a']);
  assert.deepEqual((await f.activity().listConnectorMaintenance(scan)).jobs.map(x=>x.job.tenantId),['org_b']);
});
test('activity retries, stale inputs and malformed references cannot target a reconnected or foreign connection',async()=>{
  const a=make('org_a'),f=fixture([a,make('org_b',{environment:'selfhost'}),make('org_c',{disconnectedAt:'bad'})]);
  const {jobs}=await f.activity().listConnectorMaintenance({sourceId:'test',status:'disconnected'});
  assert.equal(jobs.length,1);
  const {job}=jobs[0];
  await assert.rejects(f.activity().purgeDisconnectedConnector({...job,sourceId:'elsewhere'}),{status:403});
  await assert.rejects(f.activity().purgeDisconnectedConnector({...job,tenantId:'org_b'}),{status:403});
  assert.equal(await f.activity().purgeDisconnectedConnector({...job,userId:'user_other'}),null);
  a.disconnectedAt=new Date(start+1000).toISOString();
  assert.equal(await f.activity().purgeDisconnectedConnector(job),null);
  a.status='active';
  assert.equal(await f.activity().purgeDisconnectedConnector(job),null);
  const {disconnectedAt: prior, ...active} = job;
  a.status='disconnecting';
  await f.activity().ensureActiveConnector(active);
  assert.deepEqual(f.writes,[]);
});
test('removes each retained generation and both Slack source schedules exactly once per purge pass',async()=>{
  const ids=[];
  await deleteConnectorSchedules(make('org_a'),['v1','v2','v3'],async id=>{
    ids.push(id); if(id.startsWith('slack-files-')) throw Object.assign(Error('missing'),{name:'ScheduleNotFoundError'});
  });
  assert.equal(new Set(ids).size,5);
  assert.deepEqual(ids.map(id=>id.slice(0,-65)),['connector','connector','connector','slack-files','slack-messages']);
  await assert.rejects(deleteConnectorSchedules(make('org_a'),['v1'],async()=>{throw Error('outage');}),/outage/);
});
