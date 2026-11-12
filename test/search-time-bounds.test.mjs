import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRealm} from '../dist/src/search/realm.mjs';
import {searchFilters} from '../dist/src/search/controls.mjs';

for (const backend of ['sqlite', 'opensearch']) {
  test(`${backend}: source time filters preserve exact inclusive instants`, {skip: backend === 'opensearch' && !process.env.OPENCRAWL_TEST_OPENSEARCH_URL}, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'opencrawl-time-bounds-'));
    const endpoint = backend === 'sqlite' ? pathToFileURL(join(directory, 'search.sqlite')).href.replace('file:', 'sqlite:') : process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
    const principal = {tenantId: 'time-' + randomUUID(), userId: 'alice'};
    const realm = createRealm({endpoint, tenantId: principal.tenantId, environment: 'test'});
    t.after(async () => {
      if (backend === 'opensearch') await fetch(endpoint + '/' + realm.index, {method: 'DELETE'});
      await rm(directory, {recursive: true, force: true});
    });
    const instant = '2026-11-11T07:30:00Z', epoch = Date.parse(instant);
    for (const corpus of ['session', 'memory', 'connector']) {
      const collection = realm.collection(corpus);
      const documents = [-1, 0, 1, 123, 1000].map(delta => {
        const at = new Date(epoch + delta).toISOString();
        return {id: 'at-' + delta, document: {...principal, text: 'time boundary evidence', timestamp: at, modifiedAt: at}};
      });
      await collection.bulk(principal, [...documents, {id: 'undated', document: {...principal, text: 'undated evidence'}}]);
      await realm.refresh(principal);
      const ids = async filters => (await collection.search(principal, {query: {bool: {filter: searchFilters(corpus, filters)}}})).hits.hits.map(hit => hit._id).sort();
      assert.deepEqual(await ids({before: instant}), ['at--1', 'at-0']);
      assert.deepEqual(await ids({after: instant}), ['at-0', 'at-1', 'at-1000', 'at-123']);
      assert.deepEqual(await ids({after: instant, before: instant}), ['at-0']);
      assert.deepEqual(await ids({before: '2026-11-11T07:30:00.123Z'}), ['at--1', 'at-0', 'at-1', 'at-123']);
      assert.deepEqual(await ids({after: '2026-11-11T07:30:00.123Z'}), ['at-1000', 'at-123']);
      assert.deepEqual(await ids({after: '2026-11-10T23:30:00-08:00', before: '2026-11-11T08:30:00+01:00'}), ['at-0']);
    }
  });
}
