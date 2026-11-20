import {activityInput,admitActivity} from '../application/agent-activity.mjs';
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
import {excerpt, groupDuplicates, groupResources, prioritizeEvidence, workspaceHit} from './presentation.mjs';
import {digest,sessionScope as ownerScope} from '../sessions/event-identity.mjs';
import {searchFiltersSchema} from './controls.mjs';
import {currentSessionSchema} from './context.mjs';
import {candidateFacets, facetNames} from './facets.mjs';
import {memoryPassageId} from '../memories/projection.mjs';
import {fail} from '../errors.mjs';

export const workspaceSearchSchema = z.strictObject({
  query: z.string().trim().max(4000).describe('Use 2–6 distinctive keywords or an exact phrase, not a question. Start match=all; shorten or use any if needed. Empty only for time-ordered browsing.'),
  source: z.enum(['all', 'sessions', 'connectors','memories']).default('all'),
  match: z.enum(['any', 'all', 'phrase']).default('any').describe('any ranks passages matching any words; all requires every analyzed term in one indexed passage, across its title/text fields. Terms do not combine across a chat. phrase requires analyzed words in order.'),
  sessionId: z.string().min(1).max(200).optional().describe('Restrict to a known session; requires source=sessions.'),
  currentSession: currentSessionSchema.optional(),
  includeCurrentSession: z.boolean().default(false).describe('Default false: exclude the current chat when its native identity is available. Set true to search it explicitly.'),
  includeToolOutputs: z.boolean().default(false).describe('Default false: omit captured tool output, including messages containing tool-result blocks. Set true to include it; connector documents are unaffected.'),
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
  context: z.boolean().optional().describe('For a sessions: result, include nearby events around its event. Defaults to 3 before and 3 after, with up to 2000 characters from each neighboring event. The selected passage stays the anchor.'),
  before: z.number().int().min(0).max(10).optional().describe('Number of preceding events. Implies context=true.'),
  after: z.number().int().min(0).max(10).optional().describe('Number of following events. Implies context=true.'),
  includeToolOutputs: z.boolean().optional().describe('Include tool/command outputs in neighboring events; false by default. The explicitly selected anchor is always readable.'),
}).refine(v => v.context !== false || v.before === undefined && v.after === undefined, 'before/after require context')
  .refine(v => !(v.context || v.before !== undefined || v.after !== undefined) || v.id.startsWith('sessions:'), 'Event context requires a sessions: passage ID')
  .refine(v => v.includeToolOutputs === undefined || v.context || v.before !== undefined || v.after !== undefined, 'includeToolOutputs requires event context');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const WINDOW = 100, TTL = 5 * 60_000;

/** Adapters resolve current authorized bindings on EVERY call, including pagination.
 * Source ranks are interleaved for discovery. Relevance searches place narrowly
 * recognized machine approval records after evidence, unless approvals are queried.
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
      if (!parsed.success) fail(400, 'Invalid search request. Check query, source, match, filters, order, facets, select, excerptChars, sessionId, currentSession, includeCurrentSession, includeToolOutputs, limit, dedupe, groupBy and cursor. Empty query requires a time order.');
      // Preserve the original dedupe=false inspection contract for older clients.
      if(!parsed.data.dedupe&&(input as {groupBy?:unknown}).groupBy===undefined)parsed.data.groupBy='none';
      const {cursor, ...query} = parsed.data;
      if (!query.currentSession && principal.owner?.provider === 'devin')
        query.currentSession = currentSessionSchema.parse({harness: 'devin', sessionId: principal.owner.sessionId});
      const fingerprint = hash([principal.tenantId, principal.userId, query]);
      const page = cursor ? decode(cursor, fingerprint) : {offset: 0, expires: now() + TTL};
      const selected = query.source === 'all' ? ['sessions', 'connectors',...(memories?['memories']:[])] : [query.source];
      const groups = await Promise.all(selected.map(async source => {
        const adapter = source === 'sessions' ? sessions : source==='memories'?memories:connectors;
        if (!adapter) return {source, state: 'not_configured', hits: [], truncated: false};
        let result;
        try {result = await adapter.search(principal, {query: query.query, match: query.match, filters:query.filters, order:query.order, ...(query.sessionId ? {sessionId: query.sessionId} : {}), ...(source==='sessions'?{currentSession:query.currentSession,includeCurrentSession:query.includeCurrentSession,includeToolOutputs:query.includeToolOutputs}:{}), limit: WINDOW});}
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
      const prioritized = query.order === 'relevance' ? prioritizeEvidence(ranked, query.query) : {results: ranked, demoted: 0};
      const deduped = query.dedupe ? groupDuplicates(prioritized.results) : {results: prioritized.results, suppressed: 0};
      const grouped=groupResources(deduped.results,query.groupBy);
      const results = grouped.results.slice(page.offset, page.offset + query.limit).map(hit => {
        const {text,...rest}=hit, fields={...rest,...(query.select.includes('text')?excerpt(text,query.query,query.excerptChars):{})};
        return Object.fromEntries(Object.entries(fields).filter(([key])=>!['title','text','url','provenance'].includes(key)||query.select.includes(key as 'title'|'text'|'url'|'provenance')));
      }), offset = page.offset + results.length;
      const next = offset < grouped.results.length ? encode({fingerprint, offset, expires: page.expires}) : null;
      const coverage = groups.map(({source, state, hits, truncated}) => ({source, state, candidates: hits.length, truncated}));
      const partial = coverage.some(g => g.state === 'unavailable' || g.state === 'pending');
      const unclassifiedSessionCandidates=groups.filter(group=>group.source==='sessions').reduce((count,group)=>count+group.hits.filter(hit=>typeof hit.containsToolOutput!=='boolean').length,0);
      return {query: query.query, searchContext:{currentSession:query.currentSession??null,
        currentSessionStatus:query.currentSession?(query.includeCurrentSession?'included':'excluded'):'unavailable',
        currentSessionExcluded:Boolean(query.currentSession)&&!query.includeCurrentSession,toolOutputsIncluded:query.includeToolOutputs,
        unclassifiedSessionCandidates,...(unclassifiedSessionCandidates&&!query.includeToolOutputs?{warning:'Some session candidates predate tool-output classification. Legacy embedded tool outputs may remain until the server metadata migration completes.'}:{})},
        results, next, coverage, partial, deduplicated: deduped.suppressed, grouped:grouped.suppressed,
        truncated: Boolean(next) || coverage.some(g => g.truncated),
        windowExhausted: !next && coverage.some(g => g.truncated),
        ...(query.facets.length?{facets:candidateFacets(ranked,query.facets),facetScope:'authorized_candidate_window'}:{}),
        pagination: 'live', ranking: query.order==='relevance'?(prioritized.demoted?'source_rank_interleave_with_approval_demotion':'source_rank_interleave'):query.order, candidateLimitPerSource: WINDOW};
    },
    async fetch(principal: Principal, input: unknown) {
      sessionScope(principal);
      if (principal.captureAccess === 'write') fail(403, 'Capture credentials cannot read workspace data.');
      const parsed = workspaceFetchSchema.safeParse(input);
      if (!parsed.success) fail(400, 'Invalid fetch request. Use id, offset, length, version; session event context accepts context, before/after 0..10 and includeToolOutputs.');
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
          const neighbor=source==='sessions'?digest(JSON.stringify([scope,document.harness,document.sessionId,document.eventId,chunk])):
            memoryPassageId({tenantId:principal.tenantId,userId:document.userId!},document.snapshotId!,document.path!,chunk,document.projectionId);
          const checked=await adapter.search(principal,{id:neighbor,query:'',limit:1});
          if(checked.hits.some(d=>d.id===neighbor&&d.tenantId===principal.tenantId&&d.userId===document.userId))neighbors[label]=source+':'+neighbor;
        }
      }
      const wantsContext = parsed.data.context || parsed.data.before !== undefined || parsed.data.after !== undefined;
      let context;
      if (wantsContext) {
        if (!adapter.context) fail(503, 'Session event context is not configured.');
        const input = {before: parsed.data.before ?? 3, after: parsed.data.after ?? 3, includeToolOutputs: parsed.data.includeToolOutputs ?? false};
        const window = await adapter.context(principal, document, input);
        const render = (items: typeof window.before) => items.map(item => {
          if (item.tenantId !== principal.tenantId || item.userId !== document.userId || item.harness !== document.harness || item.sessionId !== document.sessionId)
            throw new Error('Invalid workspace context scope');
          const event = workspaceHit('sessions', item), limit = Math.min(2000, event.text.length);
          // Do not split a UTF-16 surrogate pair at the bounded excerpt edge.
          const end = limit && /[\uD800-\uDBFF]/.test(event.text[limit - 1]!) ? limit - 1 : limit;
          return {...event, text: event.text.slice(0, end), offset: 0, totalChars: event.text.length,
            nextOffset: end < event.text.length ? end : null, version: hash(event),
            eventTextComplete: item.chunkCount === 1 && end === event.text.length};
        });
        const unclassifiedEvents = [...window.before, ...window.after].filter(item => typeof item.containsToolOutput !== 'boolean').length;
        context = {before: render(window.before), after: render(window.after), moreBefore: window.moreBefore, moreAfter: window.moreAfter,
          toolOutputsIncluded: input.includeToolOutputs, unclassifiedEvents,
          ...(unclassifiedEvents && !input.includeToolOutputs ? {warning: 'Some neighboring events predate tool-output classification and may contain embedded tool output.'} : {}),
          pagination: 'live', maxCharsPerEvent: 2000};
      }
      return {...hit, text: hit.text.slice(offset, end), offset, totalChars: hit.text.length, nextOffset: end < hit.text.length ? end : null, version: currentVersion,...neighbors,...(context ? {context} : {})};
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
      admitActivity(principal);
      if (!search) return send(503, {error: {code: 'SEARCH_NOT_CONFIGURED'}});
      const chunks = []; let size = 0;
      for await (const chunk of req) {size += chunk.length; if (size > 16384) return send(413, {error: {code: 'REQUEST_TOO_LARGE'}}); chunks.push(chunk);}
      let input; try {input = parseJson<unknown>(Buffer.concat(chunks));} catch {return send(400, {error: {code: 'INVALID_JSON'}});}
      activityInput(input);
      return send(200, {data: await search[operation](principal, input)});
    } catch(caught){const error=serviceError(caught);
      const status = [400, 401, 403, 404, 409].includes(error.status ?? 0) ? error.status! : 503;
      return send(status, {error: {code: ({401:'AUTH_REQUIRED',403:'SEARCH_FORBIDDEN',400:'INVALID_QUERY',404:'NOT_FOUND',409:'CONTENT_CHANGED'} as Record<number,string>)[status] || 'SEARCH_UNAVAILABLE', message: [400,409].includes(status) ? error.message : 'Workspace search could not complete.'}});
    }
  };
}
