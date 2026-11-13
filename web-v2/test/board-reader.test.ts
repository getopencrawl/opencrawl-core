import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router';
import {BoardReader} from '../src/pages/board-reader.js';
import {BoardContent} from '../src/pages/board.js';
import {ForumPanel} from '../src/design/forum.js';
import type {BoardMessage, BoardReport, ConsoleDataAdapter} from '../src/pages/types.js';

function post(id: number, topic = 'release'): BoardMessage {return {id, topic, timestamp: 1_800_000_000_000 + id, name: 'codex:release', agent: 'registered-agent', text: `Post ${id}\n\nFull authorized text.`};}
function fixture(count: number) {
  const source = {messages: Array.from({length: count}, (_, index) => post(index + 1)), failure: null as unknown, calls: [] as Array<{before?: number; topic?: string}>};
  const adapter: Pick<ConsoleDataAdapter, 'board'> = {async board(input, signal) {
    assert.equal(signal.aborted, false); source.calls.push(input);
    if (source.failure) throw source.failure;
    const matching = source.messages.filter(message => (!input.topic || message.topic === input.topic) && (input.before === undefined || message.id < input.before)).reverse();
    return {messages: matching.slice(0, 20), next: matching.length > 20 ? matching[19]!.id : null,
      topicSummaries: [{topic: 'release', posts: source.messages.length, latest: {timestamp: source.messages.at(-1)?.timestamp ?? 0, name: 'codex:release'}}]};
  }};
  return {source, adapter};
}
function ids(reader: BoardReader) {return reader.snapshot().report?.messages.map(message => message.id) ?? [];}

test('a permalink opens an old message in one scoped read and retains normal pagination and refresh', async () => {
  const {source, adapter} = fixture(5000), reader = new BoardReader(adapter, 'release', false, () => {}, 30);
  await reader.refresh();
  assert.deepEqual(source.calls, [{topic: 'release', before: 31}]);
  assert.deepEqual(ids(reader), Array.from({length: 20}, (_, i) => 30 - i));
  await reader.older();
  assert.equal(ids(reader).at(-1), 1);
  const before = source.calls.length;
  await reader.refresh();
  assert.equal(source.calls.length - before, 5, 'newer history still uses the bounded verified bridge');
  assert.equal(reader.snapshot().catchingUp, true);
  assert.equal(ids(reader)[0], 30, 'refresh retains the linked message while the newer chain is staged');
});

test('a bounded refresh bridges every new page before adding posts and preserves history loaded during catch-up', async () => {
  const {source, adapter} = fixture(60), reader = new BoardReader(adapter, 'release', false);
  await reader.refresh(); await reader.older();
  assert.deepEqual(ids(reader), Array.from({length: 39}, (_, i) => 60 - i));
  source.messages.push(...Array.from({length: 200}, (_, i) => post(61 + i)));
  const before = source.calls.length;
  await reader.refresh();
  assert.equal(source.calls.length - before, 5);
  assert.equal(reader.snapshot().catchingUp, true);
  assert.equal(ids(reader)[0], 60, 'an unbridged newest page is never mixed into displayed history');
  await reader.older(); await reader.older();
  assert.equal(reader.snapshot().report?.next, null);
  assert.equal(ids(reader).at(-1), 1);
  await reader.refresh();
  assert.equal(ids(reader)[0], 60, 'a second bounded chunk still cannot skip the remaining gap');
  await reader.refresh();
  assert.deepEqual(ids(reader), Array.from({length: 260}, (_, i) => 260 - i));
  assert.equal(reader.snapshot().catchingUp, false);
  assert.equal(reader.snapshot().report?.next, null, 'the oldest cursor comes from current state, including load-older work');
});

test('posts arriving during a staged snapshot are picked up by the next head refresh without duplicates', async () => {
  const {source, adapter} = fixture(20), reader = new BoardReader(adapter, 'release', false);
  await reader.refresh();
  source.messages.push(...Array.from({length: 105}, (_, i) => post(21 + i)));
  await reader.refresh();
  source.messages.push(post(126));
  await reader.refresh();
  assert.equal(ids(reader)[0], 125);
  await reader.refresh();
  assert.deepEqual(ids(reader), Array.from({length: 126}, (_, i) => 126 - i));
});

test('access and unknown failures clear cached and staged data; only explicit 5xx preserves confirmed history', async () => {
  for (const failure of [Object.assign(new Error('Revoked'), {status: 403}), Object.assign(new Error('Expired'), {status: 401}), new Error('Unclassified')]) {
    const {source, adapter} = fixture(20), reader = new BoardReader(adapter, 'release', false);
    await reader.refresh(); source.messages.push(...Array.from({length: 120}, (_, i) => post(21 + i))); await reader.refresh();
    source.failure = failure; await reader.refresh();
    assert.equal(reader.snapshot().report, null); assert.equal(reader.snapshot().catchingUp, false);
    source.failure = null; await reader.refresh();
    assert.equal(ids(reader).length, 20, 'recovery starts a new authorized window, without hidden cached history');
  }
  const {source, adapter} = fixture(40), reader = new BoardReader(adapter, '', false);
  await reader.refresh(); await reader.older(); await reader.older();
  source.failure = Object.assign(new Error('Temporarily unavailable'), {status: 503}); await reader.refresh();
  assert.equal(ids(reader).length, 40); assert.equal(reader.snapshot().error, 'Temporarily unavailable');
});

test('aborted reads cannot publish late data and overlapping poll/load-older calls are ignored', async () => {
  let release: (report: BoardReport) => void = () => {};
  let calls = 0, signal: AbortSignal | undefined;
  const reader = new BoardReader({board: (_input, incoming) => {calls++; signal = incoming; return new Promise(resolve => {release = resolve;});}}, 'release', false);
  const reading = reader.refresh(); void reader.refresh(); void reader.older();
  assert.equal(calls, 1); reader.cancel(); assert.equal(signal?.aborted, true);
  release({messages: [post(1)], topicSummaries: [], next: null}); await reading;
  assert.equal(reader.snapshot().report, null); assert.equal(reader.snapshot().busy, false);
});

test('replacement history resets atomically instead of mixing reused IDs with the old board', async () => {
  const {source, adapter} = fixture(30), reader = new BoardReader(adapter, 'release', false);
  await reader.refresh(); await reader.older();
  source.messages = [{...post(30), text: 'Replacement board'}]; await reader.refresh();
  assert.deepEqual(reader.snapshot().report?.messages, source.messages); assert.equal(reader.snapshot().report?.next, null);
});

test('malformed cursors or wrong-topic pages fail closed instead of creating a loop or leaking another thread', async () => {
  for (const page of [{messages: [post(2)], topicSummaries: [], next: 3}, {messages: [post(1, 'another-topic')], topicSummaries: [], next: null}]) {
    const reader = new BoardReader({board: async () => page}, 'release', false);
    await reader.refresh(); assert.equal(reader.snapshot().report, null); assert.notEqual(reader.snapshot().error, '');
  }
});

test('topic summaries replace atomically and counts stay distinct from thread pagination', async () => {
  const {source, adapter} = fixture(30), reader = new BoardReader(adapter, '', true);
  await reader.refresh(); source.messages.push(post(31)); await reader.refresh(); await reader.older();
  assert.equal(reader.snapshot().report?.topicSummaries[0]?.posts, 31);
  assert.deepEqual(reader.snapshot().report?.messages, []); assert.equal(reader.snapshot().report?.next, null);
  assert.equal(source.calls.length, 2);
});

test('the forum renders through a pure core adapter with encoded links and escaped full text', async () => {
  const {source, adapter} = fixture(2);
  source.messages[1] = {...post(2), topic: 'café & notes/?', name: '<script>author</script>', text: '<script>alert(1)</script>\n\nSecond paragraph.'};
  const reader = new BoardReader(adapter, '', false); await reader.refresh();
  const report = reader.snapshot().report; assert.ok(report);
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ForumPanel, {title: 'Global stream', status: 'Showing 2 messages', children: createElement(BoardContent, {report, topics: false, stream: true})})));
  assert.match(markup, /oc-forum-author/); assert.match(markup, /oc-forum-post-meta/); assert.match(markup, /#2/);
  assert.match(markup, /topic=caf%C3%A9%20%26%20notes%2F%3F/);
  assert.match(markup, /href="\/diagnostics\?view=board&amp;topic=caf%C3%A9%20%26%20notes%2F%3F&amp;message=2"/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.match(markup, /Second paragraph/);
  assert.doesNotMatch(markup, /<script>|Refresh|WorkOS/);
});


test('a reset between staged pages discards the entire old chain before reading a fresh head', async () => {
  const {source, adapter} = fixture(60), reader = new BoardReader(adapter, 'release', false);
  await reader.refresh();
  source.messages.push(...Array.from({length: 200}, (_, i) => post(61 + i)));
  await reader.refresh();
  assert.equal(reader.snapshot().catchingUp, true);
  source.messages = Array.from({length: 120}, (_, i) => ({...post(i + 1), text: `Replacement ${i + 1}`}));
  const beforeRecovery = source.calls.length;
  await reader.refresh();
  assert.equal(source.calls.length - beforeRecovery, 2, 'one checked continuation plus one fresh head');
  assert.deepEqual(ids(reader), Array.from({length: 20}, (_, i) => 120 - i));
  assert.ok(reader.snapshot().report?.messages.every(message => message.text.startsWith('Replacement')));
  assert.equal(reader.snapshot().catchingUp, false);
});

test('load older validates its overlap and never appends a replacement board to cached messages', async () => {
  const {source, adapter} = fixture(60), reader = new BoardReader(adapter, 'release', false);
  await reader.refresh();
  source.messages = Array.from({length: 30}, (_, i) => ({...post(i + 1), text: `Replacement ${i + 1}`}));
  const beforeRecovery = source.calls.length;
  await reader.older();
  assert.equal(source.calls.length - beforeRecovery, 2, 'one checked older page plus one fresh head');
  assert.deepEqual(ids(reader), Array.from({length: 20}, (_, i) => 30 - i));
  assert.ok(reader.snapshot().report?.messages.every(message => message.text.startsWith('Replacement')));
});
