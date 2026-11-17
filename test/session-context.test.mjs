import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRealm} from '../dist/src/search/realm.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createWorkspaceSearch, workspaceFetchSchema} from '../dist/src/search/workspace.mjs';
import {sessionDocumentId} from '../dist/src/sessions/indexer.mjs';
import {sessionScope} from '../dist/src/sessions/event-identity.mjs';
import {memoryApplicationState} from './fixtures/memory-application-state.mjs';

for (const backend of ['sqlite', 'opensearch']) {
  test(`${backend}: event-centered reads preserve the anchor, chronology, boundaries and authorization`, {skip: backend === 'opensearch' && !process.env.OPENCRAWL_TEST_OPENSEARCH_URL}, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'event-context-'));
    const endpoint = backend === 'sqlite' ? pathToFileURL(join(directory, 'index.sqlite')).href.replace('file:', 'sqlite:') : process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
    const principal = {tenantId: 'context-' + randomUUID(), userId: 'alice'}, owner = {...principal, userId: 'bob'};
    const state = memoryApplicationState(), options = {endpoint, environment: 'test', state};
    const realm = createRealm({...options, tenantId: principal.tenantId});
    t.after(async () => {if (backend === 'opensearch') await fetch(endpoint + '/' + realm.index, {method: 'DELETE'});await rm(directory, {recursive: true, force: true});});
    await realm.ensureIndex();
    const documents = [];
    function add(eventId, sequence, extra = {}) {
      const document = {...owner, harness: 'codex', sessionId: 'same', installationId: 'device', eventId, sequence,
        timestamp: '2026-11-01T12:00:00Z', receivedAt: '2026-11-02T00:00:00Z', kind: 'message', role: 'assistant', private: false,
        chunk: 0, chunkCount: 1, textStart: 0, textEnd: 10, containsToolOutput: false, text: eventId, ...extra};
      const id = sessionDocumentId({scope: sessionScope(document), harness: document.harness, sessionId: document.sessionId, eventId, chunk: document.chunk});
      documents.push({id, document});return 'sessions:' + id;
    }
    const first = add('first', 0, {timestamp: null});
    add('question', 1);
    const output = add('output', 2, {kind: 'tool_result', role: null, containsToolOutput: true});
    const long = add('long', 3, {text: 'x'.repeat(1999) + '😀' + 'tail'});
    add('anchor', 4, {chunkCount: 2, text: 'first anchor passage'});
    const anchor = add('anchor', 4, {chunk: 1, chunkCount: 2, text: 'selected later anchor passage', textStart: 20});
    add('legacy', 5, {containsToolOutput: undefined});
    add('metadata', 6, {kind: 'session_metadata'});
    add('later-output', 7, {kind: 'tool_result', containsToolOutput: true});
    add('answer-a', 8);add('answer-b', 8);const last = add('last', 9);
    add('foreign-owner', 3, {userId: 'charlie'});
    add('foreign-session', 3, {sessionId: 'different'});
    add('foreign-harness', 3, {harness: 'claude-code'});
    await realm.collection('session').bulk(principal, documents);await realm.refresh(principal);
    const sessions = createSessionSearch(options), workspace = createWorkspaceSearch({sessions});
    const ids = list => list.map(event => event.provenance.eventId);
    const result = await workspace.fetch(principal, {id: anchor, context: true});
    assert.equal(result.text, 'selected later anchor passage');assert.equal(result.passage.index, 1);
    assert.deepEqual(ids(result.context.before), ['first', 'question', 'long']);
    assert.deepEqual(ids(result.context.after), ['legacy', 'answer-a', 'answer-b']);
    assert.equal(result.context.moreBefore, false);assert.equal(result.context.moreAfter, true);
    assert.equal(result.context.unclassifiedEvents, 1);assert.match(result.context.warning, /predate/);
    assert.equal(result.context.before[2].text.length, 1999);assert.equal(result.context.before[2].eventTextComplete, false);
    assert.equal(result.context.before[2].nextOffset, 1999);
    const expanded = await workspace.fetch(principal, {id: long, offset: 1999, version: result.context.before[2].version});
    assert.equal(expanded.text, '😀tail');
    const tools = await workspace.fetch(principal, {id: anchor, before: 2, after: 2, includeToolOutputs: true});
    assert.deepEqual(ids(tools.context.before), ['output', 'long']);assert.deepEqual(ids(tools.context.after), ['legacy', 'later-output']);
    assert.equal(tools.context.moreBefore, true);assert.equal(tools.context.moreAfter, true);
    const explicitOutput = await workspace.fetch(principal, {id: output, context: true});
    assert.equal(explicitOutput.provenance.eventId, 'output');assert.equal(explicitOutput.context.toolOutputsIncluded, false);
    const beginning = await workspace.fetch(principal, {id: first, before: 10, after: 0});
    assert.deepEqual(beginning.context.before, []);assert.deepEqual(beginning.context.after, []);
    assert.equal(beginning.context.moreBefore, false);assert.equal(beginning.context.moreAfter, true);
    const ending = await workspace.fetch(principal, {id: last, before: 0, after: 10});
    assert.equal(ending.context.moreAfter, false);assert.equal(ending.context.moreBefore, true);
    assert.equal((await workspace.fetch(principal, {id: anchor})).context, undefined);
    await assert.rejects(workspace.fetch({...principal, captureAccess: 'write'}, {id: anchor, context: true}), /credentials/);
    await assert.rejects(workspace.fetch({...principal, tenantId: 'foreign'}, {id: anchor, context: true}));
    await state.controls.update(owner, 'sessions', 'codex', 'same', () => ({visibility: 'private', deletedAt: null}));
    await assert.rejects(workspace.fetch(principal, {id: anchor, context: true}), error => error.status === 404);
    assert.equal((await workspace.fetch(owner, {id: anchor, context: true})).text, result.text);
    await state.controls.update(owner, 'sessions', 'codex', 'same', () => ({visibility: 'team', deletedAt: null}));
    // Revocation after all index queries must suppress both anchor and context.
    const read = state.controls.read.bind(state.controls);let reads = 0;
    const racing = createWorkspaceSearch({sessions: {...sessions, context: async (...args) => {
      state.controls.read = async (...readArgs) => {
        if (++reads === 2) await state.controls.update(owner, 'sessions', 'codex', 'same', () => ({visibility: 'private', deletedAt: null}));
        return read(...readArgs);
      };
      return sessions.context(...args);
    }}});
    await assert.rejects(racing.fetch(principal, {id: anchor, context: true}), error => error.status === 404);
    state.controls.read = read;
    await state.controls.update(owner, 'sessions', 'codex', 'same', () => ({visibility: 'team', deletedAt: new Date().toISOString()}));
    await assert.rejects(workspace.fetch(owner, {id: anchor, context: true}), error => error.status === 404);
  });
}

test('context schema rejects foreign scope, non-session anchors, contradictory flags and unbounded windows', () => {
  for (const input of [{id: 'connectors:x', context: true}, {id: 'memories:x', before: 1}, {id: 'sessions:x', before: 11},
    {id: 'sessions:x', after: -1}, {id: 'sessions:x', context: false, before: 0}, {id: 'sessions:x', includeToolOutputs: true},
    {id: 'sessions:x', context: true, userId: 'other'}, {id: 'sessions:x', context: true, before: 1.5}])
    assert.equal(workspaceFetchSchema.safeParse(input).success, false, JSON.stringify(input));
});
