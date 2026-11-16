import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertApplicationSource} from '../dist/src/state/runtime.mjs';
test('standalone connector configuration cannot reuse checkpoints for another bucket or tenant',()=>{
 const database={sourceIdentity:{version:1,bucket:'installation-bucket',prefix:'sessions/shared/v1',organizationId:'org_installation'}};
 assertApplicationSource(database,{bucket:'installation-bucket',tenantId:'org_installation'});
 for(const [db,scope] of [[database,{bucket:'other-bucket',tenantId:'org_installation'}],[database,{bucket:'installation-bucket',tenantId:'org_other'}],[{}, {bucket:'installation-bucket',tenantId:'org_installation'}],[{sourceIdentity:{...database.sourceIdentity,organizationId:null}},{bucket:'installation-bucket',tenantId:'org_installation'}]])assert.throws(()=>assertApplicationSource(db,scope),{status:403,permanent:true});
});
