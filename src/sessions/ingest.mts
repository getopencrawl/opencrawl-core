import type {Principal, ObjectStore, SessionBatch, Authenticate, HttpHandler} from './types.mjs';
import {parseJson} from './types.mjs';
import type {MemorySnapshot} from '../memories/types.mjs';
import type {SearchAdapter} from '../search/types.mjs';
import type {createCaptureCredentials} from './credentials.mjs';
import type {IncomingMessage} from 'node:http';
export interface SessionIngestOptions {store: ObjectStore; prefix?: string; onStored?: (principal: Principal,batch: SessionBatch) => Promise<unknown> | undefined; onMemoryStored?: (principal: Principal,receipt: {harness: string; files: number; snapshotId: string}) => Promise<unknown>}
export interface SessionBatchReceipt {harness: string; installationId: string; sessionId: string; batchId: string; userId?: string}
import {serviceError} from './types.mjs';
import {gzipSync, gunzipSync} from 'node:zlib';
import {digest,sessionScope,reserveSessionEvents} from './event-identity.mjs';
import {createMemoryIngest,MAX_MEMORY_BYTES} from '../memories/snapshot.mjs';
import {createControls} from './controls.mjs';
export {digest,sessionScope,auditSessionEventIdentities,auditSessionEventSource} from './event-identity.mjs';

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_STORED_BATCH_BYTES = MAX_BATCH_BYTES + 1024 * 1024;

export function createSessionIngest({store, prefix = 'capture-v1', onStored=undefined,onMemoryStored=undefined}: SessionIngestOptions) {
  if (!store?.put || !store?.get) throw new Error('A durable object store is required');
  const scope = (principal: Principal) => `${prefix}/${sessionScope(principal)}`;
  // Existence checks must not download attachment bodies on every batch retry.
  const exists = (key: string, maxBytes: number) => store.has ? store.has(key, {maxBytes}) : store.get(key, {maxBytes}).then(Boolean);
  const controls = createControls({store, prefix});
  return {
    async putMemorySnapshot(principal: Principal,snapshot: MemorySnapshot) {
      const receipt=await createMemoryIngest({store,prefix}).putSnapshot(principal,snapshot);
      if(onMemoryStored)await onMemoryStored(principal,{harness:snapshot.harness,files:receipt.files,snapshotId:receipt.snapshotId});
      return receipt;
    },
    async putAttachment(principal: Principal, hash: string, bytes: Uint8Array) {
      const keyPrefix = scope(principal);
      if (!(bytes instanceof Uint8Array)) fail(400, 'Invalid attachment bytes');
      if (bytes.length > MAX_ATTACHMENT_BYTES) fail(413, 'Attachment exceeds limit');
      if (!/^[a-f0-9]{64}$/.test(hash) || digest(bytes) !== hash) fail(400, 'Attachment digest mismatch');
      await store.put(`${keyPrefix}/attachments/${hash}`, bytes, 'application/octet-stream');
      return {sha256: hash, size: bytes.length};
    },
    async putBatch(principal: Principal, batch: SessionBatch) {
      const keyPrefix = scope(principal);
      let serialized;
      try {serialized = JSON.stringify(batch);} catch {fail(400, 'Invalid capture JSON');}
      if (typeof serialized !== 'string') fail(400, 'Invalid capture JSON');
      if (Buffer.byteLength(serialized) > MAX_BATCH_BYTES) fail(413, 'Batch exceeds limit');
      // Validate and publish the same JSON snapshot, even for direct callers
      // with toJSON methods or objects that change while storage I/O is pending.
      batch = parseJson<SessionBatch>(serialized);
      if (batch?.schemaVersion !== 1 || !id(batch.installationId) || !id(batch.sessionId) ||
          !['claude-code', 'codex'].includes(batch.harness) || !Array.isArray(batch.events) || !batch.events.length ||
          !['cli', 'desktop', 'cloud', 'subagent', 'unknown'].includes(batch.origin)) fail(400, 'Invalid capture batch');
      if (batch.captureMode !== undefined && !['live','history'].includes(batch.captureMode)) fail(400, 'Invalid capture mode');
      if (batch.owner?.userId !== principal.userId || batch.owner?.tenantId !== principal.tenantId) fail(403, 'Capture owner does not match signed-in account');
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
      if ((await controls.read(principal, 'sessions', batch.harness, batch.sessionId))?.deletedAt) return {batchId: digest(serialized), eventCount: batch.events.length, stored: true, discarded: 'session_deleted'};
      for (const hash of attachments) {
        if (!await exists(`${keyPrefix}/attachments/${hash}`, MAX_ATTACHMENT_BYTES)) fail(409, 'Attachment not uploaded');
      }
      await reserveSessionEvents({store,prefix,principal,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId,events:batch.events});
      const batchId = digest(serialized);
      const key = `${keyPrefix}/${batch.harness}/${digest(batch.installationId)}/${digest(batch.sessionId)}/${batchId}.json.gz`;
      // Immutable content-addressed batches: retries and simultaneous delivery do not duplicate or overwrite events.
      if (!await exists(key, MAX_STORED_BATCH_BYTES)) {
        const record = {...batch, owner: {tenantId: principal.tenantId, userId: principal.userId,
          name: principal.name ?? null, email: principal.email ?? null}, receivedAt: new Date().toISOString()};
        await store.put(key, gzipSync(JSON.stringify(record)), 'application/gzip');
      }
      if (onStored) await onStored(principal, batch);
      return {batchId, eventCount: batch.events.length, stored: true};
    },
    // The author selects a record within the authenticated tenant; it grants no authority.
    async getBatch(principal: Principal, {harness, installationId, sessionId, batchId, userId=principal?.userId}: Partial<SessionBatchReceipt>) {
      sessionScope(principal);
      if (!principal) fail(401, 'Authentication required');
      if (principal.captureAccess === 'write') fail(403, 'Capture credentials cannot read batches');
      if (!id(userId)) fail(400, 'Invalid author');
      if (!['claude-code','codex'].includes(harness ?? '') || !id(installationId) || !id(sessionId) || !/^[a-f0-9]{64}$/.test(batchId ?? '')) fail(400, 'Invalid receipt');
      const data = await store.get(`${scope({...principal,userId})}/${harness}/${digest(installationId)}/${digest(sessionId)}/${batchId}.json.gz`, {maxBytes: MAX_STORED_BATCH_BYTES});
      if (!data) return null;
      const batch = parseJson<SessionBatch>(gunzipSync(data,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}));
      if (batch.owner?.tenantId!==principal.tenantId || batch.owner?.userId!==userId ||
          batch.harness!==harness || batch.installationId!==installationId || batch.sessionId!==sessionId) throw new Error('Stored batch does not match its authorized scope');
      return batch;
    }
  };
}

/** Shared HTTP protocol for hosted OAuth and single-tenant deployments. */
export function createCaptureHandler({ingest, authenticate, search=undefined, credentials=undefined}: {ingest: ReturnType<typeof createSessionIngest>; authenticate: Authenticate; search?: SearchAdapter | null; credentials?: ReturnType<typeof createCaptureCredentials>}): HttpHandler {
  if (typeof authenticate !== 'function') throw new Error('Authentication adapter required');
  return async (req, res) => {
    const send = (status: number, data: Record<string, unknown>) => {res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'});res.end(JSON.stringify({schemaVersion:1, ...data}));};
    try {
      if (req.headers.origin) return send(403, {error:{code:'BROWSER_REQUEST_DENIED'}});
      const principal = await authenticate(req);
      sessionScope(principal);
      if (!principal) fail(401, 'Authentication required');
      const url = new URL(req.url ?? '', 'http://capture');
      if(principal.captureAccess==='write' && !(
        req.method==='GET' && url.pathname==='/api/sessions/identity' ||
        req.method==='POST' && url.pathname==='/api/sessions/batches' ||
        req.method==='POST' && url.pathname==='/api/sessions/memories' ||
        req.method==='PUT' && /^\/api\/sessions\/attachments\/[a-f0-9]{64}$/.test(url.pathname))) return send(403,{error:{code:'CAPTURE_WRITE_ONLY'}});
      if(credentials && req.method==='POST' && url.pathname==='/api/sessions/credentials') return send(200,{data:await credentials.issue(principal)});
      const credential=/^\/api\/sessions\/credentials\/([a-f0-9]{64})$/.exec(url.pathname);
      if(credentials && req.method==='DELETE' && credential) return send(200,{data:await credentials.revoke(principal,credential[1])});
      if (req.method === 'GET' && url.pathname === '/api/sessions/identity') return send(200, {data:{principal}});
      if(req.method==='GET' && url.pathname==='/api/sessions/search') {
        if(!search)return send(503,{error:{code:'SEARCH_NOT_CONFIGURED'}});
        return send(200,{data:await search.search(principal,{query:url.searchParams.get('q')??'',limit:Number(url.searchParams.get('limit')??20)})});
      }
      const attachment = /^\/api\/sessions\/attachments\/([a-f0-9]{64})$/.exec(url.pathname);
      if (attachment && req.method === 'PUT') {
        return send(200, {data:await ingest.putAttachment(principal, attachment[1], await readBody(req, MAX_ATTACHMENT_BYTES))});
      }
      if (url.pathname === '/api/sessions/batches' && req.method === 'POST') {
        let batch; try {batch = parseJson<SessionBatch>(await readBody(req, MAX_BATCH_BYTES));} catch(caught){const e=serviceError(caught);if(e.status)throw e;fail(400,'Invalid JSON');}
        return send(200, {data:await ingest.putBatch(principal,batch)});
      }
      if (url.pathname === '/api/sessions/memories' && req.method === 'POST') {
        let snapshot;try{snapshot=parseJson<MemorySnapshot>(await readBody(req,MAX_MEMORY_BYTES));}catch(caught){const e=serviceError(caught);if(e.status)throw e;fail(400,'Invalid memory JSON');}
        return send(200,{data:await ingest.putMemorySnapshot(principal,snapshot)});
      }
      if (url.pathname === '/api/sessions/batches' && req.method === 'GET') {
        const batch = await ingest.getBatch(principal, Object.fromEntries(url.searchParams));
        return send(batch ? 200 : 404, batch ? {data:batch} : {error:{code:'NOT_FOUND'}});
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
