import {admitActivity} from '../application/agent-activity.mjs';
import type {Principal, ObjectStore, EventIdentityStore, SessionBatch, Authenticate, HttpHandler} from './types.mjs';
import {parseJson, isSessionHarness, SESSION_HARNESS_PATTERN} from './types.mjs';
import type {MemorySnapshot} from '../memories/types.mjs';
import type {SearchAdapter} from '../search/types.mjs';
import type {createCaptureCredentials} from './credentials.mjs';
import type {IncomingMessage} from 'node:http';
import {privacyPrompt, type PrivacyPreferences} from './privacy.mjs';
// Older clients check this list before enabling their bundled capture adapters.
const legacyHarnessCapabilities = ['claude-code', 'codex', 'cursor', 'grok-bot', 'antigravity', 'devin', 'replicas'];
export interface SessionIngestOptions {privacy?:PrivacyPreferences; store: ObjectStore; eventIdentities?: EventIdentityStore; prefix?: string; scheduleIndexing?: (key: string) => Promise<unknown>; onStored?: (principal: Principal,batch: SessionBatch) => Promise<unknown> | undefined; onMemoryStored?: (principal: Principal,receipt: {harness: string; files: number; snapshotId: string}) => Promise<unknown>}
export interface SessionBatchReceipt {harness: string; installationId: string; sessionId: string; batchId: string; userId?: string}
import {serviceError} from './types.mjs';
import {gzipSync, gunzipSync, gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {digest,sessionScope,reserveSessionEvents} from './event-identity.mjs';
import {createMemoryIngest,MAX_MEMORY_BYTES} from '../memories/snapshot.mjs';
import {createControls} from './controls.mjs';
import {sessionWriteBarrier, sessionWriteStore} from './write-barrier.mjs';
import {fail} from '../errors.mjs';
import {expandReplicasPayload} from './replicas-payload.mjs';
import type {RecordingPolicy} from './recording.mjs';
export {digest,sessionScope,auditSessionEventIdentities,auditSessionEventSource} from './event-identity.mjs';

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
/** Capability checked by rollout tooling before accepting deletion requests. */
export const sessionDeletionVersion = 1;
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_STORED_BATCH_BYTES = MAX_BATCH_BYTES + 1024 * 1024;
const decompressBatch = promisify(gunzip);
type WriteGate = <T>(write:()=>Promise<T>)=>Promise<T>;
const directWrite:WriteGate = write=>write();

function checkNativeSession(principal:Principal,session:{harness:string;sessionId:string}) {
  const owner=principal.owner;
  if(owner?.provider==='devin' && (session.harness!=='devin' || session.sessionId!==owner.sessionId))
    fail(403,'Capture must belong to the authenticated Devin session');
}

export function createSessionIngest({store, privacy, eventIdentities, prefix = 'capture-v1', scheduleIndexing=undefined, onStored=undefined,onMemoryStored=undefined}: SessionIngestOptions) {
  if (!store?.put || !store?.get) throw new Error('A durable object store is required');
  const scope = (principal: Principal) => `${prefix}/${sessionScope(principal)}`;
  // Existence checks must not download attachment bodies on every batch retry.
  const exists = (key: string, maxBytes: number) => store.has ? store.has(key, {maxBytes}) : store.get(key, {maxBytes}).then(Boolean);
  const controls = createControls({store, prefix});
  return {
    async putMemorySnapshot(principal: Principal,snapshot: MemorySnapshot, gate:WriteGate=directWrite) {
      if(principal.owner?.provider==='devin')fail(403,'Devin Cloud does not supply memory snapshots');
      const receipt=await gate(()=>createMemoryIngest({store,prefix,scheduleIndexing}).putSnapshot(principal,snapshot));
      if(onMemoryStored)await onMemoryStored(principal,{harness:snapshot.harness,files:receipt.files,snapshotId:receipt.snapshotId});
      return receipt;
    },
    async putAttachment(principal: Principal, hash: string, bytes: Uint8Array, session?: {harness: string; installationId: string; sessionId: string}) {
      const keyPrefix = scope(principal);
      if (!(bytes instanceof Uint8Array)) fail(400, 'Invalid attachment bytes');
      if (bytes.length > MAX_ATTACHMENT_BYTES) fail(413, 'Attachment exceeds limit');
      if (!/^[a-f0-9]{64}$/.test(hash) || digest(bytes) !== hash) fail(400, 'Attachment digest mismatch');
      if (!session || !isSessionHarness(session.harness) || !id(session.sessionId) || !id(session.installationId)) fail(409, 'Upgrade the capture client: attachments require a session identity');
      checkNativeSession(principal,session);
      const barrier = sessionWriteBarrier(store, prefix, principal, session.harness, session.sessionId);
      if ((await controls.read(principal, 'sessions', session.harness, session.sessionId))?.deletedAt || (await barrier.inspect()).closed) return {sha256: hash, size: bytes.length, discarded: 'session_deleted'};
      try {
        await sessionWriteStore(store, prefix, principal, session.harness, session.sessionId).put(`${keyPrefix}/${session.harness}/${digest(session.installationId)}/${digest(session.sessionId)}/attachments/${hash}`, bytes, 'application/octet-stream');
      } catch (error) {if ((await barrier.inspect()).closed) return {sha256: hash, size: bytes.length, discarded: 'session_deleted'}; throw error;}
      return {sha256: hash, size: bytes.length};
    },
    async putBatch(principal: Principal, batch: SessionBatch, gate:WriteGate=directWrite, blobs?:ReadonlyMap<string,Uint8Array>) {
      const keyPrefix = scope(principal);
      let serialized;
      try {serialized = JSON.stringify(batch);} catch {fail(400, 'Invalid capture JSON');}
      if (typeof serialized !== 'string') fail(400, 'Invalid capture JSON');
      if (Buffer.byteLength(serialized) > MAX_BATCH_BYTES) fail(413, 'Batch exceeds limit');
      // Validate and publish the same JSON snapshot, even for direct callers
      // with toJSON methods or objects that change while storage I/O is pending.
      batch = parseJson<SessionBatch>(serialized);
      if (batch?.schemaVersion !== 1 || !id(batch.installationId) || !id(batch.sessionId) ||
          !isSessionHarness(batch.harness) || !Array.isArray(batch.events) || !batch.events.length ||
          !['cli', 'desktop', 'cloud', 'subagent', 'unknown'].includes(batch.origin)) fail(400, 'Invalid capture batch');
      if (batch.captureMode !== undefined && !['live','history'].includes(batch.captureMode)) fail(400, 'Invalid capture mode');
      if (batch.owner?.userId !== principal.userId || batch.owner?.tenantId !== principal.tenantId) fail(403, 'Capture owner does not match signed-in account');
      checkNativeSession(principal,batch);
      if (batch.events.length > 1000 || !batch.events.every(e => e && id(e.id) && typeof e.kind === 'string')) fail(400, 'Invalid events');
      if (!Array.isArray(batch.attachments) || batch.attachments.length > 1000) fail(400, 'Invalid attachments');
      const attachments = new Set<string>();
      for (const attachment of batch.attachments) {
        if (!attachment || typeof attachment !== 'object') fail(400, 'Invalid attachment');
        if (attachment.status === 'captured') {
          if (!/^[a-f0-9]{64}$/.test(attachment.sha256 ?? '')) fail(400, 'Invalid attachment digest');
          attachments.add(attachment.sha256!);
        } else if (!['missing', 'too_large', 'remote_reference'].includes(attachment.status ?? '')) fail(400, 'Invalid attachment status');
      }
      // The owner deleted this session. Accept the retry so clients stop sending
      // it, but never store or index it again.
      const control=await controls.read(principal,'sessions',batch.harness,batch.sessionId);
      if (control?.deletedAt) return {batchId: digest(serialized), eventCount: batch.events.length, stored: true, discarded: 'session_deleted'};
      const barrier = sessionWriteBarrier(store, prefix, principal, batch.harness, batch.sessionId);
      const discarded = () => ({batchId: digest(serialized), eventCount: batch.events.length, stored: true, discarded: 'session_deleted'});
      if ((await barrier.inspect()).closed) return discarded();
      const writes = sessionWriteStore(store, prefix, principal, batch.harness, batch.sessionId);
      const attachmentKeys = new Map<string, string>();
      try {
      const {key,batchId}=await gate(async()=>{
      for (const hash of attachments) {
        const scoped = `${keyPrefix}/${batch.harness}/${digest(batch.installationId)}/${digest(batch.sessionId)}/attachments/${hash}`, legacy = `${keyPrefix}/attachments/${hash}`;
        const supplied=blobs?.get(hash);
        if(supplied&&(supplied.byteLength>MAX_ATTACHMENT_BYTES||digest(supplied)!==hash))fail(400,'Invalid inline attachment');
        if (await exists(scoped, MAX_ATTACHMENT_BYTES)) attachmentKeys.set(hash, scoped);
        else if(supplied){
          await writes.put(scoped,supplied,'application/octet-stream');
          attachmentKeys.set(hash,scoped);
        }
        else {
          // New manifests must never acquire a dependency on an owner-wide blob.
          const bytes = await store.get(legacy, {maxBytes: MAX_ATTACHMENT_BYTES});
          if (!bytes) fail(409, 'Attachment not uploaded');
          if (digest(bytes) !== hash) throw new Error('Stored attachment digest mismatch');
          await writes.put(scoped, bytes, 'application/octet-stream');
          attachmentKeys.set(hash, scoped);
        }
      }
      await reserveSessionEvents({eventIdentities,store:writes,prefix,principal,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId,events:batch.events});
      const batchId = digest(serialized);
      const key = `${keyPrefix}/${batch.harness}/${digest(batch.installationId)}/${digest(batch.sessionId)}/${batchId}.json.gz`;
      // Immutable content-addressed batches: retries and simultaneous delivery do not duplicate or overwrite events.
      if (!await exists(key, MAX_STORED_BATCH_BYTES)) {
        // The receiver alone sets this bit on newly accepted prompt batches.
        delete batch.privacyReview;
        const review=privacy && !control && batch.captureMode!=='history' && !principal.owner &&
          batch.events.some(event=>privacyPrompt(event)!=null) && await privacy.eligible(principal) &&
          (await privacy.read(principal)).enabled;
        if(review)await writes.put(key+'.privacy-pending',Buffer.from('1'),'text/plain');
        const record = {...batch, ...(review?{privacyReview:true}:{}), attachments: batch.attachments.map(item => ({...item, objectKey: attachmentKeys.get(item.sha256 ?? '') ?? null})), owner: {tenantId: principal.tenantId, userId: principal.userId,
          name: principal.name ?? null, email: principal.email ?? null}, receivedAt: new Date().toISOString()};
        await writes.put(key, gzipSync(JSON.stringify(record)), 'application/gzip');
      }
      // The immutable write is retried safely if durable dispatch failed. Never
      // acknowledge a configured handoff before Temporal accepted this object.
      return {key,batchId};
      });
      if (scheduleIndexing) await scheduleIndexing(key);
      if (onStored) await onStored(principal, batch);
      return {batchId, eventCount: batch.events.length, stored: true};
      } catch (error) {if ((await barrier.inspect()).closed) return discarded(); throw error;}
    },
    // The author selects a record within the authenticated tenant; it grants no authority.
    async getBatch(principal: Principal, {harness, installationId, sessionId, batchId, userId=principal?.userId}: Partial<SessionBatchReceipt>) {
      sessionScope(principal);
      if (!principal) fail(401, 'Authentication required');
      if (principal.captureAccess === 'write') fail(403, 'Capture credentials cannot read batches');
      if (!id(userId)) fail(400, 'Invalid author');
      if (!isSessionHarness(harness) || !id(installationId) || !id(sessionId) || !/^[a-f0-9]{64}$/.test(batchId ?? '')) fail(400, 'Invalid receipt');
      const owner = {...principal, userId};
      const readable = async () => {
        const control = await controls.read(owner, 'sessions', harness!, sessionId);
        return !control?.deletedAt && (control?.visibility !== 'private' || userId === principal.userId);
      };
      if (!await readable()) return null;
      const key=`${scope(owner)}/${harness}/${digest(installationId)}/${digest(sessionId)}/${batchId}.json.gz`;
      const data = await store.get(key, {maxBytes: MAX_STORED_BATCH_BYTES});
      if (!data) return null;
      const batch = parseJson<SessionBatch>(gunzipSync(data,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}));
      if (batch.owner?.tenantId!==principal.tenantId || batch.owner?.userId!==userId ||
          batch.harness!==harness || batch.installationId!==installationId || batch.sessionId!==sessionId) throw new Error('Stored batch does not match its authorized scope');
      if(batch.privacyReview && principal.userId!==userId && await store.get(key+'.privacy-pending',{maxBytes:32}) &&
        !await store.get(key+'.privacy-cleared',{maxBytes:32}) &&
        (await controls.read(owner,'sessions',harness!,sessionId))?.visibility!=='team')return null;
      // A receipt locates content; it cannot override a visibility change or
      // tombstone, including one committed while the object was being read.
      const expanded=await expandReplicasPayload(store,prefix,owner,key,batch);
      if (!await readable()) return null;
      return expanded;
    }
  };
}

/** Shared HTTP protocol for hosted OAuth and single-tenant deployments. */
export function createCaptureHandler({ingest, authenticate, recording, search=undefined, credentials=undefined}: {ingest: ReturnType<typeof createSessionIngest>; authenticate: Authenticate; recording?: RecordingPolicy; search?: SearchAdapter | null; credentials?: ReturnType<typeof createCaptureCredentials>}): HttpHandler {
  if (typeof authenticate !== 'function') throw new Error('Authentication adapter required');
  return async (req, res) => {
    const send = (status: number, data: Record<string, unknown>) => {res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'});res.end(JSON.stringify({schemaVersion:1, ...data}));};
    try {
      if (req.headers.origin) return send(403, {error:{code:'BROWSER_REQUEST_DENIED'}});
      const principal = await authenticate(req);
      if(principal)admitActivity(principal);
      if (!principal) throw Object.assign(new Error('Authentication required'), {status:401});
      const revalidate=async()=>{
        const current=await authenticate(req);
        if(!current||sessionScope(current)!==sessionScope(principal)||current.captureAccess!==principal.captureAccess)fail(403,'Capture access changed');
      };
      const privateResult=async(status:number,data:Record<string,unknown>)=>{await revalidate();return send(status,data);};
      sessionScope(principal);
      if (!principal) fail(401, 'Authentication required');
      const url = new URL(req.url ?? '', 'http://capture');
      if(principal.captureAccess==='write' && !(
        req.method==='GET' && ['/api/sessions/identity','/api/sessions/recording'].includes(url.pathname) ||
        req.method==='HEAD' && url.pathname==='/api/sessions/recording' ||
        req.method==='POST' && url.pathname==='/api/sessions/batches' ||
        req.method==='POST' && url.pathname==='/api/sessions/memories' ||
        req.method==='PUT' && /^\/api\/sessions\/attachments\/[a-f0-9]{64}$/.test(url.pathname))) return send(403,{error:{code:'CAPTURE_WRITE_ONLY'}});
      if(credentials && req.method==='POST' && url.pathname==='/api/sessions/credentials') return await privateResult(200,{data:await credentials.issue(principal)});
      const credential=/^\/api\/sessions\/credentials\/([a-f0-9]{64})$/.exec(url.pathname);
      if(credentials && req.method==='DELETE' && credential) return send(200,{data:await credentials.revoke(principal,credential[1])});
      const header=req.headers['x-opencrawl-recording'], revision=typeof header==='string'?header:undefined;
      if (req.method === 'GET' && url.pathname === '/api/sessions/identity') {
        const policy=await recording?.read(principal,revision);
        if(policy?.paused && !revision) return send(423,{error:{code:'RECORDING_PAUSED'}});
        if(policy && policy.revision!=='0' && !revision) return send(426,{error:{code:'RECORDING_CLIENT_UPGRADE_REQUIRED'}});
        return await privateResult(200,{data:{principal,capabilities:{batchEncodings:['gzip'],harnesses:legacyHarnessCapabilities,harnessPattern:SESSION_HARNESS_PATTERN.source},...policy && {recording:policy}}});
      }
      if(req.method==='GET'&&url.pathname==='/api/sessions/recording'&&recording&&revision){
        // Older uploaders immediately retry a successful response. While paused,
        // return 423 so they use their existing retry delay.
        const policy=await recording.read(principal);
        if(policy.paused)return send(423,{error:{code:'RECORDING_PAUSED'}});
        return await privateResult(200,{data:policy});
      }
      const admit=async()=>{
        if(!recording)return;
        const policy=await recording.read(principal);
        if(policy.paused)fail(423,'Recording is paused');
        if((revision??'0')!==policy.revision)fail(412,'Refresh recording permission');
      };
      if(req.method==='HEAD'&&url.pathname==='/api/sessions/recording'){
        if(!recording || !revision)return send(412,{error:{code:'RECORDING_PERMISSION_UNAVAILABLE'}});
        await admit();res.writeHead(204,{'cache-control':'no-store'});res.end();return;
      }
      const write=<T,>(times:readonly unknown[],run:()=>Promise<T>)=>recording ? recording.capture(principal,revision,times,run) : run();
      if(req.method==='GET' && url.pathname==='/api/sessions/search') {
        if(!search)return send(503,{error:{code:'SEARCH_NOT_CONFIGURED'}});
        return await privateResult(200,{data:await search.search(principal,{query:url.searchParams.get('q')??'',limit:Number(url.searchParams.get('limit')??20)})});
      }
      const attachment = /^\/api\/sessions\/attachments\/([a-f0-9]{64})$/.exec(url.pathname);
      if (attachment && req.method === 'PUT') {
        const session = {harness: url.searchParams.get('harness') ?? '', installationId: url.searchParams.get('installationId') ?? '', sessionId: url.searchParams.get('sessionId') ?? ''};
        await admit();
        const bytes=await readBody(req,MAX_ATTACHMENT_BYTES);await revalidate();
        return send(200,{data:await write([req.headers['x-opencrawl-event-time']],()=>ingest.putAttachment(principal,attachment[1]!,bytes,session))});
      }
      if (url.pathname === '/api/sessions/batches' && req.method === 'POST') {
        await admit();
        let batch; try {batch = parseJson<SessionBatch>(await readBatchBody(req));} catch(caught){const e=serviceError(caught);if(e.status)throw e;fail(400,'Invalid JSON');}
        await revalidate();
        if(!Array.isArray(batch?.events)||batch.events.length>1000)fail(400,'Invalid events');
        return send(200,{data:await ingest.putBatch(principal,batch,run=>write(batch.events.map(e=>e?.timestamp),run))});
      }
      if (url.pathname === '/api/sessions/memories' && req.method === 'POST') {
        await admit();
        let snapshot;try{snapshot=parseJson<MemorySnapshot>(await readBody(req,MAX_MEMORY_BYTES));}catch(caught){const e=serviceError(caught);if(e.status)throw e;fail(400,'Invalid memory JSON');}
        await revalidate();
        if(!Array.isArray(snapshot?.files)||snapshot.files.length>4096)fail(400,'Invalid memory snapshot');
        return send(200,{data:await ingest.putMemorySnapshot(principal,snapshot,run=>write(snapshot.files.map(f=>f?.modifiedAt),run))});
      }
      if (url.pathname === '/api/sessions/batches' && req.method === 'GET') {
        const batch = await ingest.getBatch(principal, Object.fromEntries(url.searchParams));
        return await privateResult(batch ? 200 : 404, batch ? {data:batch} : {error:{code:'NOT_FOUND'}});
      }
      return send(404,{error:{code:'NOT_FOUND'}});
    } catch(caught){const e=serviceError(caught);return send(e.status || 503,{error:{code:e.status ? 'CAPTURE_REJECTED':'CAPTURE_UNAVAILABLE', message:e.status ? e.message:'Capture storage unavailable'}});}
  };
}
async function readBody(req: IncomingMessage, max: number) {
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'Payload exceeds limit');chunks.push(chunk);}
  return Buffer.concat(chunks);
}

/** Bound both the wire body and its expansion before parsing or storage. */
async function readBatchBody(req: IncomingMessage) {
  const header=req.headers['content-encoding'];
  if(Array.isArray(header))fail(415,'Unsupported capture encoding');
  const encoding=(header??'identity').trim().toLowerCase();
  if(!['identity','gzip'].includes(encoding))fail(415,'Unsupported capture encoding');
  const bytes=await readBody(req,MAX_BATCH_BYTES);
  if(encoding==='identity')return bytes;
  try{return await decompressBatch(bytes,{maxOutputLength:MAX_BATCH_BYTES});}
  catch(error){
    if(error instanceof Error && 'code' in error && error.code==='ERR_BUFFER_TOO_LARGE')fail(413,'Expanded payload exceeds limit');
    fail(400,'Invalid compressed capture JSON');
  }
}
