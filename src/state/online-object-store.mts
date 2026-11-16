import {randomUUID} from 'node:crypto';
import type {ObjectStore, ReadOptions, StoreVersion} from '../sessions/types.mjs';
import {ONLINE_MAX_PAYLOAD_BYTES, type createOnlineJournal, type OnlineExternalSnapshot, type OnlineExternalStore, type OnlineMutation} from './online-journal.mjs';
import type {OnlineWriteAuthority} from './online-authority.mjs';

type Journal = Pick<ReturnType<typeof createOnlineJournal>, 'mutate' | 'reconcile'>;
export interface OnlineObjectClassification {maxBytes: number; preservedNative?: true}
/** Known concrete S3 capabilities used by legacy connector consumers. Unknown
 * adapter methods are deliberately not copied: they could bypass journaling. */
export interface LegacyOnlineObjectStore extends ObjectStore {
  read?(key: string, options?: ReadOptions): AsyncIterable<Uint8Array>;
  checkAccess?(): Promise<void>;
  location?: string;
}
export interface OnlineMigrationObjectStore extends LegacyOnlineObjectStore {
  read(key: string, options?: ReadOptions): AsyncIterable<Uint8Array>;
}

function fail(code: string): never {
  throw Object.assign(new Error('Online object store: ' + code), {code: 'ONLINE_OBJECT_STORE_' + code});
}

/** Explicit compatibility adapter. No classifier, epoch or live wiring is
 * inferred here. Raw objects retain their existing representation and methods. */
export function createOnlineMigrationObjectStore({raw, external, journal, classify, sourceId, writeAuthority}: {
  raw: LegacyOnlineObjectStore;
  external: OnlineExternalStore;
  journal?: Journal;
  classify: (key: string) => OnlineObjectClassification | null;
  sourceId: string;
  writeAuthority?: OnlineWriteAuthority;
}): OnlineMigrationObjectStore {
  if (typeof sourceId !== 'string' || !sourceId || Buffer.byteLength(sourceId) > 2048 || sourceId.includes('\0')) fail('INVALID_SOURCE');
  function classification(key: string) {
    const value = classify(key);
    if (value === null) return null;
    if (!value || !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > ONLINE_MAX_PAYLOAD_BYTES) fail('INVALID_CLASSIFICATION');
    if (value.preservedNative !== undefined && value.preservedNative !== true) fail('INVALID_CLASSIFICATION');
    return {maxBytes: value.maxBytes, ...(value.preservedNative ? {preservedNative: true as const} : {})};
  }
  function readable(bound: OnlineObjectClassification) {if (bound.preservedNative) fail('PRESERVED_NATIVE_BODY_DENIED');}
  function mutable(bound: OnlineObjectClassification) {if (bound.preservedNative) fail('PRESERVED_NATIVE_MUTATION_DENIED');}
  function limit(bound: OnlineObjectClassification, options?: ReadOptions) {
    if (options?.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) fail('INVALID_READ_LIMIT');
    readable(bound);
    return Math.min(bound.maxBytes, options?.maxBytes ?? bound.maxBytes);
  }
  async function read(key: string, maxBytes: number): Promise<OnlineExternalSnapshot> {
    const value = await external.read(key, {maxBytes});
    if (typeof value.deleted !== 'boolean' || value.version !== null && (typeof value.version !== 'string' || !value.version)) fail('INVALID_EXTERNAL_READ');
    if (value.deleted) {
      if (value.bytes !== null || value.contentType !== null) fail('INVALID_EXTERNAL_READ');
    } else if (value.version === null || !Buffer.isBuffer(value.bytes) || value.bytes.length > maxBytes || typeof value.contentType !== 'string') fail('INVALID_EXTERNAL_READ');
    return value;
  }
  function payload(bytes: Uint8Array, contentType: string, bound: OnlineObjectClassification): OnlineMutation {
    mutable(bound);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > bound.maxBytes) fail('PAYLOAD_LIMIT');
    if (typeof contentType !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(contentType)) fail('INVALID_CONTENT_TYPE');
    // Copy before reconcile awaits so callers cannot change the journaled value.
    return {kind: 'put', bytes: Buffer.from(bytes), contentType};
  }
  async function mutate(key: string, mutation: OnlineMutation, condition?: {version: string | null}) {
    if (!journal) fail('JOURNAL_NOT_CONFIGURED');
    const reconciled = await journal.reconcile(key, external);
    if (reconciled?.state === 'pending') fail('PENDING_RECONCILIATION');
    const result = await journal.mutate({operationId: randomUUID(), key, mutation, ...(condition ? {condition} : {})}, external);
    if (result.state === 'pending') fail('PENDING_MUTATION');
    if (result.state !== 'applied' && result.state !== 'notApplied') fail('INVALID_MUTATION_RESULT');
    return result.state === 'applied';
  }
  async function route<T>(key: string, callbacks: {legacy(): Promise<T>; journal(): Promise<T>}) {
    if (!writeAuthority) fail('WRITE_AUTHORITY_NOT_CONFIGURED');
    let invoked = false, closed = false, settled = false, operation: Promise<T> | undefined;
    const once = (callback: () => Promise<T>) => () => {
      if (invoked || closed) fail('AUTHORITY_CALLBACK_REUSED');
      invoked = true; operation = (async () => callback())();
      void operation.then(() => {settled = true;}, () => {settled = true;});
      return operation;
    };
    try {
      await writeAuthority.run(Object.freeze({sourceId, key}), {legacy: once(callbacks.legacy), journal: once(callbacks.journal)});
      if (!invoked) fail('AUTHORITY_CALLBACK_NOT_RUN');
      if (!settled) fail('AUTHORITY_CALLBACK_NOT_AWAITED');
      return await operation!;
    } finally {closed = true;}
  }
  function applied(value: boolean) {
    if (!value) throw Object.assign(new Error('Online object store: write was not applied'), {code: 'ONLINE_OBJECT_STORE_NOT_APPLIED', writeOutcome: 'not-applied'});
  }
  function condition(version: StoreVersion | null) {
    if (version === null) return {version: null};
    if (typeof version !== 'string' && (typeof version !== 'number' || !Number.isFinite(version))) fail('INVALID_VERSION');
    const text = String(version);
    if (!text || text === '*' || text.length > 1024 || /[\r\n\0]/.test(text)) fail('INVALID_VERSION');
    return {version: text};
  }
  function rawPurgeKey(key: string) {
    if (classification(key)) fail('MUTABLE_PHYSICAL_PURGE_DENIED');
  }
  return {
    ...(raw.bucket === undefined ? {} : {bucket: raw.bucket}),
    ...(raw.location === undefined ? {} : {location: raw.location}),
    ...(raw.checkAccess ? {checkAccess: () => raw.checkAccess!()} : {}),
    async *read(key, options) {
      const bound = classification(key);
      if (!bound) {
        if (raw.read) yield* raw.read(key, options);
        else {
          const bytes = await raw.get(key, options);
          if (bytes === null) fail('SOURCE_NOT_AVAILABLE');
          yield bytes;
        }
        return;
      }
      const value = await read(key, limit(bound, options));
      if (value.deleted) fail('SOURCE_NOT_AVAILABLE');
      yield value.bytes!;
    },
    async get(key, options) {
      const bound = classification(key);
      if (!bound) return raw.get(key, options);
      const value = await read(key, limit(bound, options));
      return value.deleted ? null : value.bytes;
    },
    async has(key, options) {
      const bound = classification(key);
      if (!bound) return raw.has ? raw.has(key, options) : (await raw.get(key, options)) !== null;
      return !(await read(key, limit(bound, options))).deleted;
    },
    async readVersion(key, options) {
      const bound = classification(key);
      if (!bound) return raw.readVersion(key, options);
      const value = await read(key, limit(bound, options));
      return value.deleted ? {version: null, data: null} : {version: value.version, data: value.bytes};
    },
    async put(key, bytes, contentType) {
      const bound = classification(key);
      if (!bound) return raw.put(key, bytes, contentType);
      const frozen = payload(bytes, contentType ?? 'application/octet-stream', bound);
      if (frozen.kind !== 'put') fail('INVALID_PAYLOAD');
      return route(key, {
        legacy: () => raw.put(key, frozen.bytes, contentType),
        journal: async () => {applied(await mutate(key, frozen));},
      });
    },
    async compareAndSet(key, version, bytes) {
      const bound = classification(key);
      if (!bound) return raw.compareAndSet(key, version, bytes);
      const frozen = payload(bytes, 'application/json', bound), expected = condition(version);
      if (frozen.kind !== 'put') fail('INVALID_PAYLOAD');
      return route(key, {legacy: () => raw.compareAndSet(key, version, frozen.bytes), journal: () => mutate(key, frozen, expected)});
    },
    async delete(key) {
      const bound = classification(key);
      if (!bound) {
        if (!raw.delete) fail('RAW_DELETE_UNSUPPORTED');
        return raw.delete(key);
      }
      mutable(bound);
      return route(key, {
        legacy: async () => {if (!raw.delete) fail('RAW_DELETE_UNSUPPORTED'); await raw.delete(key);},
        journal: async () => {applied(await mutate(key, {kind: 'delete'}));},
      });
    },
    async listPage(prefix, options) {
      if (options?.maxKeys !== undefined && (!Number.isSafeInteger(options.maxKeys) || options.maxKeys < 1 || options.maxKeys > 1000)) fail('INVALID_PAGE_LIMIT');
      const page = await raw.listPage(prefix, options);
      if (!Array.isArray(page.keys) || page.keys.length > (options?.maxKeys ?? 1000) || page.keys.some(key => typeof key !== 'string' || !key.startsWith(prefix))) fail('INVALID_RAW_PAGE');
      const visible = new Array<boolean>(page.keys.length);
      let next = 0;
      let failure: {error: unknown} | undefined;
      // One existing page, at most 1,000 reads and eight in flight. Keep only
      // visibility bits, drain issued reads on failure, never follow a cursor.
      await Promise.all(Array.from({length: Math.min(8, page.keys.length)}, async () => {
        while (!failure && next < page.keys.length) {
          const index = next++, key = page.keys[index];
          try {
            const bound = classification(key);
            visible[index] = !bound || bound.preservedNative === true || !(await read(key, bound.maxBytes)).deleted;
          } catch (error) {failure ??= {error};}
        }
      }));
      if (failure) throw failure.error;
      return {...page, keys: page.keys.filter((_key, index) => visible[index])};
    },
    ...(raw.purgePrefix ? {purgePrefix: async (prefix: string, options: Parameters<NonNullable<ObjectStore['purgePrefix']>>[1] = {}) => {
      return raw.purgePrefix!(prefix, {
        ...options,
        select(key) {
          const selected = options.select?.(key) ?? true;
          if (selected) rawPurgeKey(key);
          return selected;
        },
        ...(options.selectVersion ? {selectVersion: async (key: string, read: () => Promise<Buffer>) => {
          rawPurgeKey(key);
          return options.selectVersion!(key, read);
        }} : {}),
        beforeDelete: async (key: string, read: () => Promise<Buffer>) => {
          rawPurgeKey(key);
          await options.beforeDelete?.(key, read);
        },
      });
    }} : {}),
  };
}
