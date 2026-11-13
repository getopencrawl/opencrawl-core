import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authorizedBoard} from '../dist/src/application/board.mjs';

test('reusing request admission never skips final authorization or permits a workspace mismatch',async()=>{
  const principal={tenantId:'org_a',userId:'user_a'};
  let admissions=0,checks=0,reads=0,active=true,revoke=false;
  const board=authorizedBoard({prefix:'board',
    store:{async readVersion(){reads++;if(revoke)active=false;return {data:null,version:null};},async compareAndSet(){return true;}},
    admit:async p=>{admissions++;return p;},
    authorize:async p=>{checks++;if(!active)throw Object.assign(Error('revoked'),{status:403});return p;},
  });
  await board.topics(principal,{workspace:'org_a'});
  assert.equal(admissions,1);assert.equal(checks,1);
  await assert.rejects(board.topics(principal,{workspace:'org_b'}),/scope/);assert.equal(reads,1);
  revoke=true;await assert.rejects(board.topics(principal,{workspace:'org_a'}),/revoked/);
  assert.equal(checks,2);
});
