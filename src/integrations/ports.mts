import type {Readable} from 'node:stream';
import type {IntegrationRecord, UpdateOptions, Provider, ProxyRequest, ProxyResponse, ProviderData} from './types.mjs';
export type Fetch = typeof globalThis.fetch;
export type Log = (event: string, data: Record<string, unknown>) => void;
/** No organization provisioning or fleet scans in the product registry. */
export interface IntegrationRegistry {
  list(tenantId: string, userId: string): Promise<IntegrationRecord[]>;
  listTenant(tenantId: string): Promise<IntegrationRecord[]>;
  get(tenantId: string, userId: string, integrationId: string): Promise<IntegrationRecord | null>;
  create(record: IntegrationRecord): Promise<IntegrationRecord>;
  update(record: Pick<IntegrationRecord, 'tenantId' | 'userId' | 'integrationId'>, fields: Partial<IntegrationRecord>, options?: UpdateOptions): Promise<IntegrationRecord>;
}
/** The runtime supplies existing storage, scoped to the admitted organization. */
export interface IntegrationStorage {
  get(tenantId: string): Promise<string | null>;
  read(bucket: string, key: string): Promise<Buffer>;
  write(bucket: string, key: string, body: Buffer): Promise<unknown>;
  stream(bucket: string, key: string): Promise<Readable>;
  list(bucket: string, prefix: string): Promise<Array<{key: string; size: number}>>;
  deletePrefix(bucket: string, prefix: string): Promise<number>;
}
/** Provider consent and credential ownership are supplied by the runtime. */
export interface ConnectorOAuth {
  authConfig(input: {toolkit: string; name: string; scheme?: string; credentials?: Record<string, string>}): Promise<string>;
  link(input: {authConfigId: string; userId: string; callbackUrl: string}): Promise<{redirect_url: string; connected_account_id: string; expires_at?: string}>;
  account(id: string): Promise<{id: string; user_id?: string; status: string; is_disabled?: boolean; toolkit?: {slug: string}}>;
  remove(id: string): Promise<void>;
  proxy<T = ProviderData>(input: ProxyRequest & {connectedAccountId: string; userId: string}): Promise<ProxyResponse<T>>;
  sourceConfiguration(record: IntegrationRecord, provider: Provider): Promise<Record<string, unknown>>;
}
export interface LandingDestination {
  validate(record: IntegrationRecord): void;
  prepare(record: IntegrationRecord): Promise<Partial<IntegrationRecord>>;
  settings(record: IntegrationRecord): Promise<{definitionId?: string; configuration: Record<string, unknown>}>;
}
