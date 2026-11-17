import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {credentialVault} from '../dist/src/integrations/credential-vault.mjs';
import {createSlackOAuth} from '../dist/src/integrations/slack-oauth.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';
const org='org_oss',user='user_a',integrationId='int_'+'a'.repeat(26),url='https://oss.example.com';
const scopes='channels:read,channels:history,search:read,users:read,team:read,emoji:read';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-credential-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createLocalSessionStore(dir),key=Buffer.alloc(32,7),vault=credentialVault({store,key,prefix:'credentials',organizationId:org});
  const state={calls:[],now:Date.now(),exchangeGate:null,revoke:false,connectedAccountId:null};
  const record={tenantId:org,userId:user,integrationId,provider:'slack',status:'provisioning'};
  const registry={get:async()=>({...record,connectedAccountId:state.connectedAccountId})};
  const send=async(target,options={})=>{
    const u=new URL(target);state.calls.push({url:u.href,options});
    if(u.pathname==='/api/oauth.v2.access'){
      await state.exchangeGate?.();
      if(state.failExchange)throw new Error('lost provider response');
      return Response.json({ok:true,authed_user:{token_type:'user',access_token:'access-secret',refresh_token:'refresh-secret',scope:scopes,expires_in:120}});
    }
    if(u.pathname==='/api/auth.revoke')return Response.json({ok:true,revoked:true});
    if(u.pathname==='/api/conversations.list')return Response.json({ok:true,channels:[{id:'C_PUBLIC',name:'general',is_private:false},{id:'C_PRIVATE',name:'private',is_private:true}]});
    if(u.pathname==='/api/search.messages')return Response.json({ok:true,messages:{matches:[{text:'public',channel:{id:'C_PUBLIC'}},{text:'private',channel:{id:'C_PRIVATE'}}]}});
    return Response.json({ok:true,team_id:'T123',team:'Test',user:'Test'});
  };
  const service=createSlackOAuth({organizationId:org,url,proxyUrl:url,clientId:'client-id',clientSecret:'client-secret',vault,registry,fetch:send,now:()=>state.now});
  const callbackUrl=url+'/integrations/slack/callback?integration='+integrationId+'&state=integration-nonce';
  const link=await service.link({authConfigId:'slack',userId:`selfhost:${org}:${user}`,callbackUrl});state.connectedAccountId=link.connected_account_id;
  const flow=new URL(link.redirect_url).searchParams.get('state'),query=()=>new URLSearchParams({state:flow,code:'one-use-code'});
  const connect=()=>service.complete({tenantId:org,userId:user},query());
  return {store,key,vault,state,service,link,query,connect,record,callbackUrl};
}
test('OAuth secrets are encrypted, scope-bound, and never included in Airbyte source settings',async t=>{
  const f=await fixture(t);assert.equal(await f.connect(),f.callbackUrl);
  const g=await f.vault.read(f.link.connected_account_id);
  const bytes=await f.store.get(`credentials/${org}/${g.record.id}.enc`);
  assert.ok(!bytes.includes(Buffer.from('access-secret')));assert.ok(!bytes.includes(Buffer.from('refresh-secret')));
  await assert.rejects(f.vault.write(g.record,null),{status:409});
  await assert.rejects(credentialVault({store:f.store,key:Buffer.alloc(32,8),prefix:'credentials',organizationId:org}).read(g.record.id));
  const other='grant_'+'b'.repeat(48);await f.store.put(`credentials/${org}/${other}.enc`,bytes);await assert.rejects(f.vault.read(other));
  const config=await f.service.sourceConfiguration({...f.record,connectedAccountId:g.record.id},{sourceConfiguration:()=>({start_date:'2026-01-01'})});
  assert.ok(config.credential_proxy_api_key);assert.doesNotMatch(JSON.stringify(config),/access-secret|refresh-secret|client-secret/);
});
test('OAuth callback is owner-bound, single-use, and a lost token response never repeats the exchange',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.complete({tenantId:org,userId:'user_foreign'},f.query()),{status:403});
  assert.equal(f.state.calls.length,0);
  f.state.failExchange=true;await assert.rejects(f.connect(),/lost provider/);
  f.state.failExchange=false;await assert.rejects(f.connect(),{status:403});
  assert.equal(f.state.calls.filter(c=>c.url.endsWith('/oauth.v2.access')).length,1);
  assert.equal((await f.vault.read(f.link.connected_account_id)).record.status,'EXCHANGING');
});
test('proxy credentials are source-specific, read-only, and return only current public-channel results',async t=>{
  const f=await fixture(t);await f.connect();const id=f.link.connected_account_id,g=(await f.vault.read(id)).record;
  const call=(input,secret=g.proxyToken)=>f.service.proxyCredential(id,secret,`selfhost:${org}:${user}`,input);
  await assert.rejects(call({endpoint:'https://slack.com/api/auth.test'},'wrong'),{status:403});
  await assert.rejects(call({endpoint:'https://evil.example.com/api/auth.test'}),{status:403});
  await assert.rejects(call({endpoint:'https://slack.com/api/chat.postMessage',method:'POST'}),{status:403});
  await assert.rejects(call({endpoint:'https://slack.com/api/search.messages',query:{query:'secret'}}),{status:403});
  await assert.rejects(call({endpoint:'https://slack.com/api/search.messages',query:{query:'in:#private after:2026-01-01'}}),{status:403});
  const result=await call({endpoint:'https://slack.com/api/search.messages',query:{query:'in:#general after:2026-01-01'}});
  assert.deepEqual(result.data.messages.matches.map(x=>x.text),['public']);
  f.record.status='deleting';await assert.rejects(call({endpoint:'https://slack.com/api/auth.test'}),{status:403});
});
test('expiring tokens refresh once and local revocation denies all further proxy use',async t=>{
  const f=await fixture(t);await f.connect();f.state.now+=90000;
  const id=f.link.connected_account_id,g=(await f.vault.read(id)).record;
  await f.service.proxyCredential(id,g.proxyToken,`selfhost:${org}:${user}`,{endpoint:'https://slack.com/api/auth.test'});
  assert.equal(f.state.calls.filter(c=>c.url.endsWith('/oauth.v2.access')).length,2);
  await f.service.remove(id);assert.equal((await f.vault.read(id)).record.status,'REVOKED');
  assert.equal((await f.vault.read(id)).record.accessToken,undefined);
  await assert.rejects(f.service.proxyCredential(id,g.proxyToken,`selfhost:${org}:${user}`,{endpoint:'https://slack.com/api/auth.test'}),{status:403});
});
