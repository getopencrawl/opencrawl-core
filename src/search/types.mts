import type {Principal, TenantPrincipal, CredentialProvider, JsonValue} from '../sessions/types.mjs';
import type {SearchFilters, SearchOrder} from './controls.mjs';

export type Corpus = 'connector' | 'session' | 'board' | 'memory';
export interface SearchDocument {
  [field: string]: unknown;
  tenantId: string; id?: string | number; text?: string; title?: string; sourceKey?: string;
  timestamp?: string | number | null; receivedAt?: string; extractedAt?: number;
  author?: string; authorId?: string; userId?: string; provider?: string; harness?: string; kind?: string;
  installationId?: string; sessionId?: string; eventId?: string; role?: string | null;
  sequence?: number; chunk?: number; url?: string; host?: string | null;
  path?: string; project?: string; snapshotId?: string; generation?: number; modifiedAt?: string;
  projectionId?: string; passageVersion?: number; chunkCount?: number;
  sourceSessionId?: string | null; connectionId?: string; workspaceId?: string; sourceId?: string;
  parentId?: string | null; parentKind?: string; channelId?: string; heading?: string;
  boardId?: string;
}
export type NamedWritePolicy = 'session' | 'connector' | 'memory-head' | 'session-projection' | 'session-tokens';
export type WritePolicy = NamedWritePolicy | {name: 'memory-projection-rollback'; expectedProjectionId: string};
export interface DocumentItem<T extends SearchDocument = SearchDocument> {id: string; document: T; script?: string; policy?: WritePolicy}
export interface IndexHit<T extends SearchDocument = SearchDocument> {
  _id: string; _source: T; _score: number; found?: boolean; sort?: JsonValue[];
}
export interface Aggregation {
  [name: string]: unknown;
  value?: number; value_as_string?: string; doc_count?: number;
  doc_count_error_upper_bound?: number; sum_other_doc_count?: number;
  buckets?: Array<{key: string; key_as_string?: string; doc_count: number; doc_count_error_upper_bound?: number}>;
}
/** Existing hit envelope retained for internal consumers and raw diagnostics.
 * Scores and analyzed matching are backend-specific. */
export interface IndexResponse<T extends SearchDocument = SearchDocument> {
  timed_out: boolean; _shards: {failed: number};
  hits: {hits: IndexHit<T>[]; total: {relation: string; value: number}};
  aggregations?: Record<string, Aggregation>;
  docs: IndexHit<T>[];
  errors?: boolean;
  items: Array<{index?: {status: number}; update?: {status: number}; delete?: {status: number}}>;
  error?: {type?: string};
}
/** Compatibility name for existing consumers. */
export type OpenSearchResponse<T extends SearchDocument = SearchDocument> = IndexResponse<T>;
export interface QueryBody {[name: string]: unknown; query?: unknown; _source?: string[] | boolean}
export interface SearchCollection {
  field(field: string): string;
  encode(id: string, document: SearchDocument): SearchDocument;
  id(id: string): string;
  search(principal: TenantPrincipal, body: QueryBody, options?: {createIfMissing?: boolean}): Promise<IndexResponse>;
  mget(principal: TenantPrincipal, ids: string[]): Promise<IndexResponse>;
  bulk(principal: TenantPrincipal, items: DocumentItem[], options?: {refresh?: boolean}): Promise<Pick<IndexResponse, 'items'>>;
  delete(principal: TenantPrincipal, ids: string[]): Promise<Pick<IndexResponse, 'items'>>;
  byQuery(principal: TenantPrincipal, operation: 'update' | 'delete', query: unknown, mutation?: unknown): Promise<{changed: number}>;
  update(principal: TenantPrincipal, id: string, update: {patch?: Record<string, unknown>; script?: unknown; upsert: SearchDocument}): Promise<IndexResponse>;
}
/** Core-owned index boundary. Operator configuration chooses an implementation;
 * untrusted requests cannot choose a backend, realm, SQL or raw engine query. */
export interface SearchRealm {
  backend: 'opensearch' | 'sqlite';
  index: string; tenantId: string; identity: string;
  scope(principal: TenantPrincipal): void;
  ensureIndex(): Promise<void>;
  refresh(principal: TenantPrincipal): Promise<IndexResponse>;
  collection(corpus: Corpus): SearchCollection;
}
export interface RealmOptions {
  endpoint: string; index?: string; tenantId?: string; environment?: string; generation?: string;
  username?: string; password?: string; credentials?: CredentialProvider; region?: string;
  replicas?: number; fetch?: typeof globalThis.fetch;
}
export interface IndexTransportOptions extends RealmOptions {index: string; allowIndexPattern?: boolean}
export interface Mapping {
  [option: string]: unknown;
  type?: string; dynamic?: string; properties?: Record<string, Mapping>; fields?: Record<string, Mapping>;
  _meta?: {schema?: number; tenantId?: string};
}
export interface SearchInput {query?: string; limit?: number; raw?: boolean; match?: string; sessionId?: string; id?: string; filters?: SearchFilters; order?: SearchOrder}
export interface Passage extends SearchDocument {id: string; score?: number}
export interface SearchResult {hits: Passage[]; total?: number; truncated?: boolean}
export interface SearchAdapter {search(principal: Principal, input: SearchInput & {raw?: false}): Promise<SearchResult>}
