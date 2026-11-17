import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MockActivityEnvironment} from '@temporalio/testing';
import {connectorActivities} from '../dist/src/connectors/temporal/worker.mjs';
import {sessionActivities} from '../dist/src/sessions/temporal/worker.mjs';
import {paginationFixture} from './fixtures/connector-pagination-paths.mjs';

test('an unshippable session document reports a safe nonretryable bulk cause',async()=>{
 const env=new MockActivityEnvironment();
 const resolve=async()=>{throw Object.assign(new Error('private provider body'),{code:'BULK_TOO_LARGE',permanent:true});};
 await assert.rejects(env.run(sessionActivities({resolve}).indexSessionObject,{key:'private-object-key'}),error=>error.type==='BULK_TOO_LARGE'&&error.nonRetryable===true&&!error.message.includes('private'));
});

test('both real list activities reject pending pagination failures before source resolution or provider access', async () => {
  const resolve = async () => assert.fail('pending pagination failure must not resolve credentials or fetch provider');
  const lists = [connectorActivities({resolve}).listPage, sessionActivities({resolve}).listSessionPage];
  for (const list of lists) {
    for (const paginationFailure of ['cycle', 'invalid-progress', 'invalid-page', 'invalid-cursor', 'unknown', [], ['cycle'], null]) {
      await assert.rejects(list({paginationFailure}), error => error.type === 'SourcePaginationFailed' && error.nonRetryable === true);
    }
  }
});

test('legacy object activity inputs carrying a pending flag still reach normal source resolution', async () => {
  let resolved = 0;
  const resolve = async () => {resolved++; throw Object.assign(new Error('fixture source reached'), {permanent: true});};
  const env = new MockActivityEnvironment();
  for (const [operation, expected] of [[connectorActivities({resolve}).processObject, 'InvalidConnectorInput'],
    [sessionActivities({resolve}).indexSessionObject, 'InvalidSessionInput']]) {
    await assert.rejects(env.run(operation, {paginationFailure: 'cycle', key: 'fixture'}), error => error.type === expected);
  }
  assert.equal(resolved, 2);
});

test('real workspace object activities fail cyclic inventory nonretryably without a receipt', async () => {
  const env = new MockActivityEnvironment();
  for (const provider of ['granola', 'circleback', 'notion']) {
    const h = paginationFixture(provider, {list: cursor => ({keys: [], nextToken: cursor === 'A' ? 'B' : 'A'})});
    const activity = connectorActivities({resolve: async () => h}).processObject;
    await assert.rejects(env.run(activity, {key: h.binding.rawPrefix + 'workspace-snapshot'}),
      error => error.type === 'SourcePaginationFailed' && error.nonRetryable === true && error.message === 'Source pagination cursor cycle detected');
    assert.equal(h.summary().lists, 3); assert.deepEqual(h.summary().receipts, []);
  }
});
