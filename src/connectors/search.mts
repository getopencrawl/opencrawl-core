import {lexicalQuery} from '../search/lexical.mjs';
import type {RealmOptions, OpenSearchResponse, IndexHit, QueryBody, SearchInput, Aggregation} from '../search/types.mjs';
import {searchFilters,searchSort} from '../search/controls.mjs';
import type {ConnectorBinding, ConnectorPrincipal, ConnectorDocument, DocumentItem, IndexedLinearResource, SuppressionIdentity} from './types.mjs';
import {createRealm} from '../search/realm.mjs';
import {authorize, digest, documentId, validateBinding} from './scope.mjs';
import {LINEAR_KINDS} from '../integrations/linear-upstream.mjs';

import {connectorMapping} from '../search/mapping.mjs';
export {connectorMapping};
// Atomic comparison at the destination protects against retries and concurrent,
// out-of-order files. Suppressions persist across source replay.
export const SEARCHABLE_KINDS = ['message', 'channel', 'file', 'file_chunk', 'meeting', 'transcript', 'page', 'passage', 'database', 'comment', 'commit', 'pull_request', 'issue', 'review', 'issue_comment', 'review_comment', 'commit_comment', 'release'];
const linearKinds = Object.values(LINEAR_KINDS);


export function createConnectorSearch(options: RealmOptions & {tenantId: string}) {
  const {tenantId}=options;
  const realm=createRealm(options), collection=realm.collection('connector'), f=collection.field;
  const principal={tenantId};
  function scoped(principal: ConnectorPrincipal, binding: ConnectorBinding) {authorize(principal,binding);realm.scope(principal);}
  function linearFilters(principal: ConnectorPrincipal, binding: ConnectorBinding) {
    scoped(principal, binding);
    if (binding.provider !== 'linear') throw new Error('Expected a Linear connection');
    return [{term: {[f('provider')]: 'linear'}}, {term: {[f('connectionId')]: binding.connectionId}},
      {term: {[f('workspaceId')]: binding.workspaceId}}, {term: {[f('deleted')]: false}}];
  }
  const unavailableLinear = {bool: {filter: [{term: {[f('provider')]: 'linear'}}, {term: {[f('available')]: false}}]}};
  type SearchResponse = OpenSearchResponse<ConnectorDocument> & {took?: number};
  type MultiGetResponse = {docs: IndexHit<ConnectorDocument>[]};
  type ConnectionCount = {total: number; kinds: Record<string, number>};
  type CountBucket = {key: string; doc_count: number; doc_count_error_upper_bound?: number; kinds?: Aggregation};
  function request(path: '/_search', options: {body: string | QueryBody}): Promise<SearchResponse>;
  function request(path: '/_mget', options: {body: string | {ids: string[]}}): Promise<MultiGetResponse>;
  async function request(path: string, {body}: {body: string | QueryBody}) {
    const data = (typeof body==='string'?JSON.parse(body):body) as QueryBody & {ids: string[]};
    if(path==='/_search')return collection.search(principal,data) as Promise<SearchResponse>;
    if(path==='/_mget')return collection.mget(principal,data.ids) as unknown as Promise<MultiGetResponse>;
    throw new Error('Unsupported connector realm operation');
  }
  function checkDocument(binding: ConnectorBinding, item: DocumentItem) {
    const d = item.document;
    if (!d || d.tenantId !== tenantId || d.connectionId !== binding.connectionId || d.workspaceId !== binding.workspaceId || d.provider !== binding.provider ||
      item.id !== documentId(binding, d.kind, d.sourceId) || d.deleted !== false || !Number.isSafeInteger(d.extractedAt) || !/^[a-f0-9]{64}$/.test(d.contentHash || '')) {
      throw Object.assign(new Error('Document scope or identity mismatch'), {permanent: true});
    }
  }
  type ConnectorSearchInput = SearchInput;
  type NormalizedResult = {hits: (ConnectorDocument & {id: string; score: number})[]; examined: number; truncated: boolean};
  type RawResponse = Pick<SearchResponse, 'took' | 'timed_out' | '_shards'> & {hits: {hits: IndexHit<ConnectorDocument>[]}};
  type RawResult = {responses: RawResponse[]; examined: number; truncated: boolean};
  function search(principal: ConnectorPrincipal, bindings: ConnectorBinding[], input: ConnectorSearchInput & {raw: true}): Promise<RawResult>;
  function search(principal: ConnectorPrincipal, bindings: ConnectorBinding[], input?: ConnectorSearchInput & {raw?: false}): Promise<NormalizedResult>;
  function search(principal: ConnectorPrincipal, bindings: ConnectorBinding[], input: ConnectorSearchInput): Promise<NormalizedResult | RawResult>;
  async function search(principal: ConnectorPrincipal, bindings: ConnectorBinding[], {query='', limit = 20, raw = false, match = 'all', id, filters, order}: ConnectorSearchInput = {}) {
      if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100) throw new Error('Authorized connections required');
      for (const binding of bindings) scoped(principal, binding);
      if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_:-]{1,256}$/.test(id))) throw new Error('Invalid passage id');
      if (!['all','any','phrase'].includes(match) || typeof query !== 'string' || (!query.trim() && !id && (!order||order==='relevance')) || query.length > 4000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid connector query');
      const byConnection = new Map(bindings.map(b => [b.connectionId, b]));
      const hits: (ConnectorDocument & {id: string; score: number})[] = [], responses: RawResponse[] = []; let after: IndexHit['sort'], examined = 0, more = true, capped = false;
      // Bound work even when channel visibility filters most candidates.
      while (hits.length < limit && examined < 1000 && more) {
        const result = await request('/_search', {body: JSON.stringify({size: 100, track_total_hits: false,
          query: {bool: {filter: [{term: {tenantId}}, {terms: {[f('connectionId')]: [...byConnection.keys()]}}, {bool: {should: [{terms: {[f('kind')]: SEARCHABLE_KINDS}}, {bool: {filter: [{term: {[f('provider')]: 'linear'}}, {terms: {[f('kind')]: linearKinds}}]}}], minimum_should_match: 1}}, {term: {[f('deleted')]: false}}, ...searchFilters('connector',filters), ...(id ? [{term:{id}}] : [])], must_not: [unavailableLinear], must: [lexicalQuery(query,match)]}},
          // Native source IDs can collide across kinds (for example a GitHub
          // issue and review). The envelope ID makes search_after a total order.
          sort: [...searchSort('connector',order),{_score: 'desc'}, {[f('connectionId')]: 'asc'}, {[f('sourceId')]: 'asc'}, {id: 'asc'}], ...(after ? {search_after: after} : {})})});
        const candidates = result?.hits?.hits;
        if (!Array.isArray(candidates)) throw new Error('Invalid connector search response');
        for (const hit of candidates) {
          const d = hit._source, binding = byConnection.get(d?.connectionId);
          if (!binding || d.tenantId !== tenantId || d.workspaceId !== binding.workspaceId || d.provider !== binding.provider || !(SEARCHABLE_KINDS.includes(d.kind) || d.provider === 'linear' && linearKinds.includes(d.kind)) || d.deleted || hit._id !== documentId(binding, d.kind, d.sourceId)) throw new Error('Search returned an invalid connector scope');
        }
        const ids = [...new Set(candidates.filter(hit => hit._source.provider === 'slack').map(hit => documentId(byConnection.get(hit._source.connectionId)!, 'channel', hit._source.channelId!)))];
        const children = candidates.filter(hit => hit._source.parentId);
        const parentIds = [...new Set(children.map(hit => documentId(byConnection.get(hit._source.connectionId)!, hit._source.parentKind!, hit._source.parentId!)))];
        // Both guards depend only on this candidate page. Read their metadata
        // together, then validate each role independently, including shared IDs.
        const metadataIds = [...new Set([...ids, ...parentIds])];
        const metadata = metadataIds.length ? await request('/_mget', {body: JSON.stringify({ids: metadataIds})}) : {docs: []};
        const allowed = new Set();
        for (const item of metadata.docs.filter(item => ids.includes(item._id))) {
          if (!item.found) continue;
          const d = item._source, binding = byConnection.get(d?.connectionId);
          if (!binding || d.tenantId !== tenantId || d.workspaceId !== binding.workspaceId || d.provider !== 'slack' || d.kind !== 'channel' || !ids.includes(item._id) || item._id !== documentId(binding, 'channel', d.sourceId)) throw new Error('Channel metadata scope mismatch');
          if (d.publicChannel === true && !d.deleted) allowed.add(item._id);
        }
        const current = new Map();
        for (const item of metadata.docs.filter(item => parentIds.includes(item._id))) {
          if (!item.found) continue;
          const d = item._source, binding = byConnection.get(d?.connectionId);
          if (!binding || d.tenantId !== tenantId || d.workspaceId !== binding.workspaceId || d.provider !== binding.provider || !parentIds.includes(item._id) || item._id !== documentId(binding, d.kind, d.sourceId)) throw new Error('Parent metadata scope mismatch');
          if (!d.deleted && (d.provider!=='linear' || d.available!==false) && (d.kind!=='file' || d.available===true)) current.set(item._id, d.resourceVersion);
        }
        const visible = [];
        for (const hit of candidates) {
          if (hits.length >= limit) {capped = true; break;}
          const d = hit._source, binding = byConnection.get(d.connectionId);
          const parentVisible = !d.parentId || (typeof d.resourceVersion==='string' && current.get(documentId(binding!, d.parentKind!, d.parentId)) === d.resourceVersion);
          const visibleResource = parentVisible && (d.provider!=='linear' || d.available!==false) && (d.kind!=='file' || d.available===true) &&
            (d.provider!=='slack' || allowed.has(documentId(binding!, 'channel', d.channelId!)));
          if (visibleResource) {
            visible.push(hit); hits.push({id: hit._id, score: hit._score, ...hit._source});
          }
        }
        // Preserve raw hit fields only after the same visibility checks as normal search.
        // Totals and max_score describe unfiltered candidates, so omit them.
        if (raw) responses.push({took: result.took, timed_out: result.timed_out, _shards: result._shards, hits: {hits: visible}});
        examined += candidates.length; more = candidates.length === 100;
        const next = candidates.at(-1)?.sort;
        if (more && (!Array.isArray(next) || JSON.stringify(next) === JSON.stringify(after))) throw new Error('Missing or non-advancing connector search cursor');
        after = next;
      }
      return raw ? {responses, examined, truncated: more || capped} : {hits, examined, truncated: more || capped};
    }
  async function countQuery(principal: ConnectorPrincipal, bindings: ConnectorBinding[], aggs: Record<string, unknown>) {
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100) throw new Error('Authorized connections required');
    for (const binding of bindings) scoped(principal, binding);
    return request('/_search', {body: JSON.stringify({size: 0, track_total_hits: true,
      query: {bool: {filter: [{term: {tenantId}}, {terms: {[f('connectionId')]: bindings.map(b => b.connectionId)}}, {term: {[f('deleted')]: false}}], must_not: [{terms: {[f('kind')]: ['passage', 'transcript', 'file_chunk']}}]}}, aggs})});
  }
  return {
    identity:realm.identity,
    ensureIndex:realm.ensureIndex,
    async putDocuments(principal: ConnectorPrincipal, binding: ConnectorBinding, documents: DocumentItem[]) {
      try {
        scoped(principal, binding);
        if (!Array.isArray(documents) || documents.length > 100) throw new Error('Invalid connector bulk size');
        for (const item of documents) checkDocument(binding, item);
      } catch (error) {throw Object.assign(error as object, {writeOutcome: 'not-applied'});}
      if (!documents.length) return;
      await collection.bulk(principal,documents.map(item=>({...item,policy:'connector'})));
    },
    async listLinearResources(principal: ConnectorPrincipal, binding: ConnectorBinding, after: string) {
      const filter = linearFilters(principal, binding);
      if (after && !/^[a-f0-9]{64}$/.test(after)) throw new Error('Invalid Linear inventory cursor');
      const result = await collection.search(principal, {
        size: 100, track_total_hits: false, sort: [{id: 'asc'}], ...(after && {search_after: [after]}),
        _source: ['provider', 'connectionId', 'workspaceId', 'kind', 'sourceId', 'resourceVersion', 'available'],
        query: {bool: {filter: [...filter, {terms: {[f('kind')]: linearKinds}}]}},
      });
      const hits = result.hits.hits;
      const resources = hits.map(({_source: d, _id}) => {
        if (d.provider !== binding.provider || d.workspaceId !== binding.workspaceId || d.connectionId !== binding.connectionId ||
            typeof d.kind !== 'string' || !linearKinds.includes(d.kind) || typeof d.sourceId !== 'string' ||
            _id !== documentId(binding, d.kind, d.sourceId) || typeof d.resourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(d.resourceVersion)) {
          throw new Error('Invalid indexed Linear resource');
        }
        return {sourceId: d.sourceId, available: d.available !== false, resourceVersion: d.resourceVersion};
      });
      return {resources, after: hits.length === 100 ? hits[hits.length - 1]._id : null};
    },
    async setLinearAvailability(principal: ConnectorPrincipal, binding: ConnectorBinding, resources: IndexedLinearResource[], available: boolean) {
      const filter = linearFilters(principal, binding);
      if (!resources.length || resources.length > 100 || typeof available !== 'boolean' ||
          resources.some(r => !/^[a-f0-9]{64}$/.test(r.resourceVersion))) throw new Error('Invalid Linear availability batch');
      // A revision hashes the kind, source ID and content and is shared by its parent and passages.
      // Restrict writes to the snapshot we checked if indexing publishes a new revision concurrently.
      const ids = resources.map(r => r.sourceId);
      await collection.byQuery(principal, 'update', {bool: {filter: [...filter,
        {terms: {[f('resourceVersion')]: resources.map(r => r.resourceVersion)}},
        {bool: {should: [{terms: {[f('sourceId')]: ids}}, {terms: {[f('parentId')]: ids}}], minimum_should_match: 1}},
      ]}}, {set: {'connector.available': available}});
    },
    async suppress(principal: ConnectorPrincipal, binding: ConnectorBinding, {kind, sourceId}: SuppressionIdentity) {
      try {
        scoped(principal, binding);
        if (!['message', 'channel', 'user', 'membership', 'file'].includes(kind) || typeof sourceId !== 'string' || sourceId.length > 250 || !sourceId) throw new Error('Invalid suppression identity');
      } catch (error) {throw Object.assign(error as object, {writeOutcome: 'not-applied'});}
      const id = documentId(binding, kind, sourceId);
      const tombstone = {tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId, provider: binding.provider, kind, sourceId, deleted: true};
      await collection.update(principal,id,{patch:{'connector.deleted':true,text:'',title:''},upsert:tombstone});
    },
    search,
    /** Live source entities per kind, excluding passage revisions across authorized connections, for reporting. */
    async count(principal: ConnectorPrincipal, bindings: ConnectorBinding[]) {
      const result = await countQuery(principal, bindings, {kinds: {terms: {field: f('kind'), size: 30}}});
      if (!Array.isArray(result?.aggregations?.kinds?.buckets)) throw new Error('Invalid connector count response');
      return {total: result.hits.total?.value ?? 0, kinds: Object.fromEntries(result.aggregations.kinds.buckets.map(b => [b.key, b.doc_count]))};
    },
    /** Exact attribution for one bounded group of authorized connections. */
    async countByConnection(principal: ConnectorPrincipal, bindings: ConnectorBinding[]): Promise<Record<string, ConnectionCount>> {
      if (!Array.isArray(bindings) || new Set(bindings.map(binding => binding.connectionId)).size !== bindings.length) throw new Error('Distinct authorized connections required');
      // Inventory needs every key. Sorting by frequency can report a nonzero
      // overall error bound across shards even when every bucket is exact.
      const result = await countQuery(principal, bindings, {connections: {
        terms: {field: f('connectionId'), size: bindings.length, shard_size: bindings.length, order: {_key: 'asc'}, show_term_doc_count_error: true},
        aggs: {kinds: {terms: {field: f('kind'), size: 30, shard_size: 30, order: {_key: 'asc'}, show_term_doc_count_error: true}}},
      }});
      const invalid = (reason: string) => new Error('Incomplete connector connection counts: ' + reason);
      const exact = (aggregation: Aggregation | undefined, group: string): CountBucket[] => {
        if (!Array.isArray(aggregation?.buckets)) throw invalid('missing ' + group + ' buckets');
        if (aggregation.sum_other_doc_count !== 0) throw invalid('omitted ' + group + ' items');
        if (aggregation.doc_count_error_upper_bound !== 0) throw invalid('uncertain ' + group + ' counts');
        const seen = new Set<string>();
        for (const bucket of aggregation.buckets) {
          if (!bucket || typeof bucket.key !== 'string' || !bucket.key || seen.has(bucket.key) || !Number.isSafeInteger(bucket.doc_count) || bucket.doc_count < 0 || (bucket.doc_count_error_upper_bound ?? 0) !== 0) throw invalid('invalid ' + group + ' bucket');
          seen.add(bucket.key);
        }
        return aggregation.buckets;
      };
      const total = result.hits.total;
      if (total?.relation !== 'eq' || !Number.isSafeInteger(total.value) || total.value < 0) throw invalid('inexact search total');
      const counts: Record<string, ConnectionCount> = Object.fromEntries(bindings.map(binding => [binding.connectionId, {total: 0, kinds: {}}]));
      let counted = 0;
      for (const bucket of exact(result.aggregations?.connections, 'connection')) {
        if (!Object.hasOwn(counts, bucket.key)) throw invalid('unexpected connection');
        const kinds = exact(bucket.kinds, 'item type');
        if (kinds.reduce((sum, kind) => sum + kind.doc_count, 0) !== bucket.doc_count) throw invalid('item types do not sum to connection total');
        counts[bucket.key] = {total: bucket.doc_count, kinds: Object.fromEntries(kinds.map(kind => [kind.key, kind.doc_count]))};
        counted += bucket.doc_count;
      }
      if (counted !== total.value) throw invalid('connections do not sum to search total');
      return counts;
    },
    refresh: () => realm.refresh(principal),
  };
}
