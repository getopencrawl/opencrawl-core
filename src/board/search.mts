import type {Principal} from '../sessions/types.mjs';
import type {RealmOptions, QueryBody, OpenSearchResponse, SearchDocument} from '../search/types.mjs';
import type {BoardMessage, VisibleMessage} from './types.mjs';
interface BoardDocument extends SearchDocument {id: number; boardId: string}
export interface Facet {values: Array<{value: string; count: number; name?: string}>; other: number}
interface Ranked {ids: number[]; facets: Record<string, Facet>; through: number}
interface Snapshot extends Ranked {owner: string; expires: number; bytes: number}
import {serviceError} from '../sessions/types.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {createRealmResolver,realmField} from '../search/realm.mjs';

const text = (max: number) => z.string().trim().min(1).max(max);
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
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const error = (message: string, status = 503) => Object.assign(new Error(message), {status});
import {boardIndexMapping} from '../search/mapping.mjs';
export {boardIndexMapping};
/** Derived index only. The caller supplies the authorized immutable source snapshot. */
export function createBoardSearch(options: RealmOptions & {now?: () => number}) {
  const {now=Date.now}=options, resolve=createRealmResolver(options), f=(field: string)=>realmField('board',field);
  const snapshots=new Map<string, Snapshot>();let cachedBytes=0;
  function complete(result: OpenSearchResponse): OpenSearchResponse<BoardDocument> {
    if (result.timed_out || result._shards?.failed !== 0 || result.hits?.total?.relation !== 'eq' || !Number.isSafeInteger(result.hits?.total?.value)) throw error('Board search did not complete; retry rather than using partial results');
    return result as OpenSearchResponse<BoardDocument>;
  }
  function prune() {
    for (const [id, snapshot] of snapshots) if (snapshot.expires <= now()) {snapshots.delete(id); cachedBytes -= snapshot.bytes;}
  }
  async function rank(principal: Principal, messages: BoardMessage[], boardId: string, args: z.output<typeof boardSearchSchema>): Promise<Ranked> {
    const realm=resolve(principal),collection=realm.collection('board');
    await realm.ensureIndex();
    const request=(path: string,body: QueryBody)=>{if(path!=='/_search')throw error('Unsupported board realm operation');return collection.search(principal,body);};
    const count = messages.length;
    const filter: QueryBody[] = [{term: {tenantId: principal.tenantId}}, {term: {[f('boardId')]:boardId}}, {range: {[f('id')]: {lte: count}}}];
    // Counts plus maximum identify a contiguous indexed prefix. Gaps trigger a replay.
    const coverage = complete(await request('/_search', {size: 0, track_total_hits: true,
      query: {bool: {filter}}, aggs: {last: {max: {field: f('id')}}}}));
    const indexed = coverage.hits.total.value, last = coverage.aggregations?.last?.value ?? 0;
    if (indexed > count) throw error('Unexpected board index coverage');
    const start = indexed === last ? indexed : 0;
    for (let offset = start; offset < count; offset += 250) {
      const batch = messages.slice(offset, offset + 250);
      await collection.bulk(principal,batch.map(m=>({id:boardId+':'+m.id,document:{boardId,tenantId:principal.tenantId,
        id:m.id,timestamp:m.timestamp,day:new Date(m.timestamp).toISOString().slice(0,10),topic:m.topic,agent:m.agent,author:m.author,name:m.name,text:m.text}})),{refresh:true});
    }
    if (start < count) {
      const verified = complete(await request('/_search', {size: 0, track_total_hits: true, query: {bool: {filter}}}));
      if (verified.hits.total.value !== count) throw error('Board indexing coverage is incomplete; retry search');
    }
    for (const [name, values] of ([['topic', args.topics], ['agent', args.agents], ['author', args.authors]] as const)) if (values.length) filter.push({terms: {[f(name)]: values}});
    if (args.since || args.until) filter.push({range: {[f('timestamp')]: {...(args.since ? {gte: args.since} : {}), ...(args.until ? {lte: args.until} : {})}}});
    const query = {bool: {filter, ...(args.query ? {
      must: [{multi_match: {query: args.query, fields: ['text', f('topic.text')+'^2'], type: 'cross_fields', operator: 'and'}}],
      should: [{match_phrase: {text: {query: args.query, boost: 2}}}],
    } : {})}};
    // Scan by immutable message ID, independent of changing relevance scores.
    // Freeze the collected ranking once; client pagination never re-queries it.
    const ranked: Array<{id: number; score: number}> = []; let after: number | undefined, result: OpenSearchResponse<BoardDocument> | undefined, total = 0;
    do {
      const page = complete(await request('/_search', {size: 1000, track_total_hits: true, timeout: '10s',
        _source: ['boardId', 'tenantId', 'id'], query, track_scores: true,
        sort: [{[f('id')]: 'asc'}], ...(after === undefined ? {} : {search_after: [after]}),
        ...(result ? {} : {aggs: Object.fromEntries([...new Set(args.facets)].map(field => [field, {terms: {field:f(field), size: args.facetSize, shard_size: 10000, show_term_doc_count_error: true}}]))}),
      }));
      if (!result) {result = page; total = page.hits.total.value;}
      const hits = page.hits.hits;
      if (page.hits.total.value !== total || !Array.isArray(hits) || total > count || (!hits.length && ranked.length < total)) throw error('Board result set is incomplete');
      for (const h of hits) {
        const s = h._source;
        if (s?.tenantId !== principal.tenantId || s.boardId !== boardId || !Number.isSafeInteger(s.id) || s.id < 1 || s.id > count || s.id <= (after ?? 0) || h._id !== boardId + ':' + s.id) throw error('Board search scope or sequence mismatch');
        if (args.query && args.sort === 'relevance' && !Number.isFinite(h._score)) throw error('Missing board relevance score');
        ranked.push({id:s.id, score:h._score}); after = s.id;
      }
      if (ranked.length > total) throw error('Board result set is incomplete');
    } while (ranked.length < total);
    ranked.sort((a,b) => (args.sort === 'relevance' && args.query ? b.score - a.score : 0) || messages[b.id-1].timestamp - messages[a.id-1].timestamp || b.id-a.id);
    const ids = ranked.map(h => h.id);
    const facets: Record<string, Facet> = {};
    for (const field of new Set(args.facets)) {
      const agg = result!.aggregations?.[field];
      if (!Array.isArray(agg?.buckets) || agg.doc_count_error_upper_bound !== 0 || !Number.isSafeInteger(agg.sum_other_doc_count)) throw error('Board facet counts are incomplete');
      facets[field] = {values: agg.buckets.map(b => {
        if (typeof b.key !== 'string' || !Number.isSafeInteger(b.doc_count) || b.doc_count < 0 || (b.doc_count_error_upper_bound ?? 0) !== 0) throw error('Invalid board facet');
        return {value: b.key, count: b.doc_count, ...(field === 'agent' ? {name: messages.find(m => m.agent === b.key)?.name} : {})};
      }), other: agg.sum_other_doc_count!};
    }
    return {ids, facets, through: count};
  }
  return {
    async search(principal: Principal, messages: BoardMessage[], key: string, input: unknown) {
      if (principal?.captureAccess !== undefined || principal?.boardSession !== undefined || typeof principal?.tenantId !== 'string' || !principal.tenantId || typeof principal.userId !== 'string' || !principal.userId || (input as {workspace?: unknown} | null)?.workspace !== principal.tenantId) throw error('Workspace scope mismatch', 403);
      const args = boardSearchSchema.parse(input);
      if (args.since && args.until && Date.parse(args.since) > Date.parse(args.until)) throw error('since must not be later than until', 400);
      if (messages.some((m, i) => m.id !== i + 1)) throw error('Invalid board snapshot');
      const {cursor, ...parameters} = args;
      const owner = digest(JSON.stringify([principal.tenantId, principal.userId, key, parameters]));
      prune(); let snapshot: Snapshot | undefined, token: string, offset = 0;
      if (cursor) {
        const match = /^([a-f0-9-]{36}):(\d{1,16})$/.exec(cursor);
        if (!match) throw error('Invalid search cursor', 400);
        token = match[1]; offset = Number(match[2]); snapshot = snapshots.get(token);
        if (!Number.isSafeInteger(offset) || !snapshot || snapshot.owner !== owner || offset >= snapshot.ids.length) throw error('Search cursor expired or does not match this workspace/query; restart search', 409);
      } else {
        let ranked;
        try {ranked = await rank(principal, messages, digest(key), args);}
        catch(caught){const e=serviceError(caught);if (e.httpStatus !== 404) throw e; ranked = await rank(principal, messages, digest(key), args);}
        snapshot = {...ranked, owner, expires: now() + 300000, bytes: 0}; token = randomUUID();
        snapshot.bytes = Buffer.byteLength(JSON.stringify({...ranked, owner, expires: snapshot.expires}));
        while (snapshots.size >= 32 || cachedBytes + snapshot.bytes > 4 * 1024 * 1024) {
          const first = snapshots.keys().next().value;
          if (!first) throw error('Search snapshot exceeds pilot capacity');
          cachedBytes -= snapshots.get(first)!.bytes; snapshots.delete(first);
        }
        snapshots.set(token, snapshot); cachedBytes += snapshot.bytes;
      }
      const results: VisibleMessage[] = [];
      const output = {total: snapshot.ids.length, through: snapshot.through, messages: results,
        ...(!cursor && Object.keys(snapshot.facets).length ? {facets: snapshot.facets} : {}), next: null as string | null};
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
