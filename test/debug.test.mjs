import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resultLabel, resultGroups, queryPattern, excerpt, resultTime, boardPage, boardTopicHref} from '../web/debug.js';

test('board navigation distinguishes topic index, encoded topic links and global stream', () => {
  assert.deepEqual(boardPage('?view=board'), {kind: 'topics', topic: ''});
  for (const topic of ['capture-release', 'café & release/notes?#', '<script>']) {
    const url = new URL(boardTopicHref(topic), 'https://example.test');
    assert.equal(url.pathname, '/_/debug');
    assert.equal(url.searchParams.get('view'), 'board');
    assert.deepEqual(boardPage(url.search), {kind: 'topic', topic});
  }
  assert.deepEqual(boardPage('?view=stream&topic=ignored'), {kind: 'stream', topic: ''});
  assert.deepEqual(boardPage('?view=board&topic=%20'), {kind: 'topics', topic: ''});
});

test('result labels distinguish searchable source kinds without inferring people or channel names', () => {
  assert.equal(resultLabel({provider:'slack',kind:'message',timestamp:'1.0',threadTs:'1.0'}, 'connector'), 'Slack message');
  assert.equal(resultLabel({provider:'slack',kind:'message',timestamp:'2.0',threadTs:'1.0'}, 'connector'), 'Slack reply');
  assert.equal(resultLabel({harness:'codex',role:'user'}, 'session'), 'Codex · User message');
  assert.equal(resultLabel({harness:'claude-code',role:'assistant'}, 'session'), 'Claude Code · Assistant message');
  assert.equal(resultLabel({harness:'codex',kind:'tool_call'}, 'session'), 'Codex · Tool call');
  assert.equal(resultLabel({harness:'codex',kind:'tool_result'}, 'session'), 'Codex · Tool result');
  assert.equal(resultLabel({kind:'compaction'}, 'session'), 'Agent session · Conversation summary');
  assert.equal(resultLabel({kind:'unknown'}, 'session'), 'Agent session · Session event');
});

test('groups preserve every raw hit and response without combining scores across indexes', () => {
  const first={_id:'first',_score:0.1,_source:{text:'first'}},second={_id:'second',_score:9,_source:{text:'second'}};
  const data={connectors:{responses:[{hits:{hits:[first]}}],truncated:true},sessions:[{scope:'workspace',response:{hits:{total:{value:0},hits:[]}}},{scope:'personal',response:{hits:{total:{value:22},hits:[second]}}}]};
  const original=structuredClone(data),groups=resultGroups(data);
  assert.deepEqual(groups.map(g=>g.hits),[[first],[],[second]]);
  assert.equal(groups[2].total,22); assert.equal(groups[0].truncated,true);
  assert.deepEqual(data,original);
  assert.deepEqual(resultGroups({connectors:{state:'not_configured',responses:[]},sessions:[{scope:'personal',response:{state:'pending',responses:[]}}]}).map(g=>g.state),['not_configured','pending']);
});

test('excerpts center matches late in long items and leave raw content intact', () => {
  const text='start '.repeat(500)+'OpenCrawl match here'+' tail'.repeat(500);
  const result=excerpt(text,'opencrawl');
  assert.ok(result.leading && result.trailing);
  assert.match(result.text,/OpenCrawl match here/);
  assert.ok(result.text.length<=700);
  assert.deepEqual(excerpt('short text','text'),{text:'short text',leading:false,trailing:false});
  assert.equal(queryPattern('[] .*'),null);
  assert.equal('OPENCrawl and café'.match(queryPattern('opencrawl café')).length,2);
  assert.equal(excerpt('<script>alert(1)</script> OpenCrawl','opencrawl').text,'<script>alert(1)</script> OpenCrawl');
});

test('Slack timestamps and session ISO dates retain their actual time; invalid dates stay absent', () => {
  assert.equal(resultTime({timestamp:'1700000000.123456'},'connector').toISOString(),'2023-11-14T22:13:20.123Z');
  assert.equal(resultTime({timestamp:'2026-11-05T00:00:00Z'},'session').toISOString(),'2026-11-05T00:00:00.000Z');
  assert.equal(resultTime({timestamp:'not a date'},'session'),null);
  assert.equal(resultTime({},'session'),null);
});
