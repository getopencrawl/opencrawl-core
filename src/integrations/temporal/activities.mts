import type {IntegrationActivities, IntegrationActivityOptions, IntegrationCommand, IntegrationCommandFailure, IntegrationCommandReference, ResolvedIntegrationLifecycle} from './types.mjs';
import {Context, heartbeat} from '@temporalio/activity';
import {ApplicationFailure} from '@temporalio/common';
import {integrationSteps, validateIntegrationCommand} from './contracts.mjs';

const sameReference = (a: IntegrationCommandReference, b: IntegrationCommandReference) =>
  (['environment', 'tenantId', 'userId', 'integrationId', 'commandId'] as const).every(key => a[key] === b[key]);

export function integrationActivities(options: IntegrationActivityOptions): IntegrationActivities {
  async function operation<T>(reference: IntegrationCommandReference,
    execute: (binding: ResolvedIntegrationLifecycle, command: IntegrationCommand, check: () => void) => Promise<T>): Promise<T> {
    const check = () => Context.current().cancellationSignal.throwIfAborted();
    const pulse = setInterval(() => heartbeat(), 10000);
    let binding: ResolvedIntegrationLifecycle | undefined;
    const terminal = async (reason: IntegrationCommandFailure) => {
      if (!binding) return;
      try {await binding.commands.fail(reference, reason); await binding.commands.clearSecret(reference);}
      catch {throw ApplicationFailure.retryable('Integration command finalization storage operation failed', 'IntegrationCommandStorageFailed');}
    };
    try {
      heartbeat(); check(); validateIntegrationCommand(reference);
      binding = await options.resolve(reference);
      const command = await binding.commands.read(reference);
      if (!command || !sameReference(command.reference, reference) || !integrationSteps[command.operation]) {
        throw Object.assign(new Error('Invalid integration command'), {permanent: true});
      }
      if (command.status === 'pending' && command.operation !== 'disconnect') {
        try {await binding.authorize(command);}
        catch (error) {
          if ((error as {status?: number})?.status !== 403) throw error;
          await terminal('authorization_denied');
          throw ApplicationFailure.nonRetryable('Integration command authorization was revoked', 'IntegrationAuthorizationDenied');
        }
      }
      check();
      return await execute(binding, command, check);
    } catch (caught) {
      if (Context.current().cancellationSignal.aborted) throw Context.current().cancellationSignal.reason;
      if (caught instanceof ApplicationFailure) throw caught;
      const error = caught as {permanent?: boolean; code?: string};
      if (['ProvisioningKeyRequired','ConsentRetryRequired'].includes(error.code || '')) {
        await terminal('reconnect_required');
        throw ApplicationFailure.nonRetryable(error.code==='ConsentRetryRequired'?'Restart provider sign-in to continue setup':'Reconnect with the provider credential to finish setup', 'IntegrationReconnectRequired');
      }
      if (error.permanent) {
        await terminal('invalid_command');
        throw ApplicationFailure.nonRetryable('Integration command scope or state is invalid', 'InvalidIntegrationCommand');
      }
      // Provider/storage errors may include credentials or response bodies. Only
      // fixed error types enter history; unresolved external effects keep retrying.
      throw ApplicationFailure.retryable(error.code === 'CONNECTOR_WRITE_PENDING'
        ? 'Waiting for positive connector write settlement'
        : ['ProvisioningRecoveryPending','ConsentRecoveryPending'].includes(error.code || '')
          ? 'Waiting to reconcile an earlier external resource request'
          : 'Integration lifecycle activity failed; retrying safely',
      error.code === 'CONNECTOR_WRITE_PENDING' ? 'IntegrationWritesPending' : ['ProvisioningRecoveryPending','ConsentRecoveryPending'].includes(error.code || '') ? 'IntegrationProvisioningPending' : 'IntegrationActivityFailed');
    } finally {clearInterval(pulse);}
  }
  return {
    async reconcileIntegrationSchedules(input) {
      const pulse = setInterval(() => heartbeat(), 10000);
      try {
        heartbeat(); Context.current().cancellationSignal.throwIfAborted();
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.sourceId) || !options.reconcileSchedules) throw ApplicationFailure.nonRetryable('Invalid integration scheduling source', 'InvalidIntegrationRecovery');
        await options.reconcileSchedules(input);
      } catch (error) {
        if (Context.current().cancellationSignal.aborted) throw Context.current().cancellationSignal.reason;
        if (error instanceof ApplicationFailure) throw error;
        throw ApplicationFailure.retryable('Integration schedule reconciliation failed', 'IntegrationSchedulingFailed');
      } finally {clearInterval(pulse);}
    },
    describeIntegrationCommand: reference => operation(reference, async (_binding, command) => ({operation: command.operation, status: command.status})),
    executeIntegrationStep: input => operation(input, async (binding, command, check) => {
      if (command.status !== 'pending') return {status: 'superseded'};
      if (!integrationSteps[command.operation].includes(input.step)) throw Object.assign(new Error('Invalid command step'), {permanent: true});
      return binding.runner.step(input, check);
    }),
    completeIntegrationCommand: reference => operation(reference, async (binding, command, check) => {
      if (command.status !== 'pending') return;
      if(command.operation!=='consent'){check();await binding.commands.clearSecret(reference);}
      check(); await binding.commands.complete(reference);
    }),
    async listIntegrationCommands(input) {
      const pulse = setInterval(() => heartbeat(), 10000);
      try {
        heartbeat(); Context.current().cancellationSignal.throwIfAborted();
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.sourceId)) throw ApplicationFailure.nonRetryable('Invalid integration recovery source', 'InvalidIntegrationRecovery');
        const commands = await options.resolveRecovery({sourceId: input.sourceId});
        const page = await commands.listPending({cursor: input.cursor, limit: 100});
        if (!Array.isArray(page.commands) || page.commands.length > 100 || (page.cursor !== null && typeof page.cursor !== 'string')) throw new Error('Invalid command page');
        for (const reference of page.commands) validateIntegrationCommand(reference);
        return page;
      } catch (caught) {
        if (Context.current().cancellationSignal.aborted) throw Context.current().cancellationSignal.reason;
        if (caught instanceof ApplicationFailure) throw caught;
        throw ApplicationFailure.retryable('Integration recovery storage operation failed', 'IntegrationRecoveryFailed');
      } finally {clearInterval(pulse);}
    },
  };
}
