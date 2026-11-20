import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createSetupState} from '../dist/src/state/setup.mjs';

test('setup PostgreSQL state isolates namespace, workspace and person and rejects stale writes',{skip:!postgresUrl},async t=>{
  const first=await applicationDatabaseFixture(t),second=await applicationDatabaseFixture(t);
  const a=createSetupState(first),b=createSetupState(second);await Promise.all([a.ready(),b.ready()]);
  const scope={tenantId:'workspace',userId:'alice'};
  const record={schemaVersion:1,scope,firstWin:null,installations:[]};
  assert.equal(await a.save(scope,null,record),true);
  const saved=await a.read(scope);assert.deepEqual(saved.record,record);
  for(const other of [scope,{...scope,tenantId:'other'},{...scope,userId:'bob'}])assert.equal((await b.read(other)).record,null);
  for(const other of [{...scope,tenantId:'other'},{...scope,userId:'bob'}]){
    assert.equal((await a.read(other)).record,null);
    await assert.rejects(a.save(other,null,record));
  }
  assert.equal(await a.save(scope,null,record),false);
  assert.equal(await a.save(scope,saved.version,record),true);
  assert.equal(await a.save(scope,saved.version,record),false);
  assert.deepEqual((await createSetupState(first).read(scope)).record,record,'a new service instance preserves choices');
});

test('per-agent receipts survive a legacy setup writer and restart', {skip:!postgresUrl}, async t => {
  const db = await applicationDatabaseFixture(t);
  const state = createSetupState(db);
  await state.ready();
  const scope = {tenantId:'workspace', userId:'alice'};
  const seen = '2026-11-19T10:20:30Z';
  const client = {client:'codex', installed:true, forward:true, history:'skip', historyProgress:{state:'not_started',completed:0},
    hookTrust:'trusted', lastSeenAt:seen};
  const record = {schemaVersion:1, scope, firstWin:null, installations:[{installationId:'__proto__', machine:{id:'laptop',label:'Laptop'},
    updatedAt:seen, clients:[client]}]};
  assert.equal(await state.save(scope, null, record), true);
  const params = [db.namespace, scope.tenantId, scope.userId];
  const {rows:[stored]} = await db.pool.query('SELECT record FROM opencrawl_setup_status WHERE namespace=$1 AND tenant_id=$2 AND user_id=$3', params);
  assert.equal('lastSeenAt' in stored.record.installations[0].clients[0], false, 'legacy strict schema remains readable');
  stored.record.installations[0].machine.label = 'Renamed';
  await db.pool.query('UPDATE opencrawl_setup_status SET record=$4::jsonb WHERE namespace=$1 AND tenant_id=$2 AND user_id=$3', [...params, JSON.stringify(stored.record)]);
  const [installation] = (await createSetupState(db).read(scope)).record.installations;
  assert.equal(installation.machine.label, 'Renamed');
  assert.equal(installation.clients[0].lastSeenAt, seen);
  assert.equal((await state.read({...scope,userId:'bob'})).record, null);
});
