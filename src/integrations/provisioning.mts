import {errorInfo} from '../errors.mjs';
import type {Environment} from './types.mjs';
import type {IntegrationRecord, ProvisionIntent, ResourceName, AirbyteResource} from './types.mjs';
import type {IntegrationRegistry as Registry} from './ports.mjs';
import type {Airbyte} from './airbyte.mjs';
// Managed Airbyte does not accept caller-chosen resource IDs or document create
// idempotency. An intent therefore survives an ambiguous POST until its exact
// scoped resource can be found. Absence from a listing never authorizes another
// POST: the original request may still be running in Airbyte.
import {randomBytes} from 'node:crypto';

const TYPES = {destinationId: 'destinations', sourceId: 'sources', connectionId: 'connections'} as const;
const LIVE = ['provisioning', 'error'];
const CANCELLED = ['disconnecting', 'disconnected'];
const conflict = () => Object.assign(new Error('Connection setup changed; retry to recover it.'), {status: 409, expose: true});
const pending = () => Object.assign(new Error('Connection setup is waiting for an earlier request to finish. Retry later; if it persists, contact support before reconnecting.'), {status: 409, expose: true, code: 'ProvisioningRecoveryPending'});
const version = () => randomBytes(16).toString('hex');

export const provisioningLabel = (record: Pick<IntegrationRecord, 'environment' | 'tenantId' | 'userId' | 'provider' | 'integrationId'>) => `${record.environment} ${record.tenantId} ${record.userId} ${record.provider} ${record.integrationId}`;

export function createProvisioning({environment, registry, airbyte, now = () => Date.now()}: {environment: Environment; registry: Registry; airbyte: Airbyte; now?: () => number}) {
  function validate(record: IntegrationRecord | null, expected: IntegrationRecord) {
    if (!record || record.environment !== environment || !/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(record.tenantId)
      || !/^user_[A-Za-z0-9]+$/.test(record.userId) || !/^int_[a-f0-9]{26}$/.test(record.integrationId)
      || !/^[a-z]+$/.test(record.provider)
      || (['tenantId', 'userId', 'integrationId', 'provider'] as const).some(key => record[key] !== expected[key])) throw conflict();
    return record;
  }
  const fresh = async (record: IntegrationRecord) => validate(await registry.get(record.tenantId, record.userId, record.integrationId), record);
  const update = (record: IntegrationRecord, fields: Partial<IntegrationRecord>, statuses = [...LIVE, ...CANCELLED]) => registry.update(record, {...fields, provisionVersion: version()},
    {whenStatus: statuses, whenFields: {provisionVersion: record.provisionVersion}});

  async function remember(expected: IntegrationRecord, intent: ProvisionIntent, id: unknown) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Airbyte returned an invalid resource ID');
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await fresh(expected);
      if (record.airbyte?.[intent.resource] === id && !record.provisionIntent) return record;
      if (record.provisionIntent?.attemptId !== intent.attemptId) throw conflict();
      try {
        return await update(record, {airbyte: {...record.airbyte, [intent.resource]: id}, airbyteWorkspaceId: intent.workspaceId, provisionIntent: null, resourceVersion: version(),
          ...(CANCELLED.includes(record.status) ? {status: 'disconnecting', dataDeletedAt: null} : {})});
      } catch (error) { if (errorInfo(error).code !== 'ConditionalCheckFailedException') throw error; }
    }
    throw conflict();
  }

  async function reconcile(expected: IntegrationRecord) {
    const record = await fresh(expected), intent = record.provisionIntent;
    if (!intent) return record;
    if (!TYPES[intent.resource] || intent.name !== provisioningLabel(record) || !intent.workspaceId || !intent.attemptId
      || (record.airbyteWorkspaceId && record.airbyteWorkspaceId !== intent.workspaceId)) throw conflict();
    // The adapter returns a complete bounded workspace listing or throws. It
    // rejects malformed/partial pages and never searches another workspace.
    const resources = await airbyte[TYPES[intent.resource]](intent.workspaceId);
    const matches = resources.filter(item => item.name === intent.name);
    if (!matches.length) throw pending();
    if (matches.length !== 1) throw Object.assign(new Error('We couldn’t safely recover this connection. Contact support.'), {status: 409, expose: true, code: 'ProvisioningRecoveryPending'});
    const match = matches[0];
    if (match.workspaceId !== intent.workspaceId || (intent.resource === 'connectionId'
      && (match.sourceId !== intent.sourceId || match.destinationId !== intent.destinationId
        || record.airbyte?.sourceId !== intent.sourceId || record.airbyte?.destinationId !== intent.destinationId))) throw conflict();
    return remember(record, intent, match[intent.resource]);
  }

  async function ensure(expected: IntegrationRecord, resource: ResourceName, workspaceId: string, create: () => Promise<AirbyteResource>) {
    let record = await fresh(expected);
    if (!LIVE.includes(record.status) || record.provisionRun !== expected.provisionRun) throw conflict();
    if (record.provisionIntent) record = await reconcile(record);
    if (record.provisionRun !== expected.provisionRun) throw conflict();
    if (record.airbyte?.[resource]) return record;
    if (record.status !== 'provisioning' || !TYPES[resource] || !workspaceId
      || (record.airbyteWorkspaceId && record.airbyteWorkspaceId !== workspaceId)) throw conflict();
    const intent = {resource, workspaceId, name: provisioningLabel(record), attemptId: version(), requestedAt: new Date(now()).toISOString(),
      ...(resource === 'connectionId' ? {sourceId: record.airbyte?.sourceId, destinationId: record.airbyte?.destinationId} : {})};
    if (resource === 'connectionId' && (!intent.sourceId || !intent.destinationId)) throw conflict();
    // CAS is the cross-process claim. A losing caller may reconcile, never POST.
    record = await update(record, {provisionIntent: intent, airbyteWorkspaceId: workspaceId}, ['provisioning']);
    // Upgrades cannot know whether an older process issued an unjournaled POST.
    // Adopt its exact resource if present; never recreate an ambiguous legacy step.
    if (record.provisionProtocol !== 1) return reconcile(record);
    let result;
    try { result = await create(); }
    catch (error) {
      // Keep only protocol outcome metadata, never a provider body/configuration.
      // Even a failed response is not documented as proof of no side effects.
      const failed = await fresh(record);
      if (failed.provisionIntent?.attemptId === intent.attemptId) {
        await update(failed, {provisionIntent: {...intent, responseStatus: Number.isInteger(errorInfo(error).status) ? errorInfo(error).status! : null}})
          .catch(failure => { if (errorInfo(failure).code !== 'ConditionalCheckFailedException') throw failure; });
      }
      throw error;
    }
    return remember(record, intent, result?.[resource]);
  }

  return {ensure, reconcile};
}
