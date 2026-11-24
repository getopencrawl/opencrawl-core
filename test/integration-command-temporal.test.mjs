import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Runtime, DefaultLogger, Worker} from '@temporalio/worker';
import {
  buildIntegrationWorkflows, createIntegrationWorker, ensureIntegrationRecoverySchedule,
  integrationCommandActivities, startIntegrationCommand,
} from '../dist/src/integrations/temporal/runtime.mjs';

const reference = {environment: 'production', tenantId: 'org_one', userId: 'user_one',
  integrationId: 'int_' + 'a'.repeat(26), commandId: 'd9b0eb76-a9bd-4b01-a74d-792db3739b09'};
const namespace = 'opencrawl-production', sourceId = 'hosted-integrations-production', taskQueue = 'airbyte-lifecycle-v1';

test('integration command IDs bind every scope field and only references enter the outbox result and start payload', async () => {
  const starts = [], client = {workflow: {start: async (name, options) => starts.push(options)}};
  const unprojected = {...reference, apiKey: 'do-not-serialize'};
  const id = await startIntegrationCommand(client, taskQueue, unprojected);
  assert.deepEqual(starts[0].args, [reference]);
  const distinct = await Promise.all(Object.entries({environment: 'staging', tenantId: 'org_two', userId: 'user_two',
    integrationId: 'int_' + 'b'.repeat(26), commandId: 'another-command'}).map(([key, value]) =>
    startIntegrationCommand(client, taskQueue, {...reference, [key]: value})));
  assert.equal(new Set([id, ...distinct]).size, 6);
  let reads = 0;
  const activities = integrationCommandActivities({environment: 'production', sourceId,
    execute: () => assert.fail('invalid environment reached a mutation'),
    listPending: async ({limit}) => {reads++; assert.equal(limit, 50); return {commands: [unprojected], cursor: null};}});
  await assert.rejects(activities.executeIntegrationCommand({...reference, environment: 'staging'}), /environment denied/);
  await assert.rejects(activities.listPendingIntegrationCommands({sourceId: 'foreign'}), /Invalid integration recovery source/);
  assert.equal(reads, 0);
  assert.deepEqual(await activities.listPendingIntegrationCommands({sourceId}), {commands: [{workflowId: id, reference}], cursor: null});
  await assert.rejects(startIntegrationCommand(client, taskQueue, {...reference, userId: ''}), /Invalid integration command/);
});

test('Temporal resumes a connector phase on a replacement worker and recovers unsent outbox commands with scoped IDs', {
  skip: process.env.OPENCRAWL_TEST_TEMPORAL !== '1', timeout: 180_000,
}, async t => {
  Runtime.install({logger: new DefaultLogger('ERROR')});
  const directory = await mkdtemp(join(tmpdir(), 'integration-lifecycle-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const executablePath = process.env.TEMPORAL_CLI_PATH;
  const env = await TestWorkflowEnvironment.createLocal({server: {namespace,
    ...(executablePath ? {executable: {type: 'existing-path', path: executablePath}} : {})}});
  t.after(() => env.teardown());
  const bundlePath = join(directory, 'workflows.cjs');
  await buildIntegrationWorkflows(bundlePath);
  let attempts = 0, landed = false, completed = false;
  const firstFailure = Promise.withResolvers(), lostComplete = Promise.withResolvers();
  const lost = {...reference, tenantId: 'org_two'};
  let lostRuns = 0;
  const legacyPages = [], legacyNext = {tenantId: reference.tenantId, integrationId: reference.integrationId};
  const options = {address: env.address, namespace, taskQueue, bundlePath, sourceId, environment: 'production',
    execute: async (ref, signal) => {
      signal.throwIfAborted();
      if (ref.tenantId === lost.tenantId) {lostRuns++; lostComplete.resolve(); return 'done';}
      assert.deepEqual(ref, reference);
      attempts++;
      if (!landed) {landed = true; return 'more';}
      if (attempts === 2) {firstFailure.resolve(); throw new Error('PRIVATE_AIRBYTE_PROVIDER_BODY');}
      assert.ok(!completed);
      completed = true;
      return 'done';
    },
    adoptLegacy: async cursor => {legacyPages.push(cursor);return cursor ? null : legacyNext;},
    listPending: async ({cursor}) => cursor ? {commands: [lost], cursor: null} : {commands: [reference], cursor: 'second'}};

  const id = await startIntegrationCommand(env.client, taskQueue, {...reference, apiKey: 'PRIVATE_AIRBYTE_KEY'});
  const handle = env.client.workflow.getHandle(id);
  const before = await createIntegrationWorker(options);
  try {await before.worker.runUntil(() => firstFailure.promise);} finally {await before.connection.close();}
  assert.equal(attempts, 2);
  const after = await createIntegrationWorker(options);
  try {
    await after.worker.runUntil(async () => {
      await handle.result();
      const runId = (await handle.describe()).runId;
      assert.equal(await startIntegrationCommand(env.client, taskQueue, reference), id);
      assert.equal((await handle.describe()).runId, runId);
      const scheduleId = await ensureIntegrationRecoverySchedule(env.client, {taskQueue, sourceId});
      const schedule = env.client.schedule.getHandle(scheduleId);
      const description = await schedule.describe();
      assert.equal(description.spec.intervals[0].every, 600_000);
      assert.equal(description.policies.catchupWindow, 60_000);
      await lostComplete.promise;
      await schedule.pause();
      assert.equal(await ensureIntegrationRecoverySchedule(env.client, {taskQueue, sourceId}), scheduleId);
      assert.equal((await schedule.describe()).state.paused,true);
      await assert.rejects(ensureIntegrationRecoverySchedule(env.client, {taskQueue: 'other', sourceId}), /scope mismatch/);
      const lostId = await startIntegrationCommand(env.client, taskQueue, lost);
      await env.client.workflow.getHandle(lostId).result();
      await env.client.schedule.getHandle(scheduleId).delete();
    });
  } finally {await after.connection.close();}
  assert.equal(attempts, 3); assert.equal(lostRuns, 1);
  assert.deepEqual(legacyPages,[null,legacyNext]);
  const history = await handle.fetchHistory();
  const secrets = /PRIVATE_AIRBYTE_(KEY|PROVIDER_BODY)/;
  function inspect(value) {
    if (value instanceof Uint8Array) assert.doesNotMatch(Buffer.from(value).toString(), secrets);
    else if (typeof value === 'string') assert.doesNotMatch(value, secrets);
    else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
  }
  inspect(history);
  await Worker.runReplayHistory({workflowBundle: {codePath: bundlePath}}, history);
});
