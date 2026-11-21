import {boardStateFixture} from './fixtures/board-state.mjs';
import {postgresUrl} from './fixtures/application-database.mjs';
import {randomBytes} from 'node:crypto';
import {createSetupState} from '../dist/src/state/setup.mjs';
import {createRecordingPolicy} from '../dist/src/state/recording.mjs';
import {createDevinState} from '../dist/src/state/devin.mjs';
import {createPostgresEventIdentities} from '../dist/src/sessions/postgres-identities.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair,SignJWT} from 'jose';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {selfhostApplication} from '../dist/src/selfhost/application.mjs';
import {createLocalIdentity} from '../dist/src/identity/better-auth.mjs';
import {createDevinVerifier,DEVIN_ISSUER} from '../dist/src/identity/devin.mjs';
import {createDevinConnections} from '../dist/src/identity/devin-connections.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {singleOrganizationSessionSource} from '../dist/src/selfhost/indexing.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';

test('self-host admin connects Devin once; fresh cloud sessions use CLI, capture and native MCP with revocable scoped identities',{skip:!postgresUrl},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'devin-selfhost-')),store=createLocalSessionStore(dir),prefix='sessions/selfhost/v1';
  const {database,state:boardState}=await boardStateFixture(t),devinState=createDevinState(database,randomBytes(32)),setupState=createSetupState(database),recording=createRecordingPolicy(database),eventIdentities=createPostgresEventIdentities({connectionString:postgresUrl,namespace:database.namespace});
  await Promise.all([devinState.ready(), setupState.ready(), recording.ready()]);
  t.after(async()=>{await eventIdentities.close();});
  const organizationId='org_local',org='org-11111111111141118111111111111111';
  let app;const server=createServer((req,res)=>app(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://localhost:'+server.address().port;
  const identity=await createLocalIdentity({url,secret:'x'.repeat(40),database,organizationId});await identity.ready();
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await identity.close();await rm(dir,{recursive:true,force:true});});
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const settings={url,authOrigin:url+'/api/auth',clientId:'opencrawl-cli',organizationId,setupToken:'setup',search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:organizationId}};
  app=selfhostApplication({settings,boardState,devinState,setupState,recording,eventIdentities,store,prefix,identity,devinIdentityKey:async()=>publicKey,readAsset:async()=>''});
  const sign=(session,changes={})=>new SignJWT({org_id:org,devin_id:session,...changes}).setProtectedHeader({alg:'RS256'}).setIssuer(DEVIN_ISSUER).setAudience(url).setSubject(`org_id:${org}`).setIssuedAt().setExpirationTime('60s').sign(privateKey);
  const token=await sign('cloud-one'),fresh=await sign('cloud-two');
  const request=(path,body,auth=token,headers={})=>fetch(url+path,{method:body!==undefined?'POST':'GET',headers:{authorization:'Bearer '+auth,'content-type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('/api/cli/me')).status,403);
  const signup=await fetch(url+'/auth/signup',{method:'POST',redirect:'manual',headers:{origin:url,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({setup:'setup',workspace:'Local team',name:'Ada Admin',email:'ada@example.com',password:'correct horse battery'})});
  assert.equal(signup.status,303);
  const cookie=signup.headers.getSetCookie().map(line=>line.split(';')[0]).join('; ');
  // Issue through the real CLI device grant, with no hosted account or tokens.
  const form=(path,body,headers={})=>fetch(url+path,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(body)});
  const device=await(await form('/api/cli/device',{client_id:'opencrawl-cli'})).json();
  assert.equal((await form('/device',{user_code:device.user_code,decision:'approve'},{origin:url,cookie})).status,200);
  const login=await form('/api/cli/token',{client_id:'opencrawl-cli',grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code});
  assert.equal(login.status,200);const human=(await login.json()).access_token;
  const approvalPath='/api/cli/workloads/devin/approval';
  const cliApproval=await request(approvalPath,{},human);assert.equal(cliApproval.status,200);assert.equal(cliApproval.headers.get('cache-control'),'no-store');
  const cliSetup=(await cliApproval.json()).data;assert.match(cliSetup.code,/^[a-f0-9]{64}$/);assert.equal(cliSetup.workspaceId,organizationId);
  for(const [path,body,auth,headers,status] of [
    [approvalPath,{},token,{},403],[approvalPath,{},'invalid',{},401],
    [approvalPath,{},human,{origin:url},403],[approvalPath+'?tenant=other',{},human,{},403],
    [approvalPath,{tenantId:'org_other'},human,{},400],[approvalPath,[],human,{},400],
    [approvalPath,undefined,human,{},405],
  ])assert.equal((await request(path,body,auth,headers)).status,status);
  for(const body of ['not-json','',JSON.stringify({large:'x'.repeat(4100)})]){
    const malformed=await fetch(url+approvalPath,{method:'POST',headers:{authorization:'Bearer '+human},body});
    assert.equal(malformed.status,400);
  }
  assert.equal((await request('/api/devin/connect',{code:cliSetup.code})).status,200);
  const setup=(await (await request(approvalPath,{},human)).json()).data;
  for(const [path,body,auth,headers,expected] of [
    ['/api/devin/connect',{code:setup.code},token,{origin:url},403],
    ['/api/devin/connect?tenant=other',{code:setup.code},token,{},403],
    ['/api/devin/connect',{code:setup.code,tenantId:organizationId},token,{},400],
    ['/api/devin/connect',{code:setup.code},'invalid',{},401],
  ])assert.equal((await request(path,body,auth,headers)).status,expected);
  const connected=await request('/api/devin/connect',{code:setup.code});assert.equal(connected.status,200);
  assert.deepEqual(await connected.json(),{organizationId:org,tenantId:organizationId,connected:true});
  assert.equal((await request('/api/devin/connect',{code:setup.code},fresh)).status,409);
  const me=await request('/api/cli/me');assert.equal(me.status,200);assert.equal((await me.json()).data.credential,'workspace-identity');
  const principal=(await (await request('/api/sessions/identity')).json()).data.principal;
  const second=(await (await request('/api/sessions/identity',undefined,fresh)).json()).data.principal;
  assert.equal(principal.captureAccess,'write');assert.equal(principal.owner.provider,'devin');
  assert.notEqual(principal.userId,second.userId);assert.equal(second.tenantId,organizationId);
  const batch={schemaVersion:1,installationId:'fixture',sessionId:'cloud-one',harness:'devin',origin:'cloud',captureMode:'live',owner:principal,events:[{id:'event',kind:'message',data:{role:'user',content:'Devin self-host fixture'},sequence:0}],attachments:[]};
  for(const altered of [{sessionId:'cloud-two'},{harness:'codex'}])assert.equal((await request('/api/sessions/batches',{...batch,...altered})).status,403);
  const first=await request('/api/sessions/batches',batch);assert.equal(first.status,200);const receipt=(await first.json()).data;
  const again=await request('/api/sessions/batches',batch);assert.equal(again.status,200);assert.deepEqual((await again.json()).data,receipt);
  for(const owner of [{tenantId:organizationId,userId:'human'},{...principal,tenantId:'org_other'},second])assert.equal((await request('/api/sessions/batches',{...batch,owner})).status,403);
  assert.equal((await request('/api/sessions/credentials',{})).status,403);
  assert.equal((await request('/api/console/bootstrap')).status,401);
  assert.equal((await request('/api/board/register',{session:'cloud-one',name:'devin:one',task:'Synthetic parity',harness:'devin'})).status,200);
  assert.equal((await request('/api/board/register',{session:'cloud-two',name:'devin:two',task:'Synthetic receiver',harness:'devin'},fresh)).status,200);
  const posted=await request('/api/board/publish',{session:'cloud-one',id:'fixture',topic:'parity',text:'@devin:two synthetic notice'});assert.equal(posted.status,200);
  const inbox=(await (await request('/api/board/inbox',{session:'cloud-two'},fresh)).json()).data;
  assert.equal(inbox.batch.messages[0].text,'@devin:two synthetic notice');
  assert.equal((await request('/api/board/ack',{session:'cloud-two',receipt:inbox.batch.receipt},fresh)).status,200);
  assert.equal((await request('/api/board/fetch',{workspace:'org_other',id:'message:1'})).status,403);
  assert.equal((await request('/api/board/publish',{session:'cloud-one',id:'forged',topic:'parity',text:'wrong owner'},fresh)).status,404);
  const client=new Client({name:'devin-selfhost-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}));
  try {
    assert.equal((await client.callTool({name:'test_connection',arguments:{}})).structuredContent.connected,true);
    const fetched=await client.callTool({name:'board_fetch',arguments:{id:'message:1'}});
    assert.notEqual(fetched.isError,true);assert.match(JSON.stringify(fetched),/synthetic notice/);
    assert.equal((await client.callTool({name:'board_fetch',arguments:{workspace:'org_other',id:'message:1'}})).isError,true);
  } finally {await client.close();}
  const source=singleOrganizationSessionSource(settings,store,prefix,eventIdentities),resolved=await source.resolve({sourceId:source.sourceId}),documents=[];
  const worker=createSessionPipeline({...resolved,search:{identity:'devin-fixture',ensureIndex:async()=>{},putDocuments:async rows=>documents.push(...rows)}});
  for(const key of (await worker.listPage()).keys)await worker.processObject({key});
  assert.equal(documents.length,1);assert.equal(documents[0].document.text,'Devin self-host fixture');
  assert.equal(documents[0].document.userId,principal.userId);assert.equal(documents[0].document.tenantId,organizationId);
  for(const owner of [{...principal,tenantId:'org_other'},{...principal,userId:'workload_devin_forged'}])await assert.rejects(resolved.resolvePrincipal({batch:{owner}}),/scope denied/);
  const ingest=createSessionIngest({store,eventIdentities,prefix}),humanOwner={tenantId:organizationId,userId:'human'};
  const humanReceipt=await ingest.putBatch(humanOwner,{...batch,owner:humanOwner});
  await createControls({store,prefix}).update(humanOwner,'sessions','devin','cloud-one',()=>({visibility:'private',deletedAt:null}));
  assert.equal(await ingest.getBatch({...principal,captureAccess:undefined},{...humanReceipt,harness:'devin',installationId:'fixture',sessionId:'cloud-one',userId:'human'}),null);
  const [member]=(await identity.directory.userManagement.listOrganizationMemberships({organizationId})).data;
  const connections=createDevinConnections({repository:devinState,verify:createDevinVerifier({audience:url,key:async()=>publicKey}),isAdmin:async p=>p.userId===member.userId});
  const admin={tenantId:organizationId,userId:member.userId};
  await identity.directory.userManagement.updateOrganizationMembership(member.id,{roleSlug:'member'});
  assert.equal((await request(approvalPath,{},human)).status,403,'an existing CLI login loses approval authority when demoted');
  await identity.directory.userManagement.updateOrganizationMembership(member.id,{roleSlug:'admin'});
  assert.equal((await connections.sharedInstallations(admin))[0].name,'Devin Cloud');
  const eventGrant='/api/cli/workloads/devin/event-grant', startupEvents='/api/cli/workloads/devin/startup-events';
  const realFetch=globalThis.fetch;
  let inspectedKeys=0,eventsAvailable=true;
  const prepare={action:'prepareRecording'};

  const interception=t.mock.method(globalThis,'fetch',(target,init)=>{
    if(String(target)==='https://api.devin.ai/v3/self'){
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer cog_test_org');
      inspectedKeys++;
      return Promise.resolve(Response.json({principal_type:'service_user',org_id:org}));
    }
    if(String(target)==='https://mcp.devin.ai/mcp'){
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer cog_test_org');
      const body=JSON.parse(init.body);
      if(body.method==='notifications/initialized')return Promise.resolve(new Response(null,{status:202}));
      assert.ok(['initialize','tools/list'].includes(body.method),'setup must never read an actual session');
      const result=body.method==='initialize'
        ?{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'devin-fixture',version:'1'}}
        :{tools:eventsAvailable?[{name:'devin_session_events',inputSchema:{type:'object',properties:{}}}]:[]};
      return Promise.resolve(Response.json({jsonrpc:'2.0',id:body.id,result}));
    }
    return realFetch(target,init);
  });
  const input={organizationId:org,serviceKey:'cog_test_org',restrictToOneSession:true};
  assert.equal((await request(eventGrant,input,token)).status,403);
  assert.equal((await request(eventGrant,{...input,tenantId:'other'},human)).status,400);
  assert.equal((await request(eventGrant,input,human,{origin:url})).status,403);
  assert.equal(inspectedKeys,0);
  assert.equal((await request(eventGrant,prepare,token)).status,403);
  const missing=await request(eventGrant,prepare,human);
  assert.equal(missing.status,412);
  assert.equal((await missing.json()).error.code,'DEVIN_RECORDING_CREDENTIAL_REQUIRED');
  eventsAvailable=false;
  const unavailable=await request(eventGrant,{...prepare,serviceKey:input.serviceKey},human);
  assert.equal((await unavailable.json()).error.code,'DEVIN_RECORDING_EVENTS_UNAVAILABLE');
  assert.equal(await devinState.eventGrants.read(organizationId,org),null);
  eventsAvailable=true;
  const prepared=await request(eventGrant,{...prepare,serviceKey:input.serviceKey},human);
  assert.deepEqual((await prepared.json()).data,{recording:true,organizationId:org,scope:'organization'});
  const authorized=await devinState.eventGrants.read(organizationId,org);
  assert.equal((await request(eventGrant,prepare,human)).status,200);
  assert.deepEqual(await devinState.eventGrants.read(organizationId,org),authorized,'reuse preserves the first eligible timestamp');
  assert.equal((await request(eventGrant,{...prepare,restrictToOneSession:true},human)).status,409);
  assert.equal((await request(eventGrant,{...prepare,serviceKey:'cog_different'},human)).status,409);
  await request(eventGrant,{organizationId:org,serviceKey:null},human);
  const grantReceipt=await request(eventGrant,input,human);
  assert.equal(grantReceipt.status,200);
  assert.deepEqual((await grantReceipt.json()).data,{enabled:true,organizationId:org});
  assert.equal(inspectedKeys,4);
  assert.equal((await request(eventGrant,{organizationId:org,selectSession:'devin-synthetic'},human)).status,200);
  assert.equal((await request(startupEvents,{installationId:'unknown',through:new Date().toISOString()},token)).status,403);
  assert.equal((await request(startupEvents,{sessionId:'devin-synthetic',installationId:'unknown',through:new Date().toISOString()},token)).status,400);
  assert.equal((await request(startupEvents,{installationId:'unknown',through:new Date().toISOString()},human)).status,401);
  assert.equal((await request(eventGrant,prepare,human)).status,409,'an export cannot silently widen a pilot');
  assert.equal((await request(eventGrant,{...prepare,restrictToOneSession:true},human)).status,200);
  assert.equal((await devinState.eventGrants.read(organizationId,org)).sessionId,'devin-synthetic');
  assert.equal(inspectedKeys,5);
  interception.mock.restore();
  const disconnect='/api/cli/workloads/devin/disconnect';
  assert.equal((await request(disconnect,{organizationId:org},token)).status,403);
  assert.equal((await request(disconnect,{organizationId:org,tenantId:'org_other'},human)).status,400);
  assert.equal((await request(disconnect,{organizationId:org},human)).status,200);
  assert.equal((await request('/api/devin/connect',{code:setup.code})).status,409,'revoked approval cannot reopen access');
  assert.equal((await request('/api/cli/me')).status,403);assert.equal((await request('/api/cli/me',undefined,fresh)).status,403);
  assert.equal((await request('/api/sessions/batches',batch)).status,403);
  assert.equal((await request('/api/board/inbox',{session:'cloud-two'},fresh)).status,403);
  const revoked=new Client({name:'revoked',version:'1'});
  await assert.rejects(revoked.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}})));
  await revoked.close();
});
