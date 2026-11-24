import type {SourceCard} from '../application/types.mjs';
import {errorInfo, required} from '../errors.mjs';
import type {Principal} from '../sessions/types.mjs';
import type {Environment} from './types.mjs';
import type {Log, ConnectorOAuth, LandingDestination} from './ports.mjs';
import type {Airbyte} from './airbyte.mjs';
import type {IntegrationRegistry as Registry} from './ports.mjs';
import type {IntegrationCommand, IntegrationCommands, IntegrationCommandReference} from './temporal/types.mjs';
import type {createSingleOrganizationRegistry} from './local-registry.mjs';
import type {IntegrationResources} from '../state/integration-resources.mjs';
import type {IntegrationStorage as TeamBuckets} from './ports.mjs';
import type {GithubApp} from './github.mjs';
import type {Provider, ProviderCatalog, KeyProvider, GithubProvider, GithubRepository, IntegrationRecord, Proxy, ProxyRequest, ProviderData, AirbyteJob, AirbyteResource, ResourceName, ConnectorDefinition} from './types.mjs';
export interface IntegrationCompletion {ok: boolean; reason: string; actions?: Array<{label: string; url: string}>}
export interface AirbyteLifecycle {
  commands: IntegrationCommands;
  resources: IntegrationResources;
  requests: Pick<ReturnType<typeof createSingleOrganizationRegistry>, 'requestLifecycle'|'createWithLifecycle'>;
  start(reference: IntegrationCommandReference): Promise<unknown>;
  authorize(command: IntegrationCommand, record: IntegrationRecord): Promise<boolean>;
  validateCleanupTarget(record:IntegrationRecord):Promise<string|null>;
}
export interface IntegrationOptions {
  environment: Environment; appUrl: string; buckets: TeamBuckets; legacyBucket: string; workspaceId: (mode?: 'existing') => Promise<string>; destination: LandingDestination;
  backfillDays?: number; schedule?: string; oauth: ConnectorOAuth; airbyte: Airbyte; registry: Registry;
  providers: ProviderCatalog; github?: GithubApp | null; direct?: typeof directApi; now?: () => number;
  log?: Log; maintenance?: boolean; revokeInstallation?: (installationId: string) => Promise<void>; lifecycle?: AirbyteLifecycle;
}
interface Secrets {apiKey?: string}
interface StatusSnapshot {jobs: AirbyteJob[]; live: Record<string, number> | null}
interface StatusEntry {attemptedAt: number; updatedAt?: number; value?: StatusSnapshot; pending?: Promise<void>; failed: boolean}
type PendingSignInState = 'pending' | 'expired' | 'unavailable';
// Product lifecycle: runtimes supply credential and infrastructure adapters.
import {createHash,randomBytes, timingSafeEqual} from 'node:crypto';
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
 * has no workspace ID (Granola).
 */
export function landingPrefix(provider: Provider, record: IntegrationRecord) {
  if (!TENANT.test(record.tenantId) || !USER.test(record.userId) || !INTEGRATION.test(record.integrationId)) throw new Error('Invalid integration scope');
  const owner = provider.owner(record);
  // Slack team IDs and GitHub account IDs, OpenCrawl organization IDs (Granola), Notion workspace UUIDs.
  if (!/^(user=user_[A-Za-z0-9]+|workspace=([A-Z0-9]+|org_[A-Za-z0-9]+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}))$/.test(owner)) throw new Error('Invalid integration owner');
  return `raw/v1/source=${provider.id}/${owner}/connection=${record.integrationId}`;
}

/**
 * Calls a provider's API directly with a key the user pasted, in the same {status, data} shape as
 * the OAuth adapter proxy. The durable handoff stores an expiring encrypted key until Airbyte owns the source.
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

export function createIntegrations({environment, appUrl, buckets, legacyBucket, workspaceId: workspaceIdOf, destination, backfillDays = 90, schedule = '0 0 * * * ?', oauth, airbyte, registry, providers, github = null, direct = directApi, now = () => Date.now(), log = () => {}, maintenance = false, revokeInstallation, lifecycle}: IntegrationOptions) {
  const pendingAccountCache = new Map<string, {at: number; result: Promise<PendingSignInState>}>();
  const statusCache = new Map<string, StatusEntry>();
  const statusKey = (record: IntegrationRecord) => JSON.stringify([environment, record.tenantId, record.userId, record.integrationId, record.airbyte?.connectionId]);
  const provisioning = new Map<string, Promise<IntegrationRecord>>();
  const requireWritable = () => {
    if (maintenance) throw Object.assign(new Error('Integration maintenance is in progress. Please retry shortly.'), {status: 503, expose: true});
  };
  async function dispatch(reference: IntegrationCommandReference) {
    // Outbox and requested state already committed. The scheduled dispatcher
    // also starts this same workflow ID if the immediate RPC is interrupted.
    await lifecycle!.start(reference).catch(() => log('integration.command.start_pending', {integrationId:reference.integrationId}));
  }
  function requireExecutionOwner(record:IntegrationRecord, reference?:IntegrationCommandReference){
    if(record.lifecycleCommandId !== reference?.commandId)throw Object.assign(new Error('Integration command superseded'),{status:409,code:'ConditionalCheckFailedException'});
  }
  const durable = createProvisioning({environment, registry, airbyte, now});
  const distinct = typeof buckets?.list === 'function' ? createRecordCounts({buckets, legacyBucket, log, now}) : null;

  const oauthUser = ({tenantId, userId}: Pick<Principal, 'tenantId' | 'userId'>) => `${environment}:${tenantId}:${userId}`;
  const proxyFor = (record: IntegrationRecord): Proxy => request => oauth.proxy({...request, connectedAccountId: required(record.connectedAccountId, 'connected account'), userId: oauthUser(record)});
  const providerFor = (id: string) => {
    const provider = providers[id];
    if (!provider) throw Object.assign(new Error('Unknown integration'), {status: 404});
    return provider;
  };
  function measureTotal(record:IntegrationRecord,provider:Exclude<Provider,GithubProvider>,api:Proxy){
    provider.total(api,{startDate:record.startDate,now:now(),record})
      .then(total=>registry.update(record,{total},{whenStatus:ACTIVE}))
      .catch(()=>log('integration.total.failed',{integrationId:record.integrationId}));
  }
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
    if(lifecycle){
      const find=async()=>{
        const matches=(await airbyte.declarativeSources(id)).filter(item=>item.name===name);
        if(matches.length>1)throw Object.assign(new Error('Multiple Airbyte definitions match'),{code:'ProvisioningRecoveryPending'});
        return matches[0];
      };
      const identity=createHash('sha256').update(JSON.stringify([id,name])).digest('hex');
      const definitionId=await lifecycle.resources.ensure({kind:'airbyte-definition',scope:id,name,fingerprint:identity},{
        async find(){const found=await find();return found?{id:found.id,fingerprint:identity}:null;},
        async create(){return (await airbyte.createDeclarativeSource(id,name,manifest!)).id;},
      });
      const fingerprint=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
      await lifecycle.resources.ensure({kind:'airbyte-manifest',scope:id,name,fingerprint:fingerprint(manifest)},{
        async find(){const found=await find();if(!found||found.id!==definitionId)throw new Error('Airbyte definition binding changed');return {id:found.id,fingerprint:fingerprint(found.manifest)};},
        async create(){await airbyte.updateDeclarativeSource(id,definitionId,manifest!);return definitionId;},
      });
      return definitionId;
    }
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

  function statusFor(record: IntegrationRecord) {
    const key = statusKey(record);
    let entry = statusCache.get(key);
    if (entry && (entry.pending || now() - entry.attemptedAt < 5000)) return entry;
    if (!entry) {
      // Never evict in-flight work and start a duplicate refresh under load.
      if (statusCache.size >= 256) {
        const idle = [...statusCache].find(([, value]) => !value.pending);
        if (!idle) return {attemptedAt: now(), failed: true} satisfies StatusEntry;
        statusCache.delete(idle[0]);
      }
      entry = {attemptedAt: now(), failed: false};
      statusCache.set(key, entry);
    }
    const connectionId = required(record.airbyte?.connectionId, 'connection');
    const refreshing = entry;
    refreshing.attemptedAt = now();
    // Status is display data, never an access decision. The registry is still read
    // for every request; a slow or failed provider cannot block that response.
    refreshing.pending = Promise.all([airbyte.jobs(connectionId, 100), airbyte.streamCounts(connectionId).catch(() => null)])
      .then(async ([jobs, live]) => {
        if (statusCache.get(key) !== refreshing) return;
        refreshing.value = {jobs, live};
        refreshing.updatedAt = now();
        refreshing.failed = false;
        // Warm durable counts off the response path too. Their own refresh is
        // single-flight and publishes saved measurements before any raw scan.
        if (distinct) await distinct.get(record, providerFor(record.provider), new Set(jobs.filter(job => job.status === 'succeeded').map(job => Number(job.jobId))), {wait:0});
      }).catch(error => {
        refreshing.failed = true;
        log('integration.status.refresh_failed', {provider: record.provider, integrationId: record.integrationId, message: errorInfo(error).message});
      }).finally(() => {refreshing.pending = undefined;});
    return refreshing;
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
  async function provisionRecord(record: IntegrationRecord, secrets: Secrets, reference?: IntegrationCommandReference, signal?:AbortSignal) {
    requireWritable();
    const provider = providerFor(record.provider);
    if(provider.unavailableReason)throw Object.assign(new Error(provider.unavailableReason),{status:503,expose:true});
    record = (await registry.get(record.tenantId, record.userId, record.integrationId))!;
    requireExecutionOwner(record,reference);
    if (!['provisioning','error'].includes(record.status)) throw Object.assign(new Error('Connection setup is no longer authorized'), {status: 409});
    destination.validate(record);
    const run = randomBytes(16).toString('hex');
    record = await registry.update(record, {status: 'provisioning', error: null, provisionRun: run, provisionVersion: randomBytes(16).toString('hex')},
      {whenStatus: [record.status], whenFields: {provisionVersion: record.provisionVersion, lifecycleCommandId:reference?.commandId}});
    const label = provisioningLabel(record);
    let ids = {...record.airbyte};
    const save = async (fields: Partial<IntegrationRecord>) => record = await registry.update(record, fields,
      {whenStatus: ['provisioning'], whenFields: {provisionVersion: record.provisionVersion, provisionRun: run, lifecycleCommandId:reference?.commandId}});
    let workspaceId: string;
    async function resource(name: ResourceName, create: () => Promise<AirbyteResource>) {
      signal?.throwIfAborted();
      record = await durable.ensure(record, name, workspaceId, create);
      ids = {...record.airbyte};
      if (record.status !== 'provisioning' || record.provisionRun !== run) {
        if (record.status === 'disconnecting' && !record.lifecycleCommandId) await disconnectRecord(record);
        throw Object.assign(new Error('Connection setup is no longer authorized'), {status: 409});
      }
    }
    try {
      if (record.provisionIntent) {
        record = await durable.reconcile(record);
        if(reference){if(record.airbyte?.sourceId)await lifecycle!.commands.clearSecret(reference);return record;}
      }
      ids = {...record.airbyte};
      if (record.s3Prefix !== landingPrefix(provider, record)) throw new Error('Invalid provisioning landing scope');
      workspaceId = record.airbyteWorkspaceId || await workspaceIdOf();
      if (!ids.destinationId) {
        const destinationFields = await destination.prepare(record);
        if (Object.keys(destinationFields).length) record = await save(destinationFields);
        const destinationSettings = await destination.settings(record);
        await resource('destinationId', () => airbyte.createDestination({workspaceId, name: label, ...destinationSettings}));
        if (reference) return record;
      }
      if (!ids.sourceId) {
        if (provider.auth === 'api-key' && !secrets.apiKey) {
          throw Object.assign(new Error('Reconnect with your workspace API key to finish setup.'), {code: 'ProvisioningKeyRequired'});
        }
        const definitionId = await definitionFor(provider, workspaceId);
        const configuration = provider.auth === 'api-key'
          ? provider.sourceConfiguration({startDate: record.startDate, apiKey: secrets.apiKey})
          : provider.auth === 'github-app' ? provider.sourceConfiguration({githubApp: github!.sourceSettings(), record})
          : await oauth.sourceConfiguration(record, provider);
        await resource('sourceId', () => airbyte.createSource({workspaceId, name: label, definitionId, configuration}));
        if (reference) {await lifecycle!.commands.clearSecret(reference);return record;}
      }
      if (!ids.connectionId) {
        await resource('connectionId', () => airbyte.createConnection({name: label, sourceId: ids.sourceId, destinationId: ids.destinationId,
          namespaceDefinition: 'destination', schedule: {scheduleType: 'cron', cronExpression: provider.schedule || schedule}, status: 'active',
          configurations: {streams: provider.streamsFor?.(record) ?? provider.streams}}));
        if (reference) return record;
      }
      const connectionId=required(ids.connectionId, 'connection');
      if (reference) {
        const previousJobId=await airbyte.latestSyncJobId(connectionId);
        if (record.initialSyncIntent) {
          // An accepted POST may have outlived the worker. The first sync is
          // satisfied by a new job on this exact connection (including its cron).
          const baseline=record.initialSyncIntent.previousJobId;
          if(previousJobId===null||baseline!==null&&BigInt(previousJobId)<=BigInt(baseline)) {
            throw Object.assign(new Error('Awaiting evidence of the initial Airbyte sync'),{code:'ProvisioningRecoveryPending'});
          }
          return save({status:'active'});
        }
        await save({initialSyncIntent:{commandId:reference.commandId,previousJobId}});
      }
      signal?.throwIfAborted();
      await airbyte.sync(connectionId).catch(error => { if (errorInfo(error).status !== 409) throw error; });
      return await save({status: 'active'});
    } catch (error) {
      // Airbyte validation errors may echo the source configuration.
      if (secrets.apiKey && error instanceof Error) error.message = error.message.replaceAll(secrets.apiKey, '[redacted]');
      log('integration.provision.failed', {integrationId: record.integrationId});
      // Never replace the durable resource map with a stale local snapshot after
      // an ambiguous POST or a concurrent recovery/disconnect.
      const failed = (await registry.get(record.tenantId, record.userId, record.integrationId))!;
      await registry.update(failed, {status: 'error', error: failed.provisionIntent || failed.initialSyncIntent ? 'recovery' : errorInfo(error).code === 'ProvisioningKeyRequired' ? 'reconnect' : 'setup'},
        {whenStatus: ['provisioning'], whenFields: {provisionVersion: failed.provisionVersion, provisionRun: run}})
        .catch(failure => {if (errorInfo(failure).code !== 'ConditionalCheckFailedException') throw failure;});
      throw error;
    }
  }

  async function revokeGrants(record: IntegrationRecord, verifyBinding: boolean) {
    const gone = (error: unknown) => {if (errorInfo(error).status !== 404) throw error;};
    const id = record.connectedAccountId;
    if (id) {
      if (verifyBinding) {
        const grant = await oauth.account(id).catch(error => {gone(error); return null;});
        if (grant && (grant.id !== id || grant.user_id !== oauthUser(record) ||
          grant.toolkit?.slug?.toLowerCase() !== providerFor(record.provider).toolkit)) throw new Error('Cleanup grant binding changed');
        if (grant) await oauth.remove(id).catch(gone);
      } else await oauth.remove(id).catch(gone);
    }
    // Only runtimes that own the whole GitHub installation supply a revoker.
    if (record.installationId && revokeInstallation) await revokeInstallation(record.installationId).catch(gone);
  }

  /** Stops syncing, deletes everything this connection imported, then revokes the grant. */
  async function disconnectRecord(record: IntegrationRecord, reference?:IntegrationCommandReference,signal?:AbortSignal): Promise<void> {
    requireWritable();
    requireExecutionOwner(record,reference);
    const gone = (error: unknown) => { if (errorInfo(error).status !== 404) throw error; };
    // Revoke reads and queued writes before touching providers. Failed cleanup stays
    // visible and retryable; setup callbacks cannot reactivate this record.
    record = await registry.update(record, {status: 'disconnecting'}, {whenStatus: VISIBLE,whenFields:{lifecycleCommandId:reference?.commandId}});
    // A successful create may have outlived its app process. Discover its ID
    // before the cleanup snapshot; an unresolved request cannot be declared gone.
    if(reference){
      const target=await lifecycle!.validateCleanupTarget(record);
      if(target!==(record.s3Prefix??null))throw new Error('Invalid cleanup landing target');
      if(target){
        // Hosted connections predating raw/v1 landed in one fixed legacy
        // bucket, under an exact tenant/owner/provider/connection prefix.
        const legacyPrefix=`${environment}/tenant=${record.tenantId.replace(/^personal:/,'personal-')}/user=${record.userId}/source=${record.provider}/connection=${record.integrationId}`;
        const historical=environment!=='selfhost'&&(record.s3Bucket??legacyBucket)===legacyBucket&&target===legacyPrefix;
        if(!historical&&target!==landingPrefix(providerFor(record.provider),record))throw new Error('Invalid cleanup landing scope');
      }
    }
    if (record.provisionIntent) {
      try {record = await durable.reconcile(record);}
      catch(error){
        if(reference&&errorInfo(error).code==='ProvisioningRecoveryPending')await registry.update(record,{error:'recovery'},
          {whenStatus:['disconnecting'],whenFields:{lifecycleCommandId:reference.commandId,resourceVersion:record.resourceVersion}});
        throw error;
      }
    }
    requireExecutionOwner(record,reference);
    signal?.throwIfAborted();
    const {connectionId, sourceId, destinationId} = record.airbyte || {};
    const resourceVersion=record.resourceVersion??null;
    const progress=reference && record.disconnectProgress?.commandId===reference.commandId && record.disconnectProgress.resourceVersion===resourceVersion ? record.disconnectProgress : undefined;
    const whenFields={resourceVersion:record.resourceVersion,lifecycleCommandId:reference?.commandId,disconnectProgress:record.disconnectProgress};
    async function advance(next:'data'|'grants'|'finish',deletedObjects?:number){
      await registry.update(record,{error:null,disconnectProgress:{commandId:reference!.commandId,resourceVersion,next,deletedObjects}},{whenStatus:['disconnecting'],whenFields});
    }
    distinct?.forget(record.integrationId);
    // Stop Airbyte before deleting its landing data. Native source workers
    // fail their next scope check; an already-started storage write still needs
    // the separate worker quiescence/reconciliation policy.
    if (!progress) {
      if(reference && (connectionId||sourceId||destinationId)){
        const workspaceId=await workspaceIdOf('existing');
        if(record.airbyteWorkspaceId&&record.airbyteWorkspaceId!==workspaceId)throw new Error('Cleanup workspace changed');
        try {await durable.remove(record,workspaceId);}
        catch(error){
          if(errorInfo(error).code==='ProvisioningRecoveryPending')await registry.update(record,{error:'recovery'},{whenStatus:['disconnecting'],whenFields});
          throw error;
        }
      }else{
        if (connectionId) await airbyte.deleteConnection(connectionId).catch(gone);
        if (sourceId) await airbyte.deleteSource(sourceId).catch(gone);
        if (destinationId) await airbyte.deleteDestination(destinationId).catch(gone);
      }
      if (connectionId) statusCache.delete(statusKey(record));
      if(reference)return advance('data');
    }
    let deletedObjects=progress?.deletedObjects??0;
    if (!progress || progress.next==='data') {
      if(record.s3Prefix){
        deletedObjects=await buckets.deletePrefix(record.s3Bucket || legacyBucket, `${record.s3Prefix}/`);
      }
      if(reference)return advance('grants',deletedObjects);
    }
    if (!progress || progress.next==='grants') {
      await revokeGrants(record, !!reference);
      if(reference)return advance('finish',deletedObjects);
    }
    try {
      await registry.update(record, {status: 'disconnected', disconnectedAt: new Date(now()).toISOString(), dataDeletedAt: new Date(now()).toISOString(), deletedObjects},
        {whenStatus: ['disconnecting'], whenFields});
    } catch (error) {
      if (errorInfo(error).code !== 'ConditionalCheckFailedException') throw error;
      const current = await registry.get(record.tenantId, record.userId, record.integrationId);
      if (current?.status === 'disconnected') return;
      // A resource creation returned while cleanup was running. Its durable IDs
      // must be removed before this connection can be marked finished.
      if (current?.status === 'disconnecting' && !reference) return disconnectRecord(current);
      throw error;
    }
  }

  /** What the card shows. Airbyte and the OAuth adapter details never leave the server. */
  async function view(principal: Principal, record: IntegrationRecord | null, provider: Provider): Promise<SourceCard & {integrationId?: string; connectedById?: string}>  {
    const base = {provider: provider.id, name: provider.name, description: provider.description, primaryMetric: provider.primaryMetric, units: provider.units, scope: provider.scope, help: provider.help, auth: provider.auth === 'api-key' ? 'api-key' as const : 'oauth' as const, keyHelp: provider.keyHelp};
    if (!record) return provider.unavailableReason
      ? {...base,state:'setup-required',setup:{title:`${provider.name} is not available yet`,requirement:'Indexing not available',body:provider.unavailableReason}}
      : {...base, state: 'disconnected'};
    // Older saved labels used a retired separator; normalize display without
    // rewriting provider records or their authorization metadata.
    const account = record.account?.replace(/\s*\u00b7\s*/gu, ', ') || null;
    const shown = {...base, integrationId: record.integrationId, account, total: record.total ?? null,
      connectedBy: record.userId === principal.userId ? null : record.ownerEmail || 'a teammate', connectedById: record.userId, connectedAt: record.createdAt || null};
    if(provider.unavailableReason&&record.status!=='disconnecting')return {...shown,state:'error',reconnect:true,message:provider.unavailableReason};
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
    if (record.status === 'provisioning') return record.lifecycleCommandId || provisioning.has(record.integrationId) ? {...shown, state: 'syncing', synced: 0}
      : {...shown, state: 'error', message: 'Connection setup was interrupted. Retry to recover it.'};
    if (record.status === 'disconnecting') {
      if (record.lifecycleCommandId && record.lifecycleOperation === 'disconnect' && !record.cleanupBlockedReason) return {...shown, state: 'disconnecting'};
      return {...shown, state: 'error', recoveryAction: 'disconnect', message: 'Disconnecting is not complete. Retry to finish removing this connection.'};
    }
    if (record.status === 'error' && record.error === 'setup') return {...shown, state: 'error', message: 'We couldn’t finish setting up this connection.'};
    if (record.status === 'error' && record.error === 'recovery') return {...shown, state: 'error', message: 'Connection setup is waiting for an earlier request to finish. Retry later; contact support if it persists.'};
    if (record.status === 'error' && record.error === 'reconnect') return {...shown, state: 'error', reconnect: true, message: `We couldn’t finish setting up ${provider.name}. Disconnect it, then connect again with your API key.`};
    const status = statusFor(record);
    const statusUpdatedAt = status.updatedAt === undefined ? null : new Date(status.updatedAt).toISOString();
    // Do not invent a running import or zero count before the first measurement.
    // A failed refresh retains recent measurements, but never indefinitely.
    const snapshot = status.updatedAt !== undefined && now() - status.updatedAt < 300_000 ? status.value : undefined;
    const measured = {...shown, statusUpdatedAt, statusRefreshing: Boolean(status.pending), statusUnavailable: status.failed || (status.updatedAt !== undefined && !snapshot)};
    if (!snapshot) return {...measured, state: 'connected'};
    const {jobs, live} = snapshot;
    // Jobs are newest first. An older incomplete attempt cannot describe the current run.
    const latest = jobs[0];
    if (!latest) return {...measured, state: 'connected'};
    const running = ['pending', 'running', 'incomplete'].includes(latest.status);
    // Distinct records from the bucket: Airbyte's per-sync row counts repeat every full-refresh
    // stream and every updated record. Only initial live import progress comes from Airbyte.
    const succeededSyncs = new Set(jobs.filter(j => j.status === 'succeeded').map(j => Number(j.jobId)));
    const unique = distinct ? await distinct.get(record, provider, succeededSyncs, {wait: 0}) : null;
    const counts = !unique ? (distinct && succeededSyncs.size ? null : live) : !succeededSyncs.size && live
      ? Object.fromEntries([...new Set([...Object.keys(live), ...Object.keys(unique)])].map(s => [s, Math.max(live[s] || 0, unique[s] || 0)]))
      : unique;
    // The headline counts only the provider's main streams (messages, not channel or user lists).
    const synced = counts ? provider.progressStream.reduce((sum, stream) => sum + (counts[stream] || 0), 0) : distinct && succeededSyncs.size ? undefined : jobs.reduce((sum, j) => sum + (j.rowsSynced || 0), 0);
    // Once every message is in, only trailing work (restoring long messages) is still running.
    const bulkDone = !succeededSyncs.size && !!record.total && synced !== undefined && synced >= record.total;
    const rows = (counts ? provider.progress || [] : []).map(({stream, label, trailing}) => ({label, count: counts?.[stream] || 0, trailing: !!trailing, done: !running || (bulkDone && !trailing)}));
    const succeeded = jobs.find(j => j.status === 'succeeded');
    const lastSyncedAt = succeeded ? (succeeded.lastUpdatedAt || succeeded.startTime) : null;
    if (running) {
      // ETA from the current import pace, only once it has a total and some progress.
      let eta = null;
      const started = Date.parse(latest.startTime || '');
      if (!succeeded && record.total && synced !== undefined && synced > 0 && synced < record.total && started) {
        const rate = synced / Math.max(1, now() - started);
        eta = Math.round((record.total - synced) / rate / 1000);
      }
      return {...measured, state: 'syncing', synced, rows, eta, initial: !succeeded, finishing: bulkDone && rows.some(r => r.trailing), lastSyncedAt};
    }
    if (latest.status === 'failed' || latest.status === 'cancelled') return {...measured, state: 'error', synced, lastSyncedAt, message: 'The last sync didn’t finish. We’ll retry on schedule, or you can retry now.'};
    return {...measured, state: 'synced', synced, rows, lastSyncedAt};
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
    if(lifecycle){
      const reference=await lifecycle.requests.createWithLifecycle(record,'provision',{apiKey:key},principal.userId);
      await dispatch(reference);
      measureTotal(record,provider,api);
      return {connected:true};
    }
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
    measureTotal(record,provider,api);
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
    try {
      if(lifecycle){
        await dispatch(await lifecycle.requests.requestLifecycle(record,'provision',{},principal.userId,{installationId,githubRepositoryIds,account:label,workspace,s3Prefix}));
        return {ok:true,reason:'connected'};
      }
      claimed = await registry.update(record, {status: 'provisioning', installationId, githubRepositoryIds, account: label, workspace, s3Prefix}, {whenStatus: ['connecting']});
    }
    catch (error) {
      if (errorInfo(error).code !== 'ConditionalCheckFailedException') throw error;
      const current = await registry.get(principal.tenantId, principal.userId, id);
      return {ok: !!current && ['provisioning', 'active', 'error'].includes(current.status), reason: 'done'};
    }
    provision(claimed).catch(() => {});
    return {ok: true, reason: 'connected'};
  }

  async function resume(record: IntegrationRecord, provider: Provider,requestedBy=record.userId) {
    if(!lifecycle)requireExecutionOwner(record);
    if(lifecycle && (record.status==='disconnecting'||record.status==='provisioning'||record.status==='error'&&['setup','recovery'].includes(record.error??''))){
      return dispatch(await lifecycle.requests.requestLifecycle(record,record.status==='disconnecting'?'disconnect':'provision',{},requestedBy));
    }
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
    statusCache.delete(statusKey(record));
    await airbyte.sync(required(record.airbyte?.connectionId, 'connection')).catch(error => { if (errorInfo(error).status !== 409) throw error; });
    if (record.status === 'error') await registry.update(record, {status: 'active', error: null}, {whenStatus: ['error']});
  }

  return {
    providers: () => Object.values(providers),
    /** Each Activity advances one persisted phase. Only scoped references enter workflow history. */
    async executeCommand(reference:IntegrationCommandReference,signal?:AbortSignal):Promise<'more'|'done'>{
      requireWritable();
      if(!lifecycle||reference.environment!==environment||!TENANT.test(reference.tenantId)||!USER.test(reference.userId)||!INTEGRATION.test(reference.integrationId)) throw new Error('Invalid integration command scope');
      const command=await lifecycle.commands.read(reference);
      if(!command)throw new Error('Unknown integration command');
      if(command.status!=='pending')return 'done';
      const record=await registry.get(reference.tenantId,reference.userId,reference.integrationId);
      if(!record||record.tenantId!==reference.tenantId||record.userId!==reference.userId||record.integrationId!==reference.integrationId||record.environment!==environment||
        record.lifecycleCommandId!==reference.commandId||record.lifecycleOperation!==command.operation||record.scope!==providerFor(record.provider).scope)throw new Error('Integration command binding changed');
      signal?.throwIfAborted();
      if(command.operation==='disconnect'){
        // Earlier command writers could persist an unresolved external writer
        // or consent POST. Only positive reconciliation may release either hold.
        if(record.cleanupBlockedReason || record.oauthIntent)throw new Error('Cleanup is awaiting external reconciliation');
        if(record.status==='abandoned'){
          if(record.provisionIntent || record.s3Prefix || Object.values(record.airbyte??{}).some(Boolean))throw new Error('Abandoned consent contains provisioned resources');
          await revokeGrants(record,true);
        }else if(record.status!=='disconnected'){
          if(record.status!=='disconnecting')throw new Error('Invalid disconnect command state');
          await disconnectRecord(record,reference,signal);
          return 'more';
        }
      }else if(command.operation==='provision'){
        if(record.status!=='active'){
          if(!await lifecycle.authorize(command,record)){await lifecycle.commands.fail(reference,'authorization_denied');return 'done';}
          if(!['provisioning','error'].includes(record.status))throw new Error('Invalid provision command state');
          const provider=providerFor(record.provider);
          try{
            if(!record.s3Prefix){
              if(provider.auth==='github-app'||provider.auth==='api-key')throw Object.assign(new Error('Connection must be authorized again'),{code:'ProvisioningKeyRequired'});
              const {label,workspace,settings}=await provider.account(proxyFor(record),record);
              const fields={account:label||null,workspace:workspace||null,...(settings?{settings}:{})};
              const claimed=await registry.update(record,{...fields,s3Prefix:landingPrefix(provider,{...record,...fields})},{whenStatus:['provisioning','error'],whenFields:{lifecycleCommandId:reference.commandId,provisionVersion:record.provisionVersion}});
              measureTotal(claimed,provider,proxyFor(claimed));
              return 'more';
            }
            // After a successful source POST with a lost response, reconcile the
            // intent before requiring the key. A reconciled source owns its key.
            const needKey=provider.auth==='api-key'&&!record.airbyte?.sourceId&&!record.provisionIntent;
            const secrets=needKey?await lifecycle.commands.readSecret(reference):{};
            await provisionRecord(record,secrets,reference,signal);
            return 'more';
          }catch(error){
            if(errorInfo(error).code!=='ProvisioningKeyRequired')throw error;
            await lifecycle.commands.fail(reference,'reconnect_required');
            return 'done';
          }
        }
      }else throw new Error('Unsupported Airbyte command');
      await lifecycle.commands.complete(reference);
      return 'done';
    },

    /** Recover one explicitly scoped record; fleet discovery belongs to the runtime. */
    async recoverRecord(record: IntegrationRecord) {
      requireWritable();
      if (record.environment !== environment || !providers[record.provider] || !TENANT.test(record.tenantId) || !USER.test(record.userId) || !INTEGRATION.test(record.integrationId)) throw new Error('Invalid provisioning recovery scope');
      // Discovery can race a completed setup or disconnect. Recovery only resumes
      // unfinished work; it must not sync active or deleted connections at startup.
      const current = await registry.get(record.tenantId, record.userId, record.integrationId);
      if (!current) return;
      if (current.environment !== environment || current.provider !== record.provider || current.tenantId !== record.tenantId || current.userId !== record.userId || current.integrationId !== record.integrationId) throw new Error('Invalid provisioning recovery scope');
      if(current.lifecycleCommandId)return;
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
      if(provider.unavailableReason)throw Object.assign(new Error(provider.unavailableReason),{status:503,expose:true});
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
      if(provider.unavailableReason)return {ok:false,reason:'unavailable'};
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
      if(lifecycle && (account.id!==record.connectedAccountId||account.user_id!==oauthUser(record)))return {ok:false,reason:'invalid'};
      if (provider.scope === 'team') {
        const taken = (await registry.listTenant(principal.tenantId)).some(r => r.integrationId !== record.integrationId && visible(principal, provider, r) && r.status !== 'connecting');
        if (taken) {
          await oauth.remove(required(record.connectedAccountId, 'connected account')).catch(() => {});
          await registry.update(record, {status: 'abandoned'}, {whenStatus: ['connecting']});
          return {ok: false, reason: 'taken'};
        }
      }
      let claimed;
      try {
        if(lifecycle){
          await dispatch(await lifecycle.requests.requestLifecycle(record,'provision',{},principal.userId,{}));
          return {ok:true,reason:'connected'};
        }
        claimed = await registry.update(record, {status: 'provisioning'}, {whenStatus: ['connecting']});
      }
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
      measureTotal(claimed,provider,proxy);
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
      if(provider.unavailableReason&&record.status!=='disconnecting')throw Object.assign(new Error(provider.unavailableReason),{status:503,expose:true});
      return resume(record, provider,principal.userId);
    },

    /** Stops syncing, deletes the imported data and revokes the grant. */
    async disconnect(principal: Principal, providerId: string) {
      requireWritable();
      const record = await current(principal, providerFor(providerId));
      if (record) {
        if(lifecycle)await dispatch(await lifecycle.requests.requestLifecycle(record,'disconnect',{},principal.userId));
        else await disconnectRecord(record);
      }
    },

    /** Disconnects every live connection this user can see: their own and the team's. Returns how many. */
    async disconnectAll(principal: Principal) {
      requireWritable();
      const records = (await registry.listTenant(principal.tenantId))
        .filter(r => VISIBLE.includes(r.status) && (r.userId === principal.userId || providers[r.provider]?.scope === 'team'));
      for (const record of records) {
        if(lifecycle)await dispatch(await lifecycle.requests.requestLifecycle(record,'disconnect',{},principal.userId));
        else await disconnectRecord(record);
      }
      return records.length;
    },
  };
}

export type Integrations = ReturnType<typeof createIntegrations>;
