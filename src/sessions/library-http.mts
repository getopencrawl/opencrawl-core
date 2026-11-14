/** Release capability used by shells to verify the public deletion contract. */
export const sessionDeletionExecution = 'temporal' as const;
import type {Principal, Authenticate, HttpHandler} from './types.mjs';
import {parseJson, serviceError, SESSION_HARNESSES} from './types.mjs';
import {z} from 'zod';
import {validParticipant} from './participants.mjs';
import {sessionScope} from './event-identity.mjs';
import type {createSessionLibrary} from './library.mjs';
import type {createMemoryLibrary} from '../memories/library.mjs';

const harness = z.enum(SESSION_HARNESSES);
// Memory files exist only for harnesses that keep them on disk.
const memoryHarness = z.enum(['claude-code', 'codex']);
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const path = z.string().min(4).max(2048);
const visibility = z.enum(['team', 'private']);
const scope = z.enum(['all', 'mine']).default('all');
export const libraryOperations = {
  'sessions/list': z.strictObject({scope, participant: z.string().refine(validParticipant).optional(), query: z.string().max(500).default(''), limit: z.number().int().min(1).max(500).default(50)}),
  'sessions/read': z.strictObject({userId: id, harness, sessionId: id, cursor: z.string().max(2048).nullish(), limit: z.number().int().min(1).max(200).default(100)}),
  'sessions/visibility': z.strictObject({harness, sessionId: id, visibility}),
  'sessions/delete': z.strictObject({harness, sessionId: id}),
  'memories/list': z.strictObject({scope}),
  'memories/read': z.strictObject({userId: id, harness: memoryHarness, path}),
  'memories/visibility': z.strictObject({harness: memoryHarness, path, visibility}),
  'memories/delete': z.strictObject({harness: memoryHarness, path}),
};
export type LibraryOperation = keyof typeof libraryOperations;
export const isLibraryOperation = (value: string): value is LibraryOperation => Object.hasOwn(libraryOperations, value);
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}

/** One validated entry point for every runtime. The runtime authenticates and
 * supplies the principal; owner checks and visibility live in the libraries. */
export function createLibraryApi({sessions, memories}: {sessions?: ReturnType<typeof createSessionLibrary> | null; memories?: ReturnType<typeof createMemoryLibrary> | null}) {
  return async (principal: Principal, operation: string, input: unknown) => {
    sessionScope(principal);
    if (principal.captureAccess !== undefined) fail(403, 'Capture credentials cannot manage sessions or memories');
    if (!isLibraryOperation(operation)) fail(404, 'Unknown operation');
    const parsed = libraryOperations[operation].safeParse(input ?? {});
    if (!parsed.success) fail(400, 'Invalid request');
    const [resource, action] = operation.split('/') as ['sessions' | 'memories', string];
    const library = resource === 'sessions' ? sessions : memories;
    if (!library) fail(503, resource === 'sessions' ? 'Session storage is not configured' : 'Memory storage is not configured');
    const value = parsed.data as Record<string, unknown>;
    if (action === 'list') return library.list(principal, value);
    if (action === 'read') return library.read(principal, value);
    if (action === 'visibility') return library.setVisibility(principal, value);
    return resource === 'sessions' ? sessions!.requestDeletion(principal, value) : memories!.delete(principal, value);
  };
}
/** Status and safe message for an operation failure. Unclassified failures never expose details. */
export function libraryFailure(caught: unknown) {
  const error = serviceError(caught), status = [400, 403, 404, 413].includes(error.status ?? 0) ? error.status! : 503;
  return {status, message: status === 503 ? 'Sessions and memories are temporarily unavailable. Try again.' : error.message};
}

/** Self-host HTTP protocol: POST /api/library/<resource>/<action> with a JSON body. */
export function createLibraryHandler({api, authenticate}: {api: ReturnType<typeof createLibraryApi>; authenticate: Authenticate}): HttpHandler {
  return async (req, res) => {
    const send = (status: number, value: Record<string, unknown>) => {res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify({schemaVersion: 1, ...value}));};
    try {
      if (req.method !== 'POST') return send(405, {error: {code: 'METHOD_NOT_ALLOWED'}});
      if (req.headers.origin) return send(403, {error: {code: 'BROWSER_REQUEST_DENIED'}});
      const principal = await authenticate(req);
      if (!principal) return send(401, {error: {code: 'AUTH_REQUIRED'}});
      const operation = new URL(req.url ?? '', 'http://library').pathname.replace(/^\/api\/library\//, '');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {size += chunk.length; if (size > 16384) return send(413, {error: {code: 'REQUEST_TOO_LARGE'}}); chunks.push(Buffer.from(chunk));}
      let input: unknown; try {input = chunks.length ? parseJson<unknown>(Buffer.concat(chunks)) : {};} catch {return send(400, {error: {code: 'INVALID_JSON'}});}
      return send(200, {data: await api(principal, operation, input)});
    } catch (caught) {
      const {status, message} = libraryFailure(caught);
      return send(status, {error: {code: status === 503 ? 'LIBRARY_UNAVAILABLE' : 'LIBRARY_REJECTED', message}});
    }
  };
}
