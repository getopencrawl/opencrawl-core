import type {SourceCard} from '../application/types.mjs';
import {errorInfo, required} from '../errors.mjs';
import type {Principal} from '../sessions/types.mjs';
import type {Environment} from './types.mjs';
import type {Log, ConnectorOAuth, LandingDestination} from './ports.mjs';
import type {Airbyte} from './airbyte.mjs';
import type {IntegrationRegistry as Registry} from './ports.mjs';
import type {IntegrationStorage as TeamBuckets} from './ports.mjs';
import type {GithubApp} from './github.mjs';
import type {Provider, ProviderCatalog, KeyProvider, GithubProvider, GithubRepository, IntegrationRecord, Proxy, ProxyRequest, ProviderData, AirbyteJob, AirbyteResource, ResourceName, ConnectorDefinition} from './types.mjs';
export interface IntegrationCompletion {ok: boolean; reason: string; actions?: Array<{label: string; url: string}>}
export interface IntegrationOptions {
  environment: Environment; appUrl: string; buckets: TeamBuckets; legacyBucket: string; workspaceId: () => Promise<string>; destination: LandingDestination;
  backfillDays?: number; schedule?: string; oauth: ConnectorOAuth; airbyte: Airbyte; registry: Registry;
  providers: ProviderCatalog; github?: GithubApp | null; direct?: typeof directApi; now?: () => number;
  log?: Log; maintenance?: boolean; revokeInstallation?: (installationId: string) => Promise<void>;
}
interface Secrets {apiKey?: string}
type PendingSignInState = 'pending' | 'expired' | 'unavailable';
// Product lifecycle: runtimes supply credential and infrastructure adapters.
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createRecordCounts} from './counts.mjs';
import {createProvisioning, provisioningLabel} from './provisioning.mjs';

const TENANT = /^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/;
const USER = /^user_[A-Za-z0-9]+$/;
const INTEGRATION = /^int_[a-f0-9]{26}$/;
const ACTIVE = ['connecting', 'provisioning', 'active', 'error'];
const VISIBLE = [...ACTIVE, 'disconnecting'];
const DAY = 86_400_000;
const ORG = /^org_[A-Za-z0-9]+$/;

// Airbyte returns manifests with keys reordered; compare content, not serialization.
const canonical = (value: unknown) => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const newest = (records: IntegrationRecord[]) => records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;

export const integrationId = () => 'int_' + randomBytes(13).toString('hex');

/**
 * Where one connection's raw records live inside the team bucket:
 * raw/v1/source=<provider>/<owner>/connection=<integration>, where <owner> is user=<userId>
 * for per-user sources (Circleback) and workspace=<id> for team sources: the Slack team ID, Notion
 * workspace ID or GitHub account ID, or the OpenCrawl team's organization ID where the provider
 * has no workspace ID (Granola, Google Drive).
 */
export function landingPrefix(provider: Provider, record: IntegrationRecord) {
  if (!TENANT.test(record.tenantId) || !USER.test(record.userId) || !INTEGRATION.test(record.integrationId)) throw new Error('Invalid integration scope');
  const owner = provider.owner(record);
  // Slack team IDs and GitHub account IDs, OpenCrawl organization IDs (Granola, Google Drive), Notion workspace UUIDs.
  if (!/^(user=user_[A-Za-z0-9]+|workspace=([A-Z0-9]+|org_[A-Za-z0-9]+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}))$/.test(owner)) throw new Error('Invalid integration owner');
  return `raw/v1/source=${provider.id}/${owner}/connection=${record.integrationId}`;
}

/**
 * Calls a provider's API directly with a key the user pasted, in the same {status, data} shape as
 * the the OAuth adapter proxy. Only used while connecting; the key is never logged or stored by the app.
 */
export function directApi(apiKey: string, fetchImpl = globalThis.fetch): Proxy {
  return async <T = ProviderData,>({endpoint, query = {}}: ProxyRequest) => {
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    const res = await fetchImpl(url, {headers: {Authorization: `Bearer ${apiKey}`, Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(30000)});
    const text = await res.text();
    let data: T | null = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return {status: res.status, data: data as T};
  };
}

export function createIntegrations({environment, appUrl, buckets, legacyBucket, workspaceId: workspaceIdOf, destination, backfillDays = 90, schedule = '0 0 * * * ?', oauth, airbyte, registry, providers, github = null, direct = directApi, now = () => Date.now(), log = () => {}, maintenance = false, revokeInstallation}: IntegrationOptions) {
  const pendingAccountCache = new Map<string, {at: number; result: Promise<PendingSignInState>}>();
  const jobCache = new Map<string, {at: number; jobs: AirbyteJob[]}>();
  const provisioning = new Map<string, Promise<IntegrationRecord>>();
  const requireWritable = () => {
    if (maintenance) throw Object.assign(new Error('Integration maintenance is in progress. Please retry shortly.'), {status: 503, expose: true});
  };
  const durable = createProvisioning({environment, registry, airbyte, now});
  const distinct = typeof buckets?.list === 'function' ? createRecordCounts({buckets, legacyBucket, log, now}) : null;

  const oauthUser = ({tenantId, userId}: Pick<Principal, 'tenantId' | 'userId'>) => `${environment}:${tenantId}:${userId}`;
  const proxyFor = (record: IntegrationRecord): Proxy => request => oauth.proxy({...request, connectedAccountId: required(record.connectedAccountId, 'connected account'), userId: oauthUser(record)});
  const providerFor = (id: string) => {
    const provider = providers[id];
    if (!provider) throw Object.assign(new Error('Unknown integration'), {status: 404});
    return provider;
  };
  /** Team sources are shared by everyone in the tenant; user sources belong to one person. */
  const visible = (principal: Principal, provider: Provider, record: IntegrationRecord) => record.provider === provider.id && VISIBLE.includes(record.status)
    && (provider.scope === 'team' || record.userId === principal.userId);

  /**
   * Each provider's connector definition, resolved on its own: one provider's connector failing
   * never blocks connecting another.
   */
  const definitions = new Map<string, Promise<string>>();
  function definitionFor(provider: Provider, id: string) {
    const key = `${id}:${provider.id}`;
    if (!definitions.has(key)) {
      definitions.set(key, (async () => {
        return provider.connector.docker ? dockerDefinition(id, provider.connector) : manifestDefinition(id, provider);
      })().catch(error => { definitions.delete(key); throw error; }));
    }
    return definitions.get(key)!;
  }

  /** The published declarative manifest, updated when the file changes. */
  async function manifestDefinition(id: string, provider: Provider) {
    const {name, manifest} = provider.connector;
    const definition = (await airbyte.declarativeSources(id)).find(d => d.name === name);
    if (!definition) return (await airbyte.createDeclarativeSource(id, name, manifest!)).id;
    if (canonical(definition.manifest) !== canonical(manifest)) {
      // A failed update keeps the published version; it must not block connecting.
      await airbyte.updateDeclarativeSource(id, definition.id, manifest!)
        .catch(error => log('integration.connector.update_failed', {provider: provider.id, message: errorInfo(error).message}));
    }
    return definition.id;
  }

  /**
   * Docker connector definitions are installed by the operator; product requests only resolve them.
   */
  async function dockerDefinition(id: string, {name}: ConnectorDefinition) {
    const definition = (await airbyte.sourceDefinitions(id)).find(d => d.name === name);
    if (!definition) throw new Error(`Connector ${name} is not registered in the configured Airbyte workspace`);
    return definition.id;
  }

  /** The bucket created at onboarding. Connecting never creates storage. */
  async function teamBucket(principal: Principal) {
    const bucket = await buckets.get(principal.tenantId);
    if (!bucket) throw Object.assign(new Error('Your team’s storage isn’t ready yet. Reload this page, then connect again.'), {status: 409, expose: true});
    return bucket;
  }

  async function current(principal: Principal, provider: Provider) {
    const records = (await registry.listTenant(principal.tenantId)).filter(r => visible(principal, provider, r));
    return newest(records.filter(r => r.status !== 'connecting')) || newest(records);
  }

  async function jobsFor(connectionId: string) {
    const cached = jobCache.get(connectionId);
    // Absorbs polling from several open tabs; elapsed time, not the injectable clock.
    if (cached && performance.now() - cached.at < 3000) return cached.jobs;
    const jobs = await airbyte.jobs(connectionId, 100);
    jobCache.set(connectionId, {at: performance.now(), jobs});
    return jobs;
  }

  /** Read-only sign-in health. A provider grant alone never completes our callback. */
  async function pendingSignIn(record: IntegrationRecord, provider: Exclude<Provider, GithubProvider>): Promise<PendingSignInState> {
    const key = JSON.stringify([environment, record.tenantId, record.userId, record.integrationId, record.connectedAccountId, provider.toolkit]);
    const cached = pendingAccountCache.get(key);
    if (cached && performance.now() - cached.at < 15000) return cached.result;
    pendingAccountCache.delete(key);
    const result = Promise.resolve().then(async (): Promise<PendingSignInState> => {
      let account;
      try { account = await oauth.account(required(record.connectedAccountId, 'connected account')); }
      catch (error) { if (errorInfo(error).status === 404) return 'unavailable'; throw error; }
      if (account?.id !== record.connectedAccountId || (account.toolkit?.slug || '').toLowerCase() !== provider.toolkit
        || (account.user_id !== undefined && account.user_id !== oauthUser(record))) throw new Error('Sign-in account binding mismatch');
      if (account.is_disabled || ['FAILED', 'REVOKED', 'DELETED', 'INACTIVE'].includes(account.status)) return 'unavailable';
      if (account.status === 'EXPIRED') return 'expired';
      if (!['ACTIVE', 'INITIATED', 'INITIALIZING'].includes(account.status)) throw new Error('Unknown sign-in account status');
      return 'pending';
    }).catch(error => { pendingAccountCache.delete(key); throw error; });
    // Bound both repeated polling and memory use without retaining provider credentials.
    if (pendingAccountCache.size >= 256) pendingAccountCache.delete(pendingAccountCache.keys().next().value!);
    pendingAccountCache.set(key, {at: performance.now(), result});
    return result;
  }

  /** Local deduplication is only an optimization; durable intents fence external creates. */
  function provision(record: IntegrationRecord, secrets: Secrets = {}) {
    requireWritable();
    if (provisioning.has(record.integrationId)) return Promise.reject(Object.assign(new Error('Connection setup is already running'), {status: 409}));
    const pending = provisionRecord(record, secrets).finally(() => provisioning.delete(record.integrationId));
    provisioning.set(record.integrationId, pending);
    return pending;
  }

  /** Recover any earlier create before creating the next resource or starting a sync. */
  async function provisionRecord(record: IntegrationRecord, secrets: Secrets) {
    requireWritable();
    const provider = providerFor(record.provider);
    record = (await registry.get(record.tenantId, record.userId, record.integrationId))!;
    if (!ACTIVE.includes(record.status)) throw Object.assign(new Error('Connection setup is no longer authorized'), {status: 409});
    destination.validate(record);
    const run = randomBytes(16).toString('hex');
    record = await registry.update(record, {status: 'provisioning', error: null, provisionRun: run, provisionVersion: randomBytes(16).toString('hex')},
      {whenStatus: [record.status], whenFields: {provisionVersion: record.provisionVersion}});
    const label = provisioningLabel(record);
    let ids = {...record.airbyte};
    const save = async (fields: Partial<IntegrationRecord>) => record = await registry.update(record, fields,
      {whenStatus: ['provisioning'], whenFields: {provisionVersion: record.provisionVersion, provisionRun: run}});
    let workspaceId: string;
    async function resource(name: ResourceName, create: () => Promise<AirbyteResource>) {
      record = await durable.ensure(record, name, workspaceId, create);
      ids = {...record.airbyte};
      if (record.status !== 'provisioning' || record.provisionRun !== run) {
        if (record.status === 'disconnecting') await disconnectRecord(record);
        throw Object.assign(new Error('Connection setup is no longer authorized'), {status: 409});
      }
    }
    try {
      if (record.provisionIntent) record = await durable.reconcile(record);
      ids = {...record.airbyte};
      if (record.s3Prefix !== landingPrefix(provider, record)) throw new Error('Invalid provisioning landing scope');
      const destinationFields = await destination.prepare(record);
      if (Object.keys(destinationFields).length) record = await save(destinationFields);
      workspaceId = record.airbyteWorkspaceId || await workspaceIdOf();
      const definitionId = await definitionFor(provider, workspaceId);
      const destinationSettings = await destination.settings(record);
      await resource('destinationId', () => airbyte.createDestination({workspaceId, name: label, ...destinationSettings}));
      // Key-based sources hand their key straight to Airbyte, which stores it as a secret.
      if (provider.auth === 'api-key' && !ids.sourceId && !secrets.apiKey) {
        throw Object.assign(new Error('Reconnect with your workspace API key to finish setup.'), {code: 'ProvisioningKeyRequired'});
      }
      await resource('sourceId', async () => airbyte.createSource({workspaceId, name: label, definitionId, configuration: provider.auth === 'api-key'
        ? provider.sourceConfiguration({startDate: record.startDate, apiKey: secrets.apiKey})
        : provider.auth === 'github-app' ? provider.sourceConfiguration({githubApp: github!.sourceSettings(), record})
        : await oauth.sourceConfiguration(record, provider)}));
      await resource('connectionId', () => airbyte.createConnection({name: label, sourceId: ids.sourceId, destinationId: ids.destinationId,
        namespaceDefinition: 'destination', schedule: {scheduleType: 'cron', cronExpression: provider.schedule || schedule}, status: 'active',
        configurations: {streams: provider.streams}}));
      record = await save({airbyte: ids});
      await airbyte.sync(required(ids.connectionId, 'connection')).catch(error => { if (errorInfo(error).status !== 409) throw error; });
      return await save({status: 'active'});
    } catch (error) {
      // Airbyte validation errors may echo the source configuration.
      if (secrets.apiKey && error instanceof Error) error.message = error.message.replaceAll(secrets.apiKey, '[redacted]');
      log('integration.provision.failed', {integrationId: record.integrationId, message: errorInfo(error).message});
      // Never replace the durable resource map with a stale local snapshot after
      // an ambiguous POST or a concurrent recovery/disconnect.
      const failed = (await registry.get(record.tenantId, record.userId, record.integrationId))!;
      await registry.update(failed, {status: 'error', error: failed.provisionIntent ? 'recovery' : errorInfo(error).code === 'ProvisioningKeyRequired' ? 'reconnect' : 'setup'},
        {whenStatus: ['provisioning'], whenFields: {provisionVersion: failed.provisionVersion, provisionRun: run}})
        .catch(failure => {if (errorInfo(failure).code !== 'ConditionalCheckFailedException') throw failure;});
      throw error;
    }
  }

  /** Stops syncing, deletes everything this connection imported, then revokes the grant. */
  async function disconnectRecord(record: IntegrationRecord): Promise<void> {
    requireWritable();
    const gone = (error: unknown) => { if (errorInfo(error).status !== 404) throw error; };
    // Revoke reads and queued writes before touching providers. Failed cleanup stays
    // visible and retryable; setup callbacks cannot reactivate this record.
    record = await registry.update(record, {status: 'disconnecting'}, {whenStatus: VISIBLE});
    // A successful create may have outlived its app process. Discover its ID
    // before the cleanup snapshot; an unresolved request cannot be declared gone.
    if (record.provisionIntent) record = await durable.reconcile(record);
    const {connectionId, sourceId, destinationId} = record.airbyte || {};
    distinct?.forget(record.integrationId);
    // Stop Airbyte before deleting its landing data. Native source workers
    // fail their next scope check; an already-started storage write still needs
    // the separate worker quiescence/reconciliation policy.
    if (connectionId) await airbyte.deleteConnection(connectionId).catch(gone);
    if (sourceId) await airbyte.deleteSource(sourceId).catch(gone);
    if (destinationId) await airbyte.deleteDestination(destinationId).catch(gone);
    if (connectionId) jobCache.delete(connectionId);
    let deletedObjects = 0;
    if (record.s3Prefix) deletedObjects = await buckets.deletePrefix(record.s3Bucket || legacyBucket, `${record.s3Prefix}/`);
    if (record.connectedAccountId) await oauth.remove(required(record.connectedAccountId, 'connected account')).catch(gone);
    // A GitHub installation can serve other applications or deployments. Only a
    // runtime that owns the entire managed grant may revoke it on disconnect.
    if (record.installationId && revokeInstallation) await revokeInstallation(record.installationId).catch(gone);
    try {
      await registry.update(record, {status: 'disconnected', disconnectedAt: new Date(now()).toISOString(), dataDeletedAt: new Date(now()).toISOString(), deletedObjects},
        {whenStatus: ['disconnecting'], whenFields: {resourceVersion: record.resourceVersion}});
    } catch (error) {
      if (errorInfo(error).code !== 'ConditionalCheckFailedException') throw error;
      const current = await registry.get(record.tenantId, record.userId, record.integrationId);
      if (current?.status === 'disconnected') return;
      // A resource creation returned while cleanup was running. Its durable IDs
      // must be removed before this connection can be marked finished.
      if (current?.status === 'disconnecting') return disconnectRecord(current);
      throw error;
    }
  }

  /** What the card shows. Airbyte and the OAuth adapter details never leave the server. */
  async function view(principal: Principal, record: IntegrationRecord | null, provider: Provider): Promise<SourceCard & {integrationId?: string; connectedById?: string}>  {
    const base = {provider: provider.id, name: provider.name, description: provider.description, units: provider.units, scope: provider.scope, help: provider.help, auth: provider.auth === 'api-key' ? 'api-key' as const : 'oauth' as const, keyHelp: provider.keyHelp};
    if (!record) return {...base, state: 'disconnected'};
    // Older saved labels used a retired separator; normalize display without
    // rewriting provider records or their authorization metadata.
    const account = record.account?.replace(/\s*\u00b7\s*/gu, ', ') || null;
    const shown = {...base, integrationId: record.integrationId, account, total: record.total ?? null,
      connectedBy: record.userId === principal.userId ? null : record.ownerEmail || 'a teammate', connectedById: record.userId, connectedAt: record.createdAt || null};
    if (record.status === 'connecting') {
      // Someone else's unfinished sign-in doesn't block the card for the rest of the team.
      if (record.userId !== principal.userId) return {...base, state: 'disconnected'};
      if (provider.auth !== 'github-app' && record.connectedAccountId) {
        const signIn = await pendingSignIn(record, provider);
        if (signIn !== 'pending') return {...shown, state: 'error', recoveryAction: 'connect',
          message: signIn === 'expired' ? `${provider.name} sign-in expired. Restart sign-in to connect.`
            : `${provider.name} sign-in didn’t finish. Restart sign-in to connect.`};
      }
      return {...shown, state: 'connecting'};
    }
    if (record.status === 'provisioning') return provisioning.has(record.integrationId) ? {...shown, state: 'syncing', synced: 0}
      : {...shown, state: 'error', message: 'Connection setup was interrupted. Retry to recover it.'};
    if (record.status === 'disconnecting') return {...shown, state: 'error', recoveryAction: 'disconnect', message: 'Disconnecting is not complete. Retry to finish removing this connection.'};
    if (record.status === 'error' && record.error === 'setup') return {...shown, state: 'error', message: 'We couldn’t finish setting up this connection.'};
    if (record.status === 'error' && record.error === 'recovery') return {...shown, state: 'error', message: 'Connection setup is waiting for an earlier request to finish. Retry later; contact support if it persists.'};
    if (record.status === 'error' && record.error === 'reconnect') return {...shown, state: 'error', reconnect: true, message: `We couldn’t finish setting up ${provider.name}. Disconnect it, then connect again with your API key.`};
    const jobs = record.airbyte?.connectionId ? await jobsFor(record.airbyte.connectionId) : [];
    const running = jobs.find(j => ['pending', 'running', 'incomplete'].includes(j.status));
    const live = await airbyte.streamCounts(required(record.airbyte?.connectionId, 'connection')).catch(() => null);
    // Distinct records from the bucket: Airbyte's per-sync row counts repeat every full-refresh
    // stream and every updated record. Only initial live import progress comes from Airbyte.
    const succeededSyncs = new Set(jobs.filter(j => j.status === 'succeeded').map(j => Number(j.jobId)));
    const unique = distinct ? await distinct.get(record, provider, succeededSyncs) : null;
    const counts = !unique ? live : !succeededSyncs.size && live
      ? Object.fromEntries([...new Set([...Object.keys(live), ...Object.keys(unique)])].map(s => [s, Math.max(live[s] || 0, unique[s] || 0)]))
      : unique;
    // The headline counts only the provider's main streams (messages, not channel or user lists).
    const synced = counts ? provider.progressStream.reduce((sum, stream) => sum + (counts[stream] || 0), 0) : jobs.reduce((sum, j) => sum + (j.rowsSynced || 0), 0);
    // Once every message is in, only trailing work (restoring long messages) is still running.
    const bulkDone = !!record.total && synced >= record.total;
    const rows = (provider.progress || []).map(({stream, label, trailing}) => ({label, count: counts?.[stream] || 0, trailing: !!trailing, done: !running || (bulkDone && !trailing)}));
    const succeeded = jobs.find(j => j.status === 'succeeded');
    const latest = jobs[0];
    const lastSyncedAt = succeeded ? (succeeded.lastUpdatedAt || succeeded.startTime) : null;
    if (running || !latest) {
      // ETA from the current import pace, only once it has a total and some progress.
      let eta = null;
      const started = Date.parse(running?.startTime || '');
      if (!succeeded && record.total && synced > 0 && synced < record.total && started) {
        const rate = synced / Math.max(1, now() - started);
        eta = Math.round((record.total - synced) / rate / 1000);
      }
      return {...shown, state: 'syncing', synced, rows, eta, initial: !succeeded, finishing: bulkDone && rows.some(r => r.trailing), lastSyncedAt};
    }
    if (latest.status === 'failed' || latest.status === 'cancelled') return {...shown, state: 'error', synced, lastSyncedAt, message: 'The last sync didn’t finish. We’ll retry on schedule, or you can retry now.'};
    return {...shown, state: 'synced', synced, rows, lastSyncedAt};
  }

  async function connectWithKey(principal: Principal, provider: KeyProvider, apiKey: unknown) {
    const invalid = (message: string) => Object.assign(new Error(message), {status: 400, expose: true});
    if (typeof apiKey !== 'string' || !new RegExp(provider.keyHelp.pattern).test(apiKey.trim())) throw invalid(`That doesn’t look like a ${provider.name} workspace API key.`);
    const key = apiKey.trim();
    const api = direct(key);
    const {label, workspace} = await provider.account(api, principal);
    const s3Bucket = await teamBucket(principal);
    const stamp = new Date(now()).toISOString();
    let record: IntegrationRecord = {integrationId: integrationId(), tenantId: principal.tenantId, userId: principal.userId, ownerEmail: principal.email || null,
      provider: provider.id, scope: provider.scope, environment, s3Bucket, provisionProtocol: 1, status: 'provisioning', account: label || null, workspace,
      createdAt: stamp, updatedAt: stamp, startDate: new Date(now() - backfillDays * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z')};
    record.s3Prefix = landingPrefix(provider, record);
    await registry.create(record);
    // Two admins pasting keys at once: the earliest connection wins.
    const [first] = (await registry.listTenant(principal.tenantId)).filter(r => visible(principal, provider, r) && r.status !== 'connecting')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.integrationId.localeCompare(b.integrationId));
    if (first && first.integrationId !== record.integrationId) {
      await registry.update(record, {status: 'abandoned'});
      throw Object.assign(new Error('Already connected'), {status: 409});
    }
    // Answer now; Airbyte setup takes up to a minute and the card shows its setup status.
    provision(record, {apiKey: key}).catch(async () => {
      // Without a source, Airbyte never stored the key, so a retry can't work: ask to reconnect.
      const failed = (await registry.get(record.tenantId, record.userId, record.integrationId))!;
      if (failed?.status !== 'error' || failed.airbyte?.sourceId || failed.provisionIntent) return;
      await registry.update(record, {status: 'error', error: 'reconnect'},
        {whenStatus: ['error'], whenFields: {provisionVersion: failed.provisionVersion, provisionRun: failed.provisionRun}});
    }).catch(error => log('integration.provision.cleanup_failed', {integrationId: record.integrationId, message: errorInfo(error).message}));
    provider.total(api, {startDate: record.startDate})
      .then(total => registry.update(record, {total}, {whenStatus: ACTIVE}))
      .catch(error => log('integration.total.failed', {integrationId: record.integrationId, message: errorInfo(error).message}));
    return {connected: true};
  }

  // Every continuation obtains a fresh GitHub user grant. Never persist the user token,
  // and never infer repository authority merely from installation visibility.
  async function completeGitHub(principal: Principal, provider: GithubProvider, query: URLSearchParams): Promise<IntegrationCompletion> {
    const parts = (query.get('state') || '').split('.');
    const [id = '', nonce = '', selectedId = ''] = parts;
    const callbackId = query.get('installation_id') || '';
    if (!INTEGRATION.test(id) || parts.length < 2 || parts.length > 3 ||
      (parts.length === 3 && !/^[1-9]\d{0,19}$/.test(selectedId)) ||
      (callbackId && !/^[1-9]\d{0,19}$/.test(callbackId)) ||
      (selectedId && callbackId && selectedId !== callbackId)) return {ok: false, reason: 'invalid'};
    const record = await registry.get(principal.tenantId, principal.userId, id);
    if (!record || record.provider !== provider.id) return {ok: false, reason: 'invalid'};
    const expected = Buffer.from(required(record.nonce, 'connection nonce')), given = Buffer.from(nonce);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return {ok: false, reason: 'invalid'};
    if (record.status !== 'connecting') return {ok: ACTIVE.includes(record.status), reason: 'done'};
    if (!query.get('code')) {
      await registry.update(record, {status: 'abandoned'}, {whenStatus: ['connecting']});
      return {ok: false, reason: 'declined'};
    }
    const state = `${id}.${nonce}`;
    const callbackUrl = new URL('/integrations/github/callback', appUrl).href;
    const userToken = await github!.userToken(query.get('code')!, callbackUrl);
    let installation;
    let repositories: GithubRepository[] = [];
    try {
      const installations = await github!.userInstallations(userToken);
      if (installations.some(item => !/^[1-9]\d{0,19}$/.test(String(item.id)) || !item.account?.login)) throw new Error('Invalid GitHub installation response');
      const installationId = selectedId || callbackId;
      if (installationId) installation = installations.find(item => String(item.id) === installationId);
      else if (installations.length === 1) installation = installations[0];
      else return {ok: false, reason: 'choose', actions: [
        ...installations.map(item => ({label: `Connect ${item.account.login}`, url: github!.authorizeUrl(`${state}.${item.id}`, callbackUrl)})),
        {label: installations.length ? 'Install for another account' : 'Install GitHub App', url: github!.installUrl(state)},
      ]};
      if (installation) repositories = await github!.userRepositories(userToken, String(installation.id));
    }
    finally { await github!.revokeUserToken(userToken); }
    if (!installation) return {ok: false, reason: 'invalid'};
    if (!repositories.length) return {ok: false, reason: 'repositories'};
    if (repositories.some(repo => !Number.isSafeInteger(repo.id) || repo.id <= 0)) throw new Error('Invalid GitHub repository response');
    const installationId = String(installation.id);
    const githubRepositoryIds = [...new Set(repositories.map(repo => repo.id))];
    const {label, workspace} = provider.account(installation, repositories);
    const s3Prefix = landingPrefix(provider, {...record, workspace});
    const taken = (await registry.listTenant(principal.tenantId)).some(r => r.integrationId !== record.integrationId && visible(principal, provider, r) && r.status !== 'connecting');
    if (taken) {
      await registry.update(record, {status: 'abandoned'}, {whenStatus: ['connecting']});
      return {ok: false, reason: 'taken'};
    }
    let claimed;
    try { claimed = await registry.update(record, {status: 'provisioning', installationId, githubRepositoryIds, account: label, workspace, s3Prefix}, {whenStatus: ['connecting']}); }
    catch (error) {
      if (errorInfo(error).code !== 'ConditionalCheckFailedException') throw error;
      const current = await registry.get(principal.tenantId, principal.userId, id);
      return {ok: !!current && ['provisioning', 'active', 'error'].includes(current.status), reason: 'done'};
    }
    provision(claimed).catch(() => {});
    return {ok: true, reason: 'connected'};
  }

  async function resume(record: IntegrationRecord, provider: Provider) {
    if (record.status === 'disconnecting') return disconnectRecord(record);
    if (provisioning.has(record.integrationId)) throw Object.assign(new Error('Connection setup is already running'), {status: 409});
    if (record.error === 'reconnect' && !record.provisionIntent) throw Object.assign(new Error(`Disconnect ${provider.name}, then connect it again with your API key.`), {status: 400, expose: true});
    if (record.status === 'provisioning' || (record.status === 'error' && ['setup', 'recovery', 'reconnect'].includes(record.error || ''))) {
      if (!record.s3Prefix) {
        if (provider.auth === 'github-app') throw Object.assign(new Error('Disconnect GitHub, then reconnect to confirm repository access.'), {status: 400, expose: true});
        const {label, workspace, settings} = await provider.account(proxyFor(record), record);
        record = await registry.update(record, {account: label || null, workspace: workspace || null, ...(settings ? {settings} : {}), provisionVersion: randomBytes(16).toString('hex')},
          {whenStatus: ['error', 'provisioning'], whenFields: {provisionVersion: record.provisionVersion, provisionRun: record.provisionRun}});
        record = await registry.update(record, {s3Prefix: landingPrefix(provider, record), provisionVersion: randomBytes(16).toString('hex')},
          {whenStatus: ['error', 'provisioning'], whenFields: {provisionVersion: record.provisionVersion, provisionRun: record.provisionRun}});
      }
      return provision(record);
    }
    jobCache.delete(required(record.airbyte?.connectionId, 'connection'));
    await airbyte.sync(required(record.airbyte?.connectionId, 'connection')).catch(error => { if (errorInfo(error).status !== 409) throw error; });
    if (record.status === 'error') await registry.update(record, {status: 'active', error: null}, {whenStatus: ['error']});
  }

  return {
    providers: () => Object.values(providers),

    /** Recover one explicitly scoped record; fleet discovery belongs to the runtime. */
    async recoverRecord(record: IntegrationRecord) {
      requireWritable();
      if (record.environment !== environment || !providers[record.provider] || !TENANT.test(record.tenantId) || !USER.test(record.userId) || !INTEGRATION.test(record.integrationId)) throw new Error('Invalid provisioning recovery scope');
      // Discovery can race a completed setup or disconnect. Recovery only resumes
      // unfinished work; it must not sync active or deleted connections at startup.
      const current = await registry.get(record.tenantId, record.userId, record.integrationId);
      if (!current) return;
      if (current.environment !== environment || current.provider !== record.provider || current.tenantId !== record.tenantId || current.userId !== record.userId || current.integrationId !== record.integrationId) throw new Error('Invalid provisioning recovery scope');
      if (current.status !== 'provisioning' && current.status !== 'disconnecting'
        && !(current.status === 'error' && ['setup', 'recovery'].includes(current.error || ''))) return;
      return resume(current, providers[current.provider]);
    },

    async list(principal: Principal): Promise<Array<SourceCard & {integrationId?: string; connectedById?: string}>> {
      const records = await registry.listTenant(principal.tenantId);
      return Promise.all(Object.values(providers).map(provider => {
        // A teammate's unfinished sign-in never hides a live team connection.
        const live = records.filter(r => visible(principal, provider, r));
        const record = newest(live.filter(r => r.status !== 'connecting')) || newest(live);
        return view(principal, record, provider).catch(error => {
          log('integration.status.failed', {provider: provider.id, message: errorInfo(error).message});
          return {provider: provider.id, name: provider.name, description: provider.description, units: provider.units, scope: provider.scope, help: provider.help, auth: provider.auth === 'api-key' ? 'api-key' as const : 'oauth' as const, keyHelp: provider.keyHelp, state: 'unavailable' as const};
        });
      }));
    },

    /**
     * Starts hosted sign-in and returns the URL to open, or for key-based providers checks the
     * pasted key and starts the import. One live connection per provider and owner.
     */
    async connect(principal: Principal, providerId: string, {apiKey}: {apiKey?: unknown} = {}) {
      requireWritable();
      const provider = providerFor(providerId);
      const live = (await registry.listTenant(principal.tenantId)).filter(r => visible(principal, provider, r));
      if (live.some(r => r.status !== 'connecting')) throw Object.assign(new Error('Already connected'), {status: 409});
      // Team-wide sources land under the OpenCrawl organization.
      if (provider.teamOnly && !ORG.test(principal.tenantId)) throw Object.assign(new Error(`Connect ${provider.name} from your team’s OpenCrawl organization.`), {status: 400, expose: true});
      if (provider.auth === 'api-key') return connectWithKey(principal, provider, apiKey);
      // The team bucket exists before anyone signs in, so setup can't fail on it later.
      const s3Bucket = await teamBucket(principal);
      const record: IntegrationRecord = {integrationId: integrationId(), tenantId: principal.tenantId, userId: principal.userId, ownerEmail: principal.email || null,
        provider: provider.id, scope: provider.scope, environment, s3Bucket, provisionProtocol: 1, status: 'connecting', nonce: randomBytes(24).toString('base64url'),
        createdAt: new Date(now()).toISOString(), startDate: new Date(now() - backfillDays * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z')};
      for (const mine of live.filter(r => r.userId === principal.userId)) await registry.update(mine, {status: 'abandoned'}, {whenStatus: ['connecting']}).catch(() => {});
      if (provider.auth === 'github-app') {
        if (!github) throw Object.assign(new Error('GitHub isn’t available yet.'), {status: 503, expose: true});
        // OAuth also returns when the app was already installed for this account.
        await registry.create({...record, updatedAt: record.createdAt});
        return {redirectUrl: github.authorizeUrl(`${record.integrationId}.${record.nonce}`, new URL('/integrations/github/callback', appUrl).href)};
      }
      const authConfigId = await oauth.authConfig({toolkit: provider.toolkit, ...provider.authConfig});
      const callback = new URL(`/integrations/${provider.id}/callback`, appUrl);
      callback.searchParams.set('integration', record.integrationId);
      callback.searchParams.set('state', record.nonce!);
      const link = await oauth.link({authConfigId, userId: oauthUser(record), callbackUrl: callback.href});
      await registry.create({...record, connectedAccountId: link.connected_account_id, authConfigId, updatedAt: record.createdAt});
      return {redirectUrl: link.redirect_url};
    },

    /**
     * Completes sign-in. The callback's query string is untrusted: the integration must belong
     * to this signed-in user, the state must match, and the OAuth adapter must confirm the account is
     * the one we created for them and is active.
     */
    async complete(principal: Principal, providerId: string, query: URLSearchParams): Promise<IntegrationCompletion> {
      requireWritable();
      const provider = providerFor(providerId);
      if (provider.auth === 'github-app') return completeGitHub(principal, provider, query);
      const id = query.get('integration') || '';
      if (!INTEGRATION.test(id)) return {ok: false, reason: 'invalid'};
      const record = await registry.get(principal.tenantId, principal.userId, id);
      if (!record || record.provider !== provider.id) return {ok: false, reason: 'invalid'};
      if (record.status !== 'connecting') return {ok: ACTIVE.includes(record.status), reason: 'done'};
      const expected = Buffer.from(required(record.nonce, 'connection nonce')), given = Buffer.from(query.get('state') || '');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return {ok: false, reason: 'invalid'};
      if (query.get('connected_account_id') && query.get('connected_account_id') !== record.connectedAccountId) return {ok: false, reason: 'invalid'};
      if (query.get('status') === 'failed') {
        await registry.update(record, {status: 'abandoned'}, {whenStatus: ['connecting']});
        return {ok: false, reason: 'declined'};
      }
      const account = await oauth.account(required(record.connectedAccountId, 'connected account'));
      if (account?.status !== 'ACTIVE' || account.is_disabled || (account.toolkit?.slug || '').toLowerCase() !== provider.toolkit) return {ok: false, reason: 'declined'};
      if (provider.scope === 'team') {
        const taken = (await registry.listTenant(principal.tenantId)).some(r => r.integrationId !== record.integrationId && visible(principal, provider, r) && r.status !== 'connecting');
        if (taken) {
          await oauth.remove(required(record.connectedAccountId, 'connected account')).catch(() => {});
          await registry.update(record, {status: 'abandoned'}, {whenStatus: ['connecting']});
          return {ok: false, reason: 'taken'};
        }
      }
      let claimed;
      try { claimed = await registry.update(record, {status: 'provisioning'}, {whenStatus: ['connecting']}); }
      catch (error) { if (errorInfo(error).code === 'ConditionalCheckFailedException') return {ok: true, reason: 'done'}; throw error; }
      const proxy = proxyFor(claimed);
      try {
        // `settings` is what the source needs beyond the grant (Circleback's Workspace folder).
        const {label, workspace, settings} = await provider.account(proxy, claimed);
        claimed = await registry.update(claimed, {account: label || null, workspace: workspace || null, ...(settings ? {settings} : {})}, {whenStatus: ['provisioning']});
        claimed = await registry.update(claimed, {s3Prefix: landingPrefix(provider, claimed)}, {whenStatus: ['provisioning']});
      } catch (error) {
        log('integration.account.failed', {integrationId: claimed.integrationId, message: errorInfo(error).message});
        if (errorInfo(error).code === 'ConditionalCheckFailedException') return {ok: false, reason: 'done'};
        await registry.update(claimed, {status: 'error', error: 'setup'}, {whenStatus: ['provisioning']});
        return {ok: true, reason: 'connected'};
      }
      // Counting can take a few calls; the card shows "of N" once it lands.
      provider.total(proxy, {startDate: claimed.startDate, now: now(), record: claimed})
        .then(total => registry.update(claimed, {total}, {whenStatus: ACTIVE}))
        .catch(error => log('integration.total.failed', {integrationId: claimed.integrationId, message: errorInfo(error).message}));
      // Setup runs in the background; the card shows progress and any failure.
      provision(claimed).catch(() => {});
      return {ok: true, reason: 'connected'};
    },

    /** Retries setup if it failed, otherwise runs a sync now. */
    async retry(principal: Principal, providerId: string) {
      requireWritable();
      const provider = providerFor(providerId);
      const record = await current(principal, provider);
      if (!record || record.status === 'connecting') throw Object.assign(new Error('Not connected'), {status: 404});
      return resume(record, provider);
    },

    /** Stops syncing, deletes the imported data and revokes the grant. */
    async disconnect(principal: Principal, providerId: string) {
      requireWritable();
      const record = await current(principal, providerFor(providerId));
      if (record) await disconnectRecord(record);
    },

    /** Disconnects every live connection this user can see: their own and the team's. Returns how many. */
    async disconnectAll(principal: Principal) {
      requireWritable();
      const records = (await registry.listTenant(principal.tenantId))
        .filter(r => VISIBLE.includes(r.status) && (r.userId === principal.userId || providers[r.provider]?.scope === 'team'));
      for (const record of records) await disconnectRecord(record);
      return records.length;
    },
  };
}

export type Integrations = ReturnType<typeof createIntegrations>;
