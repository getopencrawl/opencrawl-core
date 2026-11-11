import type {ObjectStore, Principal} from './types.mjs';
import {createConnectorWriteBarrier} from '../connectors/write-barrier.mjs';
import {digest, sessionScope} from './event-identity.mjs';
import {isSessionHarness} from './types.mjs';

/** Reuse the durable CAS fence. Only hashes and write receipts are retained;
 * the fence is outside raw capture prefixes and never expires or reopens. */
export function sessionWriteBarrier(store: ObjectStore, prefix: string, owner: Principal, harness: string, sessionId: string) {
  sessionScope(owner);
  if (!isSessionHarness(harness) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sessionId)) throw new Error('Invalid session fence identity');
  return createConnectorWriteBarrier({store, namespace: 'sessions', tenantId: digest(owner.tenantId),
    controlPrefix: `${prefix}/${sessionScope(owner)}/controls/write-barriers/`,
    connectionId: digest(JSON.stringify([prefix, owner.userId, harness, sessionId]))});
}

/** Fence individual remote writes, including CAS event ledgers. A rejected
 * read cannot strand a writer; an ambiguous remote write must remain pending. */
export function sessionWriteStore(store: ObjectStore, prefix: string, owner: Principal, harness: string, sessionId: string): ObjectStore {
  const barrier = sessionWriteBarrier(store, prefix, owner, harness, sessionId);
  return {...store,
    put: (key, bytes, type) => barrier.run('object-put', () => store.put(key, bytes, type), {target: digest(key)}),
    compareAndSet: (key, version, bytes) => barrier.run('object-put', () => store.compareAndSet(key, version, bytes), {target: digest(key)}),
  };
}
