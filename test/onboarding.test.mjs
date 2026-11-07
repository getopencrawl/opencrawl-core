import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createOnboardingStatus} from '../src/onboarding-status.mjs';
import {createSessionIngest} from '../src/sessions/ingest.mjs';
import {createOpenCrawlMcp} from '../src/mcp/server.mjs';
import {standaloneCapture} from '../src/sessions/standalone.mjs';
import {createLocalSessionStore} from '../src/sessions/local-store.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const principal = {tenantId:'tenant-a', userId:'user-a'};
const batch = {schemaVersion:1,owner:principal,installationId:'install',sessionId:'session',harness:'codex',origin:'cli',events:[{id:'event',kind:'message'}],attachments:[]};

test('receipts persist, fail closed by scope, and only follow durable accepted sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(),'opencrawl-onboarding-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=createLocalSessionStore(directory);
  const status=createOnboardingStatus({store});
  assert.deepEqual(await status.read(principal), {cli:null,mcp:null,mcpTest:null,session:null});
  await assert.rejects(status.read({userId:'user-a'}), /Authentication/);
  await status.cli(principal);
  await status.mcp(principal, {name:'codex'});
  assert.equal((await status.read(principal)).mcpTest,null);
  await status.mcpTest(principal);
  assert.ok((await createOnboardingStatus({store:createLocalSessionStore(directory)}).read(principal)).mcpTest.observedAt);
  const ingest=createSessionIngest({store,onStored:status.session});
  await assert.rejects(ingest.putBatch({...principal,userId:'user-b'},batch), /owner/);
  assert.equal((await status.read(principal)).session,null);
  await ingest.putBatch(principal,batch);
  assert.equal((await createOnboardingStatus({store:createLocalSessionStore(directory)}).read(principal)).session.harness,'codex');
  for (const other of [{...principal,tenantId:'tenant-b'},{...principal,userId:'user-b'}]) {
    assert.deepEqual(await status.read(other),{cli:null,mcp:null,mcpTest:null,session:null});
  }
  let receipts=0;
  const broken={...memorySessionStore(),put:async()=>{throw new Error('storage down');}};
  await assert.rejects(createSessionIngest({store:broken,onStored:()=>receipts++}).putBatch(principal,batch),/storage down/);
  assert.equal(receipts,0);
});

test('real MCP clients record independent authenticated identities in legacy and modern exchanges', async t => {
  const objects=new Map(), store={put:async(k,v)=>objects.set(k,v),get:async k=>objects.get(k)};
  const status=createOnboardingStatus({store});
  let handler;
  const server=createServer((req,res)=>handler(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const calls=[];
  handler=createOpenCrawlMcp({origin,authenticate:async req=>req.headers.authorization==='Bearer test'?principal:null,onAuthenticated:(who,info,request)=>{calls.push(request);return status.mcp(who,info);},onConnectionTest:status.mcpTest});
  t.after(async()=>{await handler.close();await new Promise(r=>server.close(r));});
  assert.equal((await fetch(origin+'/mcp')).status,401);
  assert.equal((await status.read(principal)).mcp,null);
  for (const [mode,name,expected] of [['legacy','claude-code','Claude'],['auto','ChatGPT','ChatGPT'],['auto','unrecognized','']]) {
    const client=new Client({name,version:'1'},{versionNegotiation:{mode}});
    await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer test'}}}));
    await client.listTools();
    const before=(await status.read(principal)).mcpTest;
    if (mode === 'legacy') assert.equal(before,null);
    assert.equal((await client.callTool({name:'test_connection',arguments:{url:'https://untrusted.test'}})).isError,true);
    assert.deepEqual((await status.read(principal)).mcpTest,before);
    await client.callTool({name:'opencrawl',arguments:{}});
    assert.deepEqual((await status.read(principal)).mcpTest,before);
    const result=await client.callTool({name:'test_connection',arguments:{}});
    assert.notEqual(result.isError,true);
    assert.ok((await status.read(principal)).mcpTest.observedAt);
    await client.close();
    assert.equal((await status.read(principal)).mcp.client,expected || null);
  }
  assert.equal((await status.read({...principal,userId:'user-b'})).mcp,null);
  assert.equal((await status.read({...principal,userId:'user-b'})).mcpTest,null);
  assert.ok(calls.some(c=>c.method==='tools/call'&&c.tool==='test_connection'));
  assert.ok(calls.some(c=>c.method==='tools/list'&&c.tool===null));
});

test('single-tenant receiver exposes authenticated onboarding without hosted services', async t => {
  const store=memorySessionStore();
  const token='x'.repeat(32);
  const server=createServer(standaloneCapture({token,principal,store}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const headers={authorization:'Bearer '+token};
  assert.equal((await fetch(base+'/api/onboarding')).status,401);
  await fetch(base+'/api/sessions/identity',{headers});
  assert.equal((await fetch(base+'/api/sessions/batches',{method:'POST',headers,body:JSON.stringify(batch)})).status,200);
  const result=await (await fetch(base+'/api/onboarding',{headers})).json();
  assert.ok(result.data.cli.observedAt);
  assert.equal(result.data.session.harness,'codex');
});


test('test_connection fails rather than acknowledging an unrecorded verification', async t => {
  let handler;
  const server=createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  handler=createOpenCrawlMcp({origin,authenticate:async()=>principal,onConnectionTest:async()=>{throw new Error('receipt storage unavailable');}});
  t.after(async()=>{await handler.close();await new Promise(resolve=>server.close(resolve));});
  const client=new Client({name:'codex',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp')));
  t.after(()=>client.close());
  assert.equal((await client.callTool({name:'test_connection',arguments:{}})).isError,true);
});
