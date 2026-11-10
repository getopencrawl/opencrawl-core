import type {Principal, ObjectStore} from './types.mjs';
import {parseJson, isSessionHarness} from './types.mjs';
import {digest,sessionScope} from './event-identity.mjs';

/** Owner-controlled state for one captured session or memory file. Stored beside
 * the owner's capture objects, so it carries the same tenant/user scope. */
export interface ResourceControl {schemaVersion: 1; visibility: 'team' | 'private'; deletedAt: string | null; updatedAt: string}
export type ControlKind = 'sessions' | 'memories';
const MAX_CONTROL_BYTES = 4096;
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status, permanent: status !== 503});}

export function controlKey(prefix: string, owner: Principal, kind: ControlKind, harness: string, name: string) {
  if (!isSessionHarness(harness) || typeof name !== 'string' || !name || name.length > 2048) fail(400, 'Invalid control identity');
  return `${prefix}/${sessionScope(owner)}/controls/${kind}/${harness}/${digest(name)}.json`;
}
function decode(bytes: Uint8Array | null): ResourceControl | null {
  if (!bytes) return null;
  const value = parseJson<ResourceControl>(bytes);
  if (value?.schemaVersion !== 1 || !['team', 'private'].includes(value.visibility) || (value.deletedAt !== null && !Number.isFinite(Date.parse(value.deletedAt)))) fail(503, 'Invalid resource control');
  return value;
}

export function createControls({store, prefix}: {store: ObjectStore; prefix: string}) {
  async function read(owner: Principal, kind: ControlKind, harness: string, name: string) {
    if (typeof store.readVersion !== 'function') fail(503, 'Owner controls require conditional object storage');
    return decode((await store.readVersion(controlKey(prefix, owner, kind, harness, name), {maxBytes: MAX_CONTROL_BYTES})).data);
  }
  /** Compare-and-set so concurrent visibility and delete requests never lose a tombstone. */
  async function update(owner: Principal, kind: ControlKind, harness: string, name: string, change: (current: ResourceControl | null) => Omit<ResourceControl, 'schemaVersion' | 'updatedAt'>) {
    const key = controlKey(prefix, owner, kind, harness, name);
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await store.readVersion(key, {maxBytes: MAX_CONTROL_BYTES});
      const next: ResourceControl = {schemaVersion: 1, ...change(decode(current.data)), updatedAt: new Date().toISOString()};
      if (await store.compareAndSet(key, current.data ? current.version : null, Buffer.from(JSON.stringify(next)))) return next;
    }
    fail(503, 'Resource control busy; retry');
  }
  /** Every control of one kind and harness for an owner, keyed by name digest. */
  async function list(owner: Principal, kind: ControlKind, harness: string) {
    const root = controlKey(prefix, owner, kind, harness, 'x').replace(/[a-f0-9]{64}\.json$/, '');
    const found = new Map<string, ResourceControl>(), seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await store.listPage(root, {continuationToken: cursor, maxKeys: 1000});
      for (const key of page.keys) {
        const name = /^([a-f0-9]{64})\.json$/.exec(key.slice(root.length))?.[1];
        if (!key.startsWith(root) || !name) continue;
        const control = decode((await store.readVersion(key, {maxBytes: MAX_CONTROL_BYTES})).data);
        if (control) found.set(name, control);
        if (found.size > 10000) fail(413, 'Too many resource controls');
      }
      cursor = page.nextToken;
      if (cursor) {if (seen.has(cursor)) fail(503, 'Control inventory cursor did not advance'); seen.add(cursor);}
    } while (cursor);
    return found;
  }
  return {read, update, list};
}

/** Private resources stay readable by their owner only. Documents indexed before
 * visibility existed have no private field and remain team-visible. */
export function visibleTo(corpus: 'session' | 'memory', principal: Principal) {
  return {bool: {must_not: [{bool: {filter: [{term: {[corpus + '.private']: true}}], must_not: [{term: {[corpus + '.userId']: principal.userId}}]}}]}};
}
