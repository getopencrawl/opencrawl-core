import type {ConnectorBinding} from '../connectors/types.mjs';
import type {Composio} from './composio.mjs';
import type {Registry} from './registry.mjs';
import type {Provider, Proxy, ProxyRequest, ConnectionRecord, ConnectionStatus} from './types.mjs';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createComposio} from './composio.mjs';
import {providers as catalog} from './providers.mjs';
import {validateBinding} from '../connectors/scope.mjs';

// Self-host source connections. Composio (the operator's own project and API key) signs
// people in and proxies provider calls; deploy/connectors runs the same declarative manifests
// as hosted OpenCrawl through that proxy into this deployment's bucket, and the indexer
// makes them searchable. One connection per provider: every source is team-wide.
const CONNECTION = /^int_[a-f0-9]{26}$/;
const LIVE: ConnectionStatus[] = ['connecting', 'active', 'error', 'disconnecting'];
const BACKFILL_DAYS = 90;
const exposed = (message: string, status = 400) => Object.assign(new Error(message), {status, expose: true});

export interface SourceItem {
  id: string; name: string; description: string; help: string; auth: 'oauth' | 'api-key';
  state: 'available' | 'unavailable' | 'connecting' | 'syncing' | 'synced' | 'error' | 'disconnecting';
  keyHelp?: {title?: string; body?: string; label?: string; placeholder?: string};
  account?: string | null; error?: string | null; lastSyncAt?: string | null;
}

/** Calls a provider's API with a pasted key, in the Composio proxy's {status, data} shape. */
export function directApi(apiKey: string, fetchImpl = globalThis.fetch): Proxy {
  return async ({endpoint, query = {}}: ProxyRequest) => {
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    const res = await fetchImpl(url, {headers: {Authorization: `Bearer ${apiKey}`, Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(30000)});
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return {status: res.status, data};
  };
}

export function createSources({registry, tenantId, origin, composioApiKey = '', composioBaseUrl, providers = catalog, fetch: fetchImpl = globalThis.fetch, now = () => Date.now()}: {
  registry: Registry; tenantId: string; origin: string; composioApiKey?: string; composioBaseUrl?: string;
  providers?: Readonly<Record<string, Provider>>; fetch?: typeof globalThis.fetch; now?: () => number;
}) {
  const composioUser = `opencrawl-selfhost:${tenantId}`;
  /** The environment key wins; otherwise the key pasted through the API. */
  const composioKey = () => composioApiKey || registry.setting('composio_api_key') || '';
  const composio = (apiKey = composioKey()): Composio => createComposio({apiKey, baseUrl: composioBaseUrl, fetch: fetchImpl});
  const providerFor = (id: string) => {
    if (!Object.hasOwn(providers, id)) throw exposed('Unknown source', 404);
    return providers[id];
  };
  const current = (provider: Provider) => registry.list(LIVE).filter(r => r.provider === provider.id).at(-1) || null;
  const proxyFor = (record: ConnectionRecord): Proxy => request => composio().proxy({...request, connectedAccountId: record.connectedAccountId!, userId: record.composioUser!});

  function state(provider: Provider, record: ConnectionRecord | null): SourceItem['state'] {
    if (!record) return provider.auth === 'oauth' && !composioKey() ? 'unavailable' : 'available';
    if (record.status === 'active') return record.lastSyncStatus === 'succeeded' ? 'synced' : record.lastSyncStatus === 'failed' ? 'error' : 'syncing';
    return record.status as SourceItem['state'];
  }

  /** Reads the provider account, then activates the connection for the runner. */
  async function activate(record: ConnectionRecord, provider: Provider, api: Proxy) {
    try {
      const {label, workspace, settings} = await provider.account(api, tenantId);
      return registry.update(record.id, ['connecting'], {status: 'active', label, workspaceId: workspace, settings: settings || {}, nonce: null, error: null});
    } catch (error) {
      const failure = error as Error & {expose?: boolean};
      registry.update(record.id, ['connecting'], {status: 'error', error: failure.expose ? failure.message : 'We couldn’t read this account. Disconnect and try again.'});
      throw error;
    }
  }

  return {
    composioUser,
    list() {
      const items = Object.values(providers).map((provider): SourceItem => {
        const record = current(provider);
        return {id: provider.id, name: provider.name, description: provider.description, help: provider.help, auth: provider.auth,
          ...(provider.auth === 'api-key' ? {keyHelp: provider.keyHelp} : {}), state: state(provider, record),
          account: record?.label ?? null, error: record?.error || record?.lastSyncError || null, lastSyncAt: record?.lastSyncAt ?? null};
      });
      return {composio: {configured: Boolean(composioKey()), managedByEnvironment: Boolean(composioApiKey)}, items};
    },

    /** Checks a pasted Composio project API key before storing it. */
    async setComposioKey(apiKey: unknown) {
      if (composioApiKey) throw exposed('COMPOSIO_API_KEY is set in the environment; change it there.', 409);
      if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_.-]{10,200}$/.test(apiKey.trim())) throw exposed('That doesn’t look like a Composio API key.');
      try { await composio(apiKey.trim()).check(); }
      catch (error) { if ([401, 403].includes((error as {status?: number}).status || 0)) throw exposed('Composio didn’t accept that API key.'); throw error; }
      registry.setSetting('composio_api_key', apiKey.trim());
      return {ok: true};
    },

    async connect(id: string, {apiKey}: {apiKey?: unknown} = {}) {
      const provider = providerFor(id);
      const existing = current(provider);
      if (existing && existing.status !== 'connecting') throw exposed(`${provider.name} is already connected.`, 409);
      if (existing) registry.update(existing.id, ['connecting'], {status: 'abandoned'});
      const connection = {id: 'int_' + randomBytes(13).toString('hex'), provider: provider.id,
        startDate: new Date(now() - BACKFILL_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')};
      if (provider.auth === 'api-key') {
        if (typeof apiKey !== 'string' || !new RegExp(provider.keyHelp.pattern).test(apiKey.trim())) throw exposed(`That doesn’t look like a ${provider.name} workspace API key.`);
        const key = apiKey.trim();
        const {label, workspace} = await provider.account(directApi(key, fetchImpl), tenantId);
        registry.create({...connection, status: 'active', label, workspaceId: workspace, apiKey: key});
        return {ok: true};
      }
      if (!composioKey()) throw exposed('Add a Composio API key first.', 409);
      const client = composio();
      const authConfigId = await client.authConfig({toolkit: provider.toolkit, ...provider.authConfig});
      const nonce = randomBytes(24).toString('base64url');
      const callback = new URL(`/integrations/${provider.id}/callback`, origin);
      callback.searchParams.set('integration', connection.id);
      callback.searchParams.set('state', nonce);
      const link = await client.link({authConfigId, userId: composioUser, callbackUrl: callback.href});
      registry.create({...connection, status: 'connecting', nonce, connectedAccountId: link.connected_account_id, composioUser});
      return {redirectUrl: link.redirect_url};
    },

    /**
     * Completes Composio sign-in. The query string is untrusted: the state must match the
     * pending connection, and Composio must confirm the account we created is active.
     */
    async complete(id: string, query: URLSearchParams) {
      const provider = providerFor(id);
      if (provider.auth !== 'oauth') return {ok: false, reason: 'invalid'};
      const connectionId = query.get('integration') || '';
      const record = CONNECTION.test(connectionId) ? registry.get(connectionId) : null;
      if (!record || record.provider !== provider.id) return {ok: false, reason: 'invalid'};
      if (record.status !== 'connecting') return {ok: record.status === 'active', reason: 'done'};
      const expected = Buffer.from(record.nonce || ''), given = Buffer.from(query.get('state') || '');
      if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) return {ok: false, reason: 'invalid'};
      if (query.get('connected_account_id') && query.get('connected_account_id') !== record.connectedAccountId) return {ok: false, reason: 'invalid'};
      if (query.get('status') === 'failed') {
        registry.update(record.id, ['connecting'], {status: 'abandoned'});
        return {ok: false, reason: 'declined'};
      }
      const account = await composio().account(record.connectedAccountId!);
      if (account?.status !== 'ACTIVE' || account.is_disabled || (account.toolkit?.slug || '').toLowerCase() !== provider.toolkit
        || (account.user_id !== undefined && account.user_id !== record.composioUser)) return {ok: false, reason: 'declined'};
      if (registry.list(['active', 'error', 'disconnecting']).some(r => r.provider === provider.id)) {
        await composio().remove(record.connectedAccountId!).catch(() => {});
        registry.update(record.id, ['connecting'], {status: 'abandoned'});
        return {ok: false, reason: 'taken'};
      }
      try { await activate(record, provider, proxyFor(record)); }
      catch { return {ok: false, reason: 'account'}; }
      return {ok: true, reason: 'connected'};
    },

    /** Asks the runner for an immediate sync. */
    retry(id: string) {
      const record = current(providerFor(id));
      if (!record || record.status !== 'active') throw exposed('Nothing to retry.', 409);
      registry.requestSync(record.id);
      return {ok: true};
    },

    /**
     * Revokes the grant now and hides the connection from search immediately; the runner then
     * deletes its raw data and marks it disconnected.
     */
    async disconnect(id: string) {
      const record = current(providerFor(id));
      if (!record) return {ok: true};
      if (record.connectedAccountId) {
        await composio().remove(record.connectedAccountId).catch(error => { if ((error as {status?: number}).status !== 404) throw error; });
      }
      registry.update(record.id, [record.status], {status: record.workspaceId ? 'disconnecting' : 'disconnected', apiKey: null, nonce: null});
      return {ok: true};
    },

    /** Current searchable connections, resolved on every call so disconnects apply at once. */
    bindings(): ConnectorBinding[] {
      return registry.list(['active', 'error']).filter(r => r.workspaceId && Object.hasOwn(providers, r.provider)).map(r => validateBinding({
        tenantId, connectionId: r.id, workspaceId: r.workspaceId!, provider: r.provider as ConnectorBinding['provider'], access: providers[r.provider].access,
        rawPrefix: `raw/v1/source=${r.provider}/workspace=${r.workspaceId}/connection=${r.id}/`,
      }));
    },
  };
}
export type Sources = ReturnType<typeof createSources>;
