import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openSearchAggregations,termCount} from '../dist/src/search/aggregations.mjs';

test('keyword document counts compile to a metric with fixed code and bound parameters',()=>{
 const predicate={field:'session.origin',value:'subagent'};
 const result=openSearchAggregations({sessions:{multi_terms:{terms:[{field:'session.sessionId'}],size:50000},aggs:{
  first:{min:{field:'session.timestamp'}},subagents:{term_count:predicate}}}});
 assert.deepEqual(result.sessions.aggs.subagents.sum.script.params,predicate);
 assert.equal(result.sessions.aggs.subagents.sum.script.lang,'painless');
 assert.ok(!result.sessions.aggs.subagents.sum.script.source.includes('subagent'));
 assert.deepEqual(result.sessions.aggs.first,{min:{field:'session.timestamp'}});
 assert.deepEqual(termCount({field:'session.origin',value:"arbitrary ' input"}),{field:'session.origin',value:"arbitrary ' input"});
});

test('unsupported, non-indexed and malformed predicates fail before any provider request',()=>{
 for(const value of [null,{},[],{field:'text',value:'x'},{field:'session.attachments',value:'x'},
  {field:'session.origin',value:3},{field:'session.origin',value:'x',script:'untrusted'},
  {field:"session.origin')",value:'x'},{field:'session.missing',value:'x'}])assert.throws(()=>termCount(value),{status:400});
 assert.throws(()=>openSearchAggregations({bad:{term_count:{field:'session.origin',value:'x'},aggs:{}}}),{status:400});
});
