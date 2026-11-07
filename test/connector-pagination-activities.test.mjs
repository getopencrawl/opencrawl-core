import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MockActivityEnvironment} from '@temporalio/testing';
import {connectorActivities} from '../src/connectors/temporal/worker.mjs';
import {sessionActivities} from '../src/sessions/temporal/worker.mjs';

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
