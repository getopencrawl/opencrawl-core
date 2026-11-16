import {test} from 'node:test';
import assert from 'node:assert/strict';
import {eventIdentityMigrationFailure,migrateEventIdentitySource} from '../dist/src/sessions/identity-migration.mjs';
import {eventIdentityLocation} from '../dist/src/sessions/event-identity.mjs';

test('identity migration diagnostics expose only fixed phase, error labels and bounded status',()=>{
 const secret='postgres://owner:secret@private-host/customer-key';
 const record=eventIdentityMigrationFailure(Object.assign(Error(secret),{name:secret,code:secret,status:503,detail:secret,cause:Error(secret)}),'list-source');
 assert.deepEqual(record,{migration:'event-identities-postgres',state:'failed',phase:'list-source',errorType:'other',code:null,status:503,reason:null});
 assert.equal(JSON.stringify(record).includes(secret),false);
 const known=eventIdentityMigrationFailure(Object.assign(Error('Invalid legacy event identity ledger'),{code:'40P01',status:409}),'migrate-session');
 assert.equal(known.reason,'Invalid legacy event identity ledger');assert.equal(known.code,'40P01');assert.equal(known.status,409);
 for(const status of [NaN,Infinity,'503',0,600])assert.equal(eventIdentityMigrationFailure({status},'database-ready').status,null);
});

test('identity migration diagnostic phase names the failing operation without source identifiers',async()=>{
 const prefix='sessions/diagnostic/v1',scope=eventIdentityLocation({prefix,principal:{tenantId:'private-tenant',userId:'private-user'},harness:'codex',installationId:'private-install',sessionId:'private-session'});
 for(const failing of ['database-ready','list-source','validate-inventory','migrate-session']){
  let phase;const error=Error('private-body'),store={listPage:async()=>{if(failing==='list-source')throw error;return {keys:failing==='validate-inventory'?['elsewhere/private-key']:[scope.key],nextToken:null};}},eventIdentities={ready:async()=>{if(failing==='database-ready')throw error;},migrateSession:async()=>{if(failing==='migrate-session')throw error;}};
  await assert.rejects(migrateEventIdentitySource({store,prefix,eventIdentities,onPhase:value=>{phase=value;}}));
  assert.equal(phase,failing);assert.equal(JSON.stringify(eventIdentityMigrationFailure(error,phase)).includes('private'),false);
 }
});
