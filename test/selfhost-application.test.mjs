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
const org='org_selfhost',setup='setup-token-for-tests';
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-selfhost-app-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createLocalSessionStore(dir),prefix='sessions/selfhost/v1';
  let app;const server=createServer((req,res)=>app(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const origin='http://localhost:'+server.address().port;
  const identity=createLocalIdentity({url:origin,secret:randomBytes(32).toString('hex'),databasePath:join(dir,'identity.sqlite'),organizationId:org});
  await identity.ready();
  const settings={organizationId:org,url:origin,authOrigin:origin+'/api/auth',clientId:'opencrawl-cli',authSecret:'x'.repeat(32),identityPath:join(dir,'identity.sqlite'),setupToken:setup,search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:org}};
  app=selfhostApplication({settings,store,prefix,identity,readAsset:async file=>'asset:'+file});
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
});

test('MCP clients register, need a member’s consent, and receive tokens accepted by /mcp',async t=>{
  const f=await fixture(t);await f.admin();
  const resource=await (await f.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(resource.authorization_servers,[f.origin+'/api/auth']);
  const metadata=await (await f.request('/.well-known/oauth-authorization-server/api/auth')).json();
  assert.equal(metadata.issuer,f.origin+'/api/auth');
  const callback='http://127.0.0.1:33418/callback';
  const client=await (await f.request('/api/auth/oauth2/register',null,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Test agent',redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})})).json();
  assert.ok(client.client_id,JSON.stringify(client));
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  const authorize='/api/auth/oauth2/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:callback,scope:'openid offline_access',state:'s1',code_challenge:challenge,code_challenge_method:'S256',resource:f.origin+'/mcp'});
  const started=await f.request(authorize,'admin',{headers:{accept:'text/html','sec-fetch-mode':'navigate'}});
  // Browsers navigate and get a redirect; fetch() cannot send sec-fetch-mode: navigate, so this is the JSON form.
  const consent=new URL(started.headers.get('location')||(await started.json()).url,f.origin);
  assert.equal(consent.pathname,'/auth/consent');
  assert.match(await (await f.request(consent.pathname+consent.search,'admin')).text(),/Allow Test agent/);
  const approved=await (await f.post('/auth/consent','admin',{oauth_query:consent.searchParams.toString(),accept:'true'})).text();
  const redirect=new URL(/url=([^"]+)"/.exec(approved)[1].replaceAll('&amp;','&'));
  assert.equal(redirect.origin+redirect.pathname,callback);assert.equal(redirect.searchParams.get('state'),'s1');
  const token=await (await f.request('/api/auth/oauth2/token',null,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:redirect.searchParams.get('code'),redirect_uri:callback,client_id:client.client_id,code_verifier:verifier,resource:f.origin+'/mcp'})})).json();
  assert.ok(token.access_token);
  const mcp=await f.request('/mcp',null,{method:'POST',headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}})});
  assert.equal(mcp.status,200);
  assert.equal((await f.request('/mcp',null,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
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
