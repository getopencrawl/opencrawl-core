/** Portable connector contracts. Provider payloads are validated by their adapters. */
export type Provider = 'slack' | 'granola' | 'circleback' | 'notion' | 'github' | 'googledrive';
export interface ConnectorBinding {
  tenantId: string; connectionId: string; workspaceId: string; provider: Provider;
  access: 'team-public' | 'workspace-global'; rawPrefix: string;
}
export interface ConnectorPrincipal { tenantId: string; captureAccess?: string; }
export interface AirbyteEnvelope<T = Record<string, unknown>> {
  _airbyte_data: T; _airbyte_extracted_at: number;
  _airbyte_meta?: { changes?: unknown[] };
}
export interface ConnectorDocument {
  tenantId: string; connectionId: string; workspaceId: string; provider: string;
  kind: string; sourceId: string; title: string; text: string; deleted: boolean;
  extractedAt: number; sourceKey: string; contentHash?: string;
  parentId?: string; parentKind?: string; resourceVersion?: string;
  channelId?: string; threadTs?: string; timestamp?: string; authorId?: string;
  publicChannel?: boolean; available?: boolean; sourceAuthority?: number; normalizerVersion?: number;
  [field: string]: unknown;
}
export interface DocumentItem { id: string; document: ConnectorDocument; }
export interface ReadOptions { maxBytes?: number; }
export interface ListOptions { continuationToken?: string | null; maxKeys?: number; }
export interface ObjectPage { keys: string[]; nextToken?: string | null; }
export interface ConnectorStore {
  bucket?: string;
  get(key: string, options?: ReadOptions): Promise<Buffer | null>;
  read?(key: string, options?: ReadOptions): AsyncIterable<Uint8Array>;
  put(key: string, bytes: Uint8Array, mediaType?: string): Promise<unknown>;
  listPage(prefix: string, options?: ListOptions): Promise<ObjectPage>;
}
export interface ConditionalStore extends ConnectorStore {
  readVersion(key: string, options?: ReadOptions): Promise<{data: Buffer | null; version: string | number | null}>;
  compareAndSet(key: string, version: string | number | null, bytes: Uint8Array): Promise<boolean>;
}
export interface SuppressionIdentity { kind: string; sourceId: string; }
export interface ConnectorSearch {
  identity: string;
  putDocuments(principal: ConnectorPrincipal, binding: ConnectorBinding, documents: DocumentItem[]): Promise<unknown>;
  suppress?(principal: ConnectorPrincipal, binding: ConnectorBinding, identity: SuppressionIdentity): Promise<unknown>;
}
export interface PipelineOptions {
  binding: ConnectorBinding; store: ConnectorStore; search: ConnectorSearch;
  checkActive?: (binding: ConnectorBinding) => Promise<unknown>;
  heartbeat?: (progress: Record<string, number>) => void;
}
export interface PassageUnit { text: string; speaker?: string; startTime?: string; endTime?: string; heading?: string; }
export interface TextPart { path: string; text: string; }
export interface ExtractionResult { status: string; parts: TextPart[]; pages?: number; }
export interface SlackRecord extends Record<string, unknown> {
  id?: string; channel_id?: string; channel?: string; ts?: string; thread_ts?: string;
  user?: string; bot_id?: string; name?: string; real_name?: string; member_id?: string;
  topic?: {value?: string}; purpose?: {value?: string}; profile?: {display_name?: string};
  is_private?: boolean; is_im?: boolean; is_mpim?: boolean; reply_count?: number;
}
export interface SlackFile extends Record<string, unknown> {
  id: string; channels?: string[]; shares?: {public?: Record<string, unknown>};
  is_external?: boolean; size?: number; url_private_download?: string; url_private?: string;
  initial_comment?: {comment?: string}; filetype?: string; mimetype?: string; comments_count?: number;
  title?: string; name?: string; user?: string;
}
export interface SlackApiData {
  ok?: boolean; error?: string; team_id?: string; has_more?: boolean;
  response_metadata?: {next_cursor?: string};
  channels?: SlackRecord[]; channel?: SlackRecord; messages?: SlackRecord[];
  files?: SlackFile[]; file?: SlackFile; comments?: {id: string; comment: string}[];
  paging?: {pages: number; page: number};
}
export type SlackQuery = Record<string, string | number | boolean | undefined>;
export interface SlackApiResponse { status: number; headers?: Record<string, string>; data?: SlackApiData; }
export type SlackRequest = (method: string, query: SlackQuery) => Promise<SlackApiResponse>;
export interface SlackCaptureOptions {
  binding: ConnectorBinding; store: ConnectorStore; request: SlackRequest;
  checkActive?: (binding: ConnectorBinding) => Promise<unknown>; now?: () => number;
}
export type ErrorMetadata = Error & { code?: string; permanent?: boolean; status?: number; writeOutcome?: string };
export function errorMetadata(error: unknown): Partial<ErrorMetadata> {
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? error as Partial<ErrorMetadata> : {};
}

export interface GitHubRecord {
 repository?: string; sha?: string; message?: string; number?: number; title?: string; body?: string;
 html_url?: string; url?: string; id?: string | number; name?: string; tag_name?: string;
 commit_id?: string; issue_url?: string; pull_request_url?: string; author?: {login?: string};
 user?: {login?: string}; author_name?: string; labels?: (string | {name?: string})[]; state?: string;
 updated_at?: string; updatedAt?: string; committer_date?: string; published_at?: string; created_at?: string; createdAt?: string; author_date?: string;
 reviews?: (GitHubRecord & {databaseId?: number; submittedAt?: string; submitted_at?: string})[];
}
export interface SlackFileRecord extends SlackRecord {
 format_version: number; available: boolean; media_type?: string; content_key?: string;
 content_sha256?: string; content_bytes?: number; api_text?: TextPart[]; title?: string; preview?: string;
}
