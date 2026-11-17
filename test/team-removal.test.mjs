import {test} from 'node:test';
import assert from 'node:assert/strict';
import {teamService} from '../dist/src/identity/team.mjs';
import {roleWriteGuard} from '../dist/src/identity/role-write.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
const org='org_team',admin={id:'user_admin',email:'admin@example.com'};
function fixture(){
 const members=new Map(['admin','bob','other'].map(name=>['om_'+name,{id:'om_'+name,userId:'user_'+name,organizationId:name==='other'?'org_other':org,status:'active',role:{slug:name==='admin'?'admin':'member'}}]));
 const deleted=[],revoked=[],store=memorySessionStore();
 const directory={userManagement:{
  listOrganizationMemberships:async({userId,organizationId})=>({data:[...members.values()].filter(m=>(!userId||m.userId===userId)&&(!organizationId||m.organizationId===organizationId))}),
  deleteOrganizationMembership:async id=>{deleted.push(id);members.delete(id);},
  updateOrganizationMembership:async(id,{roleSlug})=>{const m=members.get(id);m.role={slug:roleSlug};return m;},
 }};
 const service=teamService(directory,roleWriteGuard(store,'access'),async principal=>{revoked.push(principal);});
 return {members,deleted,revoked,directory,store,service};
}
test('member removal resolves its target only within the trusted organization and revokes its capture delegations',async()=>{
 const f=fixture();
 await assert.rejects(f.service.removeMember(admin,org,'user_other'),{status:404});
 await assert.rejects(f.service.removeMember({id:'user_bob'},org,'user_admin'),{status:403});
 await assert.rejects(f.service.removeMember(admin,org,admin.id),{status:400});
 await assert.rejects(f.service.removeMember(admin,org,'../user_bob'),{status:400});
 assert.deepEqual(f.deleted,[]);
 assert.deepEqual(await f.service.removeMember(admin,org,'user_bob'),{ok:true,userId:'user_bob'});
 assert.deepEqual(f.deleted,['om_bob']);assert.deepEqual(f.revoked,[{tenantId:org,userId:'user_bob'}]);
 assert.ok(f.members.has('om_admin'));assert.ok(f.members.has('om_other'));
 await assert.rejects(f.service.removeMember(admin,org,'user_bob'),{status:404});
});
test('directory-managed members cannot be removed through the application',async()=>{
 const f=fixture();f.members.get('om_bob').directoryManaged=true;
 await assert.rejects(f.service.removeMember(admin,org,'user_bob'),{status:409});
 assert.deepEqual(f.deleted,[]);assert.deepEqual(f.revoked,[]);
});
test('reciprocal removals and demotions share one cross-replica guard and retain an administrator',async()=>{
 for(const action of ['removeMember','changeRole']){
  const f=fixture();f.members.get('om_bob').role={slug:'admin'};
  const results=await Promise.allSettled([f.service.removeMember(admin,org,'user_bob'),f.service[action]({id:'user_bob'},org,'user_admin','member')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.ok([...f.members.values()].some(m=>m.organizationId===org&&m.role.slug==='admin'));
  await assert.rejects(f.service[action]({id:'user_bob'},org,'user_admin','member'),{status:403});
 }
});
test('an uncertain provider deletion keeps further team writes blocked',async()=>{
 const f=fixture();f.directory.userManagement.deleteOrganizationMembership=async()=>{throw Error('timeout after dispatch');};
 await assert.rejects(f.service.removeMember(admin,org,'user_bob'),{status:503});
 await assert.rejects(f.service.changeRole(admin,org,'user_bob','admin'),{status:409});
 assert.deepEqual(f.revoked,[]);
});
test('a provider success that retains membership is never reported as confirmed removal',async()=>{
 const f=fixture();f.directory.userManagement.deleteOrganizationMembership=async()=>{};
 await assert.rejects(f.service.removeMember(admin,org,'user_bob'),{status:503});
 await assert.rejects(f.service.removeMember(admin,org,'user_bob'),{status:409});
});
