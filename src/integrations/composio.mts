import type {ProxyRequest, ProxyResponse, ProviderData} from './types.mjs';
interface ComposioOptions {apiKey: string; baseUrl?: string; fetch?: typeof globalThis.fetch}
interface AuthConfig {id: string; name: string; toolkit?: {slug: string}; status: string; is_composio_managed: boolean; auth_scheme?: string}
export interface ConnectedAccount {id: string; user_id?: string; status: string; is_disabled?: boolean; toolkit?: {slug: string}}
// Customer-operated Composio adapter (REST v3.1). The operator brings their own Composio
// project API key: Composio runs provider sign-in, stores and refreshes the tokens, and proxies
// provider API calls. OpenCrawl never sees provider tokens.
const BASE = 'https://backend.composio.dev';

export function createComposio({apiKey, baseUrl = BASE, fetch: fetchImpl = globalThis.fetch}: ComposioOptions) {
  if (!apiKey) throw Object.assign(new Error('Add a Composio API key first.'), {status: 409, expose: true});
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}/api/v3.1${path}`, {method, headers: {
      'x-api-key': apiKey, Accept: 'application/json', ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
    }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000)});
    const text = await res.text();
    let data: {error?: {message?: string}} | null = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw Object.assign(new Error(`Composio ${method} ${path.split('?')[0]} failed with ${res.status}${data?.error?.message ? `: ${data.error.message}` : ''}`), {status: res.status});
    return data as T;
  }
  return {
    apiKey,
    baseUrl,
    /** Fails with 401/403 when the project API key is not accepted. */
    check: () => request<unknown>('GET', '/auth_configs?limit=1'),
    /**
     * Returns our named auth config for a toolkit, creating it once. Matched by exact name so a
     * Composio project shared with other apps is left alone. Without `scheme` it is
     * Composio-managed; with one (Circleback's `DCR_OAUTH`) Composio registers the OAuth client.
     */
    async authConfig({toolkit, name, scheme, credentials = {}}: {toolkit: string; name: string; scheme?: string; credentials?: Record<string, string>}) {
      const {items = []} = await request<{items?: AuthConfig[]}>('GET', `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&limit=100`) || {};
      const existing = items.find(c => c.name === name && (c.toolkit?.slug || '').toLowerCase() === toolkit && c.status === 'ENABLED'
        && (scheme ? !c.is_composio_managed && c.auth_scheme === scheme : c.is_composio_managed));
      if (existing) return existing.id;
      const created = await request<{auth_config: {id: string}}>('POST', '/auth_configs', {toolkit: {slug: toolkit}, auth_config: scheme
        ? {type: 'use_custom_auth', authScheme: scheme, name, credentials}
        : {type: 'use_composio_managed_auth', name, credentials}});
      return created.auth_config.id;
    },
    /** Starts hosted sign-in. Returns {redirect_url, connected_account_id}. */
    link: ({authConfigId, userId, callbackUrl}: {authConfigId: string; userId: string; callbackUrl: string}) =>
      request<{redirect_url: string; connected_account_id: string; expires_at?: string}>('POST', '/connected_accounts/link', {auth_config_id: authConfigId, user_id: userId, callback_url: callbackUrl}),
    account: (id: string) => request<ConnectedAccount>('GET', `/connected_accounts/${encodeURIComponent(id)}`),
    /** Deletes the account and revokes the provider grant. */
    remove: (id: string) => request<void>('DELETE', `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`),
    /** Calls the provider API as the connected account. Returns {status, data, headers}. */
    proxy: <T = ProviderData,>({connectedAccountId, userId, endpoint, method = 'GET', query = {}, headers = {}, body}: ProxyRequest & {connectedAccountId: string; userId: string}) => request<ProxyResponse<T>>('POST', '/tools/execute/proxy', {
      connected_account_id: connectedAccountId, user_id: userId, endpoint, method, ...(body === undefined ? {} : {body}),
      parameters: [...Object.entries(query).filter(([, v]) => v !== undefined).map(([name, value]) => ({name, value: String(value), type: 'query'})),
        ...Object.entries(headers).map(([name, value]) => ({name, value: String(value), type: 'header'}))],
    }),
  };
}

export type Composio = ReturnType<typeof createComposio>;
