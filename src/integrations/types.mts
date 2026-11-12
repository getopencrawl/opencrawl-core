import type {Principal, JsonObject as JsonRecord, JsonValue} from '../sessions/types.mjs';
export type Environment = 'production' | 'staging' | 'selfhost';

export type ResourceName = 'destinationId' | 'sourceId' | 'connectionId';
export interface ProvisionIntent {
  resource: ResourceName; workspaceId: string; name: string; attemptId: string;
  requestedAt: string; sourceId?: string; destinationId?: string; responseStatus?: number | null;
}
export interface IntegrationRecord {
  tenantId: string; userId: string; integrationId: string; provider: string;
  environment: Environment; scope: 'team' | 'user'; status: string; createdAt: string;
  updatedAt?: string; ownerEmail?: string | null; account?: string | null; workspace?: string | null;
  s3Bucket?: string; s3Prefix?: string; startDate: string; total?: number | null;
  airbyte?: Partial<Record<ResourceName, string>>; airbyteWorkspaceId?: string;
  airbyteLandingMode?: string; airbyteMigration?: AirbyteMigration | null;
  connectedAccountId?: string; authConfigId?: string; installationId?: string; nonce?: string;
  githubRepositoryIds?: number[];
  provisionIntent?: ProvisionIntent | null; provisionProtocol?: number; provisionRun?: string;
  provisionVersion?: string; resourceVersion?: string; error?: string | null;
  disconnectedAt?: string; dataDeletedAt?: string | null; deletedObjects?: number;
  settings?: {folderId?: string | number};
}
export interface AirbyteMigration {
  format: number; nonce: string; oldDestinationId: string; definitionId: string; name: string; newDestinationId: string | null;
}
export interface UpdateOptions {whenStatus?: string[]; whenFields?: Record<string, unknown>}

export interface ProxyRequest {endpoint: string; method?: string; query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string>; body?: unknown}
export interface ProxyResponse<T> {status: number; data: T; headers?: Record<string, string>; binary_data?: {url: string; content_type?: string}}
export type Proxy = <T = ProviderData>(request: ProxyRequest) => Promise<ProxyResponse<T>>;
export interface ProviderData {
  ok?: boolean; error?: string; team_id?: string; team?: string; user?: string; email?: string;
  drives?: Array<{id: string; name?: string}>; files?: Array<{driveId?: string}>; nextPageToken?: string;
  channels: Array<{name: string}>; response_metadata?: {next_cursor?: string}; messages?: {total?: number};
  notes?: Array<{id: string; deleted_at?: string | null}>; spaces?: Array<{name?: string}>;
  private_notes_text?: string; private_notes_markdown?: string; hasMore?: boolean; cursor?: string;
  bot?: {workspace_id: string; workspace_name?: string}; results?: Array<{in_trash?: boolean}>;
  has_more?: boolean; next_cursor?: string;
}
export interface ConnectorManifest {spec: {connection_specification: JsonRecord}; [key: string]: JsonValue | undefined}
export interface ConnectorDefinition {name: string; manifest?: ConnectorManifest; docker?: {repository: string; tag: string}}
export interface AccountInfo {label: string | null; workspace?: string | null; settings?: {folderId?: string | number}}
export interface SourceConfigurationInput {startDate?: string; apiKey?: string; record?: IntegrationRecord; githubApp?: {app_id: string; private_key: string}}
export interface CountInput {startDate?: string; record?: IntegrationRecord; now?: number; maxPages?: number}
export interface GithubInstallation {id: string | number; account: {id: string | number; login: string}; repository_selection?: string; permissions?: Record<string, string>}
export interface GithubRepository {id: number; full_name: string; private?: boolean}
interface ProviderBase {
  id: string; name: string; description: string; scope: 'team' | 'user'; help: string; teamOnly?: boolean;
  /** A visible catalog entry whose end-to-end product path is not ready. */
  unavailableReason?: string;
  owner(record: IntegrationRecord): string; connector: ConnectorDefinition;
  streams: Array<{name: string; syncMode: string; cursorField?: string[]}>;
  progressStream: string[]; progress?: Array<{stream: string; label: string; trailing?: boolean}>;
  primaryMetric?: string;
  units: [string, string]; schedule?: string; keys?: Record<string, string[]>;
  sourceConfiguration(input: SourceConfigurationInput): Record<string, unknown>;
}
export interface OAuthProvider extends ProviderBase {
  auth?: 'oauth'; toolkit: string; authConfig: {name: string; scheme?: string; credentials: Record<string, string>};
  keyHelp?: undefined;
  account(proxy: Proxy, principal: Pick<Principal, 'tenantId' | 'userId'>): Promise<AccountInfo>;
  total(proxy: Proxy, input: CountInput): Promise<number | null>;
}
export interface KeyProvider extends ProviderBase {
  auth: 'api-key'; toolkit?: undefined; authConfig?: undefined;
  keyHelp: {title: string; body: string; label: string; placeholder?: string; pattern: string};
  account(proxy: Proxy, principal: Pick<Principal, 'tenantId' | 'userId'>): Promise<AccountInfo>;
  total(proxy: Proxy, input: CountInput): Promise<number | null>;
}
export interface GithubProvider extends ProviderBase {
  auth: 'github-app'; toolkit?: undefined; authConfig?: undefined; keyHelp?: undefined;
  account(installation: GithubInstallation, repositories: GithubRepository[]): AccountInfo;
  total?: undefined;
}
export type Provider = OAuthProvider | KeyProvider | GithubProvider;
export type ProviderCatalog = Record<string, Provider>;

export interface AirbyteResource {
  id: string; name: string; workspaceId: string; sourceId?: string; destinationId?: string;
  connectionId?: string; definitionId?: string; manifest?: ConnectorManifest;
  dockerRepository?: string; dockerImageTag?: string;
  status?: string; configuration?: Record<string, unknown>;
}
export interface AirbyteJob {jobId: string | number; status: string; lastUpdatedAt?: string; startTime?: string; rowsSynced?: number}
export interface StreamStats {streamName: string; recordsEmitted?: number; recordsCommitted?: number}
