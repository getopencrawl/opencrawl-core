import {setTimeout as delay} from 'node:timers/promises';
import {createConsentProvisioning} from './consent.mjs';
import type {IntegrationLifecycle, IntegrationCommandReference, IntegrationOperation, IntegrationStepInput, IntegrationStepResult} from './temporal/types.mjs';
import {integrationSteps, validateIntegrationCommand} from './temporal/contracts.mjs';
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
  lifecycle?: IntegrationLifecycle; counts?: RecordCounts; consentWaitMs?:number;
}
interface Secrets {apiKey?: string}
interface StatusSnapshot {jobs: AirbyteJob[]; live: Record<string, number> | null}
interface StatusEntry {attemptedAt: number; updatedAt?: number; value?: StatusSnapshot; pending?: Promise<void>; failed: boolean}
type PendingSignInState = 'pending' | 'expired' | 'unavailable';
// Product lifecycle: runtimes supply credential and infrastructure adapters.
import {createHash,randomBytes, timingSafeEqual} from 'node:crypto';
import type {RecordCounts} from './counts.mjs';
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
 * the OAuth adapter proxy. The key is never logged; durable provisioning stores
 * it only in an encrypted, scoped temporary SQL handoff.
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

export function createIntegrations({environment, appUrl, buckets, legacyBucket, workspaceId: workspaceIdOf, destination, backfillDays = 90, schedule = '0 0 * * * ?', oauth, airbyte, registry, providers, github = null, direct = directApi, now = () => Date.now(), log = () => {}, maintenance = false, revokeInstallation, lifecycle, counts: distinct,consentWaitMs=5000}: IntegrationOptions) {
  if(!Number.isSafeInteger(consentWaitMs)||consentWaitMs<1||consentWaitMs>10000)throw new Error('Invalid consent response deadline');
  const consent=createConsentProvisioning({registry,oauth,resources:lifecycle?.resources});
  const consentConfig=(provider:Exclude<Provider,GithubProvider|KeyProvider>,record:IntegrationRecord)=>({toolkit:provider.toolkit,...provider.authConfig,name:provider.authConfig.name+' '+environment+' '+record.tenantId});
  const pendingAccountCache = new Map<string, {at: number; result: Promise<PendingSignInState>}>();
  const statusCache = new Map<string, StatusEntry>();
  const statusKey = (record: IntegrationRecord) => JSON.stringify([environment, record.tenantId, record.userId, record.integrationId, record.airbyte?.connectionId]);
  const requireWritable = () => {
    if (maintenance) throw Object.assign(new Error('Integration maintenance is in progress. Please retry shortly.'), {status: 503, expose: true});
  };
  const durable = createProvisioning({environment, registry, airbyte, now});

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
  function definitionFor(provider: Provider, id: string, allowCreate:boolean) {
    const key = `${id}:${provider.id}:${allowCreate}`;
    if (!definitions.has(key)) {
      definitions.set(key, (async () => {
        return provider.connector.docker ? dockerDefinition(id, provider.connector) : manifestDefinition(id, provider,allowCreate);
      })().catch(error => { definitions.delete(key); throw error; }));
    }
    return definitions.get(key)!;
  }

  /** The published declarative manifest, updated when the file changes. */
  async function manifestDefinition(id: string, provider: Provider,allowCreate:boolean) {
    const {name,manifest}=provider.connector,resources=lifecycle?.resources;
    const fingerprint=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
    const identity=fingerprint(['airbyte-definition',id,name]),desired=fingerprint(manifest);
    const find=async()=>{
      const definitions=(await airbyte.declarativeSources(id)).filter(definition=>definition.name===name);
      if(definitions.length>1)throw Object.assign(new Error('Ambiguous connector definition'),{code:'ProvisioningRecoveryPending'});
      return definitions[0]??null;
    };
    if(!resources){
      const existing=await find();
      if(existing&&fingerprint(existing.manifest)===desired)return existing.id;
      throw new Error('Durable shared integration resources are not configured');
    }
    const definitionId=await resources.ensure({kind:'airbyte-definition',scope:id,name,fingerprint:identity},{
      find:async()=>{const existing=await find();return existing?{id:existing.id,fingerprint:identity}:null;},
      create:async()=>{if(!allowCreate)throw Object.assign(new Error('Legacy shared definition outcome requires reconciliation'),{code:'ProvisioningRecoveryPending'});return (await airbyte.createDeclarativeSource(id,name,manifest!)).id;},
    });
    return resources.ensure({kind:'airbyte-manifest',scope:id,name:definitionId,fingerprint:desired},{
      find:async()=>{const existing=await find();return existing?.id===definitionId?{id:existing.id,fingerprint:fingerprint(existing.manifest)}:null;},
      create:async()=>{if(!allowCreate)throw Object.assign(new Error('Legacy shared manifest outcome requires reconciliation'),{code:'ProvisioningRecoveryPending'});await airbyte.updateDeclarativeSource(id,definitionId,manifest!);return definitionId;},
    });
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
      }).catch(error => {
        refreshing.failed = true;
        log('integration.status.refresh_failed', {provider: record.provider, integrationId: record.integrationId, status: errorInfo(error).status || null});
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

  async function requestLifecycle(record: IntegrationRecord, operation: IntegrationOperation, requestedBy: string, secrets: Secrets = {}) {
    requireWritable();
    if (!registry.requestLifecycle || !lifecycle) throw Object.assign(new Error('Durable integration lifecycle is not configured'), {status: 503});
    const reference = await registry.requestLifecycle(record, operation, secrets, requestedBy);
    // SQL already durably owns this command. Recovery must submit the same ID
    // if Temporal is unavailable or the API process dies at this boundary.
    try {await lifecycle.schedule(reference);}
    catch {log('integration.lifecycle.dispatch_pending', {integrationId: record.integrationId, commandId: reference.commandId});}
    return (await registry.get(record.tenantId, record.userId, record.integrationId))!;
  }

  async function abandon(record:IntegrationRecord,requestedBy:string){
    if(!registry.abandonWithLifecycle||!lifecycle)throw Object.assign(new Error('Durable consent cleanup is not configured'),{status:503});
    const reference=await registry.abandonWithLifecycle(record,requestedBy);
    try{await lifecycle.schedule(reference);}catch{log('integration.lifecycle.dispatch_pending',{integrationId:record.integrationId,commandId:reference.commandId});}
  }
  async function consentResult(record:IntegrationRecord):Promise<{redirectUrl:string}|null>{
    if(!lifecycle||!record.lifecycleCommandId||record.lifecycleOperation!=='consent')return null;
    const reference={environment,tenantId:record.tenantId,userId:record.userId,integrationId:record.integrationId,commandId:record.lifecycleCommandId};
    const deadline=performance.now()+consentWaitMs;
    do{
      const result=await lifecycle.commands.readConsentResult(reference);if(result)return {redirectUrl:result.redirectUrl};
      const command=await lifecycle.commands.read(reference);if(!command||command.status!=='pending')return null;
      if(performance.now()>=deadline)break;await delay(Math.min(200,deadline-performance.now()));
    }while(true);
    throw Object.assign(new Error('Provider sign-in is still being prepared. Retry to continue the same request.'),{status:503,expose:true,code:'ConsentPending'});
  }

  /** One Temporal activity step. The runtime resolves current authorization and
   * storage bindings; all external calls are fenced by the authoritative row. */
  async function lifecycleStep(input: IntegrationStepInput, check: () => void = () => {}): Promise<IntegrationStepResult> {
    requireWritable(); check(); validateIntegrationCommand(input);
    if (!lifecycle || input.environment !== environment) throw Object.assign(new Error('Integration lifecycle scope denied'), {permanent: true});
    const command = await lifecycle.commands.read(input);
    if (!command || command.reference.environment !== environment || command.reference.tenantId !== input.tenantId
      || command.reference.userId !== input.userId || command.reference.integrationId !== input.integrationId
      || command.reference.commandId !== input.commandId || !integrationSteps[command.operation]?.includes(input.step)) {
      throw Object.assign(new Error('Integration lifecycle command denied'), {permanent: true});
    }
    if (command.status !== 'pending') return {status: 'superseded'};
    let record = await registry.get(input.tenantId, input.userId, input.integrationId);
    if (!record || record.environment !== environment || record.lifecycleCommandId !== input.commandId
      || record.lifecycleOperation !== command.operation) return {status: 'superseded'};
    const provider = providerFor(record.provider);
    const save = async (fields: Partial<IntegrationRecord>, statuses = [record!.status]) => {
      check();
      record = await registry.update(record!, fields, {whenStatus: statuses,
        whenFields: {lifecycleCommandId: input.commandId, resourceVersion: record!.resourceVersion, provisionVersion: record!.provisionVersion}});
      return record;
    };
    const reread = async () => {
      check();
      const current = await registry.get(input.tenantId, input.userId, input.integrationId);
      if (!current || current.lifecycleCommandId !== input.commandId || current.lifecycleOperation !== command.operation) return false;
      record = current; return true;
    };
    const resource = async (name: ResourceName, create: () => Promise<AirbyteResource>) => {
      if (!await reread()) return false;
      if (record!.airbyte?.[name]) return true;
      const workspace = required(record!.airbyteWorkspaceId, 'Airbyte workspace');
      record = await durable.ensure(record!, name, workspace, async () => {check(); return create();});
      return record.status === 'provisioning' && record.lifecycleCommandId === input.commandId && record.provisionRun === input.commandId;
    };
    if(command.operation==='consent'){
      if(record.status!=='connecting')return {status:'superseded'};
      if(provider.auth==='github-app'||provider.auth==='api-key')throw Object.assign(new Error('Invalid consent provider'),{permanent:true});
      const deadline=Date.parse(record.oauthExpiresAt??record.createdAt)+(!record.oauthExpiresAt?3600000:0);
      if(!Number.isSafeInteger(deadline)||deadline<=now()){await abandon(record,command.requestedBy);return {status:'superseded'};}
      if(input.step==='consent-expire')return {status:'done',waitUntil:Math.min(deadline,now()+60000)};
      if(input.step==='consent-config')record=await consent.authConfig(record,consentConfig(provider,record));
      else{
        if(await lifecycle.commands.readConsentResult(input))return {status:'done'};
        const callback=new URL('/integrations/'+provider.id+'/callback',appUrl);callback.searchParams.set('integration',record.integrationId);callback.searchParams.set('state',required(record.nonce,'connection nonce'));
        const linked=await consent.link(record,{authConfigId:required(record.authConfigId,'auth config'),userId:oauthUser(record),callbackUrl:record.oauthIntent?.callbackUrl??callback.href});
        record=linked.record;if(!await reread())return {status:'superseded'};
        const expiresAt=Math.min(deadline,linked.result.expires_at?Date.parse(linked.result.expires_at):now()+600000);
        if(!linked.result.redirect_url||!Number.isSafeInteger(expiresAt)||expiresAt<=now())throw Object.assign(new Error('Retry sign-in after retiring the recovered grant'),{code:'ConsentRetryRequired'});
        await save({oauthExpiresAt:new Date(expiresAt).toISOString()});
        await lifecycle.commands.writeConsentResult(input,{redirectUrl:linked.result.redirect_url,expiresAt});
      }
      return await reread()?{status:'done'}:{status:'superseded'};
    }
    if (command.operation === 'provision') {
      if (record.status === 'active') return {status: 'done'};
      if (record.status !== 'provisioning') return {status: 'superseded'};
      if (provider.unavailableReason) throw Object.assign(new Error('Provider setup is unavailable'), {permanent: true});
      if (input.step !== 'prepare') destination.validate(record);
      if (input.step === 'prepare') {
        if (record.provisionRun !== input.commandId) await save({provisionRun: input.commandId, provisionVersion: randomBytes(16).toString('hex'), error: null});
        if (record!.provisionIntent) record = await durable.reconcile(record!);
        if (!await reread()) return {status: 'superseded'};
        if (provider.auth === 'api-key' && !record!.airbyte?.sourceId) {
          // Legacy crashes cannot supply the lost temporary key. Reconcile any
          // prior intent first, then fail before creating more resources.
          const secret = await lifecycle.commands.readSecret(input);
          if (!secret.apiKey) throw Object.assign(new Error('Reconnect with the provider key'), {code: 'ProvisioningKeyRequired'});
        }
        if (!record!.s3Prefix) {
          if (provider.auth === 'github-app') throw Object.assign(new Error('Reconnect to confirm repository access'), {code: 'ProvisioningKeyRequired'});
          const {label, workspace, settings} = await provider.account(proxyFor(record!), record!);
          await save({account: label || null, workspace: workspace || null, ...(settings ? {settings} : {})});
          await save({s3Prefix: landingPrefix(provider, record!)});
        }
        if (record!.s3Prefix !== landingPrefix(provider, record!)) throw Object.assign(new Error('Invalid landing scope'), {permanent: true});
        destination.validate(record!);
        const fields = await destination.prepare(record!);
        if (Object.keys(fields).length) await save(fields);
        if (!record!.airbyteWorkspaceId) await save({airbyteWorkspaceId: await workspaceIdOf()});
        if (provider.auth !== 'github-app' && typeof provider.total === 'function' && record!.total === undefined) {
          const secret = provider.auth === 'api-key' && !record!.airbyte?.sourceId ? await lifecycle.commands.readSecret(input) : {};
          const proxy = provider.auth === 'api-key' ? secret.apiKey ? direct(secret.apiKey) : null : proxyFor(record!);
          if (proxy) {
            // Source estimates are optional display data. They run on the durable
            // worker and cannot expose credentials or block provisioning forever.
            let total: number | null = null;
            try {check(); total = await provider.total(proxy, {startDate: record!.startDate, record: record!, now: now()});}
            catch {log('integration.total.unavailable', {integrationId: record!.integrationId});}
            if (total !== null && (!Number.isSafeInteger(total) || total < 0)) total = null;
            if (!await reread()) return {status: 'superseded'};
            await save({total});
          }
        }
      } else if (input.step === 'destination') {
        const settings = await destination.settings(record);
        if (!await resource('destinationId', () => airbyte.createDestination({workspaceId: record!.airbyteWorkspaceId, name: provisioningLabel(record!), ...settings}))) return {status: 'superseded'};
      } else if (input.step === 'source') {
        if (record.provisionIntent) {record = await durable.reconcile(record); if (!await reread()) return {status: 'superseded'};}
        if (!record!.airbyte?.sourceId) {
          const secret = await lifecycle.commands.readSecret(input);
          if (provider.auth === 'api-key' && !secret.apiKey) throw Object.assign(new Error('Reconnect with the provider key'), {code: 'ProvisioningKeyRequired'});
          const definitionId = await definitionFor(provider, required(record.airbyteWorkspaceId, 'Airbyte workspace'),record.sharedResourceProtocol===1);
          if (!await resource('sourceId', async () => airbyte.createSource({workspaceId: record!.airbyteWorkspaceId, name: provisioningLabel(record!), definitionId,
            configuration: provider.auth === 'api-key' ? provider.sourceConfiguration({startDate: record!.startDate, apiKey: secret.apiKey})
              : provider.auth === 'github-app' ? provider.sourceConfiguration({githubApp: github!.sourceSettings(), record: record!})
                : await oauth.sourceConfiguration(record!, provider)}))) return {status: 'superseded'};
        }
        await lifecycle.commands.clearSecret(input);
      } else if (input.step === 'connection') {
        if (!await resource('connectionId', () => airbyte.createConnection({name: provisioningLabel(record!),
          sourceId: record!.airbyte?.sourceId, destinationId: record!.airbyte?.destinationId,
          namespaceDefinition: 'destination', schedule: {scheduleType: 'cron', cronExpression: provider.schedule || schedule}, status: 'active',
          configurations: {streams: provider.streams}}))) return {status: 'superseded'};
      } else if (input.step === 'activate') {
        check(); await lifecycle.runProviderWrite(record, 'airbyte-sync', () => airbyte.sync(required(record!.airbyte?.connectionId, 'connection')).catch(error => {if (errorInfo(error).status !== 409) throw error;}));
        if (!await reread()) return {status: 'superseded'};
        await save({status: 'active', error: null});
      }
      return {status: 'done'};
    }
    if (command.operation === 'sync') {
      if (!['active', 'error'].includes(record.status)) return {status: 'superseded'};
      check(); await lifecycle.runProviderWrite(record, 'airbyte-sync', () => airbyte.sync(required(record!.airbyte?.connectionId, 'connection')).catch(error => {if (errorInfo(error).status !== 409) throw error;}));
      if (!await reread()) return {status: 'superseded'};
      await save({status: 'active', error: null});
      statusCache.delete(statusKey(record!));
      return {status: 'done'};
    }
    if (record.status === 'disconnected') return {status: 'done'};
    if (!['disconnecting','abandoned'].includes(record.status)) return {status: 'superseded'};
    const gone = (error: unknown) => {if (errorInfo(error).status !== 404) throw error;};
    if (input.step === 'close-writers') {
      await lifecycle.cleanup.closeWriters(record);
    } else if (input.step === 'stop-writers') {
      if(record.oauthIntent){
        if(provider.auth==='github-app'||provider.auth==='api-key')throw Object.assign(new Error('Invalid consent recovery provider'),{permanent:true});
        record=await consent.reconcile(record,consentConfig(provider,record),oauthUser(record));
      }
      if (record.provisionIntent) record = await durable.reconcile(record);
      if (!await reread()) return {status: 'superseded'};
      const ids = record!.airbyte || {};
      if (ids.connectionId) {check(); await airbyte.deleteConnection(ids.connectionId).catch(gone);}
      if (ids.sourceId) {check(); await airbyte.deleteSource(ids.sourceId).catch(gone);}
      if (ids.destinationId) {check(); await airbyte.deleteDestination(ids.destinationId).catch(gone);}
      check(); await lifecycle.cleanup.stopWriters(record!);
      await save({cleanupResourceVersion: record!.resourceVersion || ''});
    } else if (input.step === 'drain-writers') {
      try {await lifecycle.cleanup.drainWriters(record);}
      catch (error) {
        if ((error as {code?: string})?.code === 'EXTERNAL_WRITER_PROOF_REQUIRED') await save({cleanupBlockedReason: 'external-writer-proof-required'});
        throw error;
      }
      if (record!.cleanupBlockedReason) await save({cleanupBlockedReason: null});
    } else if (input.step === 'delete-data') {
      // Repeat drain on every retry before deleting; cancellation/age are never
      // evidence of positive settlement of a previously dispatched remote write.
      await lifecycle.cleanup.drainWriters(record);
      // A scheduler admitted before closure may have finished after stop-writers.
      // Once its receipt settles, delete its schedule again before deleting data.
      check(); await lifecycle.cleanup.stopWriters(record);
      check();
      const deletedObjects = record.s3Prefix ? await buckets.deletePrefix(record.s3Bucket || legacyBucket, `${record.s3Prefix}/`) : 0;
      check(); await lifecycle.cleanup.deleteDocuments(record);
      await distinct?.remove(record); statusCache.delete(statusKey(record));
      await save({deletedObjects, dataDeletedAt: new Date(now()).toISOString()});
    } else if (input.step === 'revoke-grants') {
      if (record.connectedAccountId) {check(); await oauth.remove(record.connectedAccountId).catch(gone);}
      if (record.installationId && revokeInstallation) {check(); await revokeInstallation(record.installationId).catch(gone);}
      check(); await lifecycle.commands.clearSecret(input);
    } else if (input.step === 'finalize') {
      await lifecycle.cleanup.drainWriters(record);
      if (!await reread()) return {status: 'superseded'};
      if (record!.provisionIntent || record!.oauthIntent || (record!.cleanupResourceVersion ?? '') !== (record!.resourceVersion ?? '')) return {status: 'restart'};
      await save({status: 'disconnected', disconnectedAt: new Date(now()).toISOString()});
    }
    return {status: 'done'};
  }

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
    if (record.status === 'provisioning') return {...shown, state: 'syncing', synced: 0};
    if (record.status === 'disconnecting') return {...shown, state: 'error', recoveryAction: 'disconnect', message: record.cleanupBlockedReason === 'external-writer-proof-required' ? 'Disconnected from search. Data cleanup is waiting for your operator to verify that external writers have stopped.' : 'Disconnected from search. Data cleanup is continuing safely in the background.'};
    if(record.status==='error'&&record.lifecycleOperation==='consent')return {...shown,state:'error',recoveryAction:'connect',message:'Provider sign-in could not be prepared. Retry sign-in to continue safely.'};
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
    const running = jobs.find(j => ['pending', 'running', 'incomplete'].includes(j.status));
    // Distinct records from the bucket: Airbyte's per-sync row counts repeat every full-refresh
    // stream and every updated record. Only initial live import progress comes from Airbyte.
    const succeededSyncs = new Set(jobs.filter(j => j.status === 'succeeded').map(j => Number(j.jobId)));
    const unique = distinct ? await distinct.get(record) : null;
    const counts = !unique ? (distinct && succeededSyncs.size ? null : live) : !succeededSyncs.size && live
      ? Object.fromEntries([...new Set([...Object.keys(live), ...Object.keys(unique)])].map(s => [s, Math.max(live[s] || 0, unique[s] || 0)]))
      : unique;
    // The headline counts only the provider's main streams (messages, not channel or user lists).
    const synced = counts ? provider.progressStream.reduce((sum, stream) => sum + (counts[stream] || 0), 0) : distinct && succeededSyncs.size ? undefined : jobs.reduce((sum, j) => sum + (j.rowsSynced || 0), 0);
    // Once every message is in, only trailing work (restoring long messages) is still running.
    const bulkDone = !!record.total && synced !== undefined && synced >= record.total;
    const rows = (counts ? provider.progress || [] : []).map(({stream, label, trailing}) => ({label, count: counts?.[stream] || 0, trailing: !!trailing, done: !running || (bulkDone && !trailing)}));
    const succeeded = jobs.find(j => j.status === 'succeeded');
    const latest = jobs[0];
    const lastSyncedAt = succeeded ? (succeeded.lastUpdatedAt || succeeded.startTime) : null;
    if (running || !latest) {
      // ETA from the current import pace, only once it has a total and some progress.
      let eta = null;
      const started = Date.parse(running?.startTime || '');
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
      provider: provider.id, scope: provider.scope, environment, s3Bucket, provisionProtocol: 1,sharedResourceProtocol:1, status: 'provisioning', account: label || null, workspace,
      createdAt: stamp, updatedAt: stamp, startDate: new Date(now() - backfillDays * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z')};
    record.s3Prefix = landingPrefix(provider, record);
    if (!registry.createWithLifecycle || !lifecycle) throw Object.assign(new Error('Durable integration lifecycle is not configured'), {status: 503});
    const reference = await registry.createWithLifecycle(record, 'provision', {apiKey: key}, principal.userId);
    try {await lifecycle.schedule(reference);}
    catch {log('integration.lifecycle.dispatch_pending', {integrationId: record.integrationId, commandId: reference.commandId});}
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
      await abandon(record,principal.userId);
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
      await abandon(record,principal.userId);
      return {ok: false, reason: 'taken'};
    }
    let claimed;
    try { claimed = await registry.update(record, {installationId, githubRepositoryIds, account: label, workspace, s3Prefix}, {whenStatus: ['connecting']}); }
    catch (error) {
      if (errorInfo(error).code !== 'ConditionalCheckFailedException') throw error;
      const current = await registry.get(principal.tenantId, principal.userId, id);
      return {ok: !!current && ['provisioning', 'active', 'error'].includes(current.status), reason: 'done'};
    }
    try {await requestLifecycle(claimed, 'provision', principal.userId);}
    catch (error) {
      if (errorInfo(error).code !== 'ConditionalCheckFailedException') throw error;
      const current = await registry.get(principal.tenantId, principal.userId, id);
      return {ok: !!current && ['provisioning', 'active', 'error'].includes(current.status), reason: 'done'};
    }
    return {ok: true, reason: 'connected'};
  }

  async function resume(record: IntegrationRecord, provider: Provider, requestedBy: string) {
    if (record.status === 'disconnecting') return requestLifecycle(record, 'disconnect', requestedBy);
    if (record.error === 'reconnect' && !record.provisionIntent) throw Object.assign(new Error(`Disconnect ${provider.name}, then connect it again with your API key.`), {status: 400, expose: true});
    if (record.status === 'provisioning' || (record.status === 'error' && ['setup', 'recovery'].includes(record.error || ''))) return requestLifecycle(record, 'provision', requestedBy);
    return requestLifecycle(record, 'sync', requestedBy);
  }

  return {
    providers: () => Object.values(providers),
    lifecycleStep,

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
      // Compatibility recovery only resubmits the already authorized SQL command.
      if (!lifecycle || !current.lifecycleCommandId) throw Object.assign(new Error('Migrate this integration lifecycle before recovery'), {status: 503});
      const reference: IntegrationCommandReference = {environment, tenantId: current.tenantId, userId: current.userId, integrationId: current.integrationId, commandId: current.lifecycleCommandId};
      const command = await lifecycle.commands.read(reference);
      if (command?.status === 'pending') await lifecycle.schedule(reference);
    },

    async list(principal: Principal): Promise<Array<SourceCard & {integrationId?: string; connectedById?: string}>> {
      const records = await registry.listTenant(principal.tenantId);
      return Promise.all(Object.values(providers).map(provider => {
        // A teammate's unfinished sign-in never hides a live team connection.
        const live = records.filter(r => visible(principal, provider, r));
        const record = newest(live.filter(r => r.status !== 'connecting')) || newest(live);
        return view(principal, record, provider).catch(error => {
          log('integration.status.failed', {provider: provider.id, status: errorInfo(error).status || null});
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
      const ownConsent=live.find(r=>r.userId===principal.userId&&r.status==='connecting'&&r.lifecycleOperation==='consent');
      if(ownConsent){const prepared=await consentResult(ownConsent);if(prepared)return prepared;await abandon(ownConsent,principal.userId);live.splice(live.indexOf(ownConsent),1);}
      for(const failed of live.filter(r=>r.userId===principal.userId&&r.status==='error'&&r.lifecycleOperation==='consent')){await abandon(failed,principal.userId);live.splice(live.indexOf(failed),1);}
      if (live.some(r => r.status !== 'connecting')) throw Object.assign(new Error('Already connected'), {status: 409});
      // Team-wide sources land under the OpenCrawl organization.
      if (provider.teamOnly && !ORG.test(principal.tenantId)) throw Object.assign(new Error(`Connect ${provider.name} from your team’s OpenCrawl organization.`), {status: 400, expose: true});
      if (provider.auth === 'api-key') return connectWithKey(principal, provider, apiKey);
      // The team bucket exists before anyone signs in, so setup can't fail on it later.
      const s3Bucket = await teamBucket(principal);
      const record: IntegrationRecord = {integrationId: integrationId(), tenantId: principal.tenantId, userId: principal.userId, ownerEmail: principal.email || null,
        provider: provider.id, scope: provider.scope, environment, s3Bucket, provisionProtocol: 1,sharedResourceProtocol:1, status: 'connecting', nonce: randomBytes(24).toString('base64url'),
        createdAt: new Date(now()).toISOString(), startDate: new Date(now() - backfillDays * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z')};
      for (const mine of live.filter(r => r.userId === principal.userId)) await abandon(mine,principal.userId);
      if (provider.auth === 'github-app') {
        if (!github) throw Object.assign(new Error('GitHub isn’t available yet.'), {status: 503, expose: true});
        // OAuth also returns when the app was already installed for this account.
        await registry.create({...record, updatedAt: record.createdAt});
        return {redirectUrl: github.authorizeUrl(`${record.integrationId}.${record.nonce}`, new URL('/integrations/github/callback', appUrl).href)};
      }
      if(!registry.createWithLifecycle||!lifecycle)throw Object.assign(new Error('Durable consent setup is not configured'),{status:503});
      const reference=await registry.createWithLifecycle({...record,oauthExpiresAt:new Date(now()+3600000).toISOString()},'consent',{},principal.userId);
      try{await lifecycle.schedule(reference);}catch{log('integration.lifecycle.dispatch_pending',{integrationId:record.integrationId,commandId:reference.commandId});}
      const current=await registry.get(record.tenantId,record.userId,record.integrationId);
      const prepared=current?await consentResult(current):null;
      if(!prepared)throw Object.assign(new Error('Provider sign-in could not be prepared. Retry to continue safely.'),{status:503,expose:true});
      return prepared;
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
        await abandon(record,principal.userId);
        return {ok: false, reason: 'declined'};
      }
      const account = await oauth.account(required(record.connectedAccountId, 'connected account'));
      if (account?.id !== record.connectedAccountId || account.status !== 'ACTIVE' || account.is_disabled || (account.user_id !== undefined && account.user_id !== oauthUser(record)) || (account.toolkit?.slug || '').toLowerCase() !== provider.toolkit) return {ok: false, reason: 'declined'};
      if (provider.scope === 'team') {
        const taken = (await registry.listTenant(principal.tenantId)).some(r => r.integrationId !== record.integrationId && visible(principal, provider, r) && r.status !== 'connecting');
        if (taken) {
          await abandon(record,principal.userId);
          return {ok: false, reason: 'taken'};
        }
      }
      try {await requestLifecycle(record, 'provision', principal.userId);}
      catch (error) {
        if (errorInfo(error).code !== 'ConditionalCheckFailedException') throw error;
        const current = await registry.get(principal.tenantId, principal.userId, id);
        return {ok: !!current && ['provisioning', 'active', 'error'].includes(current.status), reason: 'done'};
      }
      return {ok: true, reason: 'connected'};
    },

    /** Retries setup if it failed, otherwise runs a sync now. */
    async retry(principal: Principal, providerId: string) {
      requireWritable();
      const provider = providerFor(providerId);
      const record = await current(principal, provider);
      if (!record || record.status === 'connecting') throw Object.assign(new Error('Not connected'), {status: 404});
      if(provider.unavailableReason&&record.status!=='disconnecting')throw Object.assign(new Error(provider.unavailableReason),{status:503,expose:true});
      return resume(record, provider, principal.userId);
    },

    /** Stops syncing, deletes the imported data and revokes the grant. */
    async disconnect(principal: Principal, providerId: string) {
      requireWritable();
      const record = await current(principal, providerFor(providerId));
      if (record) await requestLifecycle(record, 'disconnect', principal.userId);
    },

    /** Disconnects every live connection this user can see: their own and the team's. Returns how many. */
    async disconnectAll(principal: Principal) {
      requireWritable();
      const records = (await registry.listTenant(principal.tenantId))
        .filter(r => VISIBLE.includes(r.status) && (r.userId === principal.userId || providers[r.provider]?.scope === 'team'));
      for (const record of records) await requestLifecycle(record, 'disconnect', principal.userId);
      return records.length;
    },
  };
}

export type Integrations = ReturnType<typeof createIntegrations>;
