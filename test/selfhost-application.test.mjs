import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selfhostApplication} from '../dist/src/selfhost/application.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {valueReportKey} from '../dist/src/application/value-report.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
const org='org_selfhost',origin='https://oss.example.com';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-selfhost-app-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createLocalSessionStore(dir),prefix='sessions/selfhost/v1';
  const state={role:'admin',active:true,session:true,verified:true,organizationId:org,queries:[],duringRead:null};
  const user=id=>({id,email:id+'@example.com',emailVerified:state.verified,firstName:id});
  const workos={userManagement:{
    getUser:async id=>user(id),
    listSessions:async userId=>({data:[{id:'session_'+userId,userId,status:state.session?'active':'revoked',endedAt:null,expiresAt:new Date(Date.now()+600_000).toISOString()}],listMetadata:{after:null}}),
    listOrganizationMemberships:async input=>{state.queries.push(input);return {data:[{id:'om_a',userId:input.userId||'user_a',organizationId:org,status:state.active?'active':'inactive',role:{slug:state.role}}]};},
    loadSealedSession:({sessionData:id})=>({authenticate:async()=>({authenticated:true,user:user(id),sessionId:'session_'+id,organizationId:state.organizationId}),getLogoutUrl:async()=>origin+'/signed-out'}),
    getAuthorizationUrlWithPKCE:async input=>{state.login=input;return {url:'https://identity.example.com/sign-in',state:'state',codeVerifier:'verifier'};},
  },organizations:{getOrganization:async id=>{await state.duringRead?.();return {id,name:'Self-hosted team'};}}};
  const settings={organizationId:org,url:origin,authOrigin:'https://identity.example.com',clientId:'client_oss',apiKey:'sk_test',cookiePassword:'test-only-secret'.repeat(3),search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:org}};
  const app=selfhostApplication({settings,store,prefix,workos,readAsset:async file=>'asset:'+file});
  const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base='http://127.0.0.1:'+server.address().port;
  const request=(path,who='user_a',options={})=>fetch(base+path,{redirect:'manual',...options,headers:{...(who?{cookie:'__Host-opencrawl-session='+who}:{}),...options.headers}});
  return {request,state,store,prefix};
}
test('OSS serves its application with no shell, pins login to configured organization, and accepts distinct members',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/health',null)).status,200);
  assert.equal((await f.request('/api/console/bootstrap',null)).status,401);
  const login=await f.request('/auth/login?organization_id=org_foreign',null);
  assert.equal(login.status,303);assert.equal(f.state.login.organizationId,org);
  const a=await (await f.request('/api/console/bootstrap')).json(),b=await (await f.request('/api/console/bootstrap','user_b')).json();
  assert.equal(a.workspace.name,'Self-hosted team');assert.notEqual(a.cacheScope,b.cacheScope);
  assert.ok(f.state.queries.every(q=>q.organizationId===org));
  const page=await f.request('/onboarding');assert.equal(page.status,200);assert.match(await page.text(),/console\/assets\/app.js/);
  assert.equal(await (await f.request('/console/assets/app.js',null)).text(),'asset:web-v2/dist/selfhost/app.js');
  assert.equal(await (await f.request('/console/assets/callback.css',null)).text(),'asset:web-v2/dist/selfhost/callback.css');
  assert.equal((await f.request('/organizations/select','user_a',{method:'POST',headers:{origin}})).status,404);
});
test('OSS admission rejects foreign claims, revoked sessions, missing membership and cross-origin mutations',async t=>{
  const f=await fixture(t);
  f.state.organizationId='org_foreign';assert.equal((await f.request('/api/console/bootstrap')).status,403);
  f.state.organizationId=org;f.state.active=false;assert.equal((await f.request('/api/console/bootstrap')).status,403);
  f.state.active=true;f.state.session=false;assert.equal((await f.request('/api/console/bootstrap')).status,401);
  f.state.session=true;
  assert.equal((await f.request('/api/console/team/invite','user_a',{method:'POST',headers:{origin:'https://foreign.example'}})).status,403);
});
test('OSS reads only its configured organization measured report from operator storage',async t=>{
  const f=await fixture(t);
  const onboarding=createOnboardingStatus({store:f.store,prefix:f.prefix}),principal={tenantId:org,userId:'user_a'};
  await onboarding.cli(principal);await onboarding.mcpTest(principal);
  await onboarding.session(principal,{harness:'codex',events:[{kind:'message'}]});await onboarding.complete(principal);
  const report={schema:1,measuredAt:'2026-11-09',window:{from:'2026-11-01',to:'2026-11-08',days:8},
    model:{model:'Measured model',input:1,cacheRead:0,cacheWrite:0,output:1,asOf:'2026-11-09',share:100},
    savings:{tasks:1,heldOutTasks:1,turns:2,turnsPerTask:2,turnPercent:20,tokens:{input:1,cacheRead:0,cacheWrite:0,output:1}},
    observed:{from:null,to:null,conflictsAvoided:0,duplicatesAvoided:0,knowledgeReused:0,searches:0,searchesUseful:0,searchesUsed:0}};
  await f.store.put(valueReportKey(f.prefix,'org_foreign'),JSON.stringify(report));
  assert.equal((await (await f.request('/api/console/usage')).json()).value,null);
  await f.store.put(valueReportKey(f.prefix,org),JSON.stringify(report));
  const response=await f.request('/api/console/usage');assert.equal(response.status,200);
  const result=await response.json();assert.deepEqual(result.value,report);assert.equal(result.capture,null);
  f.state.organizationId='org_foreign';assert.equal((await f.request('/api/console/usage')).status,403);
});
test('OSS withholds a completed tRPC response if membership or admin role changes during its read',async t=>{
  const f=await fixture(t);
  f.state.duringRead=()=>{f.state.active=false;};
  let result=await f.request('/api/trpc/console.bootstrap?input='+encodeURIComponent('{}'));
  assert.equal(result.status,403);assert.doesNotMatch(await result.text(),/Self-hosted team/);
  f.state.active=true;f.state.duringRead=()=>{f.state.role='member';};
  result=await f.request('/api/trpc/console.bootstrap?input='+encodeURIComponent('{}'));
  assert.equal(result.status,403);assert.doesNotMatch(await result.text(),/Self-hosted team/);
});
test('delegated capture works for the configured team, remains write-only, and obeys revocation',async t=>{
  const f=await fixture(t),p={tenantId:org,userId:'user_a'};
  const credentials=createCaptureCredentials({store:f.store,prefix:f.prefix}),issued=await credentials.issue(p);
  const request=path=>f.request(path,null,{headers:{authorization:'Bearer '+issued.token}});
  assert.equal((await request('/api/sessions/identity')).status,200);
  assert.equal((await request('/api/sessions/search?query=private')).status,403);
  await credentials.revoke(p,issued.id);assert.equal((await request('/api/sessions/identity')).status,401);
});
