import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const fail = (status, message) => {throw Object.assign(new Error(message), {status});};
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Principal MUST come from the deployment's authentication adapter, never the upload. */
export function sessionScope(principal) {
  if (!principal || !id(principal.tenantId) || !id(principal.userId)) fail(401, 'Authentication required');
  return `tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}`;
}
export function createSessionIngest({store, prefix = 'capture-v1'}) {
  if (!store?.put || !store?.get) throw new Error('A durable object store is required');
  const scope = principal => `${prefix}/${sessionScope(principal)}`;
  return {
    async putAttachment(principal, hash, bytes) {
      if (!/^[a-f0-9]{64}$/.test(hash) || digest(bytes) !== hash) fail(400, 'Attachment digest mismatch');
      if (bytes.length > MAX_ATTACHMENT_BYTES) fail(413, 'Attachment exceeds limit');
      await store.put(`${scope(principal)}/attachments/${hash}`, bytes, 'application/octet-stream');
      return {sha256: hash, size: bytes.length};
    },
    async putBatch(principal, batch) {
      const keyPrefix = scope(principal);
      if (batch?.schemaVersion !== 1 || !id(batch.installationId) || !id(batch.sessionId) ||
          !['claude-code', 'codex'].includes(batch.harness) || !Array.isArray(batch.events) || !batch.events.length ||
          !['cli', 'desktop', 'subagent', 'unknown'].includes(batch.origin)) fail(400, 'Invalid capture batch');
      if (batch.owner?.userId !== principal.userId || batch.owner?.tenantId !== principal.tenantId) fail(403, 'Capture owner does not match signed-in account');
      if (batch.events.length > 1000 || !batch.events.every(e => id(e.id) && typeof e.kind === 'string')) fail(400, 'Invalid events');
      if (!Array.isArray(batch.attachments) || batch.attachments.length > 1000) fail(400, 'Invalid attachments');
      for (const attachment of batch.attachments) {
        if (attachment.status === 'captured') {
          if (!/^[a-f0-9]{64}$/.test(attachment.sha256)) fail(400, 'Invalid attachment digest');
          if (!await store.get(`${keyPrefix}/attachments/${attachment.sha256}`)) fail(409, 'Attachment not uploaded');
        } else if (!['missing', 'too_large', 'remote_reference'].includes(attachment.status)) fail(400, 'Invalid attachment status');
      }
      const serialized = JSON.stringify(batch);
      if (Buffer.byteLength(serialized) > MAX_BATCH_BYTES) fail(413, 'Batch exceeds limit');
      const batchId = digest(serialized);
      const key = `${keyPrefix}/${batch.harness}/${batch.installationId}/${batch.sessionId}/${batchId}.json.gz`;
      // Immutable content-addressed batches: retries and simultaneous delivery do not duplicate or overwrite events.
      if (!await store.get(key)) {
        const record = {...batch, owner: {tenantId: principal.tenantId, userId: principal.userId,
          name: principal.name ?? null, email: principal.email ?? null}, receivedAt: new Date().toISOString()};
        await store.put(key, gzipSync(JSON.stringify(record)), 'application/gzip');
      }
      return {batchId, eventCount: batch.events.length, stored: true};
    },
    async getBatch(principal, {harness, installationId, sessionId, batchId}) {
      if (!['claude-code','codex'].includes(harness) || !id(installationId) || !id(sessionId) || !/^[a-f0-9]{64}$/.test(batchId)) fail(400, 'Invalid receipt');
      const data = await store.get(`${scope(principal)}/${harness}/${installationId}/${sessionId}/${batchId}.json.gz`);
      return data ? JSON.parse(gunzipSync(data)) : null;
    }
  };
}

/** Shared HTTP protocol for hosted OAuth and single-tenant deployments. */
export function createCaptureHandler({ingest, authenticate}) {
  if (typeof authenticate !== 'function') throw new Error('Authentication adapter required');
  return async (req, res) => {
    const send = (status, data) => {res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'});res.end(JSON.stringify({schemaVersion:1, ...data}));};
    try {
      if (req.headers.origin) return send(403, {error:{code:'BROWSER_REQUEST_DENIED'}});
      const principal = await authenticate(req);
      sessionScope(principal);
      const url = new URL(req.url, 'http://capture');
      if (req.method === 'GET' && url.pathname === '/api/sessions/identity') return send(200, {data:{principal}});
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
