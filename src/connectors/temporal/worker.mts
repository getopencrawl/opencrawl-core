import type {ConnectorActivityOptions, ConnectorWorkerOptions, ConnectorActivityInput} from './types.mjs';
import type {ConnectorSegmentInput, SourcePage} from '../workflow.mjs';
import {errorMetadata} from '../types.mjs';
import {Worker, NativeConnection, bundleWorkflowCode} from '@temporalio/worker';
import {Context, heartbeat} from '@temporalio/activity';
import {ApplicationFailure} from '@temporalio/common';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createConnectorPipeline} from '../pipeline.mjs';
import {SourcePaginationError, assertSourcePaginationInput, assertSourcePaginationPage} from '../workflow.mjs';

export async function buildConnectorWorkflows(path: string) {
  const {code} = await bundleWorkflowCode({workflowsPath: fileURLToPath(new URL('./workflows.cjs', import.meta.url))});
  await writeFile(path, code);
}

/** resolve(input) must reauthorize the opaque tenant/connection references from
 * a server-owned registry and return {binding, store, search}. Never use a bucket,
 * rawPrefix or search endpoint supplied in a workflow payload as authority.
 */
export function connectorActivities({resolve}: ConnectorActivityOptions) {
  const indexes = new Map<string, Promise<unknown>>();
  async function operation(input: ConnectorActivityInput & {key?: string}, action: 'listPage' | 'processObject') {
    const pulse = setInterval(() => heartbeat(), 10000);
    try {
      if (action === 'listPage') assertSourcePaginationInput(input);
      heartbeat();
      const resolved = await resolve(input);
      const identity = resolved.search.identity;
      if (!indexes.has(identity)) indexes.set(identity, resolved.search.ensureIndex().catch(error => {indexes.delete(identity); throw error;}));
      await indexes.get(identity);
      const pipeline = createConnectorPipeline({...resolved, heartbeat, checkActive: async () => {
        // Re-resolve before writes and receipts, so revocation takes effect during retries.
        const current = await resolve(input);
        if (JSON.stringify(current.binding) !== JSON.stringify(resolved.binding) || current.search.identity !== identity || current.store.bucket !== resolved.store.bucket) {
          throw Object.assign(new Error('Connector binding changed during indexing'), {permanent: true});
        }
        if (Context.current().cancellationSignal.aborted) throw new Error('Indexing cancelled');
      }});
      const result = action === 'listPage' ? await pipeline.listPage(input) : await pipeline.processObject(input as {key: string});
      if (action === 'listPage') assertSourcePaginationPage(result);
      return result;
    } catch (error) {
      if (error instanceof SourcePaginationError) throw ApplicationFailure.nonRetryable(error.message, 'SourcePaginationFailed');
      if (errorMetadata(error).permanent) throw ApplicationFailure.nonRetryable(errorMetadata(error).message || 'Invalid connector input', 'InvalidConnectorInput');
      throw error;
    } finally { clearInterval(pulse); }
  }
  return {listPage: (input: ConnectorActivityInput) => operation(input, 'listPage') as Promise<SourcePage>, processObject: (input: ConnectorActivityInput & {key: string}) => operation(input, 'processObject') as Promise<{status: string; records: number}>};
}

/** Operator-supplied SDK connectionOptions support TLS/auth; callers own key rotation. */
export async function createConnectorWorker({address, namespace, taskQueue, bundlePath, resolve, maxConcurrentActivityTaskExecutions = 2, connectionOptions = {}}: ConnectorWorkerOptions) {
  if (!address || !namespace || !taskQueue || !bundlePath) throw new Error('Explicit Temporal worker configuration required');
  if (!connectionOptions || typeof connectionOptions !== 'object' || Array.isArray(connectionOptions) ||
      connectionOptions.address !== undefined && connectionOptions.address !== address) throw new Error('Invalid Temporal connection options');
  const connection = await NativeConnection.connect({...connectionOptions, address});
  try {
    const worker = await Worker.create({connection, namespace, taskQueue,
      workflowBundle: {codePath: bundlePath}, activities: connectorActivities({resolve}),
      maxConcurrentActivityTaskExecutions, maxConcurrentWorkflowTaskExecutions: 4, shutdownGraceTime: '30 seconds'});
    return {worker, connection};
  } catch (error) { await connection.close(); throw error; }
}
