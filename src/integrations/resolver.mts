import type {Principal} from '../identity/types.mjs';
import type {IntegrationRecord} from './types.mjs';
import type {IntegrationRegistry} from './ports.mjs';
import type {createObjectStore} from '../sessions/s3-store.mjs';
import {createConnectorSearch} from '../connectors/search.mjs';
import {validateBinding} from '../connectors/scope.mjs';
import type {createLinearAccess} from './linear-access.mjs';
export const INDEXED_PROVIDERS = Object.freeze(['slack', 'granola', 'circleback', 'notion', 'github', 'linear'] as const);
export const eligible = (record: IntegrationRecord): record is IntegrationRecord & {provider: typeof INDEXED_PROVIDERS[number]} => record.scope === 'team' && INDEXED_PROVIDERS.some(provider => provider === record.provider);

export function denied(): never {throw Object.assign(new Error('Connector is inactive or outside authorized scope'), {permanent: true, status: 403});}
export interface HostedConnectorReference {tenantId: string; userId: string; connectionId: string; generation?: string}
export interface ConnectorReferenceInput {tenantId?: unknown; userId?: unknown; connectionId?: unknown; generation?: unknown}
export interface ConnectorResolverOptions {
  environment: IntegrationRecord['environment'];
  generation: string;
  registry: IntegrationRegistry;
  /** Host policy authorizes the existing storage binding. Never provisions storage. */
  storage(record: IntegrationRecord): Promise<ReturnType<typeof createObjectStore>>;
  search(tenantId: string): ReturnType<typeof createConnectorSearch>;
  linearAccess?(record: IntegrationRecord): ReturnType<typeof createLinearAccess>;
}
interface ConnectionCount {total: number; kinds: Record<string, number>}
export interface CountSummary extends ConnectionCount {providers: Record<string, ConnectionCount>; connections: Record<string, ConnectionCount>}
/** Resolve just the active registry row and its canonical source binding. */
export function createActiveConnectorBinding({environment, generation, registry}: Pick<ConnectorResolverOptions,'environment'|'generation'> & {registry:Pick<IntegrationRegistry,'get'>}) {
  if (!['staging', 'production', 'selfhost'].includes(environment) || !/^v[1-9][0-9]*$/.test(generation)) throw new Error('Invalid connector configuration');
  function reference(value: ConnectorReferenceInput): asserts value is HostedConnectorReference {
    if (!value || !/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(typeof value.tenantId === 'string' ? value.tenantId : '') || !/^user_[A-Za-z0-9]+$/.test(typeof value.userId === 'string' ? value.userId : '') || !/^int_[a-f0-9]{26}$/.test(typeof value.connectionId === 'string' ? value.connectionId : '') || (value.generation && value.generation !== generation)) denied();
  }
  return async (input: ConnectorReferenceInput) => {
    reference(input);
    const record = await registry.get(input.tenantId, input.userId, input.connectionId);
    if (!record || record.tenantId !== input.tenantId || record.userId !== input.userId || record.integrationId !== input.connectionId || record.environment !== environment || record.status !== 'active' || !eligible(record)) denied();
    const binding = validateBinding({tenantId: record.tenantId, connectionId: record.integrationId, workspaceId: record.workspace as string,
      provider: record.provider, access: record.provider === 'slack' ? 'team-public' : 'workspace-global', rawPrefix: record.s3Prefix + '/'});
    return {record,binding};
  };
}
export function createConnectorResolver({environment, generation, registry, storage, search: searchFor, linearAccess}: ConnectorResolverOptions) {
  const activeBinding=createActiveConnectorBinding({environment,generation,registry});
  async function resolveConnection(input: ConnectorReferenceInput, includeSourceAccess: boolean) {
    const {record,binding}=await activeBinding(input);
    const store = await storage(record);
    const search = searchFor(binding.tenantId);
    const linear = includeSourceAccess && record.provider === 'linear' ? linearAccess?.(record) : undefined;
    return {binding, store, search, ...(linear ? {linear, resourceAccess: (sourceId: string) => linear.inspect(sourceId)} : {})};
  }
  const resolve = (input: ConnectorReferenceInput) => resolveConnection(input, true);
  const resolveIndexed = (input: ConnectorReferenceInput) => resolveConnection(input, false);
  type CoreSearch = ReturnType<typeof createConnectorSearch>['search'];
  type ConnectorQuery = Parameters<CoreSearch>[2];
  type NormalizedResult = Extract<Awaited<ReturnType<CoreSearch>>, {hits: unknown[]}>;
  type RawResult = Extract<Awaited<ReturnType<CoreSearch>>, {responses: unknown[]}>;
  function search(principal: Principal, query: ConnectorQuery & {raw: true}): Promise<RawResult>;
  function search(principal: Principal, query: ConnectorQuery & {raw?: false}): Promise<NormalizedResult>;
  function search(principal: Principal, query: ConnectorQuery): Promise<NormalizedResult | RawResult>;
  async function search(principal: Principal, query: ConnectorQuery): Promise<NormalizedResult | RawResult> {
      if (!principal?.tenantId || !principal?.userId) denied();
      const records = (await registry.listTenant(principal.tenantId)).filter(record => eligible(record) && record.status === 'active' && record.environment === environment);
      if (!records.length) return query.raw ? {responses: [], examined: 0, truncated: false} : {hits: [], examined: 0, truncated: false};
      const resolved = await Promise.all(records.map(record => resolveIndexed({tenantId: principal.tenantId, userId: record.userId, connectionId: record.integrationId, generation})));
      const result = await resolved[0].search.search(principal, resolved.map(r => r.binding), query);
      // A concurrent disconnect must not return results after we observe it.
      for (const record of records) await resolveIndexed({tenantId: principal.tenantId, userId: record.userId, connectionId: record.integrationId, generation});
      return result;
    }
  return {
    resolve,
    /** Indexed inventory across active authorized connections; not a retrievability claim. */
    async count(principal: Principal): Promise<CountSummary> {
      if (!principal?.tenantId || !principal?.userId) denied();
      const records = (await registry.listTenant(principal.tenantId)).filter(record => eligible(record) && record.status === 'active' && record.environment === environment);
      if (!records.length) return {total: 0, kinds: {}, providers: {}, connections: {}};
      const resolved = await Promise.all(records.map(record => resolveIndexed({tenantId: principal.tenantId, userId: record.userId, connectionId: record.integrationId, generation})));
      if (new Set(resolved.map(value => value.binding.connectionId)).size !== resolved.length) denied();
      // Core owns counting and scope checks. Keep connection attribution distinct
      // from provider totals: a card may show one of several same-provider connections.
      const counts: Record<string, ConnectionCount> = {};
      for (let offset = 0; offset < resolved.length; offset += 100) {
        const batch = resolved.slice(offset, offset + 100);
        Object.assign(counts, await batch[0].search.countByConnection(principal, batch.map(value => value.binding)));
      }
      // Match search's revocation rule when a disconnect races the reporting query.
      for (const record of records) await resolveIndexed({tenantId: principal.tenantId, userId: record.userId, connectionId: record.integrationId, generation});
      const result: CountSummary = {total: 0, kinds: {}, providers: {}, connections: {}};
      const add = (target: ConnectionCount, count: ConnectionCount) => {
        target.total += count.total;
        for (const [kind, countForKind] of Object.entries(count.kinds)) target.kinds[kind] = (target.kinds[kind] || 0) + countForKind;
      };
      for (let i = 0; i < resolved.length; i++) {
        const {provider, connectionId} = resolved[i].binding, count = counts[connectionId];
        result.connections[connectionId] = count;
        add(result, count);
        add(result.providers[provider] ||= {total: 0, kinds: {}}, count);
      }
      return result;
    },
    search,
  };
}
