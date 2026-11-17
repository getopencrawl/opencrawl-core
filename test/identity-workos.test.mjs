import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workosDirectory} from '../dist/src/identity/workos.mjs';
import {currentVerifiedUser} from '../dist/src/identity/auth.mjs';
import {activeMemberships} from '../dist/src/identity/principal.mjs';

test('WorkOS adapter strips provider fields and local enrollment authority, preserving pagination',async()=>{
  const row={id:'om_a',userId:'user_a',organizationId:'org_a',status:'active',role:{slug:'admin',permissions:['private']},metadata:{private:'hidden'}};
  const sdk={userManagement:{getUser:async()=>({id:'user_a',email:'a@example.com',emailVerified:false,locallyEnrolled:true,metadata:{private:'hidden'}}),
    listOrganizationMemberships:async()=>({data:[],autoPagination:async()=>[row]})},organizations:{getOrganization:async id=>({id,name:'Team',metadata:{secret:'hidden'}})}};
  const directory=workosDirectory(sdk);
  assert.equal((await currentVerifiedUser(directory,'user_a')).status,403);
  assert.deepEqual(await directory.organizations.getOrganization('org_a'),{id:'org_a',name:'Team'});
  const [member]=await activeMemberships(directory,'user_a','org_a');
  assert.equal(member.id,'om_a');assert.deepEqual(member.role,{slug:'admin'});assert.equal(member.metadata,undefined);
  assert.deepEqual(await activeMemberships(directory,'user_a','org_foreign'),[]);
});

test('WorkOS membership removal calls the provider deletion operation with the resolved membership ID',async()=>{
 const deleted=[];const directory=workosDirectory({userManagement:{deleteOrganizationMembership:async id=>{deleted.push(id);}}});
 await directory.userManagement.deleteOrganizationMembership('om_resolved');assert.deepEqual(deleted,['om_resolved']);
});
