import type {ConnectorBinding, ConnectorPrincipal, ConnectorStore, ConditionalStore, ConnectorSearch} from './types.mjs';
import type {ApplicationState,WriteBarrierScope} from '../state/types.mjs';
import {authorize,digest,validateBinding} from './scope.mjs';

/** Durable admission and uncertain write receipts belong to PostgreSQL. */
export function createConnectorWriteBarrier({state,...scope}:WriteBarrierScope&{state:ApplicationState}){
  if(!state?.writeBarrier)throw new Error('Authoritative application state is required');
  return state.writeBarrier(scope);
}

/** Wrap data-bearing writes once at the trusted adapter boundary. The original
 * conditional store remains private to the fence, so control writes do not
 * recursively register themselves. Reads retain their ordinary scope checks. */
interface GuardOptions<S extends ConditionalStore> {state:ApplicationState;binding: ConnectorBinding; store: S; namespace?: string}
export function guardConnectorWrites<S extends ConditionalStore, T extends ConnectorSearch>(options: GuardOptions<S> & {search: T}): {state:ApplicationState;store: S; search: T; writeBarrier: ReturnType<typeof createConnectorWriteBarrier>};
export function guardConnectorWrites<S extends ConditionalStore>(options: GuardOptions<S> & {search?: undefined}): {state:ApplicationState;store: S; writeBarrier: ReturnType<typeof createConnectorWriteBarrier>};
export function guardConnectorWrites<S extends ConditionalStore>({binding, state, store, search, namespace = 'selfhost'}: GuardOptions<S> & {search?: ConnectorSearch}) {
  binding = {...validateBinding(binding)};
  const barrier = createConnectorWriteBarrier({tenantId: binding.tenantId, connectionId: binding.connectionId, state, namespace});
  function objectScope(key: string) {
    if (typeof key !== 'string' || key.length > 2048 || key.split('/').some(part => part === '.' || part === '..') || !key.startsWith(binding.rawPrefix)) {
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
  return {state,store: guardedStore, ...(search ? {search: guardedSearch} : {}), writeBarrier: barrier};
}
