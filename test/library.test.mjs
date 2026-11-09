import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {transcriptEntries} from '../dist/src/sessions/library.mjs';
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
