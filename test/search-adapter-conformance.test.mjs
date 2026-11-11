import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRealm} from '../dist/src/search/realm.mjs';
import {lexicalQuery} from '../dist/src/search/lexical.mjs';

// The same small behavioral floor for every implementation. Deliberately no
// score equality, ranking equality, linguistic parity or performance assertions.
for (const backend of ['sqlite', 'opensearch']) {
  test(`${backend}: search adapter conformance`, {skip: backend === 'opensearch' && !process.env.OPENCRAWL_TEST_OPENSEARCH_URL}, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'opencrawl-adapter-'));
    const endpoint = backend === 'sqlite' ? pathToFileURL(join(directory, 'search.sqlite')).href.replace('file:', 'sqlite:') : process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
    const principal = {tenantId: 'adapter-' + randomUUID(), userId: 'alice'};
    const realm = createRealm({endpoint, tenantId: principal.tenantId, environment: 'test'});
    t.after(async () => {
      if (backend === 'opensearch') await fetch(endpoint + '/' + realm.index, {method: 'DELETE'});
      await rm(directory, {recursive: true, force: true});
    });
    await realm.ensureIndex();
    const collection = realm.collection('session');
    const documents = [
      {id: 'one', document: {...principal, title: 'Orion launch', text: 'release checklist approved', kind: 'message', role: 'user', sequence: 1}},
      {id: 'two', document: {...principal, title: 'Orion notes', text: 'checklist awaiting release approval', kind: 'message', role: 'assistant', sequence: 2}},
      {id: 'three', document: {...principal, text: 'unrelated archive', kind: 'tool_result', sequence: 3}},
    ];
    await collection.bulk(principal, documents);
    await realm.refresh(principal);
    const ids = result => result.hits.hits.map(hit => hit._id).sort();
    await t.test('literal lexical modes and title/body fields', async () => {
      assert.deepEqual(ids(await collection.search(principal, {query: lexicalQuery('Orion release', 'all')})), ['one', 'two']);
      assert.deepEqual(ids(await collection.search(principal, {query: lexicalQuery('release checklist', 'phrase')})), ['one']);
      assert.deepEqual(ids(await collection.search(principal, {query: lexicalQuery('Orion archive', 'any')})), ['one', 'three', 'two']);
      assert.deepEqual(ids(await collection.search(principal, {query: lexicalQuery('doesnotexist', 'all')})), []);
    });
    await t.test('exact filters, ranges, deterministic ordering and continuation', async () => {
      const query = {bool: {filter: [{term: {'session.kind': 'message'}}, {range: {'session.sequence': {gte: 1, lte: 2}}}]}};
      const request = {query, sort: [{'session.sequence': 'asc'}, {id: 'asc'}], size: 1};
      const first = await collection.search(principal, request);
      assert.equal(first.hits.total.value, 2);
      assert.equal(first.hits.hits[0]._id, 'one');
      const next = await collection.search(principal, {...request, search_after: first.hits.hits[0].sort});
      assert.equal(next.hits.hits[0]._id, 'two');
      assert.deepEqual(ids(await collection.search(principal, {query: {terms: {'session.role': ['user']}}})), ['one']);
    });
    await t.test('scope and corpus isolation on reads and writes', async () => {
      await realm.collection('memory').bulk(principal, [{id: 'one', document: {...principal, text: 'different corpus'}}]);
      const foreign = {...principal, tenantId: 'foreign'};
      await assert.rejects(collection.search(foreign, {}), /scope/i);
      await assert.rejects(collection.mget(foreign, ['one']), /scope/i);
      await assert.rejects(collection.bulk(principal, [{id: 'forged', document: {...foreign, text: 'secret'}}]), /scope/i);
      await assert.rejects(collection.delete(foreign, ['one']), /scope/i);
      assert.equal((await collection.mget(principal, ['one'])).docs[0]._source.text, documents[0].document.text);
    });
    await t.test('idempotent replacement, complete lookup and deletion', async () => {
      await collection.bulk(principal, [{...documents[0], document: {...documents[0].document, text: 'replacement evidence'}}]);
      await realm.refresh(principal);
      const lookup = await collection.mget(principal, ['one', 'missing']);
      assert.equal(lookup.docs[0]._source.text, 'replacement evidence');
      assert.equal(lookup.docs[1].found, false);
      await collection.delete(principal, ['one', 'missing']);
      await realm.refresh(principal);
      assert.deepEqual(ids(await collection.search(principal, {query: lexicalQuery('replacement', 'all')})), []);
      assert.equal((await realm.collection('memory').mget(principal, ['one'])).docs[0].found, true);
    });
  });
}
