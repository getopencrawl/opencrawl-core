import {test} from 'node:test';
import assert from 'node:assert/strict';
import {headlineMetric} from '../src/application/connector-card-model.ts';

test('semantic metric takes precedence over a larger incidental count, including zero',()=>{
  const rows=[{label:'Pages',count:0},{label:'Comments',count:1246}];
  assert.equal(headlineMetric(rows,'Pages'),rows[0]);
});
test('an unconfigured or absent metric falls back to the largest count',()=>{
  const rows=[{label:'Pages',count:842},{label:'Comments',count:1246}];
  assert.equal(headlineMetric(rows),rows[1]);
  assert.equal(headlineMetric(rows,'Documents'),rows[1]);
});
test('ties preserve stream order without mutating the source list',()=>{
  const rows=Object.freeze([{label:'Pages',count:10},{label:'Comments',count:10}]);
  assert.equal(headlineMetric(rows),rows[0]);
});
test('missing and invalid counts do not produce invented numeric metrics',()=>{
  assert.equal(headlineMetric(),undefined);
  assert.equal(headlineMetric([{label:'Pages',count:NaN},{label:'Comments',count:-1}]),undefined);
});
