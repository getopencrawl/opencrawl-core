import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {ApplicationFailure} from '@temporalio/common';
import {Worker, Runtime, DefaultLogger, bundleWorkflowCode} from '@temporalio/worker';
import {assertSourcePaginationInput, assertSourcePaginationPage} from '../dist/src/connectors/workflow.mjs';

function isPaginationFailure(error) {
  assert.equal(error.cause?.name, 'ActivityFailure');
  assert.equal(error.cause?.cause?.type, 'SourcePaginationFailed');
  assert.equal(error.cause?.cause?.nonRetryable, true);
  return true;
}

test('real Temporal: pagination activity failures replay in both versions across mixed workers, rollback and continuation', {
  skip: process.env.OPENCRAWL_TEST_TEMPORAL !== '1', timeout: 180000,
}, async t => {
  Runtime.install({logger: new DefaultLogger('ERROR')});
  const env = await TestWorkflowEnvironment.createLocal(); t.after(() => env.teardown());
  const current = await bundleWorkflowCode({workflowsPath: fileURLToPath(new URL('./fixtures/indexing-workflows.cjs', import.meta.url))});
  const legacy = await bundleWorkflowCode({workflowsPath: fileURLToPath(new URL('./fixtures/legacy-indexing-workflows.cjs', import.meta.url))});
  const stale = {version: 1, anchor: '15', window: '16', distance: '0'};
  const scenarios = [
    {name: 'fresh-cycle', period: 7, phases: [['current', Infinity]]},
    {name: 'upgrade-cycle', period: 2, phases: [['legacy', 5], ['current', Infinity]]},
    {name: 'rollback-cycle', period: 2, phases: [['current', 2], ['legacy', 7], ['current', Infinity]]},
    {name: 'rollback-stale-healthy', healthy: true, input: {cursor: '15', paginationProgress: stale},
      phases: [['current', 2], ['legacy', 7], ['current', Infinity]]},
    {name: 'cycle-on-fifth-page', input: {cursor: 'prior', paginationProgress: {version: 1, anchor: 'A', window: '8', distance: '3'}},
      transitions: {prior: 'B', B: 'C', C: 'D', D: 'E', E: 'A'}, phases: [['current', Infinity]]},
  ];
  for (const workflowType of ['indexSessionsV1', 'indexConnectorV1']) {
    for (const scenario of scenarios) {
      const taskQueue = `${workflowType}-${scenario.name}`, workflowId = taskQueue;
      let providerCalls = 0, listCalls = 0, processed = 0, worker, generation, stopAt;
      const list = async input => {
        listCalls++;
        try { if (generation === 'current') assertSourcePaginationInput(input); }
        catch (error) { throw ApplicationFailure.nonRetryable(error.message, 'SourcePaginationFailed'); }
        providerCalls++;
        let cursor;
        if (scenario.transitions) cursor = scenario.transitions[input.cursor];
        else if (scenario.healthy) cursor = Number(input.cursor) + 1 === 30 ? null : String(Number(input.cursor) + 1);
        else cursor = String(input.cursor === null ? 0 : (Number(input.cursor) + 1) % scenario.period);
        const page = {keys: [`object-${providerCalls}`], cursor};
        if (generation === 'current') assertSourcePaginationPage(page);
        if (providerCalls === stopAt) worker.shutdown();
        return page;
      };
      const process = async () => {processed++; return {records: 1};};
      const activities = {listPage: list, listSessionPage: list, processObject: process, indexSessionObject: process};
      const options = {connection: env.nativeConnection, taskQueue, activities, shutdownGraceTime: '5 seconds'};
      const handle = await env.client.workflow.start(workflowType, {
        taskQueue, workflowId, args: [{sourceId: 'fixture', ...scenario.input}],
      });
      for ([generation, stopAt] of scenario.phases) {
        worker = await Worker.create({...options, workflowBundle: generation === 'current' ? current : legacy});
        if (Number.isFinite(stopAt)) {
          await worker.run();
          assert.equal(providerCalls, stopAt);
          // Check the open history before the next worker resumes it, including
          // new-shaped runs that old workers executed past a cycle boundary.
          const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
          for (const workflowBundle of [current, legacy]) await Worker.runReplayHistory({workflowBundle}, history);
        } else {
          await worker.runUntil(async () => {
            if (scenario.healthy) await handle.result();
            else await assert.rejects(handle.result(), isPaginationFailure);
          });
        }
      }
      assert.ok(providerCalls < 30, `provider did not terminate promptly: ${providerCalls}`);
      assert.equal(processed, providerCalls, 'cycle detection must still process the current page');
      assert.equal(listCalls, providerCalls + (scenario.healthy ? 0 : 1), 'failure uses the next existing list; terminal pages add no commands');
      if (scenario.healthy) assert.equal(providerCalls, 15);
      if (scenario.transitions) assert.equal(providerCalls, 5);
      let runId = handle.firstExecutionRunId, runs = 0;
      while (runId) {
        const history = await env.client.workflow.getHandle(workflowId, runId).fetchHistory();
        for (const workflowBundle of [current, legacy]) await Worker.runReplayHistory({workflowBundle}, history);
        assert.ok(!history.events.some(event => event.workflowTaskFailedEventAttributes), 'guard must not cause workflow-task retries');
        assert.ok(!history.events.some(event => event.markerRecordedEventAttributes), 'no new marker commands');
        const continued = history.events.find(event => event.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
        if (!continued) assert.ok(history.events.some(event => scenario.healthy
          ? event.workflowExecutionCompletedEventAttributes : event.workflowExecutionFailedEventAttributes));
        if (scenario.healthy && runs === 0) {
          const nextInput = JSON.parse(Buffer.from(continued.input.payloads[0].data).toString());
          assert.equal(nextInput.cursor, '20');
          assert.deepEqual(nextInput.paginationProgress, stale, 'legacy worker must actually carry a stale checkpoint across continue-as-new');
        }
        runId = continued?.newExecutionRunId;
        assert.ok(++runs < 10);
      }
      assert.ok(runs >= 2, 'fixture must cross continue-as-new');
    }
    const taskQueue = `${workflowType}-malformed`;
    const rejectPending = async input => {
      try { assertSourcePaginationInput(input); }
      catch (error) { throw ApplicationFailure.nonRetryable(error.message, 'SourcePaginationFailed'); }
      assert.fail('malformed progress must fail before provider fetch');
    };
    const worker = await Worker.create({connection: env.nativeConnection, taskQueue, workflowBundle: current,
      activities: {listPage: rejectPending, listSessionPage: rejectPending}});
    const handle = await env.client.workflow.start(workflowType, {
      taskQueue, workflowId: taskQueue, args: [{cursor: 'B', paginationProgress: {version: 99}}],
    });
    await worker.runUntil(() => assert.rejects(handle.result(), isPaginationFailure));
    const history = await handle.fetchHistory();
    for (const workflowBundle of [current, legacy]) await Worker.runReplayHistory({workflowBundle}, history);
  }
});
