import type {Principal, ObjectStore} from './types.mjs';
import {parseJson, isSessionHarness} from './types.mjs';
import {digest,sessionScope} from './event-identity.mjs';

/** Owner-controlled state for one captured session or memory file. Stored beside
 * the owner's capture objects, so it carries the same tenant/user scope. */
export interface ResourceControl {schemaVersion: 1; visibilitySource?: 'manual' | 'automatic'; visibility: 'team' | 'private'; deletedAt: string | null; updatedAt: string; deletion?: {sessionId: string; state: 'pending' | 'complete'}}
export type ControlKind = 'sessions' | 'memories';
export const MAX_CONTROL_BYTES = 4096;
export type SourceControlIdentity={tenantHash:string;userHash:string;harness:string;sessionHash:string};
export type ControlChange=(current:ResourceControl|null)=>Omit<ResourceControl,'schemaVersion'|'updatedAt'>;
export interface ResourceControls {
  read(owner:Principal,kind:ControlKind,harness:string,name:string):Promise<ResourceControl|null>;
  readSource(source:SourceControlIdentity):Promise<ResourceControl|null>;
  update(owner:Principal,kind:ControlKind,harness:string,name:string,change:ControlChange):Promise<ResourceControl>;
  list(owner:Principal,kind:ControlKind,harness:string):Promise<Map<string,ResourceControl>>;
  pendingDeletions(owner:Principal):Promise<Array<{harness:string;sessionId:string}>>;
}
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status, permanent: status !== 503});}

export function controlKey(prefix: string, owner: Principal, kind: ControlKind, harness: string, name: string) {
  if (!['sessions','memories'].includes(kind) || !isSessionHarness(harness) || typeof name !== 'string' || !name || name.length > 2048) fail(400, 'Invalid control identity');
  return `${prefix}/${sessionScope(owner)}/controls/${kind}/${harness}/${digest(name)}.json`;
}
export function decodeControl(bytes: Uint8Array | null): ResourceControl | null {
  if (!bytes) return null;
  const value = parseJson<ResourceControl>(bytes);
  if (value?.schemaVersion !== 1 || !['team', 'private'].includes(value.visibility) || (value.deletedAt !== null && !Number.isFinite(Date.parse(value.deletedAt)))) fail(503, 'Invalid resource control');
  if(value.deletion&&(!value.deletedAt||typeof value.deletion.sessionId!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(value.deletion.sessionId)||!['pending','complete'].includes(value.deletion.state)))fail(503,'Invalid deletion control');
  return value;
}

export async function* storedHarnesses(store:ObjectStore,root: string) {
  const seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await store.listPage(root, {delimiter: '/', continuationToken: cursor, maxKeys: 1000});
    for (const path of [...(page.prefixes ?? []), ...page.keys]) {
      if (!path.startsWith(root)) throw new Error('Harness inventory outside owner scope');
      const tail = path.slice(root.length), slash = tail.indexOf('/');
      if (slash < 0) continue;
      const harness = tail.slice(0, slash);
      if (isSessionHarness(harness) && !seen.has(harness)) {
        seen.add(harness);
        yield harness;
      }
    }
    cursor = page.nextToken;
    if (cursor && cursors.has(cursor)) throw new Error('Harness inventory cursor did not advance');
    if (cursor) cursors.add(cursor);
  } while (cursor);
}

export function createControls({store, prefix}: {store: ObjectStore; prefix: string}): ResourceControls {
  /** Used only after a worker validates the queued source key's scope. */
  async function readSource(source:{tenantHash:string;userHash:string;harness:string;sessionHash:string}){
    if(!isSessionHarness(source.harness)||![source.tenantHash,source.userHash,source.sessionHash].every(value=>/^[a-f0-9]{64}$/.test(value)))fail(400,'Invalid source control identity');
    return decodeControl((await store.readVersion(`${prefix}/tenants/${source.tenantHash}/users/${source.userHash}/controls/sessions/${source.harness}/${source.sessionHash}.json`,{maxBytes:MAX_CONTROL_BYTES})).data);
  }
  async function read(owner: Principal, kind: ControlKind, harness: string, name: string) {
    if (typeof store.readVersion !== 'function') fail(503, 'Owner controls require conditional object storage');
    return decodeControl((await store.readVersion(controlKey(prefix, owner, kind, harness, name), {maxBytes: MAX_CONTROL_BYTES})).data);
  }
  /** Compare-and-set so concurrent visibility and delete requests never lose a tombstone. */
  async function update(owner: Principal, kind: ControlKind, harness: string, name: string, change: (current: ResourceControl | null) => Omit<ResourceControl, 'schemaVersion' | 'updatedAt'>) {
    const key = controlKey(prefix, owner, kind, harness, name);
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await store.readVersion(key, {maxBytes: MAX_CONTROL_BYTES});
      const next: ResourceControl = {...decodeControl(current.data), schemaVersion: 1, ...change(decodeControl(current.data)), updatedAt: new Date().toISOString()};
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
        const control = decodeControl((await store.readVersion(key, {maxBytes: MAX_CONTROL_BYTES})).data);
        if (control) found.set(name, control);
        if (found.size > 10000) fail(413, 'Too many resource controls');
      }
      cursor = page.nextToken;
      if (cursor) {if (seen.has(cursor)) fail(503, 'Control inventory cursor did not advance'); seen.add(cursor);}
    } while (cursor);
    return found;
  }
  async function pendingDeletions(owner:Principal) {
    const pending:Array<{harness:string;sessionId:string}>=[];
    for await(const harness of storedHarnesses(store,prefix+'/'+sessionScope(owner)+'/controls/sessions/')) {
      for(const control of (await list(owner,'sessions',harness)).values()) {
        if(control.deletedAt && control.deletion?.state==='pending')pending.push({harness,sessionId:control.deletion.sessionId});
      }
    }
    return pending;
  }
  return {read,readSource,update,list,pendingDeletions};
}

/** Private resources stay readable by their owner only. Documents indexed before
 * visibility existed have no private field and remain team-visible. */
export function visibleTo(corpus: 'session' | 'memory', principal: Principal) {
  return {bool: {must_not: [{bool: {filter: [{term: {[corpus + '.private']: true}}], must_not: [{term: {[corpus + '.userId']: principal.userId}}]}}]}};
}
