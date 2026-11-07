import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runConnectorSegment, SourcePaginationError} from '../src/connectors/workflow.mjs';

async function sweep(listPage, {input = {}, maxSegments = 10000, processObject = async () => ({records: 1})} = {}) {
  for (let segment = 0; segment < maxSegments; segment++) {
    const result = await runConnectorSegment(input, {listPage, processObject});
    if (!result.cursor) return result;
    // Simulate Temporal's JSON boundary and a restarted worker for every segment.
    input = JSON.parse(JSON.stringify({...input, cursor: result.cursor, paginationProgress: result.paginationProgress}));
    assert.equal(Object.keys(input.paginationProgress).length, 4);
  }
  assert.fail('fixture did not terminate');
}

test('cursor cycles fail within and across continuation segments without retaining token history', async () => {
  for (const tail of [0, 1, 4, 5, 6, 17, 64]) {
    for (const period of [1, 2, 3, 5, 6, 11, 32, 65]) {
      let pages = 0;
      await assert.rejects(sweep(async ({cursor}) => {
        pages++;
        const index = cursor === undefined || cursor === null ? 0 : Number(cursor) + 1;
        return {keys: [], cursor: String(index < tail + period ? index : tail)};
      }), error => error instanceof SourcePaginationError && /cycle/.test(error.message), `tail=${tail}, period=${period}`);
      assert.ok(pages < 4 * (tail + period + 1), `bounded detection: tail=${tail}, period=${period}`);
    }
  }
});

test('large advancing filtered-only listings keep going until a terminal page', async () => {
  let pages = 0, processed = 0;
  const result = await sweep(async ({cursor, ...input}) => {
    assert.ok(!Object.hasOwn(input, 'paginationProgress'));
    const index = cursor === null ? 0 : Number(cursor);
    pages++;
    return {keys: index === 20000 ? ['last'] : [], cursor: index === 20000 ? null : String(index + 1)};
  }, {processObject: async input => {
    assert.ok(!Object.hasOwn(input, 'paginationProgress'));
    processed++;
    return {records: 1};
  }});
  assert.equal(pages, 20001); assert.equal(processed, 1); assert.equal(result.cursor, null);
});

test('legacy restart without progress seeds the detector from its existing cursor', async () => {
  await assert.rejects(sweep(async ({cursor}) => ({keys: [], cursor: cursor === 'A' ? 'B' : 'A'}), {
    input: {cursor: 'A'},
  }), SourcePaginationError);
});

test('malformed persisted progress fails before any activity; counters are canonical and consistent', async () => {
  const valid = {version: 1, anchor: 'A', window: '4', distance: '1'};
  for (const state of [null, {}, {...valid, version: 2}, {...valid, anchor: null}, {...valid, anchor: ''},
    {...valid, window: '04'}, {...valid, window: '0'}, {...valid, window: '1'}, {...valid, window: '3'},
    {...valid, window: 4}, {...valid, distance: '01'}, {...valid, distance: '-1'}, {...valid, distance: '4'},
    {...valid, distance: '0'}, {...valid, anchor: 'B'}, {...valid, distance: null}]) {
    let calls = 0;
    await assert.rejects(runConnectorSegment({cursor: 'B', paginationProgress: state}, {
      listPage: async () => {calls++;},
    }), SourcePaginationError);
    assert.equal(calls, 0);
  }
});

test('malformed cursor and page replies become explicit pagination failures before object writes', async () => {
  for (const page of [null, {}, {keys: null, cursor: 'A'}, {keys: [3], cursor: 'A'},
    {keys: [], cursor: undefined}, {keys: ['write'], cursor: ''}, {keys: ['write'], cursor: 3}]) {
    await assert.rejects(runConnectorSegment({}, {
      listPage: async () => page, processObject: async () => assert.fail('invalid page must not write'),
    }), SourcePaginationError);
  }
  for (const cursor of [false, 0, '', {}, []]) {
    await assert.rejects(runConnectorSegment({cursor}, {listPage: async () => assert.fail('invalid input must not list')}), SourcePaginationError);
  }
});

test('counter advancement beyond Number precision has no rollover or corpus limit', async () => {
  const window = 2n ** 80n;
  const result = await runConnectorSegment({cursor: 'B', paginationProgress: {
    version: 1, anchor: 'A', window: String(window), distance: String(window - 1n),
  }}, {listPage: async ({cursor}) => ({keys: [], cursor: cursor + 'x'})});
  assert.deepEqual(result.paginationProgress, {version: 1, anchor: 'Bx', window: String(window * 2n), distance: '4'});
});

test('legacy replay path preserves five-page commands, argument shape and continuation result', async () => {
  const calls = [];
  const result = await runConnectorSegment({sourceId: 'fixture'}, {
    listPage: async input => {calls.push(input); return {keys: [], cursor: input.cursor === 'A' ? 'B' : 'A'};},
  }, {trackPagination: false});
  assert.deepEqual(calls, [null, 'A', 'B', 'A', 'B'].map(cursor => ({sourceId: 'fixture', cursor})));
  assert.deepEqual(result, {cursor: 'A', indexed: 0, failed: 0});
});
