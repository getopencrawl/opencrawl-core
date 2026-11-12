import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {transcriptEntries, promptText, createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {realmDocument} from '../dist/src/search/realm.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {gunzipSync} from 'node:zlib';
import {memoryDescription} from '../dist/src/memories/library.mjs';
import {createLibraryApi, createLibraryHandler} from '../dist/src/sessions/library-http.mjs';
import {visibleTo, createControls} from '../dist/src/sessions/controls.mjs';

test('transcripts keep messages and tool activity, never thinking or injected context as prompts', () => {
  assert.deepEqual(transcriptEntries({id: 'e', kind: 'message', data: {role: 'assistant', content: [{type: 'thinking', thinking: 'secret'}, {type: 'redacted_thinking', data: 'x'}, {type: 'text', text: 'Done'}]}}), [{type: 'message', role: 'assistant', text: 'Done'}]);
  assert.deepEqual(transcriptEntries({id: 'e', kind: 'message', data: {role: 'user', content: [{type: 'input_text', text: '<environment_context>cwd</environment_context>'}]}}), [{type: 'note', label: 'Injected context', text: '<environment_context>cwd</environment_context>', truncated: false}]);
  assert.deepEqual(transcriptEntries({id: 'e', kind: 'tool_call', data: {type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}'}}), [{type: 'tool_call', name: 'shell', input: '{"cmd":"ls"}', truncated: false}]);
  const long = transcriptEntries({id: 'e', kind: 'tool_result', data: {output: 'x'.repeat(25000)}})[0];
  assert.equal(long.text.length, 20000); assert.equal(long.truncated, true);
  assert.deepEqual(transcriptEntries({id: 'e', kind: 'token_count', data: {info: 1}}), []);
  assert.deepEqual(transcriptEntries({id: 'e', kind: 'agent_message', data: {author: 'assistant', recipient: 'worker', content: 'private routing'}}), []);
});

test('memory descriptions prefer frontmatter, then the first prose line', () => {
  assert.equal(memoryDescription('---\nname: a\ndescription: "Prefers rebases"\n---\nBody'), 'Prefers rebases');
  assert.equal(memoryDescription('\n# Heading here\nmore'), 'Heading here');
  assert.equal(memoryDescription('y'.repeat(300)).length, 240);
});

test('private resources are hidden from everyone except their owner', () => {
  assert.deepEqual(visibleTo('session', {tenantId: 't', userId: 'me'}), {bool: {must_not: [{bool: {filter: [{term: {'session.private': true}}], must_not: [{term: {'session.userId': 'me'}}]}}]}});
});

test('library HTTP requires authentication, rejects browsers, unknown operations and unexpected fields', async t => {
  const calls = [];
  const sessions = {list: async (principal, input) => {calls.push({principal, input}); return {sessions: []};}};
  const handler = createLibraryHandler({api: createLibraryApi({sessions}), authenticate: async req => req.headers.authorization === 'Bearer ok' ? {tenantId: 't', userId: 'u'} : null});
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = path => `http://127.0.0.1:${server.address().port}/api/library/${path}`;
  const post = (path, body, headers = {}) => fetch(url(path), {method: 'POST', headers: {authorization: 'Bearer ok', 'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
  assert.equal((await post('sessions/list', {}, {authorization: 'Bearer no'})).status, 401);
  assert.equal((await post('sessions/list', {}, {origin: 'https://evil.test'})).status, 403);
  assert.equal((await fetch(url('sessions/list'))).status, 405);
  assert.equal((await post('sessions/purge', {})).status, 404);
  assert.equal((await post('sessions/list', {tenantId: 'other'})).status, 400);
  assert.equal((await post('memories/list', {})).status, 503);
  const ok = await post('sessions/list', {scope: 'mine'});
  assert.equal(ok.status, 200); assert.deepEqual((await ok.json()).data, {sessions: []});
  assert.deepEqual(calls, [{principal: {tenantId: 't', userId: 'u'}, input: {scope: 'mine', query: '', limit: 50}}]);
});

test('Codex IDE and attached-file headers never become the prompt or title', () => {
  const wrapped = '# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request for Codex:\nMove the nav to a left sidebar\n';
  assert.equal(promptText(wrapped), 'Move the nav to a left sidebar');
  assert.equal(promptText('# Files pasted by the user:\n\n## Design.txt: /tmp/Design.txt\n\n## My request:\nImplement the capture flow'), 'Implement the capture flow');
  assert.equal(promptText('# Files pasted by the user:\n\n## Design.txt: /tmp/Design.txt'), null);
  assert.equal(promptText('# Context from my IDE setup:\n\n## Open tabs:\n- a.ts'), null);
  assert.equal(promptText('<environment_context>cwd</environment_context>'), null);
  assert.equal(promptText('  plain ask '), 'plain ask');
  assert.deepEqual(transcriptEntries({id: 'e', kind: 'user_message', data: {message: wrapped}}).map(entry => entry.type === 'message' ? entry.text : entry.label), ['Attached context', 'Move the nav to a left sidebar']);
});

test('library titles prefer verified native names, use original prompt text, and reject forged title scope', async () => {
  const principal={tenantId:'team',userId:'alice'}, store=memorySessionStore(), prefix='sessions/titles';
  const ingest=createSessionIngest({store,prefix}), at='2026-11-09T10:00:00Z';
  const batch={schemaVersion:1,owner:principal,installationId:'device',harness:'codex',sessionId:'session',origin:'desktop',attachments:[],events:[
    {id:'prompt',kind:'message',timestamp:at,sequence:1,data:{role:'user',channel:'user.text',id:'NATIVE-ID',content:[{type:'input_text',text:'Actual request'}]}},
    {id:'title',kind:'session_title',timestamp:at,sequence:2,data:{title:'A saved chat name'}},
  ]};
  await ingest.putBatch(principal,batch);
  const sourceKey=[...store.data.keys()].find(key=>key.endsWith('.json.gz'));
  const stored=JSON.parse(gunzipSync(store.data.get(sourceKey)));
  const hits=batchDocuments({prefix,key:sourceKey,batch:stored,principal}).map(({id,document})=>({_id:'session:'+id,_source:realmDocument('session',id,document)}));
  const records=values=>({records:{hits:{hits:values}}}), empty={hits:{total:{value:0,relation:'eq'},hits:[]},timed_out:false,_shards:{failed:0}};
  let mode='native', reads=0;
  const library=createSessionLibrary({store,prefix,endpoint:'http://localhost:9200',fetch:async(_url,request)=>{
    const body=JSON.parse(request.body);reads++;
    if(body.aggs.titles) {
      const title=structuredClone(hits[1]);
      if(mode==='forged')title._source.session.userId='bob';
      if(mode==='source')title._source.sourceKey=title._source.sourceKey.replace('/codex/','/claude-code/');
      return Response.json({...empty,aggregations:{titles:{buckets:[{key:['alice','codex','session'],metadata:records(mode==='fallback'?[]:[title]),prompts:records([hits[0]])}]}}});
    }
    return Response.json({...empty,aggregations:{sessions:{buckets:[{key:['alice','codex','session'],doc_count:1,lastActivity:{value:Date.parse(at)},firstActivity:{value:Date.parse(at)},private:{doc_count:0},origin:{buckets:[]},host:{buckets:[]}}]}}});
  }});
  assert.equal((await library.list(principal)).sessions[0].title,'A saved chat name');
  mode='fallback';assert.equal((await library.list(principal)).sessions[0].title,'Actual request');
  mode='forged';await assert.rejects(library.list(principal),/title scope/);
  mode='source';await assert.rejects(library.list(principal),/title source/);
  const before=reads;await assert.rejects(library.list({...principal,captureAccess:'write'}),{status:403});assert.equal(reads,before);
});

test('search title lookup scopes original names, bounds time, and rechecks privacy and deletion', async () => {
  const owner={tenantId:'team',userId:'alice'}, viewer={tenantId:'team',userId:'bob'}, store=memorySessionStore(), prefix='sessions/search-titles';
  const ingest=createSessionIngest({store,prefix}), controls=createControls({store,prefix}), key={userId:'alice',harness:'codex',sessionId:'session'}, encoded=JSON.stringify(['alice','codex','session']);
  const at='2026-11-09T10:00:00Z', before='2026-11-08T10:00:00Z';
  await ingest.putBatch(owner,{schemaVersion:1,owner,installationId:'device',harness:'codex',sessionId:'session',origin:'desktop',attachments:[],events:[
    {id:'title',kind:'session_title',timestamp:at,sequence:1,data:{title:'Verified original title'}},
  ]});
  const sourceKey=[...store.data.keys()].find(k=>k.endsWith('.json.gz')), batch=JSON.parse(gunzipSync(store.data.get(sourceKey)));
  const [{id,document}]=batchDocuments({prefix,key:sourceKey,batch,principal:owner});
  const envelope={_id:'session:'+id,_source:realmDocument('session',id,document)};
  let mode='normal',queries=0;
  const library=createSessionLibrary({store,prefix,endpoint:'http://localhost:9200',fetch:async(_url,request)=>{
    const body=JSON.parse(request.body);queries++;
    assert.equal(body.size,0);assert.ok(JSON.stringify(body.query).includes('session.sessionId'));
    const bound=body.query.bool.must[0].bool.filter.find(item=>item.range?.['session.timestamp'])?.range['session.timestamp'].lte;
    const bounded=bound!==undefined;
    if(bounded)assert.equal(bound,Date.parse(before));
    if(mode==='revoke')await controls.update(owner,'sessions','codex','session',()=>({visibility:'private',deletedAt:null}));
    const hit=structuredClone(envelope);if(mode==='foreign')hit._source.tenantId='different-team';
    const records=values=>({records:{hits:{hits:values}}});
    return Response.json({hits:{total:{value:0,relation:'eq'},hits:[]},timed_out:false,_shards:{failed:0},aggregations:{titles:{buckets:bounded?[]:[{key:['alice','codex','session'],metadata:records([hit]),prompts:records([])}]}}});
  }});
  assert.equal((await library.titles(viewer,[key,key])).get(encoded),'Verified original title');assert.equal(queries,1);
  assert.equal((await library.titles(viewer,[key],{before})).get(encoded),'Session session');
  mode='foreign';await assert.rejects(library.titles(viewer,[key]),/title scope/);
  mode='revoke';assert.equal((await library.titles(viewer,[key])).size,0);
  mode='normal';const reads=queries;assert.equal((await library.titles(viewer,[key])).size,0);assert.equal(queries,reads);
  assert.equal((await library.titles(owner,[key])).get(encoded),'Verified original title');
  await controls.update(owner,'sessions','codex','session',()=>({visibility:'team',deletedAt:at}));
  assert.equal((await library.titles(owner,[key])).size,0);
  await assert.rejects(library.titles({...viewer,captureAccess:'write'},[key]),{status:403});
  await assert.rejects(library.titles(viewer,Array(41).fill(key)),{status:400});
  await assert.rejects(library.titles(viewer,[key],{before:'not a date'}),{status:400});
  await assert.rejects(library.titles(viewer,[{...key,harness:'../codex'}]),{status:400});
});
