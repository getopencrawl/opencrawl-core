import type {WorkerConnectionOptions} from '../../connectors/temporal/types.mjs';
import type {IntegrationActivityOptions} from './types.mjs';
import {Worker, NativeConnection, bundleWorkflowCode} from '@temporalio/worker';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {integrationActivities} from './activities.mjs';

export async function buildIntegrationWorkflows(path: string): Promise<void> {
  const {code} = await bundleWorkflowCode({workflowsPath: fileURLToPath(new URL('./workflows.cjs', import.meta.url))});
  await writeFile(path, code);
}
export async function createIntegrationWorker({address, namespace, taskQueue, bundlePath, resolve, resolveRecovery, reconcileSchedules, connectionOptions = {}, maxConcurrentActivityTaskExecutions = 4}: WorkerConnectionOptions & IntegrationActivityOptions & {maxConcurrentActivityTaskExecutions?: number}) {
  if (!address || !namespace || !taskQueue || !bundlePath) throw new Error('Explicit integration worker configuration required');
  if (connectionOptions.address !== undefined && connectionOptions.address !== address) throw new Error('Invalid integration worker connection options');
  const connection = await NativeConnection.connect({...connectionOptions, address});
  try {
    const worker = await Worker.create({connection, namespace, taskQueue, workflowBundle: {codePath: bundlePath},
      activities: integrationActivities({resolve, resolveRecovery, reconcileSchedules}), maxConcurrentActivityTaskExecutions,
      maxConcurrentWorkflowTaskExecutions: 4, shutdownGraceTime: '30 seconds'});
    return {worker, connection};
  } catch (error) {await connection.close(); throw error;}
}
