import {gzipSync, gunzipSync} from 'node:zlib';
import {digest,sessionScope,reserveSessionEvents} from './event-identity.mjs';
export {digest,sessionScope,auditSessionEventIdentities,auditSessionEventSource} from './event-identity.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const fail = (status, message) => {throw Object.assign(new Error(message), {status});};
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_STORED_BATCH_BYTES = MAX_BATCH_BYTES + 1024 * 1024;

export function createSessionIngest({store, prefix = 'capture-v1', onStored=undefined}) {
  if (!store?.put || !store?.get) throw new Error('A durable object store is required');
  const scope = principal => `${prefix}/${sessionScope(principal)}`;
  // Existence checks must not download attachment bodies on every batch retry.
  const exists = (key, maxBytes) => store.has ? store.has(key, {maxBytes}) : store.get(key, {maxBytes}).then(Boolean);
  return {
    async putAttachment(principal, hash, bytes) {
      const keyPrefix = scope(principal);
      if (!(bytes instanceof Uint8Array)) fail(400, 'Invalid attachment bytes');
      if (bytes.length > MAX_ATTACHMENT_BYTES) fail(413, 'Attachment exceeds limit');
      if (!/^[a-f0-9]{64}$/.test(hash) || digest(bytes) !== hash) fail(400, 'Attachment digest mismatch');
      await store.put(`${keyPrefix}/attachments/${hash}`, bytes, 'application/octet-stream');
      return {sha256: hash, size: bytes.length};
    },
    async putBatch(principal, batch) {
      const keyPrefix = scope(principal);
      let serialized;
      try {serialized = JSON.stringify(batch);} catch {fail(400, 'Invalid capture JSON');}
      if (typeof serialized !== 'string') fail(400, 'Invalid capture JSON');
      if (Buffer.byteLength(serialized) > MAX_BATCH_BYTES) fail(413, 'Batch exceeds limit');
      // Validate and publish the same JSON snapshot, even for direct callers
      // with toJSON methods or objects that change while storage I/O is pending.
      batch = JSON.parse(serialized);
      if (batch?.schemaVersion !== 1 || !id(batch.installationId) || !id(batch.sessionId) ||
          !['claude-code', 'codex'].includes(batch.harness) || !Array.isArray(batch.events) || !batch.events.length ||
          !['cli', 'desktop', 'cloud', 'subagent', 'unknown'].includes(batch.origin)) fail(400, 'Invalid capture batch');
      if (batch.captureMode !== undefined && !['live','history'].includes(batch.captureMode)) fail(400, 'Invalid capture mode');
      if (batch.owner?.userId !== principal.userId || batch.owner?.tenantId !== principal.tenantId) fail(403, 'Capture owner does not match signed-in account');
      if (batch.events.length > 1000 || !batch.events.every(e => e && id(e.id) && typeof e.kind === 'string')) fail(400, 'Invalid events');
      if (!Array.isArray(batch.attachments) || batch.attachments.length > 1000) fail(400, 'Invalid attachments');
      const attachments = new Set();
      for (const attachment of batch.attachments) {
        if (!attachment || typeof attachment !== 'object') fail(400, 'Invalid attachment');
        if (attachment.status === 'captured') {
          if (!/^[a-f0-9]{64}$/.test(attachment.sha256)) fail(400, 'Invalid attachment digest');
          attachments.add(attachment.sha256);
        } else if (!['missing', 'too_large', 'remote_reference'].includes(attachment.status)) fail(400, 'Invalid attachment status');
      }
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
    async getBatch(principal, {harness, installationId, sessionId, batchId, userId=principal?.userId}) {
      sessionScope(principal);
      if (principal.captureAccess === 'write') fail(403, 'Capture credentials cannot read batches');
      if (!id(userId)) fail(400, 'Invalid author');
      if (!['claude-code','codex'].includes(harness) || !id(installationId) || !id(sessionId) || !/^[a-f0-9]{64}$/.test(batchId)) fail(400, 'Invalid receipt');
      const data = await store.get(`${scope({...principal,userId})}/${harness}/${digest(installationId)}/${digest(sessionId)}/${batchId}.json.gz`, {maxBytes: MAX_STORED_BATCH_BYTES});
      if (!data) return null;
      const batch = JSON.parse(gunzipSync(data,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}));
      if (batch.owner?.tenantId!==principal.tenantId || batch.owner?.userId!==userId ||
          batch.harness!==harness || batch.installationId!==installationId || batch.sessionId!==sessionId) throw new Error('Stored batch does not match its authorized scope');
      return batch;
    }
  };
}

/** Shared HTTP protocol for hosted OAuth and single-tenant deployments. */
export function createCaptureHandler({ingest, authenticate, search=undefined, credentials=undefined}) {
  if (typeof authenticate !== 'function') throw new Error('Authentication adapter required');
  return async (req, res) => {
    const send = (status, data) => {res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'});res.end(JSON.stringify({schemaVersion:1, ...data}));};
    try {
      if (req.headers.origin) return send(403, {error:{code:'BROWSER_REQUEST_DENIED'}});
      const principal = await authenticate(req);
      sessionScope(principal);
      const url = new URL(req.url, 'http://capture');
      if(principal.captureAccess==='write' && !(
        req.method==='GET' && url.pathname==='/api/sessions/identity' ||
        req.method==='POST' && url.pathname==='/api/sessions/batches' ||
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
        let batch; try {batch = JSON.parse(await readBody(req, MAX_BATCH_BYTES));} catch(e) {if(e.status)throw e;fail(400,'Invalid JSON');}
        return send(200, {data:await ingest.putBatch(principal,batch)});
      }
      if (url.pathname === '/api/sessions/batches' && req.method === 'GET') {
        const batch = await ingest.getBatch(principal, Object.fromEntries(url.searchParams));
        return send(batch ? 200 : 404, batch ? {data:batch} : {error:{code:'NOT_FOUND'}});
      }
      return send(404,{error:{code:'NOT_FOUND'}});
    } catch(e) {return send(e.status || 503,{error:{code:e.status ? 'CAPTURE_REJECTED':'CAPTURE_UNAVAILABLE', message:e.status ? e.message:'Capture storage unavailable'}});}
  };
}
async function readBody(req, max) {
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'Payload exceeds limit');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
