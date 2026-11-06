import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {signRequest} from '../sessions/s3-store.mjs';

const text = max => z.string().trim().min(1).max(max);
export const boardSearchSchema = z.strictObject({
  workspace: text(200), query: z.string().trim().max(500).default(''),
  topics: z.array(text(80)).max(8).default([]),
  agents: z.array(text(80)).max(8).default([]),
  authors: z.array(text(200)).max(8).default([]),
  since: z.iso.datetime({offset: true}).optional(), until: z.iso.datetime({offset: true}).optional(),
  sort: z.enum(['relevance', 'newest']).default('relevance'),
  limit: z.number().int().min(1).max(10).default(5),
  facets: z.array(z.enum(['topic', 'agent', 'author', 'day'])).max(4).default(['topic', 'agent']),
  facetSize: z.number().int().min(1).max(8).default(5),
  cursor: text(100).optional().describe('Next page; repeat the same query and filters. Expires after five minutes.'),
});
const digest = value => createHash('sha256').update(value).digest('hex');
const error = (message, status = 503) => Object.assign(new Error(message), {status});
export const boardIndexMapping = {dynamic: 'strict', properties: {
  boardId: {type: 'keyword'}, tenantId: {type: 'keyword'}, id: {type: 'integer'},
  timestamp: {type: 'date'}, day: {type: 'keyword'},
  topic: {type: 'keyword', fields: {text: {type: 'text'}}},
  agent: {type: 'keyword'}, author: {type: 'keyword'}, name: {type: 'keyword'}, text: {type: 'text'},
}};

/** Derived index only. The caller supplies the authorized immutable source snapshot. */
export function createBoardSearch({endpoint, index = 'opencrawl-board-v1', username, password,
  credentials, region = 'us-east-1', replicas = 0, fetch: send = globalThis.fetch, now = Date.now}) {
  const base = new URL(endpoint);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !/^[a-z][a-z0-9_-]{0,100}$/.test(index)) throw new Error('Invalid board search endpoint or index');
  if (Boolean(username) !== Boolean(password) || !Number.isInteger(replicas) || replicas < 0 || replicas > 2) throw new Error('Invalid board search configuration');
  let ready;
  const snapshots = new Map(); let cachedBytes = 0;
  async function request(path, body, method = 'POST', contentType = 'application/json') {
    const url = new URL(base.href.replace(/\/$/, '') + '/' + index + path);
    body = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    let headers = {'content-type': contentType};
    if (username) headers.authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    if (credentials) {
      const c = await credentials(); if (c.sessionToken) headers['x-amz-security-token'] = c.sessionToken;
      headers = signRequest({method, url, body, headers, region, service: 'es', ...c});
    }
    const response = await send(url, {method, headers, body, signal: AbortSignal.timeout(15000), redirect: 'error'});
    let data; try {data = await response.json();} catch {throw error('Invalid board search response');}
    if (!response.ok) throw Object.assign(error('Board search unavailable (' + response.status + ')'), {httpStatus: response.status, type: data?.error?.type});
    return data;
  }
  async function ensureIndex() {
    try {await request('', {settings: {number_of_shards: 1, number_of_replicas: replicas}, mappings: boardIndexMapping}, 'PUT');}
    catch (e) {if (e.httpStatus !== 400 || e.type !== 'resource_already_exists_exception') throw e;}
    const mapping = (await request('/_mapping', undefined, 'GET'))?.[index]?.mappings;
    for (const [field, definition] of Object.entries(boardIndexMapping.properties)) {
      if (mapping?.dynamic !== 'strict' || mapping?.properties?.[field]?.type !== definition.type) throw error('Board search mapping mismatch; use a new index version');
    }
    if (mapping.properties.topic.fields?.text?.type !== 'text') throw error('Missing board topic text mapping');
  }
  function complete(result) {
    if (result.timed_out || result._shards?.failed !== 0 || result.hits?.total?.relation !== 'eq' || !Number.isSafeInteger(result.hits?.total?.value)) throw error('Board search did not complete; retry rather than using partial results');
    return result;
  }
  function prune() {
    for (const [id, snapshot] of snapshots) if (snapshot.expires <= now()) {snapshots.delete(id); cachedBytes -= snapshot.bytes;}
  }
  async function rank(principal, messages, boardId, args) {
    ready ||= ensureIndex().catch(e => {ready = undefined; throw e;}); await ready;
    const count = messages.length;
    const filter = [{term: {tenantId: principal.tenantId}}, {term: {boardId}}, {range: {id: {lte: count}}}];
    // Counts plus maximum identify a contiguous indexed prefix. Gaps trigger a replay.
    const coverage = complete(await request('/_search', {size: 0, track_total_hits: true,
      query: {bool: {filter}}, aggs: {last: {max: {field: 'id'}}}}));
    const indexed = coverage.hits.total.value, last = coverage.aggregations?.last?.value ?? 0;
    if (indexed > count) throw error('Unexpected board index coverage');
    const start = indexed === last ? indexed : 0;
    for (let offset = start; offset < count; offset += 250) {
      const batch = messages.slice(offset, offset + 250);
      const body = batch.map(m => JSON.stringify({index: {_id: boardId + ':' + m.id}}) + '\n' +
        JSON.stringify({boardId, tenantId: principal.tenantId, id: m.id, timestamp: m.timestamp,
          day: new Date(m.timestamp).toISOString().slice(0, 10), topic: m.topic, agent: m.agent, author: m.author, name: m.name, text: m.text}) + '\n').join('');
      const result = await request('/_bulk?refresh=wait_for', body, 'POST', 'application/x-ndjson');
      if (result.errors || result.items?.length !== batch.length || result.items.some(i => !i.index || i.index.status < 200 || i.index.status >= 300)) throw error('Board indexing incomplete; retry search to repair it');
    }
    if (start < count) {
      const verified = complete(await request('/_search', {size: 0, track_total_hits: true, query: {bool: {filter}}}));
      if (verified.hits.total.value !== count) throw error('Board indexing coverage is incomplete; retry search');
    }
    for (const [name, values] of [['topic', args.topics], ['agent', args.agents], ['author', args.authors]]) if (values.length) filter.push({terms: {[name]: values}});
    if (args.since || args.until) filter.push({range: {timestamp: {...(args.since ? {gte: args.since} : {}), ...(args.until ? {lte: args.until} : {})}}});
    const query = {bool: {filter, ...(args.query ? {
      must: [{multi_match: {query: args.query, fields: ['text', 'topic.text^2'], type: 'cross_fields', operator: 'and'}}],
      should: [{match_phrase: {text: {query: args.query, boost: 2}}}],
    } : {})}};
    const result = complete(await request('/_search', {size: 10000, track_total_hits: true, timeout: '10s',
      _source: ['boardId', 'tenantId', 'id'], query,
      sort: args.sort === 'relevance' && args.query ? [{_score: 'desc'}, {timestamp: 'desc'}, {id: 'desc'}] : [{timestamp: 'desc'}, {id: 'desc'}],
      aggs: Object.fromEntries([...new Set(args.facets)].map(field => [field, {terms: {field, size: args.facetSize, shard_size: 10000, show_term_doc_count_error: true}}])),
    }));
    const hits = result.hits.hits;
    if (!Array.isArray(hits) || hits.length !== result.hits.total.value || hits.length > count) throw error('Board result set is incomplete');
    const ids = hits.map(h => {
      const s = h._source;
      if (s?.tenantId !== principal.tenantId || s.boardId !== boardId || !Number.isInteger(s.id) || s.id < 1 || s.id > count || h._id !== boardId + ':' + s.id) throw error('Board search scope mismatch');
      return s.id;
    });
    if (new Set(ids).size !== ids.length) throw error('Duplicate board search results');
    const facets = {};
    for (const field of new Set(args.facets)) {
      const agg = result.aggregations?.[field];
      if (!Array.isArray(agg?.buckets) || agg.doc_count_error_upper_bound !== 0 || !Number.isSafeInteger(agg.sum_other_doc_count)) throw error('Board facet counts are incomplete');
      facets[field] = {values: agg.buckets.map(b => {
        if (typeof b.key !== 'string' || !Number.isSafeInteger(b.doc_count) || b.doc_count < 0 || (b.doc_count_error_upper_bound ?? 0) !== 0) throw error('Invalid board facet');
        return {value: b.key, count: b.doc_count, ...(field === 'agent' ? {name: messages.find(m => m.agent === b.key)?.name} : {})};
      }), other: agg.sum_other_doc_count};
    }
    return {ids, facets, through: count};
  }
  return {
    async search(principal, messages, key, input) {
      if (typeof principal?.tenantId !== 'string' || !principal.tenantId || typeof principal.userId !== 'string' || !principal.userId || input.workspace !== principal.tenantId) throw error('Workspace scope mismatch', 403);
      const args = boardSearchSchema.parse(input);
      if (args.since && args.until && Date.parse(args.since) > Date.parse(args.until)) throw error('since must not be later than until', 400);
      if (messages.length > 10000 || messages.some((m, i) => m.id !== i + 1)) throw error('Invalid board snapshot');
      const {cursor, ...parameters} = args;
      const owner = digest(JSON.stringify([principal.tenantId, principal.userId, key, parameters]));
      prune(); let snapshot, token, offset = 0;
      if (cursor) {
        const match = /^([a-f0-9-]{36}):(\d{1,5})$/.exec(cursor);
        if (!match) throw error('Invalid search cursor', 400);
        token = match[1]; offset = Number(match[2]); snapshot = snapshots.get(token);
        if (!snapshot || snapshot.owner !== owner || offset >= snapshot.ids.length) throw error('Search cursor expired or does not match this workspace/query; restart search', 409);
      } else {
        let ranked;
        try {ranked = await rank(principal, messages, digest(key), args);}
        catch (e) {if (e.httpStatus !== 404) throw e; ready = undefined; ranked = await rank(principal, messages, digest(key), args);}
        snapshot = {...ranked, owner, expires: now() + 300000}; token = randomUUID();
        snapshot.bytes = Buffer.byteLength(JSON.stringify(snapshot));
        while (snapshots.size >= 32 || cachedBytes + snapshot.bytes > 4 * 1024 * 1024) {
          const first = snapshots.keys().next().value;
          if (!first) throw error('Search snapshot exceeds pilot capacity');
          cachedBytes -= snapshots.get(first).bytes; snapshots.delete(first);
        }
        snapshots.set(token, snapshot); cachedBytes += snapshot.bytes;
      }
      const results = [];
      const output = {total: snapshot.ids.length, through: snapshot.through, messages: results,
        ...(!cursor && Object.keys(snapshot.facets).length ? {facets: snapshot.facets} : {}), next: null};
      for (const id of snapshot.ids.slice(offset, offset + args.limit)) {
        const source = messages[id - 1];
        if (!source || source.id !== id) throw error('Board source changed; restart search', 409);
        const {requestId, ...message} = source;
        results.push(message); output.next = offset + results.length < snapshot.ids.length ? token + ':' + (offset + results.length) : null;
        if (Buffer.byteLength(JSON.stringify(output)) > 8192) {results.pop(); break;}
      }
      if (!results.length && snapshot.ids.length) throw error('Search metadata exceeds response budget; request fewer facets', 400);
      output.next = offset + results.length < snapshot.ids.length ? token + ':' + (offset + results.length) : null;
      // Retain even the final page's snapshot until expiry so transport retries work.
      return output;
    },
  };
}
