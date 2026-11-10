import type {IntegrationRecord} from './types.mjs';
import type {Log} from './ports.mjs';
import {digest} from '../connectors/scope.mjs';
import {errorInfo} from '../errors.mjs';
const TENANT=/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/;
const CONNECTION=/^int_[a-f0-9]{26}$/;
// Activities can finish writes for ten minutes after disconnect. Repeat after settling.
const SETTLE_MS=11*60_000;
export function createConnectionPurger({environment,generation,deleteSchedule,deleteDocuments,now=Date.now,log=()=>{}}:{
  environment:string;generation:string;deleteSchedule(id:string):Promise<unknown>;
  deleteDocuments(record:IntegrationRecord):Promise<number>;now?:()=>number;log?:Log;
}){
  // integrationId -> time of the last purge by this process. A restart purges again; purging is idempotent.
  const purged = new Map<string, number>();

  async function purge(record: IntegrationRecord) {
    const ids = ['connector-' + digest([record.tenantId, record.integrationId, generation])];
    if (record.provider === 'slack') ids.push(...['slack-files-', 'slack-messages-'].map(prefix => prefix + digest([record.tenantId, record.integrationId])));
    for (const id of ids) {
      try { await deleteSchedule(id); }
      catch (error) { if (errorInfo(error).name !== 'ScheduleNotFoundError') throw error; }
    }
    const deleted = await deleteDocuments(record);
    purged.set(record.integrationId, now());
    log('connector.purge.completed', {connectionId: record.integrationId, generation, deleted});
  }

  return async(records:IntegrationRecord[])=>{let count=0;
      for (const record of records) {
        if (record.status !== 'disconnected' || record.environment !== environment || !TENANT.test(record.tenantId || '') || !CONNECTION.test(record.integrationId || '')) continue;
        const at = Date.parse(record.disconnectedAt || '');
        if (!Number.isFinite(at) || at > now()) continue;
        const last = purged.get(record.integrationId);
        if (last !== undefined && (last >= at + SETTLE_MS || now() < at + SETTLE_MS)) continue;
        await purge(record); count++;
      }
    return count;
  };
}
