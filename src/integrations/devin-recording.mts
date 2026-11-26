import {createHash, randomUUID} from 'node:crypto';
import type {DevinFetch} from './devin-events-client.mjs';
import type {ApplicationDatabase,ApplicationTransaction} from '../state/postgres.mjs';
import {sealedEnvelope} from './credential-vault.mjs';
import {devinSessionApi, DevinReadError, type DevinSession} from './devin-api.mjs';
import {DevinRateLimitError, identifyDevinServiceUser, verifyDevinRecording, withDevinEventClient} from './devin-events-client.mjs';
import {devinRecordingStore, lockDevinOrganization, type DevinRecordingRow, type DevinCaptureRow} from './devin-recording-store.mjs';
import {createDevinState} from '../state/devin.mjs';
import {readDevinSessionStep} from './devin-live-session.mjs';
import {devinOwnerId} from '../identity/devin.mjs';
import {scope} from '../identity/devin-schema.mjs';
import {errorInfo} from '../errors.mjs';
import type {RecordingPolicy} from '../sessions/recording.mjs';
import type {Principal, SessionEvent, SessionBatch} from '../sessions/types.mjs';
import type {SessionKey} from '../sessions/session-reference.mjs';
import type {SourceCard} from '../application/types.mjs';

export type DevinRecordingJob = {tenantId:string; generation:string};
export type DevinRecording = ReturnType<typeof createDevinRecording>;
export interface DevinRecordingStatus {
  generation: string;
  organization: string;
  health: DevinRecordingRow['health'];
  connectedAt: string;
  lastCheckedAt: string | null;
  capture: 'waiting' | 'indexing' | 'recording' | 'delayed' | 'stopped';
  latestSession?: SessionKey & {permalinkId?:string};
}
interface Options {
  database: ApplicationDatabase;
  key: Uint8Array;
  audience: string;
  schedule(job: DevinRecordingJob): Promise<unknown>;
  ingest(principal: Principal, batch: SessionBatch): Promise<unknown>;
  incognito(principal: Principal, sessionId: string): Promise<unknown>;
  recording: RecordingPolicy;
  request?: DevinFetch;
  now?: () => number;
}
const catalogInterval = 10000;
const liveInterval = 4000;
const terminalRecheck = 15 * 60 * 1000;
const tenantError = (message: string, status = 400) => Object.assign(new Error(message), {status, expose:true});

export function createDevinRecording(options: Options) {
  const {database, schedule, audience, recording} = options;
  const request = options.request ?? fetch;
  const now = options.now ?? Date.now;
  const store = devinRecordingStore(database);
  const workloadState = createDevinState(database);
  const ns = store.namespace;
  const vault = sealedEnvelope(options.key);
  const binding = (tenant: string, org: string, generation: string) => JSON.stringify([ns,tenant,org,generation]);
  function ref(tenant: string, row: DevinRecordingRow, id: string): Principal {
    return {tenantId:tenant, userId:devinOwnerId(row.organization,id), name:'Devin Cloud',
      owner:{kind:'shared',provider:'devin',organizationId:row.organization,sessionId:id}};
  }
  async function status(principal: Principal, indexed?: (key: SessionKey) => Promise<boolean>): Promise<DevinRecordingStatus | null> {
    const tenant = scope.parse(principal.tenantId);
    await store.ready();
    const {rows:[row]} = await database.pool.query<Pick<DevinRecordingRow,'generation'|'organization'|'health'|'enabled_at'|'checked_at'>>(
      'SELECT generation,organization,health,enabled_at,checked_at FROM opencrawl_devin_api_connections WHERE namespace=$1 AND tenant=$2', [ns,tenant]);
    if (!row) return null;
    const stopped = row.health === 'disconnected' || row.health === 'needs-key';
    const delayed = row.health === 'retrying' || now() - (row.checked_at ?? row.enabled_at) > 120000;
    const result: DevinRecordingStatus = {generation:row.generation,organization:row.organization,health:row.health,
      capture:stopped?'stopped':delayed?'delayed':'waiting',
      connectedAt:new Date(row.enabled_at).toISOString(),lastCheckedAt:row.checked_at === null ? null : new Date(row.checked_at).toISOString()};
    if (indexed && row.health !== 'disconnected') {
      const stalled = await database.pool.query('SELECT 1 FROM opencrawl_devin_api_sessions WHERE namespace=$1 AND tenant=$2 AND generation=$3 AND failures>0 LIMIT 1',
        [ns,tenant,row.generation]);
      if (!stopped && stalled.rowCount) result.capture = 'delayed';
      const candidates = await database.pool.query<{session_id:string}>(`SELECT session_id FROM opencrawl_devin_api_sessions
        WHERE namespace=$1 AND tenant=$2 AND generation=$3 AND stored_at IS NOT NULL AND state NOT IN ('private','excluded')
        ORDER BY stored_at DESC LIMIT 5`, [ns,tenant,row.generation]);
      for (const item of candidates.rows) {
        const key = {harness:'devin',userId:devinOwnerId(row.organization,item.session_id),sessionId:item.session_id};
        if (await indexed(key)) {result.latestSession = key; break;}
      }
      if (result.capture === 'waiting' && candidates.rowCount) result.capture = result.latestSession ? 'recording' : 'indexing';
    }
    return result;
  }
  async function connect(principal: Principal, credential: string, revalidate?: () => Promise<boolean>) {
    const tenant = scope.parse(principal.tenantId), user = scope.parse(principal.userId);
    if (!/^cog_[a-zA-Z0-9_-]{1,1024}$/.test(credential)) throw tenantError('Enter a Devin organization service-user key.');
    const org = await identifyDevinServiceUser(credential,request);
    if (!await verifyDevinRecording(credential,org,request)) throw tenantError('Grant the Devin service user access to session events.',403);
    await devinSessionApi(credential,org,request).sessions({createdAfter:Math.floor(now()/1000)});
    await workloadState.ready();
    await store.locked(tenant,async (db,row) => {
      if (revalidate && !await revalidate()) throw tenantError('Workspace admin access changed. Refresh and try again.',403);
      if (row && row.health !== 'disconnected' && row.organization !== org) throw tenantError('Disconnect the current Devin organization first.',409);
      if (row?.credential && row.organization === org) {
        const path = binding(tenant,org,row.generation);
        await db.query(`UPDATE opencrawl_devin_api_connections SET credential=$3,revision=$4,health='connected',failures=0,retry_at=0
          WHERE namespace=$1 AND tenant=$2`,[ns,tenant,vault.seal(path,Buffer.from(credential)),randomUUID()]);
        return;
      }
      const generation = randomUUID();
      const key = vault.seal(binding(tenant,org,generation),Buffer.from(credential));
      // The organization has one active workspace binding within a deployment.
      // Serialize competing tenant connects before checking the unique index.
      await lockDevinOrganization(db,ns,org);
      const other = await db.query("SELECT 1 FROM opencrawl_devin_api_connections WHERE namespace=$1 AND organization=$2 AND tenant<>$3 AND health<>'disconnected'",[ns,org,tenant]);
      if (other.rowCount) throw tenantError('This Devin organization already has an active connection.',409);
      const legacy = (await db.query<{tenant_id:string}>(
        "SELECT tenant_id FROM opencrawl_devin_connections WHERE namespace=$1 AND organization_id=$2 AND record->>'revokedAt' IS NULL",
        [ns,org])).rows[0];
      if (legacy && legacy.tenant_id !== tenant) throw tenantError('This Devin organization already has an active connection.',409);
      if (legacy) {
        // Explicit organization recording consent replaces this workspace's
        // old VM recorder. The member's MCP and CLI credentials are independent.
        await db.query("UPDATE opencrawl_devin_connections SET record=jsonb_set(record,'{revokedAt}',to_jsonb($3::text)),event_grant=NULL,revision=$4 WHERE namespace=$1 AND organization_id=$2",
          [ns,org,new Date(now()).toISOString(),randomUUID()]);
      }
      await db.query(`INSERT INTO opencrawl_devin_api_connections(namespace,tenant,organization,generation,revision,credential,enabled_at,enabled_by,health)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'connected') ON CONFLICT(namespace,tenant) DO UPDATE SET
        organization=EXCLUDED.organization,generation=EXCLUDED.generation,revision=EXCLUDED.revision,credential=EXCLUDED.credential,
        enabled_at=EXCLUDED.enabled_at,enabled_by=EXCLUDED.enabled_by,health='connected',checked_at=NULL,retry_at=0,failures=0,catalog_at=0,catalog='{}'`,
        [ns,tenant,org,generation,randomUUID(),key,now(),user]);
      await db.query('DELETE FROM opencrawl_devin_api_sessions WHERE namespace=$1 AND tenant=$2 AND generation<>$3',[ns,tenant,generation]);
      await schedule({tenantId:tenant,generation});
    });
    return status(principal);
  }
  async function disconnect(principal: Principal, generation: string, revalidate?: () => Promise<boolean>) {
    const tenant = scope.parse(principal.tenantId);
    await store.locked(tenant,async (db,row) => {
      if (revalidate && !await revalidate()) throw tenantError('Workspace admin access changed. Refresh and try again.',403);
      if (row?.generation !== generation) throw tenantError('This connection has changed. Refresh and try again.',409);
      await db.query("UPDATE opencrawl_devin_api_connections SET credential=NULL,health='disconnected',revision=$3 WHERE namespace=$1 AND tenant=$2",
        [ns,tenant,randomUUID()]);
      await db.query('DELETE FROM opencrawl_devin_api_sessions WHERE namespace=$1 AND tenant=$2 AND generation=$3',[ns,tenant,generation]);
    });
    return status(principal);
  }

  async function enqueue(db: ApplicationTransaction, job: DevinRecordingJob, items: DevinSession[], enabledAt: number) {
    for (const item of items) {
      if (item.created_at * 1000 + 999 < enabledAt) continue;
      // The provider schema strips titles and other content before scheduling.
      await db.query(`INSERT INTO opencrawl_devin_api_sessions AS s(namespace,tenant,generation,session_id,source,cursor,revision,due)
        VALUES($1,$2,$3,$4,$5,'{"phase":"messages"}',$6,$7) ON CONFLICT(namespace,tenant,generation,session_id) DO UPDATE
        SET source=EXCLUDED.source,revision=EXCLUDED.revision,due=LEAST(s.due,EXCLUDED.due),
        state='active',cursor=s.cursor-'finalReview'-'reviewThroughMs'
        WHERE s.state NOT IN ('private','excluded') AND (s.source->>'updated_at')::bigint<=($5::jsonb->>'updated_at')::bigint AND s.source<>EXCLUDED.source`,
        [ns,job.tenantId,job.generation,item.session_id,item,randomUUID(),now()]);
    }
  }

  async function work(job: DevinRecordingJob) {
    const tenant = scope.parse(job.tenantId), round = now();
    const params = [ns,tenant,job.generation];
    const snapshot = await store.locked(tenant,async (db,row) => {
      if (!row?.credential || row.generation !== job.generation) return null;
      const {rows:[session]} = await db.query<DevinCaptureRow>(`SELECT * FROM opencrawl_devin_api_sessions
        WHERE namespace=$1 AND tenant=$2 AND generation=$3 AND state IN ('active','idle') ORDER BY due,session_id LIMIT 1`,params);
      return {row,session,key:vault.open(binding(tenant,row.organization,row.generation),row.credential).toString()};
    });
    if (!snapshot) return {done:true,delayMs:0};
    const {row,session,key} = snapshot;
    const catalog = !session || row.catalog_at <= session.due;
    const due = Math.max(row.retry_at, catalog ? row.catalog_at : session.due);
    if (due > round) return {done:false,delayMs:due-round};
    const api = devinSessionApi(key,row.organization,request);
    const commit = <T,>(op:(db:ApplicationTransaction)=>Promise<T>) => store.locked(tenant,async (db,current) => {
      if (!current?.credential || current.generation !== row.generation || current.revision !== row.revision) return;
      if (!catalog) {
        const guard = await db.query('SELECT 1 FROM opencrawl_devin_api_sessions WHERE namespace=$1 AND tenant=$2 AND generation=$3 AND session_id=$4 AND revision=$5',
          [...params,session.session_id,session.revision]);
        if (!guard.rowCount) return;
      }
      return op(db);
    });
    try {
      if (catalog) {
        const cursor = {...row.catalog};
        cursor.through ??= Math.floor(round/1000);
        const page = await api.sessions({createdAfter:Math.floor(row.enabled_at/1000)-1,updatedAfter:cursor.updatedSince,
          updatedBefore:cursor.through+1, after:cursor.after});
        if (page.has_next_page) {
          const after = page.end_cursor!;
          const hash = createHash('sha256').update(after).digest('base64url');
          if (cursor.pageHistory?.includes(hash)) throw Error('Repeated Devin catalog cursor.');
          cursor.pageHistory = [...cursor.pageHistory ?? [],hash];
          cursor.after = after;
        } else {
          cursor.updatedSince = Math.max(0,cursor.through-60);
          delete cursor.after; delete cursor.through; delete cursor.pageHistory;
        }
        await commit(async db => {
          await enqueue(db,job,page.items,row.enabled_at);
          await db.query(`UPDATE opencrawl_devin_api_connections SET catalog=$4,catalog_at=$5,
            checked_at=$6,retry_at=0,failures=0,health='connected',revision=$7 WHERE namespace=$1 AND tenant=$2 AND generation=$3`,
            [...params,cursor,now()+(page.has_next_page?0:catalogInterval),now(),randomUUID()]);
        });
      } else {
        const owner = ref(tenant,row,session.session_id);
        const policy = await recording.read(owner,'-1');
        const blocked = policy.paused;
        const closed = ['exit','error','suspended'].includes(session.source.status);
        const result = blocked ? undefined : await readDevinSessionStep({
          session:session.source,cursor:session.cursor,enabledAt:row.enabled_at,now:round,audience,api,
          withEvents:operation => withDevinEventClient(key,row.organization,operation,request),
          previouslyStored:ids=>storedIds(database.pool,[...params,session.session_id],ids),
        });
        await commit(async db => {
          const rowArgs = [...params,session.session_id];
          let state: DevinCaptureRow['state'] = 'active';
          let delay = liveInterval, stored = false;
          if (result?.state === 'private') {
            await options.incognito(owner,session.session_id);
            state = 'private';
          } else if (result?.state === 'before-consent') {
            state = 'excluded';
          } else if (result) {
            const permitted = result.events.filter(event => {
              const at = Date.parse(event.timestamp ?? '');
              return Number.isFinite(at) && !policy.windows?.some(([start,end]) => at >= start && (end === null || at < end));
            });
            if (permitted.length) stored = await ingestNew(db,rowArgs,owner,row,permitted,policy.revision);
            if (result.state === 'continue') delay = 0;
            if (result.state === 'caught-up' && closed) {
              if (result.cursor.finalReview) {
                state = 'complete';
              } else {
                // Replay the complete session once after it settles. Events with
                // delayed visibility or old timestamps use the same native IDs.
                // A new provider catalog update wakes a completed session.
                result.cursor = {phase:'messages',finalReview:true,reviewThroughMs:round};
                state = 'idle';
                delay = terminalRecheck;
              }
            }
          }
          await db.query(`UPDATE opencrawl_devin_api_sessions SET cursor=$5,revision=$6,due=$7,state=$8,failures=CASE WHEN $11 THEN 0 ELSE failures END,
            stored_at=CASE WHEN $9 THEN $10 ELSE stored_at END WHERE namespace=$1 AND tenant=$2 AND generation=$3 AND session_id=$4`,
            [...rowArgs,result?.cursor ?? session.cursor,randomUUID(),now()+delay,state,stored,now(),session.cursor.phase==='tools'||!session.cursor.toolRetryAt]);
          await db.query("UPDATE opencrawl_devin_api_connections SET checked_at=$4,revision=$5 WHERE namespace=$1 AND tenant=$2 AND generation=$3",
            [...params,now(),randomUUID()]);
        });
      }
    } catch (error) {
      const code = errorInfo(error).status;
      await commit(async db => {
        if (!catalog && error instanceof DevinReadError && [403,404,410].includes(error.status)) {
          await db.query("UPDATE opencrawl_devin_api_sessions SET state='idle',failures=failures+1,due=$5,revision=$6 WHERE namespace=$1 AND tenant=$2 AND generation=$3 AND session_id=$4",
            [...params,session.session_id,now()+terminalRecheck,randomUUID()]);
          return;
        }
        const denied = error instanceof DevinReadError && (error.status === 401 || catalog && error.status === 403);
        const delay = error instanceof DevinRateLimitError ? error.retryAfterMs : Math.min(300000,1000 * 2 ** Math.min(9,row.failures));
        if (!catalog && (code === 412 || code === 422 || code === 423)) {
          await db.query('UPDATE opencrawl_devin_api_sessions SET due=$5,revision=$6 WHERE namespace=$1 AND tenant=$2 AND generation=$3 AND session_id=$4',
            [...params,session.session_id,now()+liveInterval,randomUUID()]);
          return;
        }
        if (!catalog && !denied && !(error instanceof DevinRateLimitError)) {
          const retry = Math.min(300000,1000 * 2 ** Math.min(9,session.failures));
          const cursor = {...session.cursor};
          const tools = cursor.phase === 'tools';
          if (tools) {
            // A delayed tool receipt must not strand the conversation lane.
            cursor.phase = 'messages';
            cursor.toolRetryAt = now()+retry;
          }
          await db.query('UPDATE opencrawl_devin_api_sessions SET failures=failures+1,due=$5,revision=$6,cursor=$7 WHERE namespace=$1 AND tenant=$2 AND generation=$3 AND session_id=$4',
            [...params,session.session_id,now()+(tools?liveInterval:retry),randomUUID(),cursor]);
          return;
        }
        if (catalog && !denied && !(error instanceof DevinRateLimitError)) {
          await db.query("UPDATE opencrawl_devin_api_connections SET health='retrying',failures=failures+1,catalog_at=$4,revision=$5 WHERE namespace=$1 AND tenant=$2 AND generation=$3",
            [...params,now()+delay,randomUUID()]);
          return;
        }
        await db.query(`UPDATE opencrawl_devin_api_connections SET health=$4,credential=CASE WHEN $5 THEN NULL ELSE credential END,
          failures=failures+1,retry_at=$6,revision=$7 WHERE namespace=$1 AND tenant=$2 AND generation=$3`,
          [...params,denied?'needs-key':'retrying',denied,now()+delay,randomUUID()]);
      });
    }
    return {done:false,delayMs:0};
  }
  async function storedIds(db:Pick<ApplicationTransaction,'query'>,params:string[],ids:string[]) {
    const seen = await db.query<{event_id:string}>(`SELECT event_id FROM opencrawl_devin_api_seen WHERE
      namespace=$1 AND tenant=$2 AND generation=$3 AND session_id=$4 AND event_id=ANY($5::text[])`,[...params,ids]);
    return new Set(seen.rows.map(item=>item.event_id));
  }
  async function ingestNew(db:ApplicationTransaction, params:string[], owner:Principal, row:DevinRecordingRow, events:SessionEvent[], revision:string) {
    const known = await storedIds(db,params,events.map(event=>event.id));
    const fresh = events.filter(event => {if (known.has(event.id)) return false; known.add(event.id); return true;});
    if (!fresh.length) return false;
    const receipt = await recording.capture(owner,revision,fresh.map(event=>event.timestamp),() => options.ingest(owner,{
      schemaVersion:1, owner, installationId:'devin-api:'+row.organization, sessionId:params[3]!, harness:'devin',
      origin:'cloud', captureMode:'live', attachments:[], events:fresh,
    }));
    await db.query(`INSERT INTO opencrawl_devin_api_seen(namespace,tenant,generation,session_id,event_id)
      SELECT $1,$2,$3,$4,unnest($5::text[]) ON CONFLICT DO NOTHING`,[...params,fresh.map(event=>event.id)]);
    return !(receipt && typeof receipt === 'object' && 'discarded' in receipt);
  }
  async function source(principal: Principal, read: (key: SessionKey) => Promise<{events: unknown[]}>) : Promise<SourceCard> {
    const connection = await status(principal, async key => {
      try {return (await read(key)).events.length > 0;}
      catch (error) {if (errorInfo(error).status === 404) return false; throw error;}
    });
    const health = connection?.health;
    return {provider:'devin', name:'Devin', description:'Record new Devin Cloud sessions in this workspace.',
      auth:'api-key', scope:'team', account:connection?.organization, devinRecording:connection ?? undefined,
      state:!health || health === 'disconnected' ? 'disconnected' : health === 'needs-key' ? 'error' : 'connected',
      connectedAt:connection?.connectedAt};
  }
  return {ready:store.ready,connect,disconnect,status,source,runStep:work};
}
