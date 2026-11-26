/** Release capability used by shells to verify the public deletion contract. */
export const sessionDeletionExecution = 'temporal' as const;
import type {Principal, Authenticate, HttpHandler} from './types.mjs';
import {parseJson, serviceError, SESSION_HARNESS_PATTERN} from './types.mjs';
import {z} from 'zod';
import {validParticipant} from './participants.mjs';
import {sessionScope} from './event-identity.mjs';
import type {createSessionLibrary} from './library.mjs';
import type {createMemoryLibrary} from '../memories/library.mjs';
import {fail} from '../errors.mjs';
import type {RecordingPolicy} from './recording.mjs';
import type {CaptureLinks} from '../state/capture-links.mjs';
import {captureIdPattern} from '../application/capture-links.mjs';

import type {PrivacyPreferences} from './privacy.mjs';
const harness = z.string().regex(SESSION_HARNESS_PATTERN);
// Memory files exist only for harnesses that keep them on disk.
const memoryHarness = z.enum(['claude-code', 'codex']);
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const path = z.string().min(4).max(2048);
const visibility = z.enum(['team', 'private']);
const scope = z.enum(['all', 'mine']).default('all');
const byPermalink = z.strictObject({permalinkId:z.string().regex(captureIdPattern)});
const pageFields = {cursor:z.string().max(2048).nullish(),limit:z.number().int().min(1).max(200).default(100),direction:z.enum(['forward','backward']).optional(),
  event:z.strictObject({eventId:id,installationId:id.optional()}).optional()};
export const libraryOperations = {
  'privacy/status':z.strictObject({}),
  'privacy/change':z.strictObject({enabled:z.boolean(),rules:z.string().max(1500),revision:z.string().max(40),subject:z.string().max(160)}),
  'recording/status':z.strictObject({}),
  'recording/change':z.strictObject({mode:z.enum(['hour','indefinite','resume']),revision:z.string().max(40),subject:z.string().max(160)}),
  'sessions/list': z.strictObject({scope, participant: z.string().refine(validParticipant).optional(), query: z.string().max(500).default(''), limit: z.number().int().min(1).max(500).default(50)}),
  'sessions/read': z.union([byPermalink.extend(pageFields),z.strictObject({userId:id,harness,sessionId:id,...pageFields})]),
  'sessions/visibility': z.strictObject({harness, sessionId: id, visibility}),
  'sessions/delete': z.strictObject({harness, sessionId: id}),
  'memories/list': z.strictObject({scope}),
  'memories/read': z.union([byPermalink,z.strictObject({userId: id, harness: memoryHarness, path})]),
  'memories/visibility': z.strictObject({harness: memoryHarness, path, visibility}),
  'memories/delete': z.strictObject({harness: memoryHarness, path}),
};
export type LibraryOperation = keyof typeof libraryOperations;
export const isLibraryOperation = (value: string): value is LibraryOperation => Object.hasOwn(libraryOperations, value);

/** One validated entry point for every runtime. The runtime authenticates and
 * supplies the principal; owner checks and visibility live in the libraries. */
export function createLibraryApi({sessions, memories, recording, privacy, links}: {links?:CaptureLinks; privacy?:PrivacyPreferences; sessions?: ReturnType<typeof createSessionLibrary> | null; memories?: ReturnType<typeof createMemoryLibrary> | null; recording?: RecordingPolicy}) {
  return async (principal: Principal, operation: string, input: unknown) => {
    const subject=sessionScope(principal);
    if (principal.captureAccess !== undefined) fail(403, 'Capture credentials cannot manage sessions or memories');
    if (!isLibraryOperation(operation)) fail(404, 'Unknown operation');
    const parsed = libraryOperations[operation].safeParse(input ?? {});
    if (!parsed.success) fail(400, 'Invalid request');
    if(operation==='privacy/status'||operation==='privacy/change'){
      if(!privacy)fail(404,'Session privacy is unavailable');
      if(operation==='privacy/status')return privacy.read(principal);
      return privacy.change(principal,libraryOperations['privacy/change'].parse(parsed.data));
    }
    if(operation==='recording/status'||operation==='recording/change'){
      if(!recording && operation==='recording/status')return {available:false};
      if(!recording)fail(503,'Recording controls are unavailable');
      if(operation==='recording/change'){
        const change=libraryOperations['recording/change'].parse(parsed.data);
        if(change.subject!==subject)fail(409,'Your workspace or account changed. Reload the page to update recording.');
        return {...await recording.change(principal,change.mode,change.revision),subject};
      }
      const {revision,paused,until}=await recording.read(principal);
      return {revision,paused,until,subject};
    }
    const [resource, action] = operation.split('/') as ['sessions' | 'memories', string];
    const library = resource === 'sessions' ? sessions : memories;
    if (!library) fail(503, resource === 'sessions' ? 'Session storage is not configured' : 'Memory storage is not configured');
    const value = parsed.data as Record<string, unknown>;
    if (action === 'list') {
      const result=await library.list(principal,value);
      if (!links) return result;
      if ('sessions' in result) {
        const refs=result.sessions.flatMap(row=>row.historyCapture ? [row,row.historyCapture] : [row]);
        const ids=await links.register(principal.tenantId,'sessions',refs.map(row=>({...row,name:row.sessionId})));
        const byReference=new Map(refs.map((ref,i)=>[ref,ids[i]]));
        return {...result,sessions:result.sessions.map(row=>({...row,permalinkId:byReference.get(row),
          ...(row.historyCapture ? {historyCapture:{...row.historyCapture,permalinkId:byReference.get(row.historyCapture)}} : {})}))};
      }
      const ids=await links.register(principal.tenantId,'memories',result.memories.map(row=>({...row,name:row.path})));
      return {...result,memories:result.memories.map((row,i)=>({...row,permalinkId:ids[i]}))};
    }
    if (action === 'read') {
      let identity=value;
      if (typeof value.permalinkId==='string') {
        const key=await links?.resolve(principal.tenantId,resource,value.permalinkId);
        if (!key) fail(404,resource==='sessions' ? 'Session not found' : 'Memory not found');
        identity={...value,userId:key.userId,harness:key.harness,[resource==='sessions'?'sessionId':'path']:key.name};
      }
      const result=await library.read(principal,identity);
      if (!links) return result;
      if ('session' in result) {
        const row=result.session;
        const permalinkId=value.permalinkId ?? (await links.register(principal.tenantId,'sessions',[{...row,name:row.sessionId}]))[0];
        return {...result,session:{...row,permalinkId}};
      }
      const row=result.memory;
      const [permalinkId,sourceId]=await Promise.all([
        value.permalinkId ?? links.register(principal.tenantId,'memories',[{...row,name:row.path}]).then(ids=>ids[0]),
        row.sourceSessionId ? links.register(principal.tenantId,'sessions',[{...row,name:row.sourceSessionId}]).then(ids=>ids[0]) : undefined,
      ]);
      return {...result,memory:{...row,permalinkId,sourcePermalinkId:sourceId}};
    }
    if (action === 'visibility') return library.setVisibility(principal, value);
    return resource === 'sessions' ? sessions!.requestDeletion(principal, value) : memories!.delete(principal, value);
  };
}
/** Status and safe message for an operation failure. Unclassified failures never expose details. */
export function libraryFailure(caught: unknown) {
  const error = serviceError(caught), status = [400, 403, 404, 409, 413].includes(error.status ?? 0) ? error.status! : 503;
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
      if(operation==='recording/change'||operation.startsWith('privacy/'))return send(403,{error:{code:'BROWSER_SESSION_REQUIRED'}});
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
