import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {realmResponse} from './realm-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';

test('raw session responses retain OpenSearch fields after ownership checks', async () => {
  const owner = {tenantId: 'tenant', userId: 'user'};
  const response = {took: 2, timed_out: false, _shards: {successful: 1,failed:0}, hits: {total: {value: 1, relation: 'eq'}, hits: [{_id: 'id', _index: 'sessions', _score: 2, _source: {...owner, harness: 'codex', sessionId: 's', text: 'hello'}}]}};
  const search = createSessionSearch({store:deletionTestStore(),prefix:"capture-v1",endpoint: 'http://localhost:9200', index: 'sessions', fetch: async (_, options) => {
    assert.deepEqual(JSON.parse(options.body).query.bool.filter, [{term: {tenantId: owner.tenantId}},{term:{corpus:'session'}}]);
    return realmResponse('session',response);
  }});
  assert.deepEqual(await search.search(owner, {query: 'hello', raw: true}), response);
  await assert.rejects(search.search(null, {query: 'hello', raw: true}), /Authentication/);
  response.hits.hits[0]._source.userId = 'other';
  assert.deepEqual(await search.search(owner, {query: 'hello', raw: true}), response);
  response.hits.hits[0]._source.tenantId = 'other';
  await assert.rejects(search.search(owner, {query: 'hello', raw: true}), /ownership/);
});

test('raw connector hits retain search fields but never expose private or unknown channels', async () => {
  const binding = {tenantId: 'tenant', connectionId: 'conn', workspaceId: 'workspace', provider: 'slack', access: 'team-public', rawPrefix: 'raw/v1/source=slack/workspace=workspace/connection=conn/'};
  let forged = false;
  const hits = ['public', 'private', 'unknown'].map(channelId => ({_id: documentId(binding, 'message', channelId + ':1'), _index: 'connectors', _score: 3, sort: [3, 'conn', channelId + ':1'], _source: {...binding, kind: 'message', sourceId: channelId + ':1', channelId, text: channelId, deleted: false}}));
  const search = createConnectorSearch({endpoint: 'http://localhost:9200', index: 'connectors', tenantId: binding.tenantId, fetch: async url => {
    if (url.pathname.endsWith('_search')) return realmResponse('connector',{took: 1, timed_out: false, _shards: {successful: 1,failed:0}, hits: {total: {value: 3}, max_score: 3, hits: hits.map(hit => forged ? {...hit, _source: {...hit._source, tenantId: 'other'}} : hit)}});
    return realmResponse('connector',{docs: ['public', 'private','unknown'].map(channel => ({_id: documentId(binding, 'channel', channel), found: channel!=='unknown', _source: {...binding, kind: 'channel', sourceId: channel, publicChannel: channel === 'public', deleted: false}}))});
  }});
  const result = await search.search({tenantId: 'tenant'}, [binding], {query: 'hello', raw: true, limit: 1});
  assert.deepEqual(result.responses[0].hits, {hits: [hits[0]]});
  assert.equal(result.responses[0].took, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|unknown/);
  await assert.rejects(search.search({tenantId: 'other'}, [binding], {query: 'hello', raw: true}), /scope/);
  forged = true;
  await assert.rejects(search.search({tenantId: 'tenant'}, [binding], {query: 'hello', raw: true}), /scope/);
});

// The browser inspector uses the same principal-scoped retrieval as agent search.
import {diagnosticRequest} from '../dist/src/application/diagnostics.mjs';
import {Readable} from 'node:stream';
for (const operation of ['board','search']) test(`browser ${operation} permits members and withholds results after access revocation`, async () => {
  const principal={tenantId:'org_member',userId:'user_member'},calls=[];
  let allowed=200,response;
  const options={principal,admin:false,revalidate:async()=>allowed,respond:(status,body)=>{response={status,body};},
    board:{read:async(scope)=>{assert.deepEqual(scope,principal);calls.push('board');return {messages:[{text:'scoped result'}]};}},
    search:{search:async(scope)=>{assert.deepEqual(scope,principal);calls.push('search');return {hits:{hits:[{_source:{text:'scoped result'}}]}};}}};
  const run=()=>diagnosticRequest(Readable.from([Buffer.from(JSON.stringify({query:'example'}))]),new URL('https://app.example/api/debug/'+operation),{name:'debug-'+operation},options);
  await run();assert.equal(response.status,200);assert.match(response.body,/scoped result/);
  allowed=403;await run();assert.equal(response.status,403);assert.doesNotMatch(response.body,/scoped result/);
  allowed=503;await run();assert.equal(response.status,503);assert.doesNotMatch(response.body,/scoped result/);
  const count=calls.length;options.principal=null;await run();assert.equal(response.status,403);assert.equal(calls.length,count);
});

test('playground resolves only visible message bodies and session titles before final membership check', async () => {
  const principal={tenantId:'team',userId:'alice'}, titleKeys=[], boardReads=[];
  const ids=Array.from({length:60},(_,i)=>i+1);
  let status=200, sent;
  const options={principal, revalidate:async()=>status, respond:(code,body)=>{sent={code,body};},
    search:{search:async()=>({hits:{hits:[{_source:{userId:'alice',harness:'codex',sessionId:'beta',text:'launch'}}]}}),
      resultTitles:async(scope,keys)=>{assert.deepEqual(scope,principal);titleKeys.push(keys);
        return new Map([[JSON.stringify(['alice','codex','beta']),'Beta launch']]);}},
    board:{searchCandidates:async(scope,query,limit)=>{assert.deepEqual(scope,principal);assert.equal(query,'launch');assert.equal(limit,100);return {ids,total:60};},
      agent:{read:async(scope,{ids})=>{assert.deepEqual(scope,principal);boardReads.push(ids);
        return {messages:ids.map(id=>({id,thread:1,channel:'release',from:'reviewer',time:'2026-11-18T00:00:00Z',text:'Launch post '+id}))};}}}};
  const run=page=>diagnosticRequest(Readable.from([Buffer.from(JSON.stringify({query:'launch',page}))]),
    new URL('https://app.example/api/debug/search'),{name:'debug-search'},options);
  await run(1);
  assert.equal(sent.code,200);
  const first=JSON.parse(sent.body);
  assert.equal(first.sessions[0].response.hits.hits[0]._source.title,'Beta launch');
  assert.equal(first.board.hits.hits.length,24);assert.equal(first.board.hits.hits[23]._source.text,'Launch post 24');
  assert.deepEqual(boardReads.map(batch=>batch.length),[20,4]);
  await run(2);
  assert.equal(titleKeys.length,1);
  assert.deepEqual(boardReads.slice(2).flat(),ids.slice(24,49));
  status=403;await run(1);assert.equal(sent.code,403);assert.doesNotMatch(sent.body,/Beta launch|Launch post/);
});
