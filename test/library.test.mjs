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
import {visibleTo} from '../dist/src/sessions/controls.mjs';

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
