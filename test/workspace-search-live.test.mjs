import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createObjectStore} from '../dist/src/sessions/s3-store.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {createConnectorPipeline} from '../dist/src/connectors/pipeline.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createOpenCrawlMcp} from '../dist/src/mcp/server.mjs';
import {realmIndex} from '../dist/src/search/realm.mjs';

const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL,s3=process.env.OPENCRAWL_TEST_S3_ENDPOINT;
test('live unified MCP searches native sessions and every connector; no private channels, foreign tenants or revoked connections', {skip:!endpoint||!s3}, async t=>{
  const run=randomUUID(),principal={tenantId:'workspace-'+run,userId:'alice'},peer={...principal,userId:'bob'},outsider={tenantId:'outside-'+run,userId:'alice'};
  const environment='ws-'+run.slice(0,8),connectorIndex=realmIndex(environment,principal.tenantId),objects=[];
  const underlying=createObjectStore({endpoint:s3,bucket:'capture-test',credentials:{accessKeyId:'capture-test',secretAccessKey:'capture-test-secret'}});
  const store={...underlying,put:async(k,b,m)=>{objects.push(k);return underlying.put(k,b,m);}};
  const sessions=createSessionSearch({endpoint,environment}),search=createConnectorSearch({endpoint,index:connectorIndex,tenantId:principal.tenantId});
  t.after(async()=>{for(const key of objects)await store.delete(key);for(const owner of [principal,outsider])await fetch(endpoint+'/'+realmIndex(environment,owner.tenantId),{method:'DELETE'});});
  const prefix='sessions/workspace-live/'+run,ingest=createSessionIngest({store,prefix});
  for(const owner of [peer,outsider])await ingest.putBatch(owner,{schemaVersion:1,owner,harness:'codex',origin:'unknown',installationId:'fixture',sessionId:'same',attachments:[],events:[{id:'event',kind:'message',data:{role:'user',content:'violet lighthouse session evidence'}}]});
  const pipeline=createSessionPipeline({store,prefix,search:sessions,resolvePrincipal:async({batch})=>batch.owner});
  for(const key of (await pipeline.listPage()).keys)await pipeline.processObject({key});await sessions.refresh(principal);await sessions.refresh(outsider);
  await search.ensureIndex();
  const bindings=[];const date='2026-11-05T12:00:00Z';
  for(const provider of ['slack','notion','github','granola','circleback']) {
    const connectionId=provider+'-'+run,binding={tenantId:principal.tenantId,connectionId,workspaceId:'w',provider,access:provider==='slack'?'team-public':'workspace-global',rawPrefix:`raw/v1/source=${provider}/workspace=w/connection=${connectionId}/`};bindings.push(binding);
    const pipeline=createConnectorPipeline({binding,store,search});
    async function raw(stream,data){const key=binding.rawPrefix+`stream=${stream}/date=2026-11-05/sync=1/input.jsonl.gz`;await store.put(key,gzipSync(JSON.stringify({_airbyte_extracted_at:2000,_airbyte_data:data})+'\n'));}
    if(provider==='slack') {
      await raw('channels',{id:'C123',name:'public',is_private:false});await raw('channel_messages',{channel_id:'C123',ts:'1234567890.000001',text:'violet lighthouse Slack evidence'});
    } else if(provider==='notion') {
      await raw('pages',{id:'p',last_edited_time:date,properties:{Title:{type:'title',title:[{plain_text:'Page'}]}}});await raw('page_markdown',{id:'p',page_last_edited_time:date,markdown:'violet lighthouse Notion evidence'});
    } else if(provider==='github')await raw('commits',{repository:'team/repo',sha:'abc',message:'violet lighthouse GitHub evidence',committer_date:date});
    else if(provider==='granola')await raw('notes',{id:'m',title:'Meeting',summary_text:'violet lighthouse Granola evidence',updated_at:date});
    else await raw('meetings',{id:'m',name:'Meeting',notes:'violet lighthouse Circleback evidence',updatedAt:date});
    for(const key of (await pipeline.listPage()).keys)await pipeline.processObject({key});
  }
  await search.refresh();
  assert.ok((await search.search(principal,bindings,{query:'violet lighthouse',match:'phrase'})).hits.length);
  let active=bindings;
  const workspace=createWorkspaceSearch({sessions,connectors:{search:(p,q)=>active.length?search.search(p,active,q):Promise.resolve({hits:[],truncated:false})}});
  let handler;const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  handler=createOpenCrawlMcp({origin,search:workspace,authenticate:async req=>req.headers.authorization==='Bearer local-token'?principal:null});
  t.after(async()=>{await handler.close();await new Promise(r=>server.close(r));});
  const client=new Client({name:'workspace-live-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer local-token'}}}));t.after(()=>client.close());
  const call=async input=>{const result=await client.callTool({name:'search',arguments:input});assert.ok(!result.isError,JSON.stringify(result));return result.structuredContent;};
  const result=await call({query:'violet lighthouse',match:'phrase',limit:40});
  assert.equal(result.partial,false);assert.ok(result.results.some(r=>r.source==='sessions'&&r.provenance.userId==='bob'));
  assert.deepEqual(new Set(result.results.filter(r=>r.source==='connectors').map(r=>r.provenance.provider)),new Set(['slack','notion','github','granola','circleback']));
  assert.equal(result.results.filter(r=>r.source==='sessions').length,1);
  for (const hit of result.results) {
    const fetched=await client.callTool({name:'fetch',arguments:{id:hit.id}});
    assert.ok(!fetched.isError,JSON.stringify(fetched));assert.match(fetched.structuredContent.text,/violet lighthouse/);
  }
  assert.equal((await call({query:'lighthouse violet',match:'phrase'})).results.length,0);
  assert.ok((await call({query:'lighthouse violet',match:'all'})).results.length>=6);
  assert.ok((await call({query:'violet absentterm',match:'any'})).results.length>=6);
  assert.equal((await call({query:'violet absentterm',match:'all'})).results.length,0);
  assert.equal((await call({query:'violet',source:'sessions',sessionId:'different'})).results.length,0);
  const input={query:'violet',limit:1};const first=await call(input);assert.ok(first.next);
  active=[];const afterRevocation=await call({...input,cursor:first.next});assert.ok(afterRevocation.results.every(r=>r.source!=='connectors'));
  assert.equal((await client.callTool({name:'fetch',arguments:{id:result.results.find(r=>r.source==='connectors').id}})).isError,true);
  active=bindings;const slack=bindings.find(b=>b.provider==='slack');await search.suppress(principal,slack,{kind:'channel',sourceId:'C123'});await search.refresh();
  assert.ok((await call({query:'violet',limit:40})).results.every(r=>r.provenance.provider!=='slack'));
  assert.equal((await client.callTool({name:'fetch',arguments:{id:result.results.find(r=>r.provenance.provider==='slack').id}})).isError,true);
});
