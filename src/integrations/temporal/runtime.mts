import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {Context, heartbeat} from '@temporalio/activity';
import {ApplicationFailure, WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy} from '@temporalio/common';
import {ScheduleAlreadyRunning, ScheduleOverlapPolicy, type Client} from '@temporalio/client';
import type {WorkerConnectionOptions} from '../../connectors/temporal/types.mjs';
import type {IntegrationCommandReference, IntegrationCommands, IntegrationRecoveryInput} from './types.mjs';

interface IntegrationRuntime {
  sourceId: string;
  environment: IntegrationCommandReference['environment'];
  /** Load and authorize the authoritative command. Advance one persisted phase.
   * Return 'done' only after the registry reflects a terminal command. */
  execute(reference: IntegrationCommandReference, signal: AbortSignal): Promise<'more' | 'done'>;
  listPending: IntegrationCommands['listPending'];
  adoptLegacy?(cursor: LegacyCursor | null): Promise<LegacyCursor | null>;
}
export interface LegacyCursor {tenantId: string; integrationId: string}
const validLegacyCursor = (cursor: LegacyCursor) => cursor && /^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(cursor.tenantId) && /^int_[a-f0-9]{26}$/.test(cursor.integrationId);

function referenceOf(input: IntegrationCommandReference): IntegrationCommandReference {
  if (!input || !['selfhost', 'production', 'staging'].includes(input.environment)
    || !/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(input.tenantId)
    || !/^user_[A-Za-z0-9]+$/.test(input.userId) || !/^int_[a-f0-9]{26}$/.test(input.integrationId)
    || typeof input.commandId !== 'string' || !/^[A-Za-z0-9_:-]{1,200}$/.test(input.commandId)) {
    throw ApplicationFailure.nonRetryable('Invalid integration command reference', 'InvalidIntegrationReference');
  }
  const {environment, tenantId, userId, integrationId, commandId} = input;
  return {environment, tenantId, userId, integrationId, commandId};
}

function digest(fields: string[]) {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
function commandId(ref: IntegrationCommandReference) {
  return 'integration-command-v1-' + digest([ref.environment, ref.tenantId, ref.userId, ref.integrationId, ref.commandId]);
}

export async function startIntegrationCommand(client: Client, taskQueue: string, input: IntegrationCommandReference) {
  const ref = referenceOf(input), workflowId = commandId(ref);
  if (!taskQueue) throw new Error('Integration command queue required');
  try {
    await client.workflow.start('executeIntegrationCommandV1', {workflowId, taskQueue, args: [ref],
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY});
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
  return workflowId;
}

export async function ensureIntegrationRecoverySchedule(client: Client, {sourceId, taskQueue}: {sourceId: string; taskQueue: string}) {
  if (!/^[A-Za-z0-9_:-]{1,200}$/.test(sourceId) || !taskQueue) throw new Error('Invalid integration recovery configuration');
  const scheduleId = 'integration-command-outbox-v1-' + digest([sourceId]);
  const action = {type: 'startWorkflow' as const, workflowType: 'recoverIntegrationCommandsV1', taskQueue, args: [{sourceId}]};
  try {
    await client.schedule.create({scheduleId, action, spec: {intervals: [{every: '1 minute'}]},
      policies: {overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 hour'}, state: {triggerImmediately: true}});
  } catch (error) {
    if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    const existing = await client.schedule.getHandle(scheduleId).describe();
    if (existing.action.workflowType !== action.workflowType || existing.action.taskQueue !== taskQueue ||
        !isDeepStrictEqual(existing.action.args, action.args)) throw new Error('Integration recovery schedule scope mismatch');
  }
  return scheduleId;
}

export function integrationCommandActivities(runtime: IntegrationRuntime) {
  const scoped = (input: IntegrationCommandReference) => {
    const ref = referenceOf(input);
    if (ref.environment !== runtime.environment) throw ApplicationFailure.nonRetryable('Integration environment denied', 'InvalidIntegrationReference');
    return ref;
  };
  return {
    async adoptLegacyIntegrationCommands(input: {sourceId: string; cursor?: LegacyCursor}) {
      if (!input || input.sourceId !== runtime.sourceId || input.cursor !== undefined && !validLegacyCursor(input.cursor))
        throw ApplicationFailure.nonRetryable('Invalid integration recovery source', 'InvalidIntegrationSource');
      try {
        const next = await runtime.adoptLegacy?.(input.cursor ?? null);
        if (next == null) return null;
        if (!validLegacyCursor(next) || isDeepStrictEqual(next, input.cursor)) throw new Error('Invalid adoption cursor');
        return {tenantId: next.tenantId, integrationId: next.integrationId};
      } catch {throw ApplicationFailure.retryable('Legacy command adoption failed', 'IntegrationAdoptionUnavailable');}
    },
    async executeIntegrationCommand(input: IntegrationCommandReference) {
      const ref = scoped(input), signal = Context.current().cancellationSignal;
      const pulse = setInterval(heartbeat, 10_000);
      try {
        heartbeat();
        signal.throwIfAborted();
        const progress = await runtime.execute(ref, signal);
        if (progress !== 'done' && progress !== 'more') throw new Error('Invalid integration progress');
        return progress;
      } catch {
        signal.throwIfAborted();
        // Adapter errors may include Airbyte source configurations and provider bodies.
        throw ApplicationFailure.retryable('Integration command requires another attempt', 'IntegrationCommandPending');
      } finally {clearInterval(pulse);}
    },
    async listPendingIntegrationCommands(input: IntegrationRecoveryInput) {
      if (!input || input.sourceId !== runtime.sourceId ||
        (input.cursor != null && (typeof input.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(input.cursor)))) {
        throw ApplicationFailure.nonRetryable('Invalid integration recovery source', 'InvalidIntegrationSource');
      }
      try {
        const page = await runtime.listPending({cursor: input.cursor, limit: 50});
        if (page.commands.length > 50 || (page.cursor !== null &&
          (typeof page.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(page.cursor) || page.cursor === input.cursor))) {
          throw new Error('Invalid integration command page');
        }
        return {commands: page.commands.map(input => {
          const reference = scoped(input);
          return {reference, workflowId: commandId(reference)};
        }), cursor: page.cursor};
      } catch {
        throw ApplicationFailure.retryable('Integration outbox read failed', 'IntegrationOutboxUnavailable');
      }
    },
  };
}

export async function buildIntegrationWorkflows(path: string) {
  const {bundleWorkflowCode} = await import('@temporalio/worker');
  const {code} = await bundleWorkflowCode({workflowsPath: fileURLToPath(new URL('./workflows.cjs', import.meta.url))});
  await writeFile(path, code);
}

export async function createIntegrationWorker({address, namespace, taskQueue, bundlePath, connectionOptions = {}, ...runtime}: WorkerConnectionOptions & IntegrationRuntime) {
  if (!address || !namespace || !taskQueue || !bundlePath || !runtime.sourceId || connectionOptions.address && connectionOptions.address !== address) {
    throw new Error('Invalid integration worker binding');
  }
  const {NativeConnection, Worker} = await import('@temporalio/worker');
  const connection = await NativeConnection.connect({...connectionOptions, address});
  try {
    const worker = await Worker.create({connection, namespace, taskQueue, workflowBundle: {codePath: bundlePath},
      activities: integrationCommandActivities(runtime), maxConcurrentActivityTaskExecutions: 4, maxConcurrentWorkflowTaskExecutions: 4});
    return {worker, connection};
  } catch (error) {await connection.close(); throw error;}
}
