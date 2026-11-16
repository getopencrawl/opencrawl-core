import type {Environment, IntegrationRecord} from '../types.mjs';

export type IntegrationCommandOperation = 'provision' | 'disconnect' | 'sync';
export type IntegrationOperation = IntegrationCommandOperation;
export interface IntegrationCommandSecret {apiKey?: string}
export interface IntegrationCommandReference {
  environment: Environment;
  tenantId: string;
  userId: string;
  integrationId: string;
  commandId: string;
}
export interface IntegrationCommand {
  reference: IntegrationCommandReference;
  operation: IntegrationOperation;
  status: 'pending' | 'completed' | 'superseded' | 'failed';
  requestedBy: string;
  failureReason?: IntegrationCommandFailure;
}
export type IntegrationCommandFailure = 'authorization_denied' | 'invalid_command' | 'reconnect_required';
export interface IntegrationCommandPage {
  commands: IntegrationCommandReference[];
  cursor: string | null;
}
/** The adapter binds its own source/environment. Never accept an arbitrary SQL
 * connection, bucket, or tenant selection from workflow payloads. */
export interface IntegrationCommands {
  read(reference: IntegrationCommandReference): Promise<IntegrationCommand | null>;
  readSecret(reference: IntegrationCommandReference): Promise<IntegrationCommandSecret>;
  clearSecret(reference: IntegrationCommandReference): Promise<void>;
  fail(reference: IntegrationCommandReference, reason: IntegrationCommandFailure): Promise<void>;
  complete(reference: IntegrationCommandReference): Promise<void>;
  listPending(input: {cursor?: string | null; limit?: number}): Promise<IntegrationCommandPage>;
}
/** requestLifecycle is implemented by the integration registry in the same
 * transaction as desired-state mutation and encrypted secret handoff. */
export interface IntegrationLifecycleRequest {
  requestLifecycle(record: Pick<IntegrationRecord, 'tenantId' | 'userId' | 'integrationId'>,
    operation: IntegrationOperation, secrets?: IntegrationCommandSecret, requestedBy?: string): Promise<IntegrationCommandReference>;
}
export type IntegrationStep = 'prepare' | 'destination' | 'source' | 'connection' | 'activate'
  | 'close-writers' | 'stop-writers' | 'drain-writers' | 'delete-data' | 'revoke-grants' | 'finalize' | 'sync';
export interface IntegrationStepInput extends IntegrationCommandReference {step: IntegrationStep}
export interface IntegrationStepResult {status: 'done' | 'superseded' | 'restart'}
export interface IntegrationLifecycleRunner {
  step(input: IntegrationStepInput, check?: () => void): Promise<IntegrationStepResult>;
}
export interface IntegrationRecoveryInput {sourceId: string; cursor?: string | null}

export interface IntegrationCleanup {
  /** Persistently closes admission; must not clear uncertain write intents. */
  closeWriters(record: IntegrationRecord): Promise<void>;
  /** Stops native Temporal schedules and external provider writers. */
  stopWriters(record: IntegrationRecord): Promise<void>;
  /** Throws while any possibly applied write lacks positive settlement. */
  drainWriters(record: IntegrationRecord): Promise<void>;
  deleteDocuments(record: IntegrationRecord): Promise<number>;
}
export interface IntegrationLifecycle {
  commands: IntegrationCommands;
  schedule(reference: IntegrationCommandReference): Promise<unknown>;
  cleanup: IntegrationCleanup;
  runProviderWrite<T>(record: IntegrationRecord, operation: string, write: () => Promise<T>): Promise<T>;
}
export interface ResolvedIntegrationLifecycle {
  commands: IntegrationCommands;
  runner: IntegrationLifecycleRunner;
  /** Revalidates current actor membership for provision/sync. Accepted
   * disconnect cleanup continues even if the initiating member was removed. */
  authorize(command: IntegrationCommand): Promise<void>;
}
export interface IntegrationActivityOptions {
  resolve(reference: IntegrationCommandReference): Promise<ResolvedIntegrationLifecycle>;
  resolveRecovery(input: {sourceId: string}): Promise<IntegrationCommands>;
  reconcileSchedules?(input: {sourceId: string}): Promise<void>;
}
export interface IntegrationActivities {
  describeIntegrationCommand(reference: IntegrationCommandReference): Promise<{operation: IntegrationOperation; status: IntegrationCommand['status']}>;
  executeIntegrationStep(input: IntegrationStepInput): Promise<IntegrationStepResult>;
  completeIntegrationCommand(reference: IntegrationCommandReference): Promise<void>;
  listIntegrationCommands(input: IntegrationRecoveryInput): Promise<IntegrationCommandPage>;
  reconcileIntegrationSchedules(input: {sourceId: string}): Promise<void>;
}
