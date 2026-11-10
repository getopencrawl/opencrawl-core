import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selfhostApplication} from '../dist/src/selfhost/application.mjs';
import {createLocalIdentity} from '../dist/src/identity/better-auth.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {valueReportKey} from '../dist/src/application/value-report.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
const org='org_selfhost',setup='setup-token-for-tests';
async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-selfhost-app-'));
  const store=createLocalSessionStore(dir),prefix='sessions/selfhost/v1';
  let app;const server=createServer((req,res)=>app(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://localhost:'+server.address().port;
  const identity=await createLocalIdentity({url:origin,secret:randomBytes(32).toString('hex'),databasePath:join(dir,'identity.sqlite'),organizationId:org});
  await identity.ready();t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));identity.close();await rm(dir,{recursive:true,force:true});});
  const settings={organizationId:org,url:origin,authOrigin:origin+'/api/auth',clientId:'opencrawl-cli',authSecret:'x'.repeat(32),identityPath:join(dir,'identity.sqlite'),setupToken:setup,search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:org}};
  app=selfhostApplication({settings,store,prefix,identity,readAsset:async file=>'asset:'+file,...options});
  const jars=new Map();
  const request=async(path,who=null,options={})=>{
    const jar=who?jars.get(who)||new Map():null;
    const response=await fetch(origin+path,{redirect:'manual',...options,headers:{...(jar?.size?{cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...options.headers}});
    if(jar){for(const line of response.headers.getSetCookie()){const [pair]=line.split(';'),i=pair.indexOf('=');const name=pair.slice(0,i),value=pair.slice(i+1);if(!value||/Max-Age=0/i.test(line))jar.delete(name);else jar.set(name,value);}jars.set(who,jar);}
    return response;
  };
  const post=(path,who,fields,headers={})=>request(path,who,{method:'POST',body:new URLSearchParams(fields),headers:{origin,'content-type':'application/x-www-form-urlencoded',...headers}});
  const admin=async()=>{const r=await post('/auth/signup','admin',{setup,workspace:'Self-hosted team',name:'Ada Admin',email:'ada@example.com',password:'correct horse battery'});assert.equal(r.status,303);};
  const join_=async(who,email,role='member')=>{
    const [inviter]=(await identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data;
    const invited=await identity.directory.userManagement.sendInvitation({organizationId:org,email,inviterUserId:inviter.userId,roleSlug:role});
    assert.equal((await identity.invitationLinks()).get(email),invited.acceptInvitationUrl);
    const r=await post('/auth/signup',who,{invitation:invited.id,name:who,password:'another long password'});assert.equal(r.status,303);
    assert.equal((await identity.invitationLinks()).has(email),false);
    return invited;
  };
  return {request,post,identity,store,prefix,origin,admin,join:join_};
}

test('OSS first run creates one admin from the setup link; nobody else can sign up without an invitation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/health')).status,200);
  assert.equal((await f.request('/api/console/bootstrap')).status,401);
  assert.equal((await f.request('/')).headers.get('location'),'/auth/signup');
  assert.doesNotMatch(await (await f.request('/auth/signup')).text(),/name="password"/);
  assert.equal((await f.post('/auth/signup','mallory',{workspace:'x',name:'M',email:'m@example.com',password:'long enough password'})).status,403);
  await f.admin();
  const boot=await (await f.request('/api/console/bootstrap','admin')).json();
  assert.equal(boot.workspace.name,'Self-hosted team');
  assert.deepEqual(boot.onboarding,{completed:false,next:'/onboarding'});
  // Setup is single-use and Better Auth's own sign-up endpoint is not reachable.
  assert.equal((await f.post('/auth/signup','mallory',{setup,workspace:'x',name:'M',email:'m@example.com',password:'long enough password'})).status,403);
  assert.equal((await f.request('/api/auth/sign-up/email',null,{method:'POST',headers:{'content-type':'application/json',origin:f.origin},body:JSON.stringify({email:'m@example.com',password:'long enough password',name:'M'})})).status,404);
  assert.equal((await f.request('/api/auth/organization/create',null,{method:'POST'})).status,404);
  assert.equal((await f.post('/auth/login','mallory',{email:'ada@example.com',password:'wrong password!!'})).status,401);
  const login=await f.post('/auth/login','again',{email:'ada@example.com',password:'correct horse battery'});
  assert.equal(login.status,303);assert.equal((await f.request('/api/console/bootstrap','again')).status,200);
  const page=await f.request('/onboarding','admin');assert.equal(page.status,200);assert.match(await page.text(),/console\/assets\/app.js/);
  assert.equal(await (await f.request('/console/assets/app.js')).text(),'asset:web-v2/dist/selfhost/app.js');
  await f.post('/auth/logout','again',{});assert.equal((await f.request('/api/console/bootstrap','again')).status,401);
});

test('OSS invitations admit distinct members once; removing a membership denies access',async t=>{
  const f=await fixture(t);await f.admin();
  const invited=await f.join('bob','bob@example.com');
  const a=await (await f.request('/api/console/bootstrap','admin')).json(),b=await (await f.request('/api/console/bootstrap','bob')).json();
  assert.notEqual(a.cacheScope,b.cacheScope);
  assert.equal((await f.post('/auth/signup','eve',{invitation:invited.id,name:'eve',password:'another long password'})).status,410);
  const [bob]=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data.filter(m=>m.role.slug==='member');
  assert.ok(bob);
  const {adapter}=await f.identity.auth.$context;await adapter.delete({model:'member',where:[{field:'id',value:bob.id}]});
  assert.equal((await f.request('/api/console/bootstrap','bob')).status,403);
  assert.equal((await f.request('/api/console/team/invite','admin',{method:'POST',headers:{origin:'https://foreign.example'}})).status,403);
});
test('OSS onboarding requires agent setup only; the Sources step can be skipped',async t=>{
  const f=await fixture(t);await f.admin();
  const [member]=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data;
  const onboarding=createOnboardingStatus({store:f.store,prefix:f.prefix}),principal={tenantId:org,userId:member.userId};
  const finish=()=>f.request('/api/onboarding/finish','admin',{method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:'{}'});
  // Skipping sources never skips agent setup.
  assert.equal((await finish()).status,409);
  for(const path of ['/onboarding/sources','/onboarding/invite'])assert.equal((await f.request(path,'admin')).headers.get('location'),'/onboarding');
  assert.equal((await f.request('/api/onboarding/invites','admin')).status,409);
  await onboarding.cli(principal);await onboarding.mcpTest(principal);await onboarding.session(principal,{harness:'codex',events:[{kind:'message'}]});
  // With nothing connected, setup resumes at Sources, yet Invite opens and finishing needs no source.
  assert.deepEqual((await (await f.request('/api/console/bootstrap','admin')).json()).onboarding,{completed:false,next:'/onboarding/sources'});
  for(const path of ['/onboarding/sources','/onboarding/invite'])assert.equal((await f.request(path,'admin')).status,200);
  assert.equal((await f.request('/api/onboarding/invites','admin')).status,200);
  assert.equal((await f.request('/api/console/team','admin')).status,409);
  const done=await finish();assert.equal(done.status,200);assert.deepEqual(await done.json(),{workspaceUrl:'/'});
  assert.ok((await onboarding.read(principal)).completed.observedAt);
  assert.equal((await f.request('/api/console/team','admin')).status,200);
  assert.equal((await (await f.request('/api/console/bootstrap','admin')).json()).onboarding.completed,true);
  assert.equal((await finish()).status,200,'completion is idempotent');
});
test('only an admin can store a connector credential, from this origin, before or after onboarding',async t=>{
  const saved=[];let failure=null;
  const f=await fixture(t,{connectorSettings:{save:async(id,value,by)=>{if(failure)throw failure;saved.push({id,value,userId:by.userId});}}});
  await f.admin();await f.join('bob','bob@example.com');
  const send=(who,body,headers={})=>f.request('/api/integrations/credentials/composio',who,{method:'POST',headers:{origin:f.origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await send(null,{value:'k'})).status,401);
  const member=await send('bob',{value:'project-key'});assert.equal(member.status,403);assert.equal((await member.json()).error.code,'ADMIN_REQUIRED');
  assert.equal((await send('admin',{value:'project-key'},{origin:'https://foreign.example'})).status,403);
  assert.equal((await f.request('/api/integrations/credentials/composio','admin')).status,405);
  assert.equal(saved.length,0);
  // The admin has not finished onboarding; the sources step is where the key is first needed.
  const ok=await send('admin',{value:'project-key'});assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{ok:true});
  const [admin]=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data.filter(m=>m.role.slug==='admin');
  assert.deepEqual(saved,[{id:'composio',value:'project-key',userId:admin.userId}]);
  failure=Object.assign(new Error('Composio did not accept that key.'),{status:400,expose:true});
  const refused=await send('admin',{value:'bad'});assert.equal(refused.status,400);assert.equal((await refused.json()).error.message,'Composio did not accept that key.');
  failure=new Error('storage exploded: s3://private-bucket');
  const hidden=await send('admin',{value:'project-key'});assert.equal(hidden.status,503);assert.doesNotMatch(JSON.stringify(await hidden.json()),/private-bucket/);
});
test('self-host team integration actions reject members through both HTTP and tRPC',async t=>{
  const calls=[];
  const integrations={list:async()=>[],connect:async()=>{calls.push('connect');return {redirectUrl:'https://provider.example'};},retry:async()=>{calls.push('retry');},disconnect:async()=>{calls.push('disconnect');},disconnectAll:async()=>{calls.push('disconnect-all');return 0;}};
  const f=await fixture(t,{integrations,providers:{notion:{id:'notion',name:'Notion',scope:'team',auth:'oauth'}}});
  await f.admin();await f.join('bob','bob@example.com');
  for(const action of ['connect','retry','disconnect']){
    const path='/api/integrations/notion/'+action;
    const options={method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:'{}'};
    assert.equal((await f.request(path,'bob',options)).status,403);
    const rpc={...options,body:JSON.stringify({provider:'notion'})};
    assert.equal((await f.request('/api/trpc/integrations.'+action,'bob',rpc)).status,403);
    assert.equal((await f.request(path,'admin',options)).status,200);
  }
  const all={method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:'{}'};
  assert.equal((await f.request('/api/integrations/disconnect-all','bob',all)).status,403);
  assert.equal((await f.request('/api/integrations/disconnect-all','admin',all)).status,200);
  assert.deepEqual(calls,['connect','retry','disconnect','disconnect-all']);
});

test('OSS reads only its configured organization measured report from operator storage',async t=>{
  const f=await fixture(t);
  await f.admin();
  const [member]=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data;
  const onboarding=createOnboardingStatus({store:f.store,prefix:f.prefix}),principal={tenantId:org,userId:member.userId};
  await onboarding.cli(principal);await onboarding.mcpTest(principal);
  await onboarding.session(principal,{harness:'codex',events:[{kind:'message'}]});await onboarding.complete(principal);
  const report={schema:3,measuredAt:'2026-11-09',window:{from:'2026-11-01',to:'2026-11-08',days:8},
    model:{model:'Measured model',input:1,cacheRead:0,cacheWrite:0,output:1,asOf:'2026-11-09',share:100},
    savings:{sessions:1,tasks:1,uses:1,digTokens:10,digTurns:2,tokenPercent:20,turns:2,turnPercent:20,tokens:{input:1,cacheRead:0,cacheWrite:0,output:1}},
    observed:{conflictsAvoided:0,duplicatesAvoided:0,knowledgeReused:0,searches:0,searchesUseful:0,searchesUsed:0}};
  await f.store.put(valueReportKey(f.prefix,'org_foreign'),JSON.stringify(report));
  assert.equal((await (await f.request('/api/console/usage','admin')).json()).value,null);
  await f.store.put(valueReportKey(f.prefix,org),JSON.stringify(report));
  const response=await f.request('/api/console/usage','admin');assert.equal(response.status,200);
  const result=await response.json();assert.deepEqual(result.value,report);assert.equal(result.capture,null);

});
test('OSS withholds a completed tRPC response if membership or admin role changes during its read',async t=>{
  const f=await fixture(t);await f.admin();
  const organizations=f.identity.directory.organizations,read=organizations.getOrganization;let during=null;
  organizations.getOrganization=async id=>{await during?.();return read(id);};
  const {adapter}=await f.identity.auth.$context;
  const [member]=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data;
  during=()=>adapter.update({model:'member',where:[{field:'id',value:member.id}],update:{role:'member'}});
  const result=await f.request('/api/trpc/console.bootstrap?input='+encodeURIComponent('{}'),'admin');
  assert.equal(result.status,403);assert.doesNotMatch(await result.text(),/Self-hosted team/);
});

test('CLI device sign-in requires a member’s approval and yields refreshable tokens for this deployment',async t=>{
  const f=await fixture(t);await f.admin();
  const config=await (await f.request('/.well-known/opencrawl-cli')).json();
  assert.deepEqual(config.auth,{clientId:'opencrawl-cli',deviceAuthorizationEndpoint:f.origin+'/api/cli/device',tokenEndpoint:f.origin+'/api/cli/token'});
  const form=fields=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
  assert.equal((await f.request('/api/cli/device',null,form({client_id:'other'}))).status,400);
  const device=await (await f.request('/api/cli/device',null,form({client_id:'opencrawl-cli'}))).json();
  assert.equal(new URL(device.verification_uri).pathname,'/device');
  const poll=()=>f.request('/api/cli/token',null,form({client_id:'opencrawl-cli',grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code}));
  assert.equal((await (await poll()).json()).error,'authorization_pending');
  assert.match((await f.request('/device?user_code='+device.user_code)).headers.get('location'),/^\/auth\/login\?next=/);
  assert.match(await (await f.request('/device?user_code='+device.user_code,'admin')).text(),new RegExp(device.user_code));
  assert.match(await (await f.post('/device','admin',{user_code:device.user_code,decision:'approve'})).text(),/CLI connected/);
  await new Promise(resolve=>setTimeout(resolve,device.interval*1000+200));
  const tokens=await (await poll()).json();
  assert.ok(tokens.access_token&&tokens.refresh_token);
  const me=await f.request('/api/cli/me',null,{headers:{authorization:'Bearer '+tokens.access_token}});
  assert.equal(me.status,200);assert.equal((await me.json()).data.user.email,'ada@example.com');
  assert.equal((await f.request('/api/cli/me',null,{headers:{authorization:'Bearer '+tokens.access_token,origin:'https://foreign.example'}})).status,403);
  const refreshed=await (await f.request('/api/cli/token',null,form({client_id:'opencrawl-cli',grant_type:'refresh_token',refresh_token:tokens.refresh_token}))).json();
  assert.equal((await f.request('/api/cli/me',null,{headers:{authorization:'Bearer '+refreshed.access_token}})).status,200);
  assert.equal((await f.request('/api/cli/me',null,{headers:{authorization:'Bearer '+tokens.access_token.slice(0,-4)+'AAAA'}})).status,401);
  await f.identity.recoverPassword('ada@example.com','recovered long password');
  assert.equal((await f.request('/api/console/bootstrap','admin')).status,401);
  assert.equal((await f.request('/api/cli/me',null,{headers:{authorization:'Bearer '+refreshed.access_token}})).status,401);
  assert.notEqual((await f.request('/api/cli/token',null,form({client_id:'opencrawl-cli',grant_type:'refresh_token',refresh_token:refreshed.refresh_token}))).status,200);
  assert.equal((await f.post('/auth/login','again',{email:'ada@example.com',password:'correct horse battery'})).status,401);
  assert.equal((await f.post('/auth/login','recovered',{email:'ada@example.com',password:'recovered long password'})).status,303);
});

test('password recovery revokes pre-approved device logins without revoking another member',async t=>{
  const f=await fixture(t);await f.admin();await f.join('bob','bob@example.com');
  const form=fields=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
  const approve=async who=>{
    const device=await (await f.request('/api/cli/device',null,form({client_id:'opencrawl-cli'}))).json();
    assert.match(await (await f.post('/device',who,{user_code:device.user_code,decision:'approve'})).text(),/CLI connected/);
    return ()=>f.request('/api/cli/token',null,form({client_id:'opencrawl-cli',grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code}));
  };
  const pollAdmin=await approve('admin'),pollMember=await approve('bob');
  await f.identity.recoverPassword('ada@example.com','recovered long password');
  // A post-recovery token would have a new iat and bypass the old-token cutoff.
  await new Promise(resolve=>setTimeout(resolve,1100));
  const denied=await pollAdmin();assert.equal(denied.status,400);assert.equal((await denied.json()).error,'invalid_grant');
  const allowed=await pollMember();assert.equal(allowed.status,200);
  const tokens=await allowed.json();assert.ok(tokens.access_token&&tokens.refresh_token);
  assert.equal((await f.request('/api/cli/me',null,{headers:{authorization:'Bearer '+tokens.access_token}})).status,200);
});

test('MCP clients register, need a member’s consent, and receive tokens accepted by /mcp',async t=>{
  const f=await fixture(t);await f.admin();
  const resource=await (await f.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(resource.authorization_servers,[f.origin+'/api/auth']);
  const metadata=await (await f.request('/.well-known/oauth-authorization-server/api/auth')).json();
  assert.equal(metadata.issuer,f.origin+'/api/auth');
  const oidc=await f.request('/api/auth/.well-known/openid-configuration');
  assert.equal(oidc.status,200);assert.equal((await oidc.json()).issuer,metadata.issuer);
  const wrongMethod=await f.request('/api/auth/.well-known/openid-configuration',null,{method:'POST'});
  assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.get('allow'),'GET');
  const callback='http://127.0.0.1:33418/callback';
  const client=await (await f.request('/api/auth/oauth2/register',null,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Test agent',redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})})).json();
  assert.ok(client.client_id,JSON.stringify(client));
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  const authorize='/api/auth/oauth2/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:callback,scope:'openid offline_access',state:'s1',code_challenge:challenge,code_challenge_method:'S256',resource:f.origin+'/mcp'});
  const started=await f.request(authorize,'oauth',{headers:{accept:'text/html','sec-fetch-mode':'navigate'}});
  const login=new URL(started.headers.get('location')||(await started.json()).url,f.origin);
  assert.equal(login.pathname,'/auth/login');
  const signedIn=await f.post('/auth/login','oauth',{email:'ada@example.com',password:'correct horse battery',oauth_query:login.searchParams.toString()});
  assert.equal(signedIn.status,303);
  const consent=new URL(signedIn.headers.get('location'),f.origin);
  assert.equal(consent.pathname,'/auth/consent');
  assert.match(await (await f.request(consent.pathname+consent.search,'oauth')).text(),/Test agent/);
  const approved=await (await f.post('/auth/consent','oauth',{oauth_query:consent.searchParams.toString(),accept:'true'})).text();
  const redirect=new URL(JSON.parse(/<script[^>]+id="opencrawl-page"[^>]*>(.*?)<\/script>/s.exec(approved)[1]).page.url);
  assert.equal(redirect.origin+redirect.pathname,callback);assert.equal(redirect.searchParams.get('state'),'s1');
  const token=await (await f.request('/api/auth/oauth2/token',null,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:redirect.searchParams.get('code'),redirect_uri:callback,client_id:client.client_id,code_verifier:verifier,resource:f.origin+'/mcp'})})).json();
  assert.ok(token.access_token);
  const mcp=await f.request('/mcp',null,{method:'POST',headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}})});
  assert.equal(mcp.status,200);
  assert.equal((await f.request('/mcp',null,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const {adapter}=await f.identity.auth.$context;
  const [member]=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data;
  assert.equal(await adapter.count({model:'oauthConsent',where:[{field:'userId',value:member.userId}]}),1);
  const pending=await f.request(authorize,'oauth',{headers:{accept:'text/html','sec-fetch-mode':'navigate'}});
  const pendingUrl=new URL(pending.headers.get('location')||(await pending.json()).url,f.origin);
  assert.ok(pendingUrl.searchParams.get('code'));
  await f.identity.recoverPassword('ada@example.com','recovered long password');
  assert.equal(await adapter.count({model:'oauthConsent',where:[{field:'userId',value:member.userId}]}),0);
  const stale=await f.request('/api/auth/oauth2/token',null,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:pendingUrl.searchParams.get('code'),redirect_uri:callback,client_id:client.client_id,code_verifier:verifier,resource:f.origin+'/mcp'})});
  assert.equal(stale.status,400);
  assert.equal((await f.post('/auth/login','fresh',{email:'ada@example.com',password:'recovered long password'})).status,303);
  const again=await f.request(authorize,'fresh',{headers:{accept:'text/html','sec-fetch-mode':'navigate'}});
  assert.equal(new URL(again.headers.get('location')||(await again.json()).url,f.origin).pathname,'/auth/consent');
});

test('delegated capture works for the configured team, remains write-only, and obeys revocation',async t=>{
  const f=await fixture(t);await f.admin();
  const [member]=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data;
  const p={tenantId:org,userId:member.userId};
  const credentials=createCaptureCredentials({store:f.store,prefix:f.prefix}),issued=await credentials.issue(p);
  const request=path=>f.request(path,null,{headers:{authorization:'Bearer '+issued.token}});
  assert.equal((await request('/api/sessions/identity')).status,200);
  assert.equal((await request('/api/sessions/search?query=private')).status,403);
  await credentials.revoke(p,issued.id);assert.equal((await request('/api/sessions/identity')).status,401);
});


test('local auth requires same-origin forms, forbids token shortcuts, and bounds failed sign-in attempts',async t=>{
  const f=await fixture(t);await f.admin();
  assert.equal((await f.request('/auth/login',null,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'email=ada@example.com&password=bad'})).status,403);
  assert.equal((await f.post('/auth/logout','admin',{}, {origin:'https://foreign.example'})).status,403);
  assert.equal((await f.request('/auth/logout','admin')).status,405);
  assert.equal((await f.request('/api/auth/token','admin')).status,404);
  assert.equal((await f.request('/api/auth/get-session','admin')).status,404);
  const row=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data[0];
  const user=await f.identity.directory.userManagement.getUser(row.userId);
  assert.equal(user.emailVerified,false);assert.equal(user.locallyEnrolled,true);
  const generic=await f.identity.auth.api.signJWT({body:{payload:{sub:user.id,aud:f.origin+'/mcp',scope:'openid',client_id:'opencrawl-cli'}}});
  assert.equal((await f.request('/api/cli/me',null,{headers:{authorization:'Bearer '+generic.token}})).status,401);
  assert.equal((await f.request('/mcp',null,{method:'POST',headers:{authorization:'Bearer '+generic.token,'content-type':'application/json'},body:'{}'})).status,401);
  assert.deepEqual((await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:'org_foreign'})).data,[]);
  const redirect=await f.post('/auth/login','again',{email:user.email,password:'correct horse battery',next:'/\\evil.example'});
  assert.equal(redirect.headers.get('location'),'/');
  assert.equal((await f.post('/auth/login','wrong',{email:user.email,password:'wrong password'})).status,401);
  assert.equal((await f.post('/auth/login','wrong',{email:user.email,password:'wrong password'})).status,429);
});

test('bootstrap is consumed once across racing registrations and never reopens after all memberships are removed',async t=>{
  const f=await fixture(t);
  const responses=await Promise.all(['one','two'].map(who=>f.post('/auth/signup',who,{setup,workspace:who,name:who,email:who+'@example.com',password:'a long account password'})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[303,403]);
  const db=(await f.identity.auth.$context).adapter;
  const rows=(await f.identity.directory.userManagement.listOrganizationMemberships({organizationId:org})).data;
  assert.equal(rows.length,1);
  await db.delete({model:'member',where:[{field:'id',value:rows[0].id}]});
  assert.equal(await f.identity.setupRequired(),false);
  assert.equal((await f.post('/auth/signup','third',{setup,workspace:'third',name:'third',email:'third@example.com',password:'a long account password'})).status,403);
});
