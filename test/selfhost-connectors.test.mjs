import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selfhostServices} from '../dist/src/selfhost/services.mjs';
import {createComposioOAuth} from '../dist/src/integrations/composio.mjs';

async function fixture(t,extra={}){
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-source-catalog-'));
  const services=selfhostServices({organizationId:'org_team',url:'https://self.example',registryPath:join(dir,'registry.sqlite'),search:{endpoint:'http://127.0.0.1:1',environment:'selfhost',tenantId:'org_team'}},{bucket:'owned'},
    {AIRBYTE_WORKSPACE_ID:'00000000-0000-0000-0000-000000000001',AIRBYTE_URL:'http://127.0.0.1:1',AIRBYTE_CLIENT_ID:'test',AIRBYTE_CLIENT_SECRET:'test',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test',...extra});
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
  const oauth=createComposioOAuth({apiKey:'private-key',organizationId:'org_team',fetch:async(url,options)=>{
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
