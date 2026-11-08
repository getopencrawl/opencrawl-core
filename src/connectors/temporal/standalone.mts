import type {ConnectorBinding} from '../types.mjs';
import type {ConnectorSegmentInput} from '../workflow.mjs';
import type {RealmOptions} from '../../search/types.mjs';
import type {WorkerConnectionOptions, ConnectorActivityInput} from './types.mjs';
import {guardConnectorWrites} from '../write-barrier.mjs';
import {realmIndex} from '../../search/realm.mjs';
import {readFile} from 'node:fs/promises';
import {createObjectStore, awsCredentials} from '../../sessions/s3-store.mjs';
import {createConnectorSearch} from '../search.mjs';
import {validateBinding} from '../scope.mjs';
import {buildConnectorWorkflows, createConnectorWorker} from './worker.mjs';
import {connectorClient, ensureConnectorSchedule} from './client.mjs';

const [configPath, bundlePath] = process.argv.slice(2);
if (!configPath || !bundlePath) throw new Error('Usage: node dist/src/connectors/temporal/standalone.mjs config.json workflow-bundle.cjs');
const config = JSON.parse(await readFile(configPath, 'utf8')) as {binding: ConnectorBinding; s3: Parameters<typeof createObjectStore>[0]; search: RealmOptions; temporal: WorkerConnectionOptions};
const binding = validateBinding(config.binding);
const store = createObjectStore({...config.s3, credentials: awsCredentials()});
const search = createConnectorSearch({...config.search, tenantId: binding.tenantId, index: config.search.index || realmIndex('selfhost', binding.tenantId)});
await store.checkAccess(); await search.ensureIndex();
await buildConnectorWorkflows(bundlePath);
const resolve = async (reference: ConnectorActivityInput) => {
  if (reference.tenantId !== binding.tenantId || reference.connectionId !== binding.connectionId) throw Object.assign(new Error('Standalone connector scope denied'), {permanent: true});
  return {binding, ...guardConnectorWrites({binding, store, search})};
};
const {worker, connection} = await createConnectorWorker({...config.temporal, bundlePath, resolve});
const scheduling = await connectorClient(config.temporal);
await ensureConnectorSchedule(scheduling.client, {reference: {tenantId: binding.tenantId, connectionId: binding.connectionId}, taskQueue: config.temporal.taskQueue});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => worker.shutdown());
try { await worker.run(); } finally { await scheduling.connection.close(); await connection.close(); }
