import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createConnectorSecrets} from '../dist/src/state/connector-secrets.mjs';
import {stateFor} from './fixtures/memory-application-state.mjs';
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
async function fixture(t,{persistent=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-credential-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createLocalSessionStore(dir),key=Buffer.alloc(32,7);
  const database=persistent?await applicationDatabaseFixture(t):null;
  const applicationState=database?{connectorSecrets:createConnectorSecrets(database)}:stateFor(store);if(database)await applicationState.connectorSecrets.ready();
  const vault=credentialVault({state:applicationState,key,prefix:'credentials',organizationId:org});
  const state={calls:[],now:Date.now(),exchangeGate:null,revoke:false,connectedAccountId:null};
  const record={tenantId:org,userId:user,integrationId,provider:'slack',status:'provisioning'};
  const registry={get:async()=>({...record,connectedAccountId:state.connectedAccountId})};
  const send=async(target,options={})=>{
    const u=new URL(target);state.calls.push({url:u.href,options});
    if(u.pathname==='/api/oauth.v2.access'){
      await state.exchangeGate?.();
      if(state.failExchange)throw new Error('lost provider response');
      const suffix=state.uniqueTokens?String(state.calls.filter(c=>c.url.endsWith('/oauth.v2.access')).length):'';
      return Response.json({ok:true,authed_user:{token_type:'user',access_token:'access-secret'+suffix,refresh_token:'refresh-secret'+suffix,scope:scopes,expires_in:120}});
    }
    if(u.pathname==='/api/auth.revoke'){if(state.failRevoke)throw Error('provider revoke unavailable');return Response.json({ok:true,revoked:true});}
    if(u.pathname==='/api/conversations.list')return Response.json({ok:true,channels:[{id:'C_PUBLIC',name:'general',is_private:false},{id:'C_PRIVATE',name:'private',is_private:true}]});
    if(u.pathname==='/api/search.messages')return Response.json({ok:true,messages:{matches:[{text:'public',channel:{id:'C_PUBLIC'}},{text:'private',channel:{id:'C_PRIVATE'}}]}});
    return Response.json({ok:true,team_id:'T123',team:'Test',user:'Test'});
  };
  const service=createSlackOAuth({organizationId:org,url,proxyUrl:url,clientId:'client-id',clientSecret:'client-secret',vault,registry,fetch:send,now:()=>state.now});
  const callbackUrl=url+'/integrations/slack/callback?integration='+integrationId+'&state=integration-nonce';
  const link=await service.link({authConfigId:'slack',userId:`selfhost:${org}:${user}`,callbackUrl});state.connectedAccountId=link.connected_account_id;
  const flow=new URL(link.redirect_url).searchParams.get('state'),query=()=>new URLSearchParams({state:flow,code:'one-use-code'});
  const connect=()=>service.complete({tenantId:org,userId:user},query());
  return {store,key,vault,state,service,link,query,connect,record,callbackUrl,applicationState,database};
}
test('OAuth secrets are encrypted, scope-bound, and never included in Airbyte source settings',async t=>{
  const f=await fixture(t);assert.equal(await f.connect(),f.callbackUrl);
  const g=await f.vault.read(f.link.connected_account_id);
  const bytes=(await stateFor(f.store).connectorSecrets.read({kind:'grant',organizationId:org,id:g.record.id},`credentials/${org}/${g.record.id}.enc`)).data;
  assert.ok(!bytes.includes(Buffer.from('access-secret')));assert.ok(!bytes.includes(Buffer.from('refresh-secret')));
  await assert.rejects(f.vault.write(g.record,null),{status:409});
  await assert.rejects(credentialVault({state:stateFor(f.store),key:Buffer.alloc(32,8),prefix:'credentials',organizationId:org}).read(g.record.id));
  const other='grant_'+'b'.repeat(48);await stateFor(f.store).connectorSecrets.compareAndSet({kind:'grant',organizationId:org,id:other},`credentials/${org}/${other}.enc`,null,bytes);await assert.rejects(f.vault.read(other));
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

test('Slack consent intent uses one deterministic grant and recovers the original redirect after lost acknowledgement',async t=>{
 const f=await fixture(t),input={authConfigId:'slack',userId:`selfhost:${org}:${user}`,callbackUrl:f.callbackUrl,requestId:'a'.repeat(32)};
 assert.equal(await f.service.recoverLink(input),null);
 const first=await f.service.link(input),again=await f.service.link(input);assert.deepEqual(again,first);assert.deepEqual(await f.service.recoverLink(input),first);
 assert.notEqual(first.connected_account_id,f.link.connected_account_id);assert.equal(f.state.calls.length,0);
 await assert.rejects(f.service.link({...input,callbackUrl:f.callbackUrl+'&other=changed'}),{status:403});
});

test('PostgreSQL keeps late exchange tokens encrypted for durable retirement after revocation wins',{skip:!postgresUrl},async t=>{
 const f=await fixture(t,{persistent:true}),started=Promise.withResolvers(),release=Promise.withResolvers();f.state.exchangeGate=async()=>{started.resolve();await release.promise;};
 const exchange=f.connect();await started.promise;await assert.rejects(f.service.remove(f.link.connected_account_id),{code:'ConnectorGrantSettlementPending'});
 let saved=(await f.vault.read(f.link.connected_account_id)).record;assert.equal(saved.status,'REVOKED');assert.equal(saved.tokenIntent.kind,'exchange');assert.equal(saved.remoteRevoked,undefined);
 release.resolve();await assert.rejects(exchange,{status:403});saved=(await f.vault.read(saved.id)).record;assert.equal(saved.tokenIntent,undefined);assert.deepEqual(saved.retirementTokens,['access-secret','refresh-secret']);
 const ciphertext=(await f.database.pool.query('SELECT ciphertext FROM opencrawl_connector_secrets WHERE namespace=$1',[f.database.namespace])).rows[0].ciphertext;assert.ok(!ciphertext.includes(Buffer.from('access-secret')));assert.ok(!ciphertext.includes(Buffer.from('refresh-secret')));
 f.state.failRevoke=true;await assert.rejects(f.service.remove(saved.id));assert.deepEqual((await f.vault.read(saved.id)).record.retirementTokens,saved.retirementTokens);
 f.state.failRevoke=false;await f.service.remove(saved.id);saved=(await f.vault.read(saved.id)).record;assert.deepEqual(saved.retirementTokens,[]);assert.equal(saved.remoteRevoked,true);assert.equal(saved.accessToken,undefined);assert.equal(saved.refreshToken,undefined);
 assert.deepEqual(f.state.calls.filter(c=>c.url.endsWith('/auth.revoke')).slice(-2).map(c=>c.options.headers.Authorization),['Bearer access-secret','Bearer refresh-secret']);assert.equal(f.state.calls.filter(c=>c.url.endsWith('/oauth.v2.access')).length,1);
});
test('PostgreSQL refresh retires old access and refresh tokens, and late refreshed tokens cannot revive a revoked grant',{skip:!postgresUrl},async t=>{
 const f=await fixture(t,{persistent:true});f.state.uniqueTokens=true;await f.connect();f.state.now+=90000;
 const started=Promise.withResolvers(),release=Promise.withResolvers();f.state.exchangeGate=async()=>{started.resolve();await release.promise;};
 const id=f.link.connected_account_id,g=(await f.vault.read(id)).record;
 const refreshing=f.service.proxyCredential(id,g.proxyToken,`selfhost:${org}:${user}`,{endpoint:'https://slack.com/api/auth.test'});await started.promise;
 await assert.rejects(f.service.remove(id),{code:'ConnectorGrantSettlementPending'});assert.equal((await f.vault.read(id)).record.accessToken,undefined);release.resolve();await assert.rejects(refreshing,{status:403});await f.service.remove(id);
 const revoked=f.state.calls.filter(c=>c.url.endsWith('/auth.revoke')).map(c=>c.options.headers.Authorization);
 assert.deepEqual(revoked,['Bearer access-secret1','Bearer refresh-secret1','Bearer access-secret2','Bearer refresh-secret2']);assert.equal((await f.vault.read(id)).record.remoteRevoked,true);
});
test('refresh admission waits for bounded retirement, and legacy unknown tokens never become remotely settled by age',async t=>{
 const f=await fixture(t);f.state.uniqueTokens=true;await f.connect();f.state.now+=90000;
 let saved=await f.vault.read(f.link.connected_account_id);await f.vault.write({...saved.record,retirementTokens:['one','two','three','four']},saved.version);f.state.failRevoke=true;
 await assert.rejects(f.service.proxyCredential(saved.record.id,saved.record.proxyToken,`selfhost:${org}:${user}`,{endpoint:'https://slack.com/api/auth.test'}));assert.equal(f.state.calls.filter(c=>c.url.endsWith('/oauth.v2.access')).length,1);
 f.state.failRevoke=false;saved=await f.vault.read(saved.record.id);await f.vault.write({...saved.record,retirementTokens:[],tokenProtocol:undefined},saved.version);
 await assert.rejects(f.service.remove(saved.record.id),{code:'ConnectorGrantSettlementPending'});f.state.now+=365*86400000;await assert.rejects(f.service.remove(saved.record.id),{code:'ConnectorGrantSettlementPending'});assert.equal((await f.vault.read(saved.record.id)).record.legacyTokenUncertainty,true);
});
test('a lost refresh response keeps its durable intent across revocation and never repeats the one-shot exchange',async t=>{
 const f=await fixture(t);await f.connect();f.state.now+=90000;f.state.failExchange=true;const saved=(await f.vault.read(f.link.connected_account_id)).record;
 const call=()=>f.service.proxyCredential(saved.id,saved.proxyToken,`selfhost:${org}:${user}`,{endpoint:'https://slack.com/api/auth.test'});
 await assert.rejects(call());f.state.failExchange=false;await assert.rejects(call(),{status:403});await assert.rejects(f.service.remove(saved.id),{code:'ConnectorGrantSettlementPending'});
 assert.equal(f.state.calls.filter(c=>c.url.endsWith('/oauth.v2.access')).length,2);const current=(await f.vault.read(saved.id)).record;assert.equal(current.status,'REVOKED');assert.equal(current.tokenIntent.kind,'refresh');assert.equal(current.remoteRevoked,undefined);
});

test('an imported legacy revoked marker cannot prove that previously discarded tokens were revoked',async t=>{
 const f=await fixture(t);await f.connect();await f.service.remove(f.link.connected_account_id);const saved=await f.vault.read(f.link.connected_account_id);
 await f.vault.write({...saved.record,tokenProtocol:undefined},saved.version);await assert.rejects(f.service.remove(saved.record.id),{code:'ConnectorGrantSettlementPending'});
 const current=(await f.vault.read(saved.record.id)).record;assert.equal(current.legacyTokenUncertainty,true);assert.equal(current.remoteRevoked,false);
});
