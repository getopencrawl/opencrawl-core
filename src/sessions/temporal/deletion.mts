import type {SessionLibraryOptions} from '../library.mjs';
import type {ObjectStore} from '../types.mjs';
import {createSessionLibrary} from '../library.mjs';
import {createSessionDeletionRequests} from '../deletion-requests.mjs';
import {Context, heartbeat} from '@temporalio/activity';
import {ApplicationFailure} from '@temporalio/common';

export interface SessionDeletionInput {sourceId: string; key: string}
export interface SessionDeletionRecoveryInput {sourceId: string; cursor?: string | null}
export interface SessionDeletionBinding extends SessionLibraryOptions {tenantId?: string; userId?: string}
export type SessionDeletionResolver = (input: {sourceId: string}) => Promise<SessionDeletionBinding>;

/** Resolve an operator-bound source and then read the authoritative intent.
 * Job arguments cannot select a tenant, owner, store, search index or credentials. */
export function sessionDeletionActivities(resolve: SessionDeletionResolver) {
  async function run<T>(input: {sourceId: string}, action: (binding: SessionDeletionBinding) => Promise<T>): Promise<T> {
    const check = () => {if (Context.current().cancellationSignal.aborted) throw Object.assign(new Error('Session deletion activity cancelled'), {writeOutcome: 'not-applied'});};
    const pulse = setInterval(() => heartbeat(), 10000);
    try {
      heartbeat(); check();
      const binding = await resolve({sourceId: input.sourceId});
      // A timed-out attempt must stop at its next storage boundary. Remote work
      // already sent remains safe to repeat under the permanent write fence.
      const raw = binding.store;
      const store: ObjectStore = {...raw,
        readVersion: async (...args) => {check(); return raw.readVersion(...args);},
        get: async (...args) => {check(); return raw.get(...args);},
        put: async (...args) => {check(); return raw.put(...args);},
        compareAndSet: async (...args) => {check(); return raw.compareAndSet(...args);},
        listPage: async (...args) => {check(); return raw.listPage(...args);},
        ...(raw.delete ? {delete: async (key: string) => {check(); await raw.delete!(key);}} : {}),
        ...(raw.purgePrefix ? {purgePrefix: async (prefix: string, options: Parameters<NonNullable<ObjectStore['purgePrefix']>>[1] = {}) => {
          check(); return raw.purgePrefix!(prefix, {...options,
            select: key => {check(); return options.select ? options.select(key) : true;},
            ...(options.selectVersion ? {selectVersion: async (key: string, read: () => Promise<Buffer>) => {check(); return options.selectVersion!(key, async () => {check(); return read();});}} : {}),
            beforeDelete: async (key, read) => {check(); await options.beforeDelete?.(key, async () => {check(); return read();});},
          });
        }} : {}),
      };
      const result = await action({...binding, store}); check(); return result;
    } catch (caught) {
      if (Context.current().cancellationSignal.aborted) throw Context.current().cancellationSignal.reason;
      const error = caught as {permanent?: boolean; type?: string};
      // Never copy transcript fragments or provider response bodies to history.
      // Provider 403/404 responses can be repaired; only an explicit trusted
      // binding/intent scope rejection is permanent.
      if (error.permanent) throw ApplicationFailure.nonRetryable('Session deletion scope denied', 'SessionDeletionScopeDenied');
      throw ApplicationFailure.retryable(error.type === 'SessionDeletionWritesPending' ? 'Waiting for unfinished session writes' : 'Session deletion storage operation failed',
        error.type === 'SessionDeletionWritesPending' ? error.type : 'SessionDeletionStorageFailed');
    } finally {clearInterval(pulse);}
  }
  async function stage(input: SessionDeletionInput, name: 'prepareDeletion' | 'purgeDeletionArchives' | 'finishDeletion') {
    return run(input, async binding => {
      const requests = createSessionDeletionRequests(binding), request = await requests.read(input.key);
      if (!request) return {skipped: true};
      if (binding.tenantId && request.owner.tenantId !== binding.tenantId || binding.userId && request.owner.userId !== binding.userId)
        throw Object.assign(new Error('Session deletion binding mismatch'), {permanent: true});
      await createSessionLibrary(binding)[name](request.owner, request);
      if (name === 'finishDeletion') await requests.remove(input.key);
      return {skipped: false};
    });
  }
  return {
    prepareSessionDeletion: (input: SessionDeletionInput) => stage(input, 'prepareDeletion'),
    purgeSessionDeletionArchives: (input: SessionDeletionInput) => stage(input, 'purgeDeletionArchives'),
    finishSessionDeletion: (input: SessionDeletionInput) => stage(input, 'finishDeletion'),
    listSessionDeletionRequests: (input: SessionDeletionRecoveryInput) => run(input, binding => createSessionDeletionRequests(binding).list(input.cursor)),
  };
}
