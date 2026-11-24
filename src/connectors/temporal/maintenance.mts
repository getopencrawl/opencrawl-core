import {digest} from '../scope.mjs';
import type {IntegrationRecord} from '../../integrations/types.mjs';
import type {IntegrationRegistry} from '../../integrations/ports.mjs';
import {INDEXED_PROVIDERS, eligible, denied} from '../../integrations/resolver.mjs';
import {CONNECTOR_PURGE_SETTLE_MS} from '../../integrations/purge.mjs';

export type ConnectorState = 'active' | 'disconnected';
export interface RegistryPosition {tenantId: string; integrationId: string}
export interface DiscoveryInput {sourceId: string; status: ConnectorState; cursor?: RegistryPosition}
export interface ConnectorJob {
  sourceId: string;
  tenantId: string;
  userId: string;
  connectionId: string;
  disconnectedAt?: string;
}
interface MaintenanceOptions {
  sourceId: string;
  environment: IntegrationRecord['environment'];
  generation: string;
  registry: Pick<IntegrationRegistry, 'get' | 'update'>;
  listPage(status: ConnectorState, cursor?: RegistryPosition): Promise<{records: IntegrationRecord[]; cursor: RegistryPosition | null}>;
  ensureActive(record: IntegrationRecord): Promise<void>;
  purge(record: IntegrationRecord): Promise<void>;
  now?: () => number;
}

export function connectorMaintenanceJob(sourceId: string, generation: string, record: IntegrationRecord) {
  const job: ConnectorJob = {sourceId, tenantId: record.tenantId, userId: record.userId, connectionId: record.integrationId};
  if (record.status === 'disconnected') job.disconnectedAt = record.disconnectedAt;
  return {job, id: digest([sourceId, generation, job.tenantId, job.userId, job.connectionId, job.disconnectedAt || 'active'])};
}

export function connectorMaintenance({sourceId, environment, generation, registry, listPage, ensureActive, purge, now = Date.now}: MaintenanceOptions) {
  if (!sourceId || !/^v[1-9]\d*$/.test(generation)) throw new Error('Invalid connector maintenance binding');
  function current(record: IntegrationRecord, status: ConnectorState) {
    return record.environment === environment && record.status === status && INDEXED_PROVIDERS.some(p => p === record.provider)
      && /^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(record.tenantId)
      && /^user_[A-Za-z0-9]+$/.test(record.userId) && /^int_[a-f0-9]{26}$/.test(record.integrationId);
  }
  function completed(record: IntegrationRecord) {
    return record.searchPurge?.generation === generation && record.searchPurge.disconnectedAt === record.disconnectedAt;
  }
  async function resolve(job: ConnectorJob, status: ConnectorState) {
    if (job.sourceId !== sourceId) return denied();
    const record = await registry.get(job.tenantId, job.userId, job.connectionId);
    if (!record) return null;
    if (record.tenantId !== job.tenantId || record.userId !== job.userId || record.integrationId !== job.connectionId || record.environment !== environment) return denied();
    return current(record, status) ? record : null;
  }
  return {
    async listConnectorMaintenance(input: DiscoveryInput) {
      if (input.sourceId !== sourceId || !['active', 'disconnected'].includes(input.status)) return denied();
      const page = await listPage(input.status, input.cursor);
      let failed = 0;
      const jobs: Array<{job: ConnectorJob; id: string}> = [];
      for (const record of page.records) {
        if (!current(record,input.status)) continue;
        if (input.status === 'active') {
          if (!eligible(record)) continue;
          try { await ensureActive(record); } catch { failed++; }
          continue;
        }
        const at = Date.parse(record.disconnectedAt || '');
        if (!Number.isFinite(at) || at > now() || completed(record)) continue;
        jobs.push(connectorMaintenanceJob(sourceId,generation,record));
      }
      return {jobs, failed, cursor: page.cursor};
    },
    async ensureActiveConnector(job: ConnectorJob) {
      const record = await resolve(job,'active');
      if (record && eligible(record)) await ensureActive(record);
    },
    async purgeDisconnectedConnector(job: ConnectorJob): Promise<number | null> {
      const record = await resolve(job,'disconnected');
      if (!record || completed(record) || !job.disconnectedAt || record.disconnectedAt !== job.disconnectedAt) return null;
      const at = Date.parse(job.disconnectedAt);
      const started = now();
      if (!Number.isFinite(at) || at > started) return denied();
      await purge(record);
      // A pass started before the deadline may have missed a final write, even
      // if deletion took long enough to finish after the deadline.
      if (started < at + CONNECTOR_PURGE_SETTLE_MS) return at + CONNECTOR_PURGE_SETTLE_MS;
      await registry.update(record, {searchPurge: {generation, disconnectedAt: job.disconnectedAt}}, {
        whenStatus: ['disconnected'], whenFields: {disconnectedAt: job.disconnectedAt},
      });
      return null;
    },
  };
}
export type ConnectorMaintenance = ReturnType<typeof connectorMaintenance>;
