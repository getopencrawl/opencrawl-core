import {createRealm} from '../search/realm.mjs';
import {authorize, digest, documentId, validateBinding} from './scope.mjs';

import {connectorMapping} from '../search/mapping.mjs';
export {connectorMapping};
// Atomic comparison at the destination protects against retries and concurrent,
// out-of-order files. Suppressions persist across source replay.
export const SEARCHABLE_KINDS = ['message', 'channel', 'file', 'file_chunk', 'meeting', 'transcript', 'page', 'passage', 'database', 'comment', 'commit', 'pull_request', 'issue', 'review', 'issue_comment', 'review_comment', 'commit_comment', 'release'];
const UPSERT = `if (ctx._source.connector == null) { ctx._source = params.doc; }
else if (ctx._source.connector.deleted == true) { ctx.op = 'none'; }
else if (ctx._source.connector.containsKey('sourceAuthority') && (!params.doc.connector.containsKey('sourceAuthority') || params.doc.connector.sourceAuthority < ctx._source.connector.sourceAuthority)) { ctx.op = 'none'; }
else if (params.doc.connector.containsKey('sourceAuthority') && (!ctx._source.connector.containsKey('sourceAuthority') || params.doc.connector.sourceAuthority > ctx._source.connector.sourceAuthority)) { ctx._source = params.doc; }
else if (params.doc.connector.extractedAt == ctx._source.connector.extractedAt && params.doc.connector.containsKey('normalizerVersion') &&
 (!ctx._source.connector.containsKey('normalizerVersion') || params.doc.connector.normalizerVersion > ctx._source.connector.normalizerVersion)) { ctx._source = params.doc; }
else if (params.doc.connector.extractedAt == ctx._source.connector.extractedAt && ctx._source.connector.containsKey('normalizerVersion') &&
 (!params.doc.connector.containsKey('normalizerVersion') || params.doc.connector.normalizerVersion < ctx._source.connector.normalizerVersion)) { ctx.op = 'none'; }
else if (ctx._source.connector.extractedAt == null ||
 (params.doc.connector.containsKey('versionAt') && (!ctx._source.connector.containsKey('versionAt') || params.doc.connector.versionAt > ctx._source.connector.versionAt)) ||
 ((!params.doc.connector.containsKey('versionAt') || params.doc.connector.versionAt == ctx._source.connector.versionAt) &&
 (params.doc.connector.extractedAt > ctx._source.connector.extractedAt ||
 (params.doc.connector.extractedAt == ctx._source.connector.extractedAt && ((params.doc.connector.containsKey('componentCount') && params.doc.connector.componentCount > ctx._source.connector.componentCount) ||
 ((!params.doc.connector.containsKey('componentCount') || params.doc.connector.componentCount == ctx._source.connector.componentCount) && params.doc.connector.contentHash.compareTo(ctx._source.connector.contentHash) > 0)))))) {
 ctx._source = params.doc;
} else { ctx.op = 'none'; }`;

export function createConnectorSearch(options) {
  const {tenantId}=options;
  const realm=createRealm(options), collection=realm.collection('connector'), f=collection.field;
  const principal={tenantId};
  function scoped(principal, binding) {authorize(principal,binding);realm.scope(principal);}
  async function request(path,{body}={}) {
    const data=typeof body==='string'?JSON.parse(body):body;
    if(path==='/_search')return collection.search(principal,data);
    if(path==='/_mget')return collection.mget(principal,data.ids);
    throw new Error('Unsupported connector realm operation');
  }
  function checkDocument(binding, item) {
    const d = item.document;
    if (!d || d.tenantId !== tenantId || d.connectionId !== binding.connectionId || d.workspaceId !== binding.workspaceId || d.provider !== binding.provider ||
      item.id !== documentId(binding, d.kind, d.sourceId) || d.deleted !== false || !Number.isSafeInteger(d.extractedAt) || !/^[a-f0-9]{64}$/.test(d.contentHash || '')) {
      throw Object.assign(new Error('Document scope or identity mismatch'), {permanent: true});
    }
  }
  return {
    identity:realm.identity,
    ensureIndex:realm.ensureIndex,
    async putDocuments(principal, binding, documents) {
      try {
        scoped(principal, binding);
        if (!Array.isArray(documents) || documents.length > 100) throw new Error('Invalid connector bulk size');
        for (const item of documents) checkDocument(binding, item);
      } catch (error) {throw Object.assign(error, {writeOutcome: 'not-applied'});}
      if (!documents.length) return;
      await collection.bulk(principal,documents.map(item=>({...item,script:UPSERT})));
    },
    async suppress(principal, binding, {kind, sourceId}) {
      try {
        scoped(principal, binding);
        if (!['message', 'channel', 'user', 'membership', 'file'].includes(kind) || typeof sourceId !== 'string' || sourceId.length > 250 || !sourceId) throw new Error('Invalid suppression identity');
      } catch (error) {throw Object.assign(error, {writeOutcome: 'not-applied'});}
      const id = documentId(binding, kind, sourceId);
      const tombstone = {tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId, provider: binding.provider, kind, sourceId, deleted: true};
      await collection.update(principal,id,{script:{source:"ctx._source.connector.deleted = true; ctx._source.text = ''; ctx._source.title = '';"},upsert:tombstone});
    },
    async search(principal, bindings, {query, limit = 20, raw = false, match = 'all', id} = {}) {
      if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100) throw new Error('Authorized connections required');
      for (const binding of bindings) scoped(principal, binding);
      if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_:-]{1,256}$/.test(id))) throw new Error('Invalid passage id');
      if (!['all','any','phrase'].includes(match) || typeof query !== 'string' || (!query.trim() && !id) || query.length > 4000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid connector query');
      const byConnection = new Map(bindings.map(b => [b.connectionId, b]));
      const hits = [], responses = []; let after, examined = 0, more = true, capped = false;
      // Bound work even when channel visibility filters most candidates.
      while (hits.length < limit && examined < 1000 && more) {
        const result = await request('/_search', {body: JSON.stringify({size: 100, track_total_hits: false,
          query: {bool: {filter: [{term: {tenantId}}, {terms: {[f('connectionId')]: [...byConnection.keys()]}}, {terms: {[f('kind')]: SEARCHABLE_KINDS}}, {term: {[f('deleted')]: false}}, ...(id ? [{term:{id}}] : [])], must: query.trim() ? [{multi_match: {query, fields: ['title^2', 'text', f('heading')], ...(match === 'phrase' ? {type:'phrase'} : {operator: match === 'all' ? 'and' : 'or'})}}] : [{match_all:{}}]}},
          // Native source IDs can collide across kinds (for example a GitHub
          // issue and review). The envelope ID makes search_after a total order.
          sort: [{_score: 'desc'}, {[f('connectionId')]: 'asc'}, {[f('sourceId')]: 'asc'}, {id: 'asc'}], ...(after ? {search_after: after} : {})})});
        const candidates = result?.hits?.hits;
        if (!Array.isArray(candidates)) throw new Error('Invalid connector search response');
        for (const hit of candidates) {
          const d = hit._source, binding = byConnection.get(d?.connectionId);
          if (!binding || d.tenantId !== tenantId || d.workspaceId !== binding.workspaceId || d.provider !== binding.provider || !SEARCHABLE_KINDS.includes(d.kind) || d.deleted || hit._id !== documentId(binding, d.kind, d.sourceId)) throw new Error('Search returned an invalid connector scope');
        }
        const ids = [...new Set(candidates.filter(hit => hit._source.provider === 'slack').map(hit => documentId(byConnection.get(hit._source.connectionId), 'channel', hit._source.channelId)))];
        const channels = ids.length ? await request('/_mget', {body: JSON.stringify({ids})}) : {docs: []};
        if (!Array.isArray(channels.docs)) throw new Error('Missing channel visibility metadata');
        const allowed = new Set();
        for (const item of channels.docs) {
          if (!item.found) continue;
          const d = item._source, binding = byConnection.get(d?.connectionId);
          if (!binding || d.tenantId !== tenantId || d.workspaceId !== binding.workspaceId || d.provider !== 'slack' || d.kind !== 'channel' || !ids.includes(item._id) || item._id !== documentId(binding, 'channel', d.sourceId)) throw new Error('Channel metadata scope mismatch');
          if (d.publicChannel === true && !d.deleted) allowed.add(item._id);
        }
        const children = candidates.filter(hit => hit._source.parentId);
        const parentIds = [...new Set(children.map(hit => documentId(byConnection.get(hit._source.connectionId), hit._source.parentKind, hit._source.parentId)))];
        const parents = parentIds.length ? await request('/_mget', {body: JSON.stringify({ids: parentIds})}) : {docs: []};
        if (!Array.isArray(parents.docs)) throw new Error('Missing resource revision metadata');
        const current = new Map();
        for (const item of parents.docs) {
          if (!item.found) continue;
          const d = item._source, binding = byConnection.get(d?.connectionId);
          if (!binding || d.tenantId !== tenantId || d.workspaceId !== binding.workspaceId || d.provider !== binding.provider || !parentIds.includes(item._id) || item._id !== documentId(binding, d.kind, d.sourceId)) throw new Error('Parent metadata scope mismatch');
          if (!d.deleted && (d.kind!=='file' || d.available===true)) current.set(item._id, d.resourceVersion);
        }
        const visible = [];
        for (const hit of candidates) {
          if (hits.length >= limit) {capped = true; break;}
          const d = hit._source, binding = byConnection.get(d.connectionId);
          const parentVisible = !d.parentId || (typeof d.resourceVersion==='string' && current.get(documentId(binding, d.parentKind, d.parentId)) === d.resourceVersion);
          const visibleResource = parentVisible && (d.kind!=='file' || d.available===true) &&
            (d.provider!=='slack' || allowed.has(documentId(binding, 'channel', d.channelId)));
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
    },
    /** Live source entities per kind, excluding passage revisions across authorized connections, for reporting. */
    async count(principal, bindings) {
      if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100) throw new Error('Authorized connections required');
      for (const binding of bindings) scoped(principal, binding);
      const result = await request('/_search', {body: JSON.stringify({size: 0, track_total_hits: true,
        query: {bool: {filter: [{term: {tenantId}}, {terms: {[f('connectionId')]: bindings.map(b => b.connectionId)}}, {term: {[f('deleted')]: false}}], must_not: [{terms: {[f('kind')]: ['passage', 'transcript', 'file_chunk']}}]}},
        aggs: {kinds: {terms: {field: f('kind'), size: 30}}}})});
      if (!Array.isArray(result?.aggregations?.kinds?.buckets)) throw new Error('Invalid connector count response');
      return {total: result.hits.total?.value ?? 0, kinds: Object.fromEntries(result.aggregations.kinds.buckets.map(b => [b.key, b.doc_count]))};
    },
    refresh: () => realm.refresh(principal),
  };
}
