import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticPage} from '../../src/application/search-page.mts';

const hits = (prefix: string, count: number) => Array.from({length: count}, (_, id) => ({_id: prefix + id}));
for (const [sessionCount, connectorCount, memoryCount, boardCount] of [[0, 0, 0, 0], [25, 0, 0, 0], [26, 0, 0, 0], [0, 31, 26, 0], [100, 100, 100, 100], [0, 0, 0, 60]]) {
  test(`page boundaries preserve every authorized hit once (${sessionCount}, ${connectorCount}, ${memoryCount})`, () => {
    const sessions = hits('s', sessionCount), connectors = hits('c', connectorCount), memories = hits('m', memoryCount);
    const board = hits('b', boardCount);
    const expected = [...sessions, ...connectors, ...memories, ...board].map(hit => hit._id);
    const seen: string[] = [];
    let number = 1;
    for (;;) {
      const batches = [connectors.slice(0, 7), connectors.slice(7)];
      const result = diagnosticPage({
        sessions: [{scope: 'workspace', response: {hits: {hits: sessions}}}],
        connectors: {responses: batches.map(items => ({hits: {hits: items}}))},
        memories: {hits: {hits: memories}},
        board: {hits: {hits: board}},
      }, number);
      const responses = [result.sessions![0].response, ...result.connectors!.responses!, result.memories!, result.board!];
      const ids = responses.flatMap(response => response.hits!.hits!.map(hit => hit._id!));
      assert.equal(ids.length, Math.min(25, expected.length - seen.length));
      seen.push(...ids);
      assert.equal(result.page?.hasNext, seen.length < expected.length);
      if (!result.page?.hasNext) break;
      number++;
    }
    assert.deepEqual(seen.sort(), expected.sort());
  });
}

test('the final bounded page identifies additional reported matches', () => {
  const result = {sessions: [{scope: 'workspace', response: {hits: {hits: hits('s', 100), total: {value: 150}}}}]};
  assert.equal(diagnosticPage(result, 1).page?.windowLimited, undefined);
  assert.deepEqual(diagnosticPage(result, 4).page, {number: 4, hasNext: false, windowLimited: true});
});
