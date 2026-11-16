import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

test('OpenSearch and capture imports do not load SQLite in the API process', () => {
  const realm = new URL('../dist/src/search/realm.mjs', import.meta.url).href;
  const workspace = new URL('../dist/src/search/workspace.mjs', import.meta.url).href;
  const capture = new URL('../dist/src/sessions/storage.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import {createRealm} from ${JSON.stringify(realm)};
    await import(${JSON.stringify(workspace)});
    await import(${JSON.stringify(capture)});
    assert.equal(createRealm({endpoint: 'http://localhost:9200', tenantId: 'test'}).backend, 'opensearch');
    await assert.rejects(import('node:sqlite'), /node:sqlite/);
    // SQLite I/O now belongs to a bounded child process. Selecting its pure
    // configuration must not load the synchronous database in the API process.
    assert.equal(createRealm({endpoint: 'sqlite:///unused/search.sqlite', tenantId: 'test'}).backend, 'sqlite');
  `], {encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
