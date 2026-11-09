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
