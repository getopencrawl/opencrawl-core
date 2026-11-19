import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevinState} from '../dist/src/state/devin.mjs';
import {createDevinConnections} from '../dist/src/identity/devin-connections.mjs';
import {devinOwnerId} from '../dist/src/identity/devin.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';

test('one Devin organization can bind to only one tenant, including concurrent first enrollment and reconnect',{skip:!postgresUrl},async t=>{
  const database=await applicationDatabaseFixture(t),repository=createDevinState(database);
  await repository.ready();
  const org='org-11111111111141118111111111111111';
  const admins=['org_a','org_b'].map(tenantId=>({tenantId,userId:'user_admin'}));
  let adminActive=true,now=Date.now();
  const connections=createDevinConnections({repository,now:()=>now,isAdmin:async()=>adminActive,
    verify:async sessionId=>({status:200,workload:{organizationId:org,sessionId,expiresAt:now+60000}})});
  const approve=p=>connections.issue(p,{userId:p.userId,organizationId:p.tenantId,status:'active',role:{slug:'admin'}});
  const approvals=await Promise.all(admins.map(approve));
  const attempts=await Promise.allSettled(approvals.map(({code},i)=>connections.claim(code,'session-'+i)));
  assert.deepEqual(attempts.map(r=>r.status).sort(),['fulfilled','rejected']);
  const winner=attempts.findIndex(r=>r.status==='fulfilled'),loser=1-winner;
  assert.equal(attempts[loser].reason.status,409);
  assert.equal(await connections.resolveOrganization(org),admins[winner].tenantId);
  await assert.rejects(connections.revoke(admins[loser],org),{status:404});
  assert.deepEqual(await connections.sharedInstallations(admins[loser]),[]);
  const principal=sessionId=>({tenantId:admins[winner].tenantId,userId:devinOwnerId(org,sessionId),owner:{kind:'shared',provider:'devin',organizationId:org,sessionId}});
  await Promise.all(['first','second'].map(session=>connections.confirmInstallation(principal(session))));
  assert.equal((await connections.sharedInstallations(admins[winner])).length,1);

  now++;
  await connections.revoke(admins[winner],org);
  assert.equal(await connections.resolveOrganization(org),null);
  await assert.rejects(connections.claim(approvals[winner].code,'session-'+winner),{status:409});
  now++;
  const renewed=await approve(admins[winner]);
  adminActive=false;
  await assert.rejects(connections.claim(renewed.code,'fresh'),{status:403});
  adminActive=true;
  await connections.claim(renewed.code,'fresh');
  assert.deepEqual(await connections.sharedInstallations(admins[winner]),[]);
  await assert.rejects(connections.claim(renewed.code,'other-session'),{status:409});
});
