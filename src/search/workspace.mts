import type {Principal, Authenticate, HttpHandler} from '../sessions/types.mjs';
import {parseJson} from '../sessions/types.mjs';
import type {SearchAdapter, Passage} from './types.mjs';
import type {WorkspaceHit} from './presentation.mjs';
interface WorkspaceOptions {sessions?: SearchAdapter & {memories?: SearchAdapter}; connectors?: SearchAdapter; memories?: SearchAdapter; cursorKey?: string | Uint8Array; now?: () => number}
interface SearchCursor {fingerprint?: string; expires: number; offset: number}
import {serviceError} from '../sessions/types.mjs';
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {sessionScope} from '../sessions/ingest.mjs';
import {excerpt, groupDuplicates, groupResources, workspaceHit} from './presentation.mjs';
import {digest,sessionScope as ownerScope} from '../sessions/event-identity.mjs';
import {searchFiltersSchema} from './controls.mjs';
import {candidateFacets, facetNames} from './facets.mjs';

export const workspaceSearchSchema = z.strictObject({
  query: z.string().trim().max(4000).describe('Use 2–6 distinctive keywords or an exact phrase, not a question. Start match=all; shorten or use any if needed. Empty only for time-ordered browsing.'),
  source: z.enum(['all', 'sessions', 'connectors','memories']).default('all'),
  match: z.enum(['any', 'all', 'phrase']).default('any').describe('any ranks passages matching any words; all requires every analyzed term in one indexed passage, across its title/text fields. Terms do not combine across a chat. phrase requires analyzed words in order.'),
  sessionId: z.string().min(1).max(200).optional().describe('Restrict to a known session; requires source=sessions.'),
  limit: z.number().int().min(1).max(40).default(10),
  dedupe: z.boolean().default(true).describe('Group whitespace-equivalent passages within the same session/resource. Use false with groupBy=none to inspect every occurrence.'),
  cursor: z.string().max(2048).optional(),
  filters: searchFiltersSchema.optional(),
  order: z.enum(['relevance','newest','oldest']).default('relevance'),
  facets: z.array(z.enum(facetNames)).max(facetNames.length).default([]).describe('Facet counts over authorized candidates only; bounded, not exhaustive corpus totals.'),
  select: z.array(z.enum(['title','text','url','provenance'])).max(4).default(['title','text','url','provenance']).describe('Response fields to return. id and source are always included. Omit text for cheap discovery, then fetch.'),
  excerptChars: z.number().int().min(100).max(2000).default(800),
  groupBy: z.enum(['none','resource','session']).default('resource').describe('resource keeps the best passage per session event, memory file, or connector document. session also groups whole sessions. none returns every passage.'),
}).refine(v => !v.sessionId || v.source === 'sessions', 'sessionId requires source=sessions')
  .refine(v=>Boolean(v.query)||v.order!=='relevance','Empty query requires newest or oldest order');
export const workspaceFetchSchema = z.strictObject({
  id: z.string().regex(/^(sessions|connectors|memories):[A-Za-z0-9_:-]{1,256}$/).describe('An id returned by search. Access is checked again on every fetch.'),
  offset: z.number().int().min(0).max(10_000_000).default(0),
  length: z.number().int().min(1).max(16000).default(6000),
  version: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Repeat the returned version when paging, to detect content changes.'),
});
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status});}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const WINDOW = 100, TTL = 5 * 60_000;

/** Adapters resolve current authorized bindings on EVERY call, including pagination.
 * Each source retains its lexical ranking. Source ranks are interleaved so
 * a high-volume corpus cannot crowd out the other sources during discovery.
 * Cursors are bounded live windows, not snapshots or a claim of exhaustive recall.
 */
export function createWorkspaceSearch({sessions, connectors,memories=sessions?.memories, cursorKey = randomBytes(32), now = Date.now}: WorkspaceOptions = {}) {
  function sign(value: string) {return createHmac('sha256', cursorKey).update(value).digest('base64url');}
  function encode(payload: SearchCursor) {const data = Buffer.from(JSON.stringify(payload)).toString('base64url'); return data + '.' + sign(data);}
  function decode(cursor: string, fingerprint: string): SearchCursor {
    try {
      const [data, mac, extra] = cursor.split('.'), expected = Buffer.from(sign(data)), actual = Buffer.from(mac || '');
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const value = parseJson<SearchCursor>(Buffer.from(data, 'base64url'));
      if (value.fingerprint !== fingerprint || value.expires < now() || !Number.isInteger(value.offset) || value.offset < 1 || value.offset >= WINDOW * 3) throw new Error();
      return value;
    } catch {fail(400, 'Invalid or expired search cursor; repeat the original search.');}
  }
  return {
    async search(principal: Principal, input: unknown) {
      sessionScope(principal);
      if (principal.captureAccess === 'write') fail(403, 'Capture credentials cannot search workspace data.');
      const parsed = workspaceSearchSchema.safeParse(input);
      if (!parsed.success) fail(400, 'Invalid search request. Check query, source, match, filters, order, facets, select, excerptChars, sessionId, limit, dedupe, groupBy and cursor. Empty query requires a time order.');
      // Preserve the original dedupe=false inspection contract for older clients.
      if(!parsed.data.dedupe&&(input as {groupBy?:unknown}).groupBy===undefined)parsed.data.groupBy='none';
      const {cursor, ...query} = parsed.data;
      const fingerprint = hash([principal.tenantId, principal.userId, query]);
      const page = cursor ? decode(cursor, fingerprint) : {offset: 0, expires: now() + TTL};
      const selected = query.source === 'all' ? ['sessions', 'connectors',...(memories?['memories']:[])] : [query.source];
      const groups = await Promise.all(selected.map(async source => {
        const adapter = source === 'sessions' ? sessions : source==='memories'?memories:connectors;
        if (!adapter) return {source, state: 'not_configured', hits: [], truncated: false};
        let result;
        try {result = await adapter.search(principal, {query: query.query, match: query.match, filters:query.filters, order:query.order, ...(query.sessionId ? {sessionId: query.sessionId} : {}), limit: WINDOW});}
        catch(caught){const error=serviceError(caught);
          if ([401, 403].includes(error.status ?? 0)) throw error;
          return {source, state: error.status === 404 && error.type === 'index_not_found_exception' ? 'pending' : 'unavailable', hits: [], truncated: false};
        }
        if (!Array.isArray(result.hits) || result.hits.length > WINDOW || result.hits.some(hit => hit.tenantId !== principal.tenantId || typeof hit.id !== 'string')) throw new Error('Invalid workspace search scope');
        return {source, state: 'ready', hits: result.hits, truncated: Boolean(result.truncated)||(result.total ?? 0)>result.hits.length};
      }));
      const ranked: WorkspaceHit[] = [];
      for (let rank = 0; rank < WINDOW; rank++) for (const group of groups) {
        const hit = group.hits[rank]; if (!hit) continue;
        const result=workspaceHit(group.source, hit, rank + 1);ranked.push(result);
      }
      if(query.order!=='relevance')ranked.sort((a,b)=>{
        const time=(h:WorkspaceHit)=>{const raw=h.provenance.modifiedAt||h.provenance.timestamp;return typeof raw==='number'?raw:typeof raw==='string'&&/^\d{10}(\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(String(raw||''));};
        const at=time(a),bt=time(b);return (Number.isFinite(at)&&Number.isFinite(bt)?(at-bt)*(query.order==='newest'?-1:1):Number.isFinite(at)?-1:Number.isFinite(bt)?1:0)||a.id.localeCompare(b.id);
      });
      const deduped = query.dedupe ? groupDuplicates(ranked) : {results: ranked, suppressed: 0};
      const grouped=groupResources(deduped.results,query.groupBy);
      const results = grouped.results.slice(page.offset, page.offset + query.limit).map(hit => {
        const {text,...rest}=hit, fields={...rest,...(query.select.includes('text')?excerpt(text,query.query,query.excerptChars):{})};
        return Object.fromEntries(Object.entries(fields).filter(([key])=>!['title','text','url','provenance'].includes(key)||query.select.includes(key as 'title'|'text'|'url'|'provenance')));
      }), offset = page.offset + results.length;
      const next = offset < grouped.results.length ? encode({fingerprint, offset, expires: page.expires}) : null;
      const coverage = groups.map(({source, state, hits, truncated}) => ({source, state, candidates: hits.length, truncated}));
      const partial = coverage.some(g => g.state === 'unavailable' || g.state === 'pending');
      return {query: query.query, results, next, coverage, partial, deduplicated: deduped.suppressed, grouped:grouped.suppressed,
        truncated: Boolean(next) || coverage.some(g => g.truncated),
        windowExhausted: !next && coverage.some(g => g.truncated),
        ...(query.facets.length?{facets:candidateFacets(ranked,query.facets),facetScope:'authorized_candidate_window'}:{}),
        pagination: 'live', ranking: query.order==='relevance'?'source_rank_interleave':query.order, candidateLimitPerSource: WINDOW};
    },
    async fetch(principal: Principal, input: unknown) {
      sessionScope(principal);
      if (principal.captureAccess === 'write') fail(403, 'Capture credentials cannot read workspace data.');
      const parsed = workspaceFetchSchema.safeParse(input);
      if (!parsed.success) fail(400, 'Invalid fetch request. Use id, offset, length and version only.');
      const {id, offset, length, version} = parsed.data, separator = id.indexOf(':');
      const source = id.slice(0, separator), documentId = id.slice(separator + 1);
      const adapter = source === 'sessions' ? sessions : source==='memories'?memories:connectors;
      if (!adapter) fail(503, 'Source not configured.');
      // Use the SAME adapter path as search: current bindings, channel visibility,
      // deletion and parent revision checks apply to ID lookups too. No text cache.
      const result = await adapter.search(principal, {id: documentId, query: '', limit: 1});
      if (!Array.isArray(result.hits) || result.hits.length > 1 || result.hits.some(hit => hit.tenantId !== principal.tenantId || hit.id !== documentId)) throw new Error('Invalid workspace fetch scope');
      if (!result.hits.length) fail(404, 'Passage not found or no longer available.');
      const hit = workspaceHit(source, result.hits[0]), currentVersion = hash(hit);
      if (version && version !== currentVersion) fail(409, 'Passage changed; fetch again from offset 0.');
      if (offset > hit.text.length) fail(400, 'Offset exceeds passage length.');
      const end = Math.min(offset + length, hit.text.length);
      const document=result.hits[0],neighbors:{previousId?:string;nextId?:string}={};
      if(source!=='connectors'&&Number.isInteger(document.chunk)&&typeof document.chunkCount==='number'){
        for(const [label,chunk] of [['previousId',Number(document.chunk)-1],['nextId',Number(document.chunk)+1]] as const){
          if(chunk<0||chunk>=document.chunkCount)continue;
          const scope=ownerScope({tenantId:principal.tenantId,userId:document.userId!});
          const neighbor=digest(JSON.stringify(source==='sessions'?[scope,document.harness,document.sessionId,document.eventId,chunk]:[scope,document.snapshotId,document.path,chunk]));
          const checked=await adapter.search(principal,{id:neighbor,query:'',limit:1});
          if(checked.hits.some(d=>d.id===neighbor&&d.tenantId===principal.tenantId&&d.userId===document.userId))neighbors[label]=source+':'+neighbor;
        }
      }
      return {...hit, text: hit.text.slice(offset, end), offset, totalChars: hit.text.length, nextOffset: end < hit.text.length ? end : null, version: currentVersion,...neighbors};
    },
  };
}

/** Shared CLI/self-host/hosted HTTP protocol; authentication stays in the runtime. */
export function createWorkspaceSearchHandler({search, authenticate, operation = 'search'}: {search?: ReturnType<typeof createWorkspaceSearch>; authenticate: Authenticate; operation?: 'search' | 'fetch'}): HttpHandler {
  if (!['search', 'fetch'].includes(operation)) throw new Error('Invalid workspace operation');
  return async (req, res) => {
    const send = (status: number, value: Record<string, unknown>) => {res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});res.end(JSON.stringify({schemaVersion: 1, ...value}));};
    try {
      if (req.method !== 'POST') return send(405, {error: {code: 'METHOD_NOT_ALLOWED'}});
      if (req.headers.origin) return send(403, {error: {code: 'BROWSER_REQUEST_DENIED'}});
      const principal = await authenticate(req); sessionScope(principal); if (!principal) fail(401, 'Authentication required');
      if (!search) return send(503, {error: {code: 'SEARCH_NOT_CONFIGURED'}});
      const chunks = []; let size = 0;
      for await (const chunk of req) {size += chunk.length; if (size > 16384) return send(413, {error: {code: 'REQUEST_TOO_LARGE'}}); chunks.push(chunk);}
      let input; try {input = parseJson<unknown>(Buffer.concat(chunks));} catch {return send(400, {error: {code: 'INVALID_JSON'}});}
      return send(200, {data: await search[operation](principal, input)});
    } catch(caught){const error=serviceError(caught);
      const status = [400, 401, 403, 404, 409].includes(error.status ?? 0) ? error.status! : 503;
      return send(status, {error: {code: ({401:'AUTH_REQUIRED',403:'SEARCH_FORBIDDEN',400:'INVALID_QUERY',404:'NOT_FOUND',409:'CONTENT_CHANGED'} as Record<number,string>)[status] || 'SEARCH_UNAVAILABLE', message: [400,409].includes(status) ? error.message : 'Workspace search could not complete.'}});
    }
  };
}
