import {document} from '../dist/src/application/presentation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createIntegrations} from '../dist/src/integrations/service.mjs';
import {createGitHubApp} from '../dist/src/integrations/github.mjs';
import {createProviderCatalog} from '../dist/src/integrations/providers.mjs';
import {callbackPage} from '../dist/src/application/integration-callback.mjs';
import {integrationRequest} from '../dist/src/application/integration-http.mjs';

const owner = {tenantId: 'org_team', userId: 'user_owner'};
const installation = id => ({id, account: {id: id + 100, login: `account-${id}`}});
function fixture({installations = [installation(42)], repositories = [{id: 7, full_name: 'account-42/readable'}]} = {}) {
  const records = new Map(), calls = [];
  const key = r => `${r.tenantId}/${r.userId}/${r.integrationId}`;
  const registry = {
    create: async record => {records.set(key(record), structuredClone(record)); return record;},
    get: async (tenantId, userId, integrationId) => structuredClone(records.get(key({tenantId, userId, integrationId}))),
    listTenant: async tenantId => [...records.values()].filter(r => r.tenantId === tenantId).map(r => structuredClone(r)),
    update: async (record, fields, {whenStatus, whenFields = {}} = {}) => {
      const current = records.get(key(record));
      if (!current || whenStatus && !whenStatus.includes(current.status) || Object.entries(whenFields).some(([k,v]) => current[k] !== v)) throw Object.assign(new Error('CAS'), {code:'ConditionalCheckFailedException'});
      const next = {...current, ...structuredClone(fields)}; records.set(key(record), next); return structuredClone(next);
    },
  };
  const github = {
    authorizeUrl: (state, redirect_uri) => 'https://github.com/login/oauth/authorize?' + new URLSearchParams({client_id:'app-client', state, redirect_uri}),
    installUrl: state => 'https://github.com/apps/owned-app/installations/new?' + new URLSearchParams({state}),
    userToken: async code => {calls.push(['token', code]); return 'temporary-user-token';},
    userInstallations: async token => {assert.equal(token,'temporary-user-token'); return installations;},
    userRepositories: async (token,id) => {assert.equal(token,'temporary-user-token'); calls.push(['repositories',id]); return repositories;},
    revokeUserToken: async token => {calls.push(['revoke',token]);},
    installation: async () => assert.fail('App authority must not replace user authority'),
    repositories: async () => assert.fail('Do not import repositories invisible to this user'),
  };
  const provider = {id:'github',auth:'github-app',scope:'team',owner:r=>`workspace=${r.workspace}`,account:(i,r)=>({label:i.account.login,workspace:String(i.account.id)})};
  const integrations = createIntegrations({environment:'selfhost',appUrl:'https://self.example',registry,github,providers:{github:provider},oauth:{},airbyte:{},legacyBucket:'owned',buckets:{get:async()=>'owned'},workspaceId:async()=>'airbyte',destination:{validate:()=>{},prepare:()=>new Promise(()=>{})}});
  return {integrations,registry,github,calls,records,
    start: async () => {const {redirectUrl}=await integrations.connect(owner,'github');return new URL(redirectUrl);},
    record: () => structuredClone([...records.values()][0]),
  };
}

test('existing GitHub installation reconnects through OAuth and persists only user-accessible repository IDs', async()=>{
  const f=fixture(), url=await f.start();
  assert.equal(url.origin+url.pathname,'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('redirect_uri'),'https://self.example/integrations/github/callback');
  const query=new URLSearchParams({state:url.searchParams.get('state'),code:'existing-grant'});
  assert.deepEqual(await f.integrations.complete(owner,'github',query),{ok:true,reason:'connected'});
  assert.equal(f.record().installationId,'42'); assert.deepEqual(f.record().githubRepositoryIds,[7]);
  assert.equal(f.record().workspace,'142'); assert.ok(f.record().s3Prefix.includes('/workspace=142/'));
  assert.equal(f.calls.filter(c=>c[0]==='revoke').length,1);
  assert.deepEqual(await f.integrations.complete(owner,'github',query),{ok:true,reason:'done'});
  assert.equal(f.calls.filter(c=>c[0]==='token').length,1);
  assert.ok(!JSON.stringify(f.record()).includes('temporary-user-token'));
  const provider=createProviderCatalog({github:{name:'test',docker:{repository:'test',tag:'test'}}}).github;
  assert.deepEqual(provider.sourceConfiguration({githubApp:{app_id:'owned',private_key:'fixture'},record:f.record()}).repository_ids,[7]);
  assert.throws(()=>provider.sourceConfiguration({record:{installationId:'42'}}),/Reconnect GitHub/);
});

test('disconnect winning the callback claim cannot be reported as a completed connection',async()=>{
  const f=fixture(), url=await f.start(), update=f.registry.update;
  f.registry.update=async(record,fields,conditions)=>{
    if(fields.status==='provisioning')await update(record,{status:'disconnected'},{whenStatus:['connecting']});
    return update(record,fields,conditions);
  };
  assert.deepEqual(await f.integrations.complete(owner,'github',new URLSearchParams({state:url.searchParams.get('state'),code:'grant'})),{ok:false,reason:'done'});
  assert.equal(f.record().status,'disconnected');
});

test('multiple installations require an explicit selection and fresh authorization for that selection', async()=>{
  const f=fixture({installations:[installation(42),installation(43)]}), url=await f.start();
  const result=await f.integrations.complete(owner,'github',new URLSearchParams({state:url.searchParams.get('state'),code:'first'}));
  assert.equal(result.reason,'choose'); assert.equal(result.actions.length,3); assert.equal(f.record().status,'connecting');
  assert.equal(f.calls.filter(c=>c[0]==='revoke').length,1);
  const selected=new URL(result.actions[1].url).searchParams.get('state');
  assert.ok(selected.endsWith('.43'));
  assert.deepEqual(await f.integrations.complete(owner,'github',new URLSearchParams({state:selected,code:'fresh',installation_id:'42'})),{ok:false,reason:'invalid'});
  f.github.userInstallations=async()=>[installation(42)];
  assert.deepEqual(await f.integrations.complete(owner,'github',new URLSearchParams({state:selected,code:'lost-access'})),{ok:false,reason:'invalid'});
  assert.equal(f.record().status,'connecting'); assert.equal(f.calls.filter(c=>c[0]==='revoke').length,2);
  f.github.userInstallations=async()=>[installation(43)];
  assert.deepEqual(await f.integrations.complete(owner,'github',new URLSearchParams({state:selected,code:'fresh'})),{ok:true,reason:'connected'});
  assert.equal(f.record().installationId,'43');
});

test('new GitHub account can install after OAuth without abandoning the pending connection',async()=>{
  const f=fixture({installations:[]}), url=await f.start(), state=url.searchParams.get('state');
  const result=await f.integrations.complete(owner,'github',new URLSearchParams({state,code:'before-install'}));
  assert.equal(new URL(result.actions[0].url).pathname,'/apps/owned-app/installations/new');
  assert.equal(new URL(result.actions[0].url).searchParams.get('state'),state); assert.equal(f.record().status,'connecting');
  f.github.userInstallations=async()=>[installation(42)];
  assert.deepEqual(await f.integrations.complete(owner,'github',new URLSearchParams({state,code:'after-install',installation_id:'42'})),{ok:true,reason:'connected'});
});

test('state, owner, tenant and installation checks fail before any provisioning',async()=>{
  const f=fixture(), url=await f.start(), state=url.searchParams.get('state');
  for(const [principal,wrong] of [[{...owner,userId:'user_other'},state],[{...owner,tenantId:'org_other'},state],[owner,state+'.42.extra'],[owner,state+'.'],[owner,state.replace(/\.[^.]+$/,'.forged')]]) {
    assert.deepEqual(await f.integrations.complete(principal,'github',new URLSearchParams({state:wrong,code:'good'})),{ok:false,reason:'invalid'});
  }
  assert.equal(f.calls.length,0);
  assert.deepEqual(await f.integrations.complete(owner,'github',new URLSearchParams({state,code:'good',installation_id:'99'})),{ok:false,reason:'invalid'});
  assert.equal(f.record().status,'connecting');
  assert.deepEqual(await f.integrations.complete(owner,'github',new URLSearchParams({state})),{ok:false,reason:'declined'});
  assert.equal(f.record().status,'abandoned');
});

test('empty or failed repository checks do not provision, and every acquired user token is revoked',async()=>{
  for(const failure of ['empty','failure','invalid']) {
    const f=fixture({repositories:failure==='invalid'?[{id:0}]:[]}), url=await f.start();
    if(failure==='failure') f.github.userRepositories=async()=>{throw new Error('provider unavailable');};
    const complete=()=>f.integrations.complete(owner,'github',new URLSearchParams({state:url.searchParams.get('state'),code:'grant'}));
    if(failure==='empty') assert.deepEqual(await complete(),{ok:false,reason:'repositories'});
    else await assert.rejects(complete);
    assert.equal(f.record().status,'connecting'); assert.equal(f.calls.filter(c=>c[0]==='revoke').length,1);
  }
});

test('GitHub adapter pages user grants and rejects incomplete or malformed listings',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  for(const mode of ['paged','incomplete','malformed']) {
    const calls=[];
    const app=createGitHubApp({appId:'1',slug:'owned',clientId:'Iv1.owned',clientSecret:'test',privateKey:privateKey.export({type:'pkcs1',format:'pem'})},{fetch:async(input,init)=>{
      const url=new URL(input);calls.push(url);
      assert.equal(url.origin,'https://api.github.com');assert.equal(init.headers.Authorization,'Bearer grant');
      if(mode==='malformed')return Response.json({});
      const field=url.pathname.endsWith('/repositories')?'repositories':'installations';
      const many=mode==='incomplete'||url.searchParams.get('page')==='1';
      return Response.json({[field]:Array.from({length:many?100:1},(_,i)=>({id:i+1,account:{login:'owned'}}))});
    }});
    if(mode==='paged') {assert.equal((await app.userInstallations('grant')).length,101); assert.equal((await app.userRepositories('grant','42')).length,101);}
    else {await assert.rejects(app.userInstallations('grant')); await assert.rejects(app.userRepositories('grant','42'));}
    assert.ok(calls.length<=70);
  }
});

test('pending callback renders an escaped React handoff, returns 200, and does not report failure',async()=>{
  const result={ok:false,reason:'choose',actions:[{label:'</main><script>bad</script>',url:'https://github.com/login/oauth/authorize?state=bound'}]};
  const html=document(callbackPage({...result,name:'GitHub',returnTo:'https://evil.example'}));
  assert.ok(html.includes('opencrawl-page'));assert.ok(html.includes('/console/assets/app.js'));assert.doesNotMatch(html, /<main|<form/);
  assert.ok(!html.includes('<script>bad'));assert.ok(!html.includes('evil.example'));
  let response;
  await integrationRequest({},new URL('https://self.example/integrations/github/callback'),{name:'integration-callback',provider:'github'}, {
    integrations:{complete:async()=>result},providers:{github:{id:'github',name:'GitHub',scope:'team'}},principal:owner,member:{userId:owner.userId,organizationId:owner.tenantId,status:'active',role:{slug:'admin'}},onboarding:null,guided:{},
    respond:(status,body)=>{response={status,body};},message:()=>assert.fail(),document,track:()=>assert.fail('A pending choice is not a connection failure'),
  });
  assert.equal(response.status,200);assert.ok(response.body.includes('integration-callback'));
});
