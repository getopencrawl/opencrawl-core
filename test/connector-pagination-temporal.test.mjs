import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker, Runtime, DefaultLogger, bundleWorkflowCode} from '@temporalio/worker';

test('real Temporal: pagination failures, continuation state and legacy cyclic history survive worker upgrade and replay', {
  skip: process.env.OPENCRAWL_TEST_TEMPORAL !== '1', timeout: 180000,
}, async t => {
  Runtime.install({logger: new DefaultLogger('ERROR')});
  const env = await TestWorkflowEnvironment.createLocal(); t.after(() => env.teardown());
  const current = await bundleWorkflowCode({workflowsPath: fileURLToPath(new URL('./fixtures/indexing-workflows.cjs', import.meta.url))});
  const legacy = await bundleWorkflowCode({workflowsPath: fileURLToPath(new URL('./fixtures/legacy-indexing-workflows.cjs', import.meta.url))});

  for (const workflowType of ['indexSessionsV1', 'indexConnectorV1']) {
    for (const upgrade of [false, true]) {
      const taskQueue = `${workflowType}-${upgrade}`, workflowId = taskQueue;
      let pages = 0, worker;
      const list = async ({cursor}) => {
        pages++;
        // End old worker polling during its fifth activity. The new worker must
        // replay the old cyclic history, finish that segment, then guard the next.
        if (upgrade && pages === 5) worker.shutdown();
        const period = upgrade ? 2 : 7;
        return {keys: [], cursor: String(cursor === null ? 0 : (Number(cursor) + 1) % period)};
      };
      const activities = {listPage: list, listSessionPage: list};
      const options = {connection: env.nativeConnection, taskQueue, activities, shutdownGraceTime: '5 seconds'};
      const handle = await env.client.workflow.start(workflowType, {taskQueue, workflowId, args: [{sourceId: 'fixture'}]});
      if (upgrade) {
        worker = await Worker.create({...options, workflowBundle: legacy});
        await worker.run();
        assert.equal(pages, 5);
        const oldHistory = await env.client.workflow.getHandle(workflowId, handle.firstExecutionRunId).fetchHistory();
        assert.ok(!oldHistory.events.some(event => event.markerRecordedEventAttributes));
        await Worker.runReplayHistory({workflowBundle: current}, oldHistory);
      }
      worker = await Worker.create({...options, workflowBundle: current});
      await worker.runUntil(async () => assert.rejects(handle.result(), error => {
        assert.equal(error.cause?.type, 'SourcePaginationFailed');
        assert.equal(error.cause?.nonRetryable, true);
        return true;
      }));
      assert.ok(pages < 30, `cycle did not terminate promptly: ${pages}`);
      let runId = handle.firstExecutionRunId, runs = 0;
      while (runId) {
        const history = await env.client.workflow.getHandle(workflowId, runId).fetchHistory();
        await Worker.runReplayHistory({workflowBundle: current}, history);
        assert.ok(!history.events.some(event => event.workflowTaskFailedEventAttributes), 'workflow tasks must not retry a guard failure');
        const continued = history.events.find(event => event.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
        if (!continued) {
          assert.ok(history.events.some(event => event.workflowExecutionFailedEventAttributes));
          assert.ok(history.events.some(event => event.markerRecordedEventAttributes));
        } else if (upgrade && runs === 0) {
          assert.ok(!history.events.some(event => event.markerRecordedEventAttributes));
        }
        runId = continued?.newExecutionRunId;
        assert.ok(++runs < 10);
      }
      assert.ok(runs >= 2, 'fixture must cross continue-as-new');
    }
    const taskQueue = `${workflowType}-malformed`;
    const worker = await Worker.create({connection: env.nativeConnection, taskQueue, workflowBundle: current});
    await worker.runUntil(async () => assert.rejects(env.client.workflow.execute(workflowType, {
      taskQueue, workflowId: taskQueue, args: [{cursor: 'B', paginationProgress: {version: 99}}],
    }), error => error.cause?.type === 'SourcePaginationFailed' && error.cause?.nonRetryable));
  }
});
