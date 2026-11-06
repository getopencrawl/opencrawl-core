import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {sessionScope} from '../sessions/ingest.mjs';

export const workspaceSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(4000).describe('Words to find. Start with distinctive terms; broaden or reformulate if coverage is insufficient.'),
  source: z.enum(['all', 'sessions', 'connectors']).default('all'),
  match: z.enum(['any', 'all', 'phrase']).default('any').describe('any ranks passages matching any words; all requires every analyzed term; phrase requires the analyzed words in order.'),
  sessionId: z.string().min(1).max(200).optional().describe('Restrict to a known session; requires source=sessions.'),
  limit: z.number().int().min(1).max(40).default(10),
  cursor: z.string().max(2048).optional(),
}).refine(v => !v.sessionId || v.source === 'sessions', 'sessionId requires source=sessions');
const fail = (status, message) => {throw Object.assign(new Error(message), {status});};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const WINDOW = 100, TTL = 5 * 60_000;

/** Adapters resolve current authorized bindings on EVERY call, including pagination.
 * Scores from independent indexes are not comparable. Interleave their ranks.
 * Cursors are bounded live windows, not snapshots or a claim of exhaustive recall.
 */
export function createWorkspaceSearch({sessions, connectors, cursorKey = randomBytes(32), now = Date.now} = {}) {
  function sign(value) {return createHmac('sha256', cursorKey).update(value).digest('base64url');}
  function encode(payload) {const data = Buffer.from(JSON.stringify(payload)).toString('base64url'); return data + '.' + sign(data);}
  function decode(cursor, fingerprint) {
    try {
      const [data, mac, extra] = cursor.split('.'), expected = Buffer.from(sign(data)), actual = Buffer.from(mac || '');
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const value = JSON.parse(Buffer.from(data, 'base64url'));
      if (value.fingerprint !== fingerprint || value.expires < now() || !Number.isInteger(value.offset) || value.offset < 1 || value.offset >= WINDOW * 2) throw new Error();
      return value;
    } catch {fail(400, 'Invalid or expired search cursor; repeat the original search.');}
  }
  return {
    async search(principal, input) {
      sessionScope(principal);
      if (principal.captureAccess === 'write') fail(403, 'Capture credentials cannot search workspace data.');
      const parsed = workspaceSearchSchema.safeParse(input);
      if (!parsed.success) fail(400, 'Invalid search request. Use query, source, match, sessionId, limit and cursor only.');
      const {cursor, ...query} = parsed.data;
      const fingerprint = hash([principal.tenantId, principal.userId, query]);
      const page = cursor ? decode(cursor, fingerprint) : {offset: 0, expires: now() + TTL};
      const selected = query.source === 'all' ? ['sessions', 'connectors'] : [query.source];
      const groups = await Promise.all(selected.map(async source => {
        const adapter = source === 'sessions' ? sessions : connectors;
        if (!adapter) return {source, state: 'not_configured', hits: [], truncated: false};
        let result;
        try {result = await adapter.search(principal, {query: query.query, match: query.match, ...(query.sessionId ? {sessionId: query.sessionId} : {}), limit: WINDOW});}
        catch (error) {
          if ([401, 403].includes(error.status)) throw error;
          return {source, state: error.status === 404 && error.type === 'index_not_found_exception' ? 'pending' : 'unavailable', hits: [], truncated: false};
        }
        if (!Array.isArray(result.hits) || result.hits.length > WINDOW || result.hits.some(hit => hit.tenantId !== principal.tenantId || typeof hit.id !== 'string')) throw new Error('Invalid workspace search scope');
        return {source, state: 'ready', hits: result.hits, truncated: source === 'sessions' ? result.total > result.hits.length : Boolean(result.truncated)};
      }));
      const ranked = [];
      for (let rank = 0; rank < WINDOW; rank++) for (const group of groups) {
        const hit = group.hits[rank]; if (!hit) continue;
        const provenance = group.source === 'sessions'
          ? {sessionId: hit.sessionId, eventId: hit.eventId, userId: hit.userId, harness: hit.harness, kind: hit.kind, role: hit.role, sequence: hit.sequence, chunk: hit.chunk, timestamp: hit.timestamp, receivedAt: hit.receivedAt}
          : {provider: hit.provider, connectionId: hit.connectionId, workspaceId: hit.workspaceId, sourceId: hit.sourceId, kind: hit.kind, parentId: hit.parentId, parentKind: hit.parentKind, channelId: hit.channelId, authorId: hit.authorId, timestamp: hit.timestamp, sequence: hit.sequence, heading: hit.heading};
        ranked.push({id: group.source + ':' + hit.id, source: group.source, sourceRank: rank + 1,
          title: hit.title || (group.source === 'sessions' ? `Session ${hit.sessionId}` : hit.kind), text: hit.text || '', ...(hit.url ? {url: hit.url} : {}), provenance});
      }
      const results = ranked.slice(page.offset, page.offset + query.limit), offset = page.offset + results.length;
      const next = offset < ranked.length ? encode({fingerprint, offset, expires: page.expires}) : null;
      const coverage = groups.map(({source, state, hits, truncated}) => ({source, state, candidates: hits.length, truncated}));
      const partial = coverage.some(g => g.state === 'unavailable' || g.state === 'pending');
      return {query: query.query, results, next, coverage, partial,
        truncated: Boolean(next) || coverage.some(g => g.truncated),
        windowExhausted: !next && coverage.some(g => g.truncated),
        pagination: 'live', ranking: 'interleaved_source_rank', candidateLimitPerSource: WINDOW};
    },
  };
}

/** Shared CLI/self-host/hosted HTTP protocol; authentication stays in the runtime. */
export function createWorkspaceSearchHandler({search, authenticate}) {
  return async (req, res) => {
    const send = (status, value) => {res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'});res.end(JSON.stringify({schemaVersion: 1, ...value}));};
    try {
      if (req.method !== 'POST') return send(405, {error: {code: 'METHOD_NOT_ALLOWED'}});
      if (req.headers.origin) return send(403, {error: {code: 'BROWSER_REQUEST_DENIED'}});
      const principal = await authenticate(req); sessionScope(principal);
      if (!search) return send(503, {error: {code: 'SEARCH_NOT_CONFIGURED'}});
      const chunks = []; let size = 0;
      for await (const chunk of req) {size += chunk.length; if (size > 16384) return send(413, {error: {code: 'REQUEST_TOO_LARGE'}}); chunks.push(chunk);}
      let input; try {input = JSON.parse(Buffer.concat(chunks));} catch {return send(400, {error: {code: 'INVALID_JSON'}});}
      return send(200, {data: await search.search(principal, input)});
    } catch (error) {
      const status = [400, 401, 403].includes(error.status) ? error.status : 503;
      return send(status, {error: {code: status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'SEARCH_FORBIDDEN' : status === 400 ? 'INVALID_QUERY' : 'SEARCH_UNAVAILABLE', message: status === 400 ? error.message : 'Workspace search could not complete.'}});
    }
  };
}
