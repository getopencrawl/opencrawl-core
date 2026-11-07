import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {paginationFixture} from './fixtures/connector-pagination-paths.mjs';
import {SourcePaginationError} from '../src/connectors/workflow.mjs';

const cycle = cursor => ({keys: [], nextToken: cursor === 'A' ? 'B' : 'A'});
const isCycle = error => error instanceof SourcePaginationError && error.code === 'cycle' && error.message === 'Source pagination cursor cycle detected';
const standalone = async scenario => JSON.parse((await promisify(execFile)(process.execPath, [
  '--experimental-vm-modules', fileURLToPath(new URL('./fixtures/connector-pagination-paths.mjs', import.meta.url)), '--standalone-fixture', scenario,
], {timeout: 15000})).stdout);

test('actual standalone entrypoint rejects empty S3 A/B cycles without refresh or success output', async () => {
  const result = await standalone('cycle');
  assert.deepEqual(result.error, {name: 'SourcePaginationError', code: 'cycle', message: 'Source pagination cursor cycle detected'});
  assert.deepEqual(result.cursors, [null, 'A', 'B']);
  assert.equal(result.refreshes, 0); assert.deepEqual(result.receipts, []); assert.deepEqual(result.output, []);
});

test('actual standalone entrypoint advances empty/filtered pages and processes terminal objects sequentially', async () => {
  const result = await standalone('healthy');
  assert.equal(result.error, undefined); assert.deepEqual(result.cursors, [null, 'A', 'B']);
  assert.deepEqual(result.reads, result.keys); assert.equal(result.maxSearching, 1);
  assert.equal(result.documents, 2); assert.equal(result.receipts.length, 2);
  assert.equal(result.refreshes, 1); assert.deepEqual(result.output, [{objects: 2, records: 2}]);
});

test('actual standalone entrypoint stops on the first object failure before later objects/pages', async () => {
  const result = await standalone('fail-fast');
  assert.equal(result.error.message, 'fixture search rejection');
  assert.deepEqual(result.reads, result.keys.slice(0, 2)); assert.equal(result.maxSearching, 1);
  assert.equal(result.lists, 1); assert.equal(result.documents, 1); assert.equal(result.receipts.length, 1);
  assert.equal(result.refreshes, 0); assert.deepEqual(result.output, []);
});

for (const provider of ['granola', 'circleback', 'notion']) {
  test(`${provider} actual S3 inventory rejects empty cycles behind the terminal outer task`, async () => {
    const h = paginationFixture(provider, {list: cycle});
    const outer = await h.pipeline.listPage();
    assert.equal(outer.cursor, null); assert.equal(outer.keys.length, 1);
    await assert.rejects(h.pipeline.processObject({key: outer.keys[0]}), isCycle);
    assert.deepEqual(h.cursors, [null, 'A', 'B']);
    assert.deepEqual(h.reads, []); assert.deepEqual(h.summary().receipts, []); assert.equal(h.documents.length, 0);
  });

  test(`${provider} resets progress for complete pre/post inventories through empty and filtered pages`, async () => {
    const h = paginationFixture(provider, {list: cursor => cursor === null ? {keys: [], nextToken: 'A'} :
      cursor === 'A' ? {keys: [h.binding.rawPrefix + 'ignored'], nextToken: 'B'} : {keys: [], nextToken: null}});
    assert.deepEqual(await h.pipeline.processObject({key: h.binding.rawPrefix + 'workspace-snapshot'}), {status: 'indexed', records: 0});
    assert.deepEqual(h.cursors, [null, 'A', 'B', null, 'A', 'B']);
    assert.equal(h.summary().receipts.length, 1); assert.equal(h.summary().receipts[0].ignored, 1);
  });

  test(`${provider} never acknowledges an incomplete final inventory after indexing a valid record`, async () => {
    let key;
    const h = paginationFixture(provider, {list: (cursor, call) => call === 1 ? {keys: [key], nextToken: null} : cycle(cursor)});
    const date = '2026-11-05T12:00:00Z';
    key = provider === 'granola' ? h.raw('notes', {id: 'm1', title: 'Meeting', updated_at: date}) :
      provider === 'circleback' ? h.raw('meetings', {id: 'm1', name: 'Meeting', updatedAt: date}) :
      h.raw('pages', {id: 'p1', last_edited_time: date});
    await assert.rejects(h.pipeline.processObject({key: h.binding.rawPrefix + 'workspace-snapshot'}), isCycle);
    assert.equal(h.documents.length, 1); assert.deepEqual(h.reads, [key]);
    assert.deepEqual(h.cursors, [null, null, 'A', 'B']); assert.deepEqual(h.summary().receipts, []);
  });
}

test('workspace inventory retains the 10000-object limit, including filtered objects', async () => {
  for (const count of [10000, 10001]) {
    const h = paginationFixture('notion', {list: cursor => {
      const start = Number(cursor || 0), end = Math.min(start + 1000, count);
      return {keys: Array.from({length: end - start}, (_, i) => h.binding.rawPrefix + 'ignored-' + (start + i)), nextToken: end < count ? String(end) : null};
    }});
    const result = h.pipeline.processObject({key: h.binding.rawPrefix + 'workspace-snapshot'});
    if (count > 10000) {
      await assert.rejects(result, /Workspace snapshot exceeds 10000 objects/);
      assert.deepEqual(h.summary().receipts, []);
    } else {
      assert.equal((await result).status, 'indexed');
      assert.equal(h.summary().receipts[0].ignored, count);
    }
    assert.equal(h.documents.length, 0);
  }
});

test('workspace inventory rejects malformed pages before reads, writes or a success receipt', async () => {
  for (const page of [null, {keys: 'bad', nextToken: null}, {keys: [42], nextToken: null}, {keys: [], nextToken: ''}, {keys: [], nextToken: 42}]) {
    const h = paginationFixture('notion');
    h.store.listPage = async () => page;
    await assert.rejects(h.pipeline.processObject({key: h.binding.rawPrefix + 'workspace-snapshot'}), SourcePaginationError);
    assert.deepEqual(h.reads, []); assert.deepEqual(h.summary().receipts, []); assert.equal(h.documents.length, 0);
  }
});

test('workspace adapters retain omitted, undefined and null terminal nextToken compatibility', async () => {
  for (const page of [{keys: []}, {keys: [], nextToken: undefined}, {keys: [], nextToken: null}]) {
    const h = paginationFixture('notion');
    let calls = 0;
    h.store.listPage = async () => {calls++; return page;};
    assert.equal((await h.pipeline.processObject({key: h.binding.rawPrefix + 'workspace-snapshot'})).status, 'indexed');
    assert.equal(calls, 2); assert.equal(h.summary().receipts.length, 1);
  }
});
