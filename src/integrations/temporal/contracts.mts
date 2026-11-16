import type {IntegrationCommandReference, IntegrationOperation, IntegrationStep} from './types.mjs';

export function validateIntegrationCommand(reference: IntegrationCommandReference): void {
  if (!reference || !['production', 'staging', 'selfhost'].includes(reference.environment)
    || !/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(reference.tenantId)
    || !/^user_[A-Za-z0-9]+$/.test(reference.userId)
    || !/^int_[a-f0-9]{26}$/.test(reference.integrationId)
    || !/^[A-Za-z0-9_-]{16,100}$/.test(reference.commandId)) {
    throw Object.assign(new Error('Invalid integration command reference'), {permanent: true});
  }
}
export function integrationWorkflowId(reference: IntegrationCommandReference): string {
  validateIntegrationCommand(reference);
  return `integration-lifecycle-v1-${reference.environment}-${reference.commandId}`;
}
export const integrationSteps: Record<IntegrationOperation, readonly IntegrationStep[]> = {
  consent: ['consent-config','consent-link','consent-expire'],
  provision: ['prepare', 'destination', 'source', 'connection', 'activate'],
  disconnect: ['close-writers', 'stop-writers', 'drain-writers', 'delete-data', 'revoke-grants', 'finalize'],
  sync: ['sync'],
};
