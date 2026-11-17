import type {ConnectorBinding, ConnectorPrincipal, ConnectorStore, ConditionalStore, ConnectorSearch, DocumentItem, SuppressionIdentity} from './types.mjs';
import {errorMetadata} from './types.mjs';
interface Writer {id: string; operation: 'object-put' | 'search-write'; phase: 'writing' | 'settled'; startedAt: number; settledAt?: number; instance: string; target: string}
interface BarrierState {version: number; namespace: string; tenantId: string; connectionId: string; closedAt: number | null; writers: Writer[]}
import {randomUUID} from 'node:crypto';
import {authorize, digest, pipelineVersion, validateBinding} from './scope.mjs';

const PREFIX = 'control/connectors/write-barriers/v1/';
const MAX_WRITERS = 128;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
export const connectorWriterInstance = randomUUID();
const unavailable = (message: string) => Object.assign(new Error(message), {status: 503, code: 'CONNECTOR_WRITE_PENDING'});
const denied = () => Object.assign(new Error('Connector writes are closed'), {status: 403, permanent: true});

/** A durable, non-expiring fence for one connection incarnation. Its conditional
 * store must provide linearizable readVersion/compareAndSet, including create.
 * Keep this control document outside every raw/derived data deletion prefix.
 * A transport failure never proves a started remote write stopped. */
export function createConnectorWriteBarrier({tenantId, connectionId, store, namespace = 'selfhost', now = Date.now, controlPrefix = PREFIX}: {tenantId: string; connectionId: string; store: ConditionalStore; namespace?: string; now?: () => number; controlPrefix?: string}) {
  if (![namespace, tenantId, connectionId].every(value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,200}$/.test(value)) ||
      typeof store?.readVersion !== 'function' || typeof store?.compareAndSet !== 'function') throw new Error('Explicit connector scope and conditional store required');
  const timestamp = () => {const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw unavailable('Invalid connector write clock'); return value;};
  if (!controlPrefix.endsWith('/') || controlPrefix.slice(0, -1).split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid write barrier control prefix');
  const key = controlPrefix + digest([namespace, tenantId, connectionId]) + '.json';
  const initial = (): BarrierState => ({version: 1, namespace, tenantId, connectionId, closedAt: null, writers: []});
  async function read() {
    const item = await store.readVersion(key, {maxBytes: MAX_STATE_BYTES});
    const state: BarrierState = item.data === null ? initial() : JSON.parse(item.data.toString()) as BarrierState;
    if (state?.version !== 1 || state.namespace !== namespace || state.tenantId !== tenantId || state.connectionId !== connectionId ||
        !(state.closedAt === null || Number.isSafeInteger(state.closedAt) && state.closedAt >= 0) ||
        !Array.isArray(state.writers) || state.writers.length > MAX_WRITERS ||
        new Set(state.writers.map(writer => writer?.id)).size !== state.writers.length || state.writers.some(writer =>
          !writer || typeof writer.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(writer.id) ||
          !['object-put', 'search-write'].includes(writer.operation) || !['writing', 'settled'].includes(writer.phase) ||
          !Number.isSafeInteger(writer.startedAt) || writer.startedAt < 0 ||
          typeof writer.instance !== 'string' || writer.instance.length > 100 ||
          typeof writer.target !== 'string' || writer.target.length > 8192 ||
          writer.phase === 'settled' && (!Number.isSafeInteger(writer.settledAt) || writer.settledAt! < 0))) {
      throw unavailable('Invalid connector write barrier scope or state');
    }
    return {...item, state};
  }
  async function change(update: (state: BarrierState) => unknown | Promise<unknown>) {
    // Retry ambiguous conditional-write responses with the same operation ID.
    // Read-back distinguishes an applied mutation from a failed response.
    let transportFailures = 0;
    for (let attempt = 0; attempt < 64; attempt++) {
      try {
        const {version, state} = await read();
        const before = JSON.stringify(state);
        await update(state);
        const bytes = Buffer.from(JSON.stringify(state));
        if (bytes.length > MAX_STATE_BYTES) throw unavailable('Connector write barrier metadata limit reached');
        if (bytes.toString() === before || await store.compareAndSet(key, version, bytes)) return state;
      } catch (error) {
        if (errorMetadata(error).permanent || errorMetadata(error).code === 'CONNECTOR_WRITE_PENDING' || ++transportFailures >= 3) throw error;
      }
    }
    throw unavailable('Connector write barrier contention; retry');
  }
  const reap = (state: BarrierState) => {state.writers = state.writers.filter(writer => writer.phase !== 'settled');};
  const snapshot = (state: BarrierState) => ({closed: state.closedAt !== null, closedAt: state.closedAt,
    pending: state.writers.filter(writer => writer.phase === 'writing').length,
    writers: state.writers.map(writer => ({...writer}))});
  return {
    key,
    scope: Object.freeze({namespace, tenantId, connectionId}),
    async inspect() {return snapshot((await read()).state);},
    /** Irreversible for this connection ID. Repeated calls recover durable
     * settled acknowledgments; uncertain writes never expire automatically. */
    async close() {
      return snapshot(await change(state => {reap(state); state.closedAt ??= timestamp();}));
    },
    async run<T>(operation: 'object-put' | 'search-write', write: () => T | Promise<T>, {target = 'unspecified'} = {}) {
      if (!['object-put', 'search-write'].includes(operation) || typeof write !== 'function' || typeof target !== 'string' || target.length > 8192) throw new Error('Invalid connector write operation');
      const id = randomUUID();
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid connector writer ID');
      try {
        await change(state => {
          // A lost acquire response may have registered us before close. The
          // closer sees this intent and cannot acknowledge deletion yet.
          if (state.writers.some(writer => writer.id === id)) return;
          reap(state);
          if (state.closedAt !== null) throw denied();
          if (state.writers.length >= MAX_WRITERS) throw unavailable('Connector has too many unresolved writes');
          state.writers.push({id, operation, target, instance: connectorWriterInstance, phase: 'writing', startedAt: timestamp()});
        });
      } catch (error) {
        // No data write has begun, so removing our own uncertain acquisition is
        // safe. A failed removal stays pending and is never mistaken for drain.
        await change(state => {state.writers = state.writers.filter(writer => writer.id !== id);}).catch(() => {});
        throw error;
      }
      let value!: T, rejected: unknown;
      try {value = await write();}
      catch (cause) {
        // Only a trusted adapter's positive no-mutation result can settle a
        // rejection. Status codes, permanent errors and cancellation alone do not.
        if (errorMetadata(cause).writeOutcome !== 'not-applied') throw Object.assign(unavailable('Connector write outcome is uncertain; deletion must wait for reconciliation'), {cause, writeId: id});
        rejected = cause;
      }
      try {
        // Persist positive settlement before cleanup. A restarted closer can
        // release this record even if the original process dies before removal.
        await change(state => {
          const writer = state.writers.find(writer => writer.id === id);
          if (writer && writer.phase !== 'settled') Object.assign(writer, {phase: 'settled', settledAt: timestamp()});
        });
        await change(reap);
      } catch (cause) {
        throw Object.assign(unavailable('Connector write finished but its acknowledgment needs retry'), {cause, writeId: id});
      }
      if (rejected) throw rejected;
      return value;
    },
  };
}

/** Wrap data-bearing writes once at the trusted adapter boundary. The original
 * conditional store remains private to the fence, so control writes do not
 * recursively register themselves. Reads retain their ordinary scope checks. */
interface GuardOptions<S extends ConditionalStore> {binding: ConnectorBinding; store: S; namespace?: string}
export function guardConnectorWrites<S extends ConditionalStore, T extends ConnectorSearch>(options: GuardOptions<S> & {search: T}): {store: S; search: T; writeBarrier: ReturnType<typeof createConnectorWriteBarrier>};
export function guardConnectorWrites<S extends ConditionalStore>(options: GuardOptions<S> & {search?: undefined}): {store: S; writeBarrier: ReturnType<typeof createConnectorWriteBarrier>};
export function guardConnectorWrites<S extends ConditionalStore>({binding, store, search, namespace = 'selfhost'}: GuardOptions<S> & {search?: ConnectorSearch}) {
  binding = {...validateBinding(binding)};
  const barrier = createConnectorWriteBarrier({tenantId: binding.tenantId, connectionId: binding.connectionId, store, namespace});
  const receiptPrefix = search?.identity && `derived/indexing/${pipelineVersion(binding)}/${digest([binding.tenantId, binding.connectionId, search.identity])}/`;
  function objectScope(key: string) {
    if (typeof key !== 'string' || key.length > 2048 || key.split('/').some(part => part === '.' || part === '..') || !(key.startsWith(binding.rawPrefix) || receiptPrefix && key.startsWith(receiptPrefix))) {
      throw Object.assign(new Error('Connector write outside its connection scope'), {status: 403, permanent: true});
    }
  }
  const guardedStore = {...store,
    put: (...args: Parameters<ConnectorStore['put']>) => {
      objectScope(args[0]);
      return barrier.run('object-put', () => store.put(...args), {target: args[0]});
    },
    compareAndSet: (...args: Parameters<ConditionalStore['compareAndSet']>) => {
      objectScope(args[0]);
      return barrier.run('object-put', () => store.compareAndSet(...args), {target: args[0]});
    },
  };
  function searchScope(principal: ConnectorPrincipal, candidate: ConnectorBinding) {
    if (principal?.captureAccess !== undefined) throw Object.assign(new Error('Connector write capability denied'), {status: 403, permanent: true});
    authorize(principal, candidate);
    if ((['tenantId', 'connectionId', 'workspaceId', 'provider', 'access', 'rawPrefix'] as const).some(field => candidate[field] !== binding[field])) {
      throw Object.assign(new Error('Connector search write outside its connection scope'), {status: 403, permanent: true});
    }
  }
  const guardedSearch = search && {...search};
  if (search && guardedSearch && typeof search.putDocuments === 'function') {
    guardedSearch.putDocuments = (principal, candidate, documents) => {
      searchScope(principal, candidate);
      const scopedPrincipal = {...principal}, scopedBinding = {...candidate};
      const target = JSON.stringify({operation: 'putDocuments', count: documents.length, idsSha256: digest(documents.map(item => item.id))});
      return barrier.run('search-write', () => search.putDocuments(scopedPrincipal, scopedBinding, documents), {target});
    };
  }
  if (search && guardedSearch && typeof search.suppress === 'function') {
    guardedSearch.suppress = (principal, candidate, identity) => {
      searchScope(principal, candidate);
      const scopedPrincipal = {...principal}, scopedBinding = {...candidate};
      const target = JSON.stringify({operation: 'suppress', identitySha256: digest(identity)});
      return barrier.run('search-write', () => search.suppress!(scopedPrincipal, scopedBinding, identity), {target});
    };
  }
  return {store: guardedStore, ...(search ? {search: guardedSearch} : {}), writeBarrier: barrier};
}
