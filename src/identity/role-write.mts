import {randomUUID} from 'node:crypto';
import type {ConditionalStore} from '../sessions/types.mjs';

export type RoleWriteStore = ConditionalStore;
export type TeamRole = 'admin' | 'member';
const fail = (status: number, message: string): never => {throw Object.assign(new Error(message), {status, expose:true});};
const unavailable = () => fail(503, 'Team changes need a workspace operator check before continuing.');
const encode = (value: object) => Buffer.from(JSON.stringify(value));
function record(data: Buffer | null): Record<string, unknown> | null {
  if (!data) return null;
  try {
    const value: unknown = JSON.parse(data.toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* A damaged guard must never be treated as an unlocked organization. */ }
  return unavailable();
}

/** No lease expiry: WorkOS has no fencing token, so an uncertain write stays blocked. */
export function roleWriteGuard(store: RoleWriteStore, prefix: string) {
  return async (organizationId: string, actorId: string, userId: string, role: TeamRole | 'remove') => {
    if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) fail(400, 'Choose a valid workspace.');
    const key = `${prefix}/organization-role-writes/${organizationId}.json`;
    const previous = await store.readVersion(key, {maxBytes:4096});
    const saved = record(previous.data);
    if (saved && (saved.schemaVersion !== 1 || saved.state !== 'idle'))
      fail(409, 'Another team change is in progress or awaiting verification. If this continues, contact your workspace operator.');
    const operationId = randomUUID();
    const held = {schemaVersion:1, state:'held', operationId, organizationId, actorId, userId, role, startedAt:new Date().toISOString()};
    if (!await store.compareAndSet(key, previous.version, encode(held)))
      fail(409, 'Another team change is in progress. Please try again after it finishes.');
    return {
      async release() {
        const current = await store.readVersion(key, {maxBytes:4096});
        const owner = record(current.data);
        if (owner?.state !== 'held' || owner.operationId !== operationId) return unavailable();
        if (!await store.compareAndSet(key, current.version, encode({schemaVersion:1, state:'idle', operationId, completedAt:new Date().toISOString()}))) return unavailable();
      },
    };
  };
}

export type RoleWriteGuard = ReturnType<typeof roleWriteGuard>;
