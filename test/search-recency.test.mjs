import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recencyRank, originalTime, RECENCY_WEIGHT, RECENCY_HALF_LIFE_DAYS} from '../dist/src/search/recency.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';

const DAY = 86_400_000, now = Date.parse('2026-11-12T12:00:00Z');
const date = days => new Date(now - days * DAY).toISOString();
const hit = (id, score, days, extra = {}) => ({id, score, tenantId:'team', userId:'alice', sessionId:id, eventId:id, text:id, timestamp:date(days), ...extra});

test('freshness breaks close lexical matches, with bounded influence and no input mutation', () => {
  const hits = [hit('strong-old', 10 * (1 + RECENCY_WEIGHT) + 0.01, 3650), hit('close-old', 10.01, 3650), hit('fresh', 10, 0)];
  const original = structuredClone(hits);
  assert.deepEqual(recencyRank('sessions', hits, now).map(h=>h.id), ['strong-old','fresh','close-old']);
  assert.deepEqual(hits, original);
  const half = hit('half-life', 10, RECENCY_HALF_LIFE_DAYS);
  const competitor = hit('older', 10 * (1 + RECENCY_WEIGHT / 2) - 0.001, 3650);
  assert.equal(recencyRank('sessions', [competitor, half], now)[0].id, 'half-life');
});

test('only original source dates count; absent, invalid and future dates are neutral', () => {
  const old = hit('old', 10, 3650);
  for (const timestamp of [undefined, null, '', 'not-a-date', '4', date(-1)]) {
    const undated = hit('undated', 10, 0, {timestamp, receivedAt:date(0), extractedAt:now, generation:now});
    assert.deepEqual(recencyRank('sessions', [old, undated], now).map(h=>h.id), ['old','undated']);
  }
  assert.equal(originalTime('connectors', hit('slack', 10, 0, {timestamp:String(now / 1000 + 0.123)})), now + 123);
  assert.equal(originalTime('memories', hit('memory', 10, 0, {modifiedAt:date(30)})), now - 30 * DAY);
  assert.ok(Number.isNaN(originalTime('memories', hit('missing', 10, 0))));
  const ties = [hit('a', 10, 5), hit('b', 10, 5)];
  assert.deepEqual(recencyRank('sessions', ties, now).map(h=>h.id), ['a','b']);
});

test('workspace recency stays inside authorized source windows and pins its clock across pages', async () => {
  const p={tenantId:'team',userId:'alice'};let clock=now, revoked=false;
  const candidates=[hit('old',10.01,3650),hit('fresh',10,0)];
  const sessions={search:async(principal,input)=>{assert.deepEqual(principal,p);assert.equal(input.limit,100);if(revoked)throw Object.assign(Error('denied'),{status:403});return {hits:input.order==='oldest'?[...candidates]:candidates};}};
  const connectors={search:async()=>({hits:[hit('connector',10000,0)]})};
  const service=createWorkspaceSearch({sessions,connectors,now:()=>clock});
  const input={query:'evidence',limit:1};
  const first=await service.search(p,input);assert.equal(first.results[0].id,'sessions:fresh');
  clock+=299000;
  const second=await service.search(p,{...input,cursor:first.next});assert.equal(second.results[0].id,'connectors:connector');
  const third=await service.search(p,{...input,cursor:second.next});assert.equal(third.results[0].id,'sessions:old');
  const historical=await service.search(p,{query:'evidence',source:'sessions',order:'oldest'});
  assert.deepEqual(historical.results.map(h=>h.id),['sessions:old','sessions:fresh']);
  revoked=true;await assert.rejects(service.search(p,{...input,cursor:first.next}),/denied/);
});
