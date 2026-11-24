import {countBinding, type CountScope} from '../state/connector-counts.mjs';
import type {Environment, IntegrationRecord} from './types.mjs';

export function connectorCountScope(environment: Environment, tenantId: string, userId: string, integrationId: string,
  {bucket, rawPrefix, provider}: {bucket: string; rawPrefix: string; provider: string}): CountScope {
  return {environment, tenantId, userId, integrationId, binding: countBinding(bucket, rawPrefix, provider)};
}

export interface IntegrationCountAdmission {
  accepts?(record: IntegrationRecord): boolean;
  request(scope: CountScope, succeeded: readonly number[], observedAt: number, active: boolean): Promise<{counts: Record<string, number> | null; dispatch: boolean}>;
  schedule(reference: {tenantId: string; userId: string; connectionId: string}): Promise<unknown>;
  erase(scope: CountScope): Promise<boolean>;
}
