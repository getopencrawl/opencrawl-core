import type {IntegrationRecord} from './types.mjs';
import type {Log} from './ports.mjs';
import {digest} from '../connectors/scope.mjs';
import {errorInfo} from '../errors.mjs';
const TENANT = /^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/;
const CONNECTION = /^int_[a-f0-9]{26}$/;

/** Compatibility operation for external runtimes. Supported application cleanup
 * is owned by the integration Temporal workflow. A clock, cancellation, or a
 * process-local cache never establishes that a remote writer has settled. */
export function createConnectionPurger({environment, generation, deleteSchedule, deleteDocuments, closeWriters, drainWriters, log = () => {}}: {
  environment: string; generation: string;
  deleteSchedule(id: string): Promise<unknown>;
  deleteDocuments(record: IntegrationRecord): Promise<number>;
  closeWriters?: (record: IntegrationRecord) => Promise<void>;
  drainWriters?: (record: IntegrationRecord) => Promise<void>;
  now?: () => number;
  log?: Log;
}) {
  return async (records: IntegrationRecord[]) => {
    let count = 0;
    for (const record of records) {
      if (record.status !== 'disconnected' || record.environment !== environment
        || !TENANT.test(record.tenantId || '') || !CONNECTION.test(record.integrationId || '')) continue;
      if (!closeWriters || !drainWriters) throw Object.assign(new Error('Positive connector write-drain hooks are required for purge'), {code: 'CONNECTOR_WRITE_PENDING'});
      await closeWriters(record);
      const ids = ['connector-' + digest([record.tenantId, record.integrationId, generation])];
      if (record.provider === 'slack') ids.push(...['slack-files-', 'slack-messages-'].map(prefix => prefix + digest([record.tenantId, record.integrationId])));
      for (const id of ids) {
        try {await deleteSchedule(id);}
        catch (error) {if (errorInfo(error).name !== 'ScheduleNotFoundError') throw error;}
      }
      await drainWriters(record);
      const deleted = await deleteDocuments(record);
      log('connector.purge.completed', {connectionId: record.integrationId, generation, deleted}); count++;
    }
    return count;
  };
}
