import type {Principal, CredentialProvider, JsonValue} from '../sessions/types.mjs';

export type Corpus = 'connector' | 'session' | 'board' | 'memory';
export interface SearchDocument {
  [field: string]: unknown;
  tenantId: string; id?: string | number; text?: string; title?: string; sourceKey?: string;
  timestamp?: string | number | null; receivedAt?: string; extractedAt?: number;
  author?: string; authorId?: string; userId?: string; provider?: string; harness?: string; kind?: string;
  installationId?: string; sessionId?: string; eventId?: string; role?: string | null;
  sequence?: number; chunk?: number; url?: string; host?: string | null;
  path?: string; project?: string; snapshotId?: string; generation?: number; modifiedAt?: string;
  sourceSessionId?: string | null; connectionId?: string; workspaceId?: string; sourceId?: string;
  parentId?: string | null; parentKind?: string; channelId?: string; heading?: string;
  boardId?: string;
}
export interface DocumentItem<T extends SearchDocument = SearchDocument> {id: string; document: T; script?: string}
export interface IndexHit<T extends SearchDocument = SearchDocument> {
  _id: string; _source: T; _score: number; found?: boolean; sort?: JsonValue[];
}
export interface Aggregation {
  [name: string]: unknown;
  value?: number; value_as_string?: string; doc_count?: number;
  doc_count_error_upper_bound?: number; sum_other_doc_count?: number;
  buckets?: Array<{key: string; key_as_string?: string; doc_count: number; doc_count_error_upper_bound?: number}>;
}
export interface OpenSearchResponse<T extends SearchDocument = SearchDocument> {
  timed_out: boolean; _shards: {failed: number};
  hits: {hits: IndexHit<T>[]; total: {relation: string; value: number}};
  aggregations?: Record<string, Aggregation>;
  docs: IndexHit<T>[];
  errors?: boolean;
  items: Array<{index?: {status: number}; update?: {status: number}; delete?: {status: number}}>;
  error?: {type?: string};
}
export interface QueryBody {[name: string]: unknown; query?: unknown; _source?: string[] | boolean}
export interface RealmOptions {
  endpoint: string; index?: string; tenantId?: string; environment?: string; generation?: string;
  username?: string; password?: string; credentials?: CredentialProvider; region?: string;
  replicas?: number; fetch?: typeof globalThis.fetch;
  /** Optional semantic retrieval: an OpenSearch ML Commons sparse-encoding model the operator
   * deployed in this cluster (e.g. opensearch-neural-sparse-encoding-doc-v3-distill). */
  semanticModel?: string;
}
export interface IndexTransportOptions extends RealmOptions {index: string; allowIndexPattern?: boolean; cluster?: boolean}
export interface Mapping {
  [option: string]: unknown;
  type?: string; dynamic?: string; properties?: Record<string, Mapping>; fields?: Record<string, Mapping>;
  _meta?: {schema?: number; tenantId?: string};
}
export interface SearchInput {query?: string; limit?: number; raw?: boolean; match?: string; sessionId?: string; id?: string; after?: string; before?: string; order?: string}
export interface Passage extends SearchDocument {id: string; score?: number}
export interface SearchResult {hits: Passage[]; total?: number; truncated?: boolean}
export interface SearchAdapter {
  search(principal: Principal, input: SearchInput & {raw?: false}): Promise<SearchResult>;
  /** The id of another passage (by chunk number) of the same record as `hit`, if this source splits
   * records into passages. Ids are not access: fetch authorizes every read again. */
  neighbour?(hit: Passage, chunk: number): string | null;
}
