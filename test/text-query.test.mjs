import {test} from 'node:test';
import assert from 'node:assert/strict';
import {textQuery,STEMMED} from '../dist/src/search/text-query.mjs';

test('full-text queries rank on exact and stemmed text and keep match semantics',()=>{
  assert.deepEqual(textQuery('rescheduled deadlines','phrase'),{match_phrase:{text:'rescheduled deadlines'}});
  for(const [match,operator] of [['any','or'],['all','and']]) {
    const {bool}=textQuery('rescheduled deadlines',match);
    assert.equal(bool.minimum_should_match,1);
    assert.deepEqual(bool.should,[{match:{text:{query:'rescheduled deadlines',operator}}},{match:{[STEMMED]:{query:'rescheduled deadlines',operator}}}]);
  }
  assert.equal(STEMMED,'text.english');
});

test('time ranges are inclusive ISO bounds on the common timestamp and reject invalid input',async()=>{
  const {timeRange}=await import('../dist/src/search/text-query.mjs');
  assert.deepEqual(timeRange(),[]);
  assert.deepEqual(timeRange(undefined,'2024-03-27T12:00:00Z'),[{range:{timestamp:{lte:'2024-03-27T12:00:00.000Z'}}}]);
  assert.deepEqual(timeRange('2024-03-01T00:00:00+02:00','2024-03-02T00:00:00Z'),[{range:{timestamp:{gte:'2024-02-29T22:00:00.000Z',lte:'2024-03-02T00:00:00.000Z'}}}]);
  for(const [a,b] of [['nope',undefined],['2024-03-02T00:00:00Z','2024-03-01T00:00:00Z']])assert.throws(()=>timeRange(a,b),e=>e.status===400);
});

test('semantic ranking adds a boosted learned-sparse clause and keeps all/phrase semantics',async()=>{
  const {SPARSE,SEMANTIC_BOOST}=await import('../dist/src/search/text-query.mjs');
  const sparse={neural_sparse:{[SPARSE]:{query_text:'q',analyzer:'bert-uncased',boost:SEMANTIC_BOOST}}};
  const any=textQuery('q','any',true).bool;
  assert.equal(any.minimum_should_match,1);assert.deepEqual(any.should.at(-1),sparse);
  const all=textQuery('q','all',true).bool;
  assert.deepEqual(all.should,[sparse]);assert.equal(all.must[0].bool.should[0].match.text.operator,'and');
  assert.deepEqual(textQuery('q','phrase',true),{match_phrase:{text:'q'}});
  assert.ok(!JSON.stringify(textQuery('q','any',false)).includes('neural_sparse'));
});
