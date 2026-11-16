import {createHash} from 'node:crypto';
import {createS3Request, type S3StoreOptions} from '../sessions/s3-store.mjs';
import {serviceError} from '../sessions/types.mjs';
import type {OnlineDeleteMutation, OnlineExternalSnapshot, OnlineExternalStore, OnlinePutMutation} from './online-journal.mjs';

const FORMAT = 'opencrawl-state-bridge-v1';
const CONTENT_TYPE = 'application/vnd.opencrawl.state-bridge+json';
const MARKER = 'x-amz-meta-opencrawl-state-bridge';
const OPERATION = 'x-amz-meta-opencrawl-operation-id';
const MAX_BYTES = 64 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

interface Envelope {
  format: typeof FORMAT;
  epoch: string;
  sourceId: string;
  keyHash: string;
  operationId: string;
  revision: string;
  deleted: boolean;
  contentType: string | null;
  payload: string | null;
  payloadHash: string | null;
}

function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function revision(value: string) {
  requireValue(/^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n, 'Invalid migration object revision');
}

function contentType(value: string) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value), 'Invalid migration object content type');
}

async function boundedBody(response: Response, limit: number) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Migration object exceeds its read limit');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Migration object exceeds its read limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** Only an enrolled legacy compatibility release may use this adapter. Its
 * envelope makes each operation's physical ETag distinct, even for equal
 * logical values. Deletion writes a retained tombstone, so a delayed request
 * cannot recreate an earlier physical absence after the journal lock is lost.
 * Raw capture objects are never routed through this adapter. */
export function createOnlineMigrationS3Store({epoch, sourceId, prefixes, timeoutMs = 30000, ...options}: S3StoreOptions & {
  epoch: string;
  sourceId: string;
  prefixes: readonly string[];
  timeoutMs?: number;
}): OnlineExternalStore {
  requireValue(UUID.test(epoch), 'A migration epoch is required');
  requireValue(typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 2048 && !sourceId.includes('\0'), 'A migration source binding is required');
  requireValue(prefixes.length > 0 && prefixes.length <= 32 && new Set(prefixes).size === prefixes.length, 'Explicit migration key prefixes are required');
  for (const prefix of prefixes) requireValue(prefix.length > 0 && prefix.length <= 8192 && prefix.endsWith('/') && !prefix.includes('\0') && !prefix.slice(0, -1).split('/').some(part => !part || part === '.' || part === '..'), 'Invalid migration key prefix');
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120000, 'Invalid migration request timeout');
  const request = createS3Request(options);
  function keyInScope(key: string) {
    requireValue(typeof key === 'string' && key.length > 0 && key.length <= 8192 && !key.includes('\0') && !key.split('/').some(part => !part || part === '.' || part === '..') && prefixes.some(prefix => key.startsWith(prefix)), 'Migration object is outside its source scope');
  }
  function expectedVersion(value: string | null) {
    requireValue(value === null || typeof value === 'string' && value.length > 0 && value.length <= 1024 && value !== '*' && !/[\r\n\0]/.test(value), 'Invalid migration object ETag');
  }
  function encode(key: string, mutation: OnlinePutMutation | OnlineDeleteMutation, deleted: boolean) {
    keyInScope(key);
    requireValue(UUID.test(mutation.operationId), 'Invalid migration operation identity');
    revision(mutation.revision);
    let payload: Buffer | null = null;
    let type: string | null = null;
    if (!deleted) {
      requireValue('bytes' in mutation && Buffer.isBuffer(mutation.bytes) && mutation.bytes.byteLength <= MAX_BYTES, 'Invalid migration object payload');
      contentType(mutation.contentType);
      payload = mutation.bytes;
      type = mutation.contentType;
    }
    const envelope: Envelope = {format: FORMAT, epoch, sourceId, keyHash: sha(key), operationId: mutation.operationId,
      revision: mutation.revision, deleted, contentType: type, payload: payload?.toString('base64') ?? null, payloadHash: payload ? sha(payload) : null};
    return Buffer.from(JSON.stringify(envelope));
  }
  async function write(key: string, version: string | null, mutation: OnlinePutMutation | OnlineDeleteMutation, deleted: boolean) {
    expectedVersion(version);
    const body = encode(key, mutation, deleted);
    try {
      await request('PUT', key, {body, signal: AbortSignal.timeout(timeoutMs), headers: {
        'content-type': CONTENT_TYPE, [MARKER]: '1', [OPERATION]: mutation.operationId,
        ...(version === null ? {'if-none-match': '*'} : {'if-match': version}),
      }});
      return true;
    } catch (caught) {
      const error = serviceError(caught);
      if (error.writeOutcome === 'not-applied' && (error.status === 412 && error.code === 'PreconditionFailed' || error.status === 409 && error.code === 'ConditionalRequestConflict')) return false;
      throw error;
    }
  }
  return {
    async read(key, {maxBytes}) {
      keyInScope(key);
      requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= MAX_BYTES, 'Invalid migration object read limit');
      const response = await request('GET', key, {signal: AbortSignal.timeout(timeoutMs)});
      if (response.status === 404) {
        const error = (await boundedBody(response, 16384)).toString('utf8');
        requireValue(/<Code>NoSuchKey<\/Code>/.test(error), 'Migration source returned an unrecognized missing-object response');
        return {version: null, operationId: null, revision: null, deleted: true, bytes: null, contentType: null};
      }
      const version = response.headers.get('etag');
      try {
        requireValue(response.status === 200, 'Migration object store returned an incomplete read');
        requireValue(version, 'Migration object store omitted ETag');
        expectedVersion(version);
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      const marked = response.headers.get(MARKER);
      const operationId = response.headers.get(OPERATION);
      const type = response.headers.get('content-type') ?? 'application/octet-stream';
      const wrapped = marked !== null || operationId !== null || type === CONTENT_TYPE;
      const bytes = await boundedBody(response, wrapped ? Math.ceil(maxBytes / 3) * 4 + 16384 : maxBytes);
      if (!wrapped) return {version, operationId: null, revision: null, deleted: false, bytes, contentType: type};
      requireValue(marked === '1' && type === CONTENT_TYPE && operationId && UUID.test(operationId), 'Incomplete migration object envelope metadata');
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid migration object envelope');
      const e = value as Record<string, unknown>;
      const fields = ['format', 'epoch', 'sourceId', 'keyHash', 'operationId', 'revision', 'deleted', 'contentType', 'payload', 'payloadHash'];
      requireValue(Object.keys(e).length === fields.length && fields.every(name => Object.hasOwn(e, name)) && e.format === FORMAT && e.epoch === epoch && e.sourceId === sourceId && e.keyHash === sha(key) && e.operationId === operationId && typeof e.revision === 'string' && typeof e.deleted === 'boolean', 'Migration object envelope binding differs');
      revision(e.revision);
      if (e.deleted) {
        requireValue(e.payload === null && e.payloadHash === null && e.contentType === null, 'Migration tombstone contains a payload');
        return {version, operationId, revision: e.revision, deleted: true, bytes: null, contentType: null};
      }
      requireValue(typeof e.payload === 'string' && typeof e.payloadHash === 'string' && /^[a-f0-9]{64}$/.test(e.payloadHash) && typeof e.contentType === 'string', 'Invalid migration object payload envelope');
      contentType(e.contentType);
      const decoded = Buffer.from(e.payload, 'base64');
      requireValue(decoded.byteLength <= maxBytes && decoded.toString('base64') === e.payload && sha(decoded) === e.payloadHash, 'Migration object payload integrity or bound differs');
      return {version, operationId, revision: e.revision, deleted: false, bytes: decoded, contentType: e.contentType} satisfies OnlineExternalSnapshot;
    },
    putIfVersion: (key, version, mutation) => write(key, version, mutation, false),
    deleteIfVersion: (key, version, mutation) => write(key, version, mutation, true),
  };
}
