import type {ObjectStore, Principal} from './types.mjs';
import {isSessionHarness, parseJson} from './types.mjs';
import {digest, sessionScope} from './event-identity.mjs';

/** An authorized deletion intent, never transcript or attachment content. The
 * protected object namespace bridges storage revocation and Temporal submission. */
export interface SessionDeletionRequest {
  schemaVersion: 1;
  owner: Pick<Principal, 'tenantId' | 'userId'>;
  harness: string;
  sessionId: string;
}
export function createSessionDeletionRequests({store, prefix}: {store: ObjectStore; prefix: string}) {
  const root = `${prefix}/_deletions/v1/`;
  function identity(request: SessionDeletionRequest) {
    if (request?.schemaVersion !== 1 || !request.owner || Object.keys(request.owner).some(k => !['tenantId', 'userId'].includes(k)) ||
      !isSessionHarness(request.harness) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(request.sessionId || '')) throw new Error('Invalid session deletion request');
    sessionScope(request.owner);
    return root + digest(JSON.stringify([prefix, request.owner.tenantId, request.owner.userId, request.harness, request.sessionId])) + '.json';
  }
  function checkKey(key: string) {
    if (typeof key !== 'string' || !key.startsWith(root) || !/^[a-f0-9]{64}\.json$/.test(key.slice(root.length))) throw Object.assign(new Error('Session deletion scope denied'), {permanent: true});
  }
  async function read(key: string) {
    checkKey(key);
    const {data} = await store.readVersion(key, {maxBytes: 4096});
    if (!data) return null;
    const request = parseJson<SessionDeletionRequest>(data);
    if (identity(request) !== key) throw Object.assign(new Error('Session deletion identity mismatch'), {permanent: true});
    return request;
  }
  return {
    read,
    readFor(owner: Pick<Principal, 'tenantId' | 'userId'>, session: {harness: string; sessionId: string}) {
      return read(identity({schemaVersion: 1, owner: {tenantId: owner.tenantId, userId: owner.userId}, harness: session.harness, sessionId: session.sessionId}));
    },
    /** Caller must have authorized ownership before recording the intent. */
    async put(owner: Principal, session: {harness: string; sessionId: string}) {
      if (owner.captureAccess !== undefined) throw Object.assign(new Error('Deletion requires owner access'), {status: 403});
      const request: SessionDeletionRequest = {schemaVersion: 1, owner: {tenantId: owner.tenantId, userId: owner.userId}, harness: session.harness, sessionId: session.sessionId};
      const key = identity(request), bytes = Buffer.from(JSON.stringify(request));
      if (!await store.compareAndSet(key, null, bytes)) {
        const existing = await read(key);
        if (!existing || identity(existing) !== key) throw new Error('Session deletion intent did not persist');
      }
      return key;
    },
    async list(cursor?: string | null) {
      const page = await store.listPage(root, {continuationToken: cursor, maxKeys: 50});
      for (const key of page.keys) checkKey(key);
      if (page.nextToken && page.nextToken === cursor) throw new Error('Session deletion cursor did not advance');
      return {keys: page.keys, cursor: page.nextToken};
    },
    /** Completion lives in the permanent owner tombstone. Remove only the intent. */
    async remove(key: string) {
      checkKey(key);
      if (!store.delete) throw new Error('Session deletion intent cleanup unavailable');
      await store.delete(key);
    },
  };
}
