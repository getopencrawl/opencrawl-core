import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {integrationRequest} from '../dist/src/application/integration-http.mjs';
const principal={tenantId:'org_team',userId:'user_admin'};
const admin={id:'om_admin',userId:principal.userId,organizationId:principal.tenantId,status:'active',role:{slug:'admin'}};
const actions=['connect','retry','disconnect','disconnect-all','callback'];
async function request(action,member,body){
  const calls=[],targets=[];let response;
  const callback=action==='callback',all=action==='disconnect-all';
  const route=all?{name:'/api/integrations/disconnect-all'}:callback?{name:'integration-callback',provider:'notion'}:{name:'integration-action',provider:'notion',action};
  const integrations=Object.fromEntries(['connect','retry','disconnect','disconnectAll','complete'].map(method=>[method,async (p,_provider,target)=>{
    assert.deepEqual(p,principal);calls.push(method);targets.push(target);return method==='complete'?{ok:true}:method==='disconnectAll'?0:{redirectUrl:'https://provider.example'};
  }]));
  await integrationRequest(Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]),new URL(callback?'https://self.example/integrations/notion/callback':`https://self.example/api/integrations/${all?action:'notion/'+action}`),route,{
    integrations,providers:{notion:{id:'notion',name:'Notion',scope:'team',auth:'oauth'}},principal,member,onboarding:null,guided:{},
    respond:(status,body)=>{response={status,body};},message:(status)=>{response={status};},document:()=>'',
  });
  return {calls,targets,response};
}
test('team integration mutations require a bound active admin before any provider or storage effect',async()=>{
  const denied=[undefined,{...admin,role:{slug:'member'}},{...admin,status:'inactive'},
    {...admin,userId:'user_other'},{...admin,organizationId:'org_other'}];
  for(const member of denied)for(const action of actions){
    const {calls,response}=await request(action,member);
    assert.equal(response.status,403,action);assert.deepEqual(calls,[],action);
  }
});
test('the bound admin can manage shared integrations and complete provider callbacks',async()=>{
  for(const action of actions){const {calls,response}=await request(action,admin);assert.equal(response.status,200,action);assert.equal(calls.length,1,action);}
});
test('retry and disconnect pass a validated integration ID to the service',async()=>{
  const integrationId='int_'+'a'.repeat(26);
  for(const action of ['retry','disconnect']){
    const valid=await request(action,admin,{integrationId});
    assert.equal(valid.response.status,200);assert.deepEqual(valid.targets,[integrationId]);
    const invalid=await request(action,admin,{integrationId:'invalid'});
    assert.equal(invalid.response.status,400);assert.deepEqual(invalid.calls,[]);
  }
});
