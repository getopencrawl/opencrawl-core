import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {selfhostServices} from '../dist/src/selfhost/services.mjs';
import {createComposioOAuth} from '../dist/src/integrations/composio.mjs';
import {createSlackOAuth} from '../dist/src/integrations/slack-oauth.mjs';
import {credentialVault} from '../dist/src/integrations/credential-vault.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {createProviderCatalog} from '../dist/src/integrations/providers.mjs';
import {connectorManifest} from '../dist/src/integrations/manifests.mjs';
import {connectorProxyHandler} from '../dist/src/integrations/proxy-http.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';

async function fixture(t,extra={}){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-source-catalog-'));
  const services=selfhostServices({organizationId:'org_team',url:'https://self.example',registryPath:join(dir,'registry.sqlite'),search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:'org_team'}},Object.assign(createLocalSessionStore(join(dir,'objects')),{bucket:'owned'}),
    {AIRBYTE_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',AIRBYTE_URL:'http://127.0.0.1:1',AIRBYTE_CLIENT_ID:'test',AIRBYTE_CLIENT_SECRET:'test',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test',OPENCRAWL_CONNECTOR_KEY:Buffer.alloc(32,7).toString('base64'),...extra});
  t.after(async()=>{services.close();await rm(dir,{recursive:true,force:true});});return services;
}
const principal={tenantId:'org_team',userId:'user_a'};

test('fresh OSS exposes every supported connector and explains missing setup without starting a connection',async t=>{
  const service=await fixture(t);
  const cards=await service.integrations.list(principal);
  assert.deepEqual(cards.map(c=>c.provider).sort(),['circleback','github','googledrive','granola','notion','slack']);
  assert.equal(cards.find(c=>c.provider==='granola').state,'disconnected');
  for(const card of cards.filter(c=>c.provider!=='granola')){assert.equal(card.state,'setup-required');assert.ok(card.setup.body);}
  await assert.rejects(service.integrations.connect(principal,'notion'),error=>error.status===503);
  assert.equal((await service.registry.listTenant(principal.tenantId)).length,0);
});

test('operator broker enables OAuth connectors without exposing its key in the catalog',async t=>{
  const service=await fixture(t,{COMPOSIO_API_KEY:'operator-private-key'});
  const cards=await service.integrations.list(principal);
  for(const id of ['googledrive','notion','circleback','slack'])assert.equal(cards.find(c=>c.provider===id).state,'disconnected');
  assert.equal(cards.find(c=>c.provider==='github').state,'setup-required');
  assert.ok(!JSON.stringify(cards).includes('operator-private-key'));
});

test('operator OAuth binds requests and source configuration to its single organization',async()=>{
  const calls=[];
  const oauth=createComposioOAuth({apiKey:'private-key',organizationId:'org_team',proxyUrl:'https://self.example',proxyKey:Buffer.alloc(32,7),registry:{list:async()=>[]},fetch:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('/auth_configs?'))return Response.json({items:[]});
    if(url.endsWith('/auth_configs'))return Response.json({auth_config:{id:'ac_owned'}});
    if(url.endsWith('/link'))return Response.json({redirect_url:'https://connect.composio.dev/owned',connected_account_id:'ca_owned'});
    if(url.includes('/connected_accounts/'))return Response.json({id:'ca_owned',user_id:'selfhost:org_foreign:user_a',status:'ACTIVE'});
    throw new Error('Unexpected request');
  }});
  const config=await oauth.authConfig({toolkit:'notion',name:'OpenCrawl Notion',credentials:{}});
  assert.equal(config,'ac_owned');
  const result=await oauth.link({authConfigId:config,userId:'selfhost:org_team:user_a',callbackUrl:'https://self.example/integrations/notion/callback'});
  assert.equal(result.connected_account_id,'ca_owned');
  assert.equal(JSON.parse(calls.at(-1).options.body).user_id,'selfhost:org_team:user_a');
  assert.ok(calls.every(call=>call.url.startsWith('https://backend.composio.dev/api/v3.1/')&&call.options.redirect==='error'&&call.options.headers['x-api-key']==='private-key'));
  assert.throws(()=>oauth.link({authConfigId:config,userId:'selfhost:org_foreign:user_a',callbackUrl:'https://self.example/callback'}),/scope/);
  await assert.rejects(oauth.account('ca_owned'),/scope/);
  const before=calls.length;await assert.rejects(oauth.remove('ca_owned'),/scope/);assert.equal(calls.length,before+1);assert.equal(calls.at(-1).options.method,'GET');
  await assert.rejects(oauth.sourceConfiguration({tenantId:'org_foreign',environment:'selfhost'},{}),/scope/);
});

const OPERATOR_KEY='operator-private-key',APP_FOR_AIRBYTE='http://app.internal:8092';
const brokered=['googledrive','notion','circleback','slack'];
/** The operator broker with a real registry and a recorded stand-in for the Composio API. */
async function broker(t,respond=()=>({status:200,data:{ok:true},headers:{}})){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-broker-'));
  const registry=createSingleOrganizationRegistry({path:join(dir,'registry.sqlite'),organizationId:'org_team'});
  t.after(async()=>{registry.close();await rm(dir,{recursive:true,force:true});});
  const calls=[];
  const oauth=createComposioOAuth({apiKey:OPERATOR_KEY,organizationId:'org_team',proxyUrl:APP_FOR_AIRBYTE,proxyKey:Buffer.alloc(32,7),registry,fetch:async(url,options)=>{
    const body=options.body?JSON.parse(options.body):undefined;calls.push({url,options,body});
    if(url.endsWith('/tools/execute/proxy'))return Response.json(respond(body));
    throw new Error('Unexpected request');
  }});
  const providers=createProviderCatalog({...Object.fromEntries([...brokered,'granola'].map(id=>[id,{name:id,manifest:connectorManifest(id)}])),github:{name:'github',docker:{repository:'r',tag:'t'}}});
  let n=0;
  const connect=(provider,connectedAccountId,userId='user_a')=>registry.create({tenantId:'org_team',userId,integrationId:'int_'+String(++n).padStart(26,'0'),provider,environment:'selfhost',scope:'team',status:'active',
    createdAt:new Date().toISOString(),startDate:'2026-01-01T00:00:00Z',connectedAccountId,settings:{folderId:77}});
  return {registry,oauth,calls,providers,connect};
}

/** Airbyte refuses to create a source whose settings miss a required field or a declared type, pattern or range. */
function conforms(id,config,manifest){
  const spec=manifest.spec.connection_specification;
  for(const key of spec.required)assert.ok(config[key]!==undefined&&config[key]!=='',`${id} manifest requires ${key}`);
  for(const [key,value] of Object.entries(config)){
    assert.ok(Object.hasOwn(spec.properties,key),`${id} manifest does not declare ${key}`);
    const declared=spec.properties[key];
    assert.equal(Number.isInteger(value)?'integer':typeof value,declared.type,`${id} ${key} must be ${declared.type}`);
    if(declared.pattern)assert.match(value,new RegExp(declared.pattern),`${id} ${key} must match ${declared.pattern}`);
    if(declared.minimum!==undefined)assert.ok(value>=declared.minimum&&value<=declared.maximum,`${id} ${key} is out of range`);
  }
}
test('every brokered connector receives the configuration its manifest requires, without the operator key',async t=>{
  const f=await broker(t);
  for(const id of brokered){
    const record=await f.connect(id,'ca_'+id),config=await f.oauth.sourceConfiguration(record,f.providers[id]);
    conforms(id,config,connectorManifest(id));
    assert.equal(config.credential_proxy_base_url,APP_FOR_AIRBYTE);
    assert.equal(config.connected_account_id,'ca_'+id);assert.equal(config.user_id,'selfhost:org_team:user_a');
    assert.ok(!JSON.stringify(config).includes(OPERATOR_KEY));
  }
  // A capability is specific to one connection and one owner.
  const drive=await f.oauth.sourceConfiguration((await f.registry.list('org_team','user_a'))[0],f.providers.googledrive);
  const other=await f.oauth.sourceConfiguration(await f.connect('googledrive','ca_second','user_b'),f.providers.googledrive);
  assert.notEqual(drive.credential_proxy_api_key,other.credential_proxy_api_key);
  assert.equal(f.calls.length,0);
});

test('the operator’s own Slack app receives the configuration its registered connector requires',async t=>{
  // What self-host registers in Airbyte once a Slack app is configured, and the provider that builds the source settings.
  const {providers}=await fixture(t,{SLACK_CLIENT_ID:'client-id',SLACK_CLIENT_SECRET:'client-secret'});
  assert.equal(providers.slack.connector.name,'OpenCrawl Slack (operator OAuth)');
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-slack-app-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const record={tenantId:'org_team',userId:'user_a',integrationId:'int_'+'a'.repeat(26),provider:'slack',environment:'selfhost',status:'provisioning',startDate:'2026-01-01T00:00:00Z'};
  let connectedAccountId=null;
  const slack=createSlackOAuth({organizationId:'org_team',url:'https://self.example',proxyUrl:APP_FOR_AIRBYTE,clientId:'client-id',clientSecret:'client-secret',
    vault:credentialVault({store:createLocalSessionStore(dir),key:Buffer.alloc(32,7),prefix:'credentials',organizationId:'org_team'}),registry:{get:async()=>({...record,connectedAccountId})},
    fetch:async target=>new URL(target).pathname==='/api/oauth.v2.access'
      ?Response.json({ok:true,authed_user:{token_type:'user',access_token:'access-secret',refresh_token:'refresh-secret',scope:'channels:read,channels:history,search:read,users:read,team:read,emoji:read',expires_in:3600}})
      :Response.json({ok:true,team_id:'T123',team:'Test',user:'Test'})});
  const link=await slack.link({authConfigId:'slack',userId:'selfhost:org_team:user_a',callbackUrl:'https://self.example/integrations/slack/callback?integration='+record.integrationId+'&state=nonce'});
  connectedAccountId=link.connected_account_id;
  await slack.complete({tenantId:'org_team',userId:'user_a'},new URLSearchParams({state:new URL(link.redirect_url).searchParams.get('state'),code:'one-use-code'}));
  const config=await slack.sourceConfiguration({...record,connectedAccountId},providers.slack);
  conforms('slack (own app)',config,providers.slack.connector.manifest);
  assert.equal(config.connected_account_id,connectedAccountId);assert.equal(config.credential_proxy_base_url,APP_FOR_AIRBYTE);
  assert.doesNotMatch(JSON.stringify(config),/access-secret|refresh-secret|client-secret/);
  // The brokered Slack connector keeps the published manifest, which names a broker account.
  assert.throws(()=>conforms('slack (published)',config,connectorManifest('slack')),/must match/);
});

test('a brokered source capability reads only its own provider’s listed endpoints while connected',async t=>{
  const f=await broker(t);
  const drive=await f.connect('googledrive','ca_drive'),config=await f.oauth.sourceConfiguration(drive,f.providers.googledrive);
  const call=(input,{secret=config.credential_proxy_api_key,id='ca_drive',user=config.user_id}={})=>f.oauth.proxyCredential(id,secret,user,input);
  const files={endpoint:'https://www.googleapis.com/drive/v3/files',query:{pageSize:'100'}};
  assert.equal((await call(files)).status,200);
  const sent=f.calls.at(-1);
  assert.equal(sent.url,'https://backend.composio.dev/api/v3.1/tools/execute/proxy');assert.equal(sent.options.headers['x-api-key'],OPERATOR_KEY);
  assert.deepEqual(sent.body,{connected_account_id:'ca_drive',user_id:'selfhost:org_team:user_a',endpoint:files.endpoint,method:'GET',parameters:[{name:'pageSize',value:'100',type:'query'}]});
  assert.equal((await call({endpoint:'https://www.googleapis.com/drive/v3/files/file_1-x/export',query:{mimeType:'text/markdown'}})).status,200);
  const upstream=f.calls.length;
  await assert.rejects(call(files,{secret:'wrong'}),{status:403});
  await assert.rejects(call(files,{secret:''}),{status:403});
  await assert.rejects(call(files,{user:'selfhost:org_team:user_b'}),{status:403});
  await assert.rejects(call(files,{user:'selfhost:org_foreign:user_a'}),{status:403});
  await assert.rejects(call(files,{id:'ca_other'}),{status:403});
  for(const denied of [
    {endpoint:'https://www.googleapis.com/upload/drive/v3/files',method:'POST',body:{}},
    {endpoint:'https://www.googleapis.com/drive/v3/files',method:'POST',body:{name:'new'}},
    {endpoint:'https://www.googleapis.com/drive/v3/files/file_1',method:'DELETE'},
    {endpoint:'https://www.googleapis.com/drive/v3/files/file_1/permissions'},
    {endpoint:'https://www.googleapis.com/drive/v3/files?corpora=user'},
    {endpoint:'https://www.googleapis.com/drive/v3/files#x'},
    {endpoint:'https://user:pass@www.googleapis.com/drive/v3/files'},
    {endpoint:'https://www.googleapis.com.evil.example/drive/v3/files'},
    {endpoint:'https://api.notion.com/v1/users'},
    {endpoint:'not a url'},
    {...files,body:{}},
    {...files,headers:{Authorization:'Bearer stolen'}},
  ])await assert.rejects(call(denied),{status:403},JSON.stringify(denied));
  assert.equal(f.calls.length,upstream);

  const notion=await f.connect('notion','ca_notion'),notionConfig=await f.oauth.sourceConfiguration(notion,f.providers.notion);
  const read=input=>f.oauth.proxyCredential('ca_notion',notionConfig.credential_proxy_api_key,notionConfig.user_id,input);
  await read({endpoint:'https://api.notion.com/v1/search',method:'POST',headers:{'Notion-Version':'2026-03-11'},body:{page_size:100}});
  assert.deepEqual(f.calls.at(-1).body,{connected_account_id:'ca_notion',user_id:'selfhost:org_team:user_a',endpoint:'https://api.notion.com/v1/search',method:'POST',body:{page_size:100},parameters:[{name:'Notion-Version',value:'2026-03-11',type:'header'}]});
  await assert.rejects(read({endpoint:'https://api.notion.com/v1/pages',method:'POST',body:{}}),{status:403});
  await assert.rejects(read(files),{status:403});
  // The drive capability does not open another connection's account.
  await assert.rejects(call({endpoint:'https://api.notion.com/v1/users'},{id:'ca_notion'}),{status:403});

  await f.registry.update(drive,{status:'disconnecting'});
  const before=f.calls.length;await assert.rejects(call(files),{status:403});assert.equal(f.calls.length,before);
});

test('brokered Slack keeps the public-channel policy of the direct adapter',async t=>{
  const f=await broker(t,body=>{
    const method=new URL(body.endpoint).pathname.slice('/api/'.length);
    if(method==='conversations.list')return {status:200,data:{ok:true,channels:[{id:'C_PUBLIC',name:'general',is_private:false},{id:'C_PRIVATE',name:'private',is_private:true}]},headers:{}};
    if(method==='search.messages')return {status:200,data:{ok:true,messages:{matches:[{text:'public',channel:{id:'C_PUBLIC'}},{text:'private',channel:{id:'C_PRIVATE'}}]}},headers:{'retry-after':'3'}};
    return {status:200,data:{ok:true},headers:{}};
  });
  const config=await f.oauth.sourceConfiguration(await f.connect('slack','ca_slack'),f.providers.slack);
  const call=input=>f.oauth.proxyCredential('ca_slack',config.credential_proxy_api_key,config.user_id,input);
  await assert.rejects(call({endpoint:'https://slack.com/api/chat.postMessage',method:'POST'}),{status:403});
  await assert.rejects(call({endpoint:'https://slack.com/api/conversations.list',query:{types:'private_channel'}}),{status:403});
  await assert.rejects(call({endpoint:'https://slack.com/api/search.messages',query:{query:'secret'}}),{status:403});
  await assert.rejects(call({endpoint:'https://slack.com/api/search.messages',query:{query:'in:#private after:2026-01-01'}}),{status:403});
  const result=await call({endpoint:'https://slack.com/api/search.messages',query:{query:'in:#general after:2026-01-01'}});
  assert.deepEqual(result.data.messages.matches.map(hit=>hit.text),['public']);assert.equal(result.headers['retry-after'],'3');
  assert.deepEqual(f.calls.at(-1).body.parameters,[{name:'query',value:'in:#general after:2026-01-01',type:'query'}]);
  assert.ok(f.calls.every(c=>c.body.method==='GET'&&c.body.user_id==='selfhost:org_team:user_a'&&c.body.connected_account_id==='ca_slack'));
});

test('the connector proxy route carries brokered reads, including a request body, and refuses browsers',async t=>{
  const f=await broker(t,()=>({status:200,data:{results:[{id:'page_1'}]},headers:{}}));
  const config=await f.oauth.sourceConfiguration(await f.connect('notion','ca_notion'),f.providers.notion);
  const server=createServer(connectorProxyHandler(f.oauth));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const post=(body,headers={})=>fetch(`http://127.0.0.1:${server.address().port}/api/connector-proxy`,{method:'POST',headers:{'content-type':'application/json','x-api-key':config.credential_proxy_api_key,...headers},body:JSON.stringify(body)});
  const search={connected_account_id:'ca_notion',user_id:config.user_id,endpoint:'https://api.notion.com/v1/search',method:'POST',parameters:[{name:'Notion-Version',value:'2026-03-11',type:'header'}],body:{page_size:100}};
  const ok=await post(search);assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{status:200,data:{results:[{id:'page_1'}]},headers:{}});
  assert.equal((await post(search,{'x-api-key':'wrong'})).status,403);
  assert.equal((await post(search,{origin:'https://self.example'})).status,403);
  assert.equal((await post({...search,method:'DELETE'})).status,400);
  assert.equal((await post({...search,endpoint:'https://api.notion.com/v1/pages'})).status,403);
  assert.equal(f.calls.length,1);
});

/** A stand-in for the broker's API that accepts exactly one project key. */
async function brokerService(t,accepted='good-project-key'){
  const seen=[];
  const server=createServer((req,res)=>{
    seen.push({method:req.method,url:req.url,key:req.headers['x-api-key']});
    if(req.headers['x-api-key']!==accepted){res.writeHead(401,{'content-type':'application/json'});return res.end('{"error":"invalid key"}');}
    res.writeHead(200,{'content-type':'application/json'});res.end('{"items":[]}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  return {url:'http://127.0.0.1:'+server.address().port,seen};
}
async function installation(t,env={}){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-connector-settings-'));
  const store=Object.assign(createLocalSessionStore(join(dir,'objects')),{bucket:'owned'});
  const open=()=>{const services=selfhostServices({organizationId:'org_team',url:'https://self.example',registryPath:join(dir,'registry.sqlite'),search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:'org_team'}},store,
    {AIRBYTE_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',AIRBYTE_URL:'http://127.0.0.1:1',AIRBYTE_CLIENT_ID:'test',AIRBYTE_CLIENT_SECRET:'test',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test',OPENCRAWL_CONNECTOR_KEY:Buffer.alloc(32,7).toString('base64'),...env});
    t.after(()=>services.close());return services;};
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return {store,open};
}
const states=async service=>Object.fromEntries((await service.integrations.list(principal)).map(card=>[card.provider,card.state]));

test('an admin-entered broker key is checked, stored encrypted, and enables its connectors without a restart',async t=>{
  const composio=await brokerService(t),f=await installation(t,{COMPOSIO_BASE_URL:composio.url}),service=f.open();
  const before=await service.integrations.list(principal),drive=before.find(card=>card.provider==='googledrive');
  assert.equal(drive.state,'setup-required');assert.equal(drive.setup.requirement,'Needs a Composio key');
  assert.deepEqual({id:drive.setup.credential.id,unlocks:drive.setup.credential.unlocks},{id:'composio',unlocks:['Google Drive','Notion','Circleback','Slack']});
  assert.match(drive.setup.credential.url,/^https:\/\/dashboard\.composio\.dev\//);
  const github=before.find(card=>card.provider==='github');
  assert.equal(github.setup.requirement,'Needs a GitHub App');assert.equal(github.setup.credential,undefined);

  const by={userId:'user_a'};
  await assert.rejects(service.connectorSettings.save('other','good-project-key',by),{status:404,expose:true});
  await assert.rejects(service.connectorSettings.save('composio','',by),{status:400,expose:true});
  await assert.rejects(service.connectorSettings.save('composio','has spaces in it',by),{status:400,expose:true});
  assert.equal(composio.seen.length,0);
  await assert.rejects(service.connectorSettings.save('composio','wrong-project-key',by),error=>error.status===400&&error.expose&&/did not accept/.test(error.message));
  assert.equal((await states(service)).notion,'setup-required');

  await service.connectorSettings.save('composio','  good-project-key\n',by);
  assert.deepEqual(composio.seen.at(-1),{method:'GET',url:'/api/v3.1/auth_configs?limit=1',key:'good-project-key'});
  assert.deepEqual(await states(service),{googledrive:'disconnected',slack:'disconnected',granola:'disconnected',circleback:'disconnected',notion:'disconnected',github:'setup-required'});
  const sealed=await f.store.get('connector-settings/v1/org_team/settings.enc');
  assert.ok(sealed.length>40);assert.ok(!sealed.includes(Buffer.from('good-project-key')));
  assert.ok(!JSON.stringify(await service.integrations.list(principal)).includes('good-project-key'));
  // The saved key survives a restart and reaches a second process.
  assert.equal((await states(f.open())).notion,'disconnected');
});

test('a broker key from the server environment cannot be replaced in the product; without a connector key nothing is stored',async t=>{
  const composio=await brokerService(t);
  const managed=(await installation(t,{COMPOSIO_BASE_URL:composio.url,COMPOSIO_API_KEY:'good-project-key'})).open();
  assert.equal((await states(managed)).googledrive,'disconnected');
  await assert.rejects(managed.connectorSettings.save('composio','another-project-key',{userId:'user_a'}),{status:409,expose:true});
  const bare=(await installation(t,{COMPOSIO_BASE_URL:composio.url,OPENCRAWL_CONNECTOR_KEY:''})).open();
  const card=(await bare.integrations.list(principal)).find(c=>c.provider==='notion');
  assert.equal(card.state,'setup-required');assert.equal(card.setup.credential,undefined);assert.match(card.setup.body,/COMPOSIO_API_KEY/);
  await assert.rejects(bare.connectorSettings.save('composio','good-project-key',{userId:'user_a'}),{status:409,expose:true});
  assert.equal(composio.seen.length,0);
});
