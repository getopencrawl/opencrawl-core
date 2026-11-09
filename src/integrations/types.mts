import type {ConnectorBinding} from '../connectors/types.mjs';

export interface ProxyRequest {endpoint: string; method?: string; query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string>; body?: unknown}
export interface ProxyResponse<T> {status: number; data: T; headers?: Record<string, string>}
export type Proxy = <T = ProviderData>(request: ProxyRequest) => Promise<ProxyResponse<T>>;
export interface ProviderData {
  ok?: boolean; error?: string; team_id?: string; team?: string; user?: string; email?: string;
  notes?: Array<{id: string}>; spaces?: Array<{name?: string}>;
  private_notes_text?: string; private_notes_markdown?: string;
  bot?: {workspace_id: string; workspace_name?: string};
}
export interface AccountInfo {label: string | null; workspace: string; settings?: Record<string, string | number>}

export interface SyncStream {name: string; syncMode: 'incremental' | 'full_refresh'; cursorField?: string[]}
interface ProviderBase {
  id: ConnectorBinding['provider']; name: string; description: string; help: string;
  /** Search access asserted for every connection of this provider; see docs/workspace-connectors.md. */
  access: ConnectorBinding['access'];
  /** How deploy/connectors runs manifests/<id>.json for a connection. */
  sync: {everyMinutes: number; streams: SyncStream[]; config(record: ConnectionRecord): Record<string, unknown>};
}
/** Signs in through the operator's Composio project; the sync runner pulls through its proxy. */
export interface OAuthProvider extends ProviderBase {
  auth: 'oauth'; toolkit: string; authConfig: {name: string; scheme?: string; credentials: Record<string, string>};
  account(proxy: Proxy, tenantId: string): Promise<AccountInfo>;
}
/** A pasted workspace key, kept in the local registry and handed only to the sync runner. */
export interface KeyProvider extends ProviderBase {
  auth: 'api-key';
  keyHelp: {title: string; body: string; label: string; placeholder?: string; pattern: string};
  account(api: Proxy, tenantId: string): Promise<AccountInfo>;
}
export type Provider = OAuthProvider | KeyProvider;

export type ConnectionStatus = 'connecting' | 'active' | 'error' | 'disconnecting' | 'disconnected' | 'abandoned';
export interface ConnectionRecord {
  id: string; provider: string; status: ConnectionStatus; createdAt: string; updatedAt: string; startDate: string;
  nonce: string | null; connectedAccountId: string | null; composioUser: string | null;
  workspaceId: string | null; label: string | null; settings: Record<string, string | number>;
  error: string | null; lastSyncAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null;
}
