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

test('connection links select the exact account and recheck its current visibility',async()=>{
  const {createIntegrations}=await import('../dist/src/integrations/service.mjs');
  const {connectionPath,connectionPage}=await import('../dist/src/application/connection-links.mjs');
  const {workspaceLinkHint}=await import('../dist/src/state/capture-links.mjs');
  const base={tenantId:'org_team',userId:'owner',environment:'selfhost',provider:'github',scope:'team',status:'active'};
  const records=['first account','second account','personal','removed','foreign'].map((account,i)=>({...base,account,integrationId:'int_'+String(i).repeat(26)}));
  records[2].provider='notes';records[2].scope='user';records[3].status='deleted';records[4].tenantId='org_other';
  records.push({...base,integrationId:'int_'+'5'.repeat(26),environment:'production',account:'other environment'},
    {...base,integrationId:'int_'+'6'.repeat(26),status:'connecting',account:'unfinished sign-in'});
  let revoke=false,reads=0;
  const registry={listTenant:async()=>records,get:async(tenant,user,id)=>{
    reads++;return revoke?null:records.find(r=>r.tenantId===tenant&&r.userId===user&&r.integrationId===id);
  }};
  const providers=Object.fromEntries([['github','team'],['notes','user']].map(([id,scope])=>[id,{id,name:id,scope,unavailableReason:'Offline'}]));
  const service=createIntegrations({environment:'selfhost',appUrl:'https://self.example',registry,providers,workspaceId:async()=>'workspace',destination:{},oauth:{},airbyte:{},buckets:{}});
  const href=connectionPath(workspaceLinkHint(principal.tenantId),records[0].integrationId);
  assert.equal(connectionPage(href).integrationId,records[0].integrationId);assert.equal(connectionPage('/integrations/github/callback'),null);
  const first=await service.connection(principal,records[0].integrationId);
  assert.equal(first.account,'first account');
  assert.deepEqual(first.otherConnections,[{account:'second account',path:connectionPath(workspaceLinkHint(principal.tenantId),records[1].integrationId)}]);
  assert.equal((await service.connection(principal,records[1].integrationId)).account,'second account');
  for(const entry of records.slice(2))assert.equal(await service.connection(principal,entry.integrationId),null);
  assert.equal(await service.connection({...principal,captureAccess:'write'},records[0].integrationId),null);
  assert.equal(reads,2);assert.equal((await service.connection({...principal,userId:'owner'},records[2].integrationId)).account,'personal');
  revoke=true;assert.equal(await service.connection(principal,records[1].integrationId),null);
});
