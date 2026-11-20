import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createDevinState} from '../dist/src/state/devin.mjs';
import {createSetupState} from '../dist/src/state/setup.mjs';

const org='org-11111111111141118111111111111111', tenant='org_local';
test('a held grant binds exactly one future session, is encrypted and is erased on disconnect',{skip:!postgresUrl},async t=>{
  const db=await applicationDatabaseFixture(t);
  const state=createDevinState(db,randomBytes(32));await state.ready();
  const connection={schemaVersion:1,organizationId:org,tenantId:tenant,approvedBy:'admin',approvedAt:new Date().toISOString(),revokedAt:null,installations:[]};
  assert.ok(await state.saveConnection(org,null,connection));
  const version=async()=>(await state.readConnection(org)).version;
  const key='cog_synthetic_credential_for_grant';
  await state.eventGrants.set(tenant,org,await version(),key,true);
  const before=await state.eventGrants.read(tenant,org);
  assert.equal(before.sessionId,null);assert.equal(before.key,key);
  assert.equal(await state.eventGrants.read('foreign',org),null);
  const sql='SELECT event_grant,record FROM opencrawl_devin_connections WHERE namespace=$1 AND organization_id=$2';
  const stored=(await db.pool.query(sql,[db.namespace,org])).rows[0];
  assert.equal(stored.event_grant.includes(Buffer.from(key)),false);
  assert.equal(JSON.stringify(stored.record).includes(key),false);
  await state.eventGrants.select(tenant,org,await version(),'devin-target');
  assert.deepEqual(await state.eventGrants.read(tenant,org),{...before,sessionId:'devin-target'});
  const rev=await version();
  await assert.rejects(state.eventGrants.select(tenant,org,rev,'devin-other'),{status:409});
  await assert.rejects(state.eventGrants.set('foreign',org,rev,key),{status:404});
  assert.ok(await state.saveConnection(org,rev,{...connection,revokedAt:new Date().toISOString()}));
  assert.equal(await state.eventGrants.read(tenant,org),null);
  assert.equal((await db.pool.query(sql,[db.namespace,org])).rows[0].event_grant,null);
  assert.ok(await state.saveConnection(org,await version(),{...connection,approvedAt:new Date().toISOString()}));
  assert.equal(await state.eventGrants.read(tenant,org),null);
});

test('only the original Devin installation and uninterrupted recording selection are eligible',{skip:!postgresUrl},async t=>{
  const db=await applicationDatabaseFixture(t),setup=createSetupState(db);await setup.ready();
  for(const initialForward of [true,false]) {
    const scope={tenantId:tenant,userId:'workload_devin_'+(initialForward?'a':'b').repeat(64)};
    const stamp='2026-11-20T00:50:00Z', installationId='native-install';
    const record=forward=>({schemaVersion:1,scope,firstWin:null,installations:[{installationId,machine:{id:'machine',label:'VM'},updatedAt:stamp,
      clients:[{client:'devin',installed:true,forward,...(forward&&{forwardSince:stamp}),history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'not_required'}]}]});
    assert.ok(await setup.save(scope,null,record(initialForward)));
    const generation=initialForward?{installationId,forwardSince:stamp}:null;
    const original=await setup.read(scope);assert.deepEqual(original.devinInitialForward,generation);
    assert.ok(await setup.save(scope,original.version,record(false)));
    const resumed=record(true);resumed.installations[0].clients[0].forwardSince='2026-11-20T00:55:00Z';
    assert.ok(await setup.save(scope,(await setup.read(scope)).version,resumed));
    const current=await setup.read(scope);
    assert.equal(current.devinInitialForward,null);
    assert.notEqual(current.devinInitialForward?.forwardSince,current.record.installations[0].clients[0].forwardSince);
  }
});
