import {signRequest} from '../sessions/s3-store.mjs';
import {authorize, digest, documentId, validateBinding} from './scope.mjs';

export const connectorMapping = {dynamic: 'strict', properties: {
  ...Object.fromEntries(['tenantId', 'connectionId', 'workspaceId', 'provider', 'kind', 'sourceId', 'channelId', 'threadTs', 'timestamp', 'authorId', 'contentHash', 'parentId', 'parentKind', 'resourceVersion', 'relatedId', 'discussionId', 'repository', 'state', 'speakers', 'startTime', 'endTime', 'fileId', 'extractionStatus', 'partPath'].map(key => [key, {type: 'keyword'}])),
  title: {type: 'text'}, text: {type: 'text'}, extractedAt: {type: 'long'}, deleted: {type: 'boolean'}, publicChannel: {type: 'boolean'},
  sourceAuthority:{type:'integer'}, available: {type:'boolean'}, partStart:{type:'integer'}, partEnd:{type:'integer'}, partOverlap:{type:'integer'},
  componentCount: {type: 'integer'}, versionAt: {type: 'long'}, sequence: {type: 'integer'}, chunkCount: {type: 'integer'}, heading: {type: 'text'},
  summary: {type: 'text', index: false}, url: {type: 'keyword', index: false, doc_values: false},
  sourceKey: {type: 'keyword', index: false, doc_values: false},
}};
export function connectorIndex(environment, tenantId, generation = 'v1') {
  if (!/^[a-z][a-z0-9-]{0,24}$/.test(environment) || !/^v[1-9][0-9]*$/.test(generation) || typeof tenantId !== 'string' || !tenantId) throw new Error('Invalid index scope');
  return `opencrawl-${environment}-connectors-${digest(tenantId).slice(0, 32)}-${generation}`;
}

// Atomic comparison at the destination protects against retries and concurrent,
// out-of-order files. Suppressions persist across source replay.
export const SEARCHABLE_KINDS = ['message', 'file', 'file_chunk', 'meeting', 'transcript', 'page', 'passage', 'database', 'comment', 'commit', 'pull_request', 'issue', 'review', 'issue_comment', 'review_comment', 'commit_comment', 'release'];
const UPSERT = `if (ctx._source.deleted == true) { ctx.op = 'none'; }
else if (ctx._source.containsKey('sourceAuthority') && (!params.doc.containsKey('sourceAuthority') || params.doc.sourceAuthority < ctx._source.sourceAuthority)) { ctx.op = 'none'; }
else if (params.doc.containsKey('sourceAuthority') && (!ctx._source.containsKey('sourceAuthority') || params.doc.sourceAuthority > ctx._source.sourceAuthority)) { ctx._source = params.doc; }
else if (ctx._source.extractedAt == null ||
 (params.doc.containsKey('versionAt') && (!ctx._source.containsKey('versionAt') || params.doc.versionAt > ctx._source.versionAt)) ||
 ((!params.doc.containsKey('versionAt') || params.doc.versionAt == ctx._source.versionAt) &&
 (params.doc.extractedAt > ctx._source.extractedAt ||
 (params.doc.extractedAt == ctx._source.extractedAt && ((params.doc.containsKey('componentCount') && params.doc.componentCount > ctx._source.componentCount) ||
 ((!params.doc.containsKey('componentCount') || params.doc.componentCount == ctx._source.componentCount) && params.doc.contentHash.compareTo(ctx._source.contentHash) > 0)))))) {
 ctx._source = params.doc;
} else { ctx.op = 'none'; }`;

export function createConnectorSearch({endpoint, index, tenantId, credentials, username, password, region = 'us-east-1', replicas = 0, fetch: send = globalThis.fetch}) {
  const base = new URL(endpoint);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !tenantId) throw new Error('Invalid connector search configuration');
  if (!/^[a-z][a-z0-9_-]{0,150}$/.test(index) || !Number.isInteger(replicas) || replicas < 0 || replicas > 2) throw new Error('Invalid connector index');
  if (Boolean(username) !== Boolean(password)) throw new Error('Configure both OpenSearch credentials');
  function scoped(principal, binding) {
    authorize(principal, binding);
    if (binding.tenantId !== tenantId) throw Object.assign(new Error('Index tenant mismatch'), {permanent: true});
  }
  async function request(path, {method = 'POST', body, contentType = 'application/json'} = {}) {
    const url = new URL(base.href.replace(/\/$/, '') + '/' + index + path);
    let headers = {'content-type': contentType};
    if (username) headers.authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    if (credentials) {
      const resolved = await credentials();
      if (resolved.sessionToken) headers['x-amz-security-token'] = resolved.sessionToken;
      headers = signRequest({method, url, body, headers, region, service: 'es', ...resolved});
    }
    const response = await send(url, {method, headers, body, signal: AbortSignal.timeout(30000), redirect: 'error'});
    let data; try { data = await response.json(); } catch {}
    if (!response.ok) throw Object.assign(new Error(`Connector search request failed (${response.status})`), {status: response.status, type: data?.error?.type});
    return data;
  }
  function checkDocument(binding, item) {
    const d = item.document;
    if (!d || d.tenantId !== tenantId || d.connectionId !== binding.connectionId || d.workspaceId !== binding.workspaceId || d.provider !== binding.provider ||
      item.id !== documentId(binding, d.kind, d.sourceId) || d.deleted !== false || !Number.isSafeInteger(d.extractedAt) || !/^[a-f0-9]{64}$/.test(d.contentHash || '')) {
      throw Object.assign(new Error('Document scope or identity mismatch'), {permanent: true});
    }
  }
  return {
    identity: base.origin + base.pathname + '/' + index,
    async ensureIndex() {
      try { await request('', {method: 'PUT', body: JSON.stringify({settings: {number_of_shards: 1, number_of_replicas: replicas}, mappings: connectorMapping})}); }
      catch (error) { if (error.status !== 400 || error.type !== 'resource_already_exists_exception') throw error; }
      const mapping = (await request('/_mapping', {method: 'GET'}))?.[index]?.mappings;
      if (mapping?.dynamic !== 'strict' || Object.entries(connectorMapping.properties).some(([key, value]) => mapping.properties?.[key] && mapping.properties[key].type !== value.type)) throw new Error('Connector mapping mismatch; use a new index generation');
      // Additive fields preserve Slack's existing IDs, receipts and index generation.
      const missing = Object.fromEntries(Object.entries(connectorMapping.properties).filter(([key]) => !mapping.properties?.[key]));
      if (Object.keys(missing).length) await request('/_mapping', {method: 'PUT', body: JSON.stringify({properties: missing})});
    },
    async putDocuments(principal, binding, documents) {
      scoped(principal, binding);
      if (!Array.isArray(documents) || documents.length > 100) throw new Error('Invalid connector bulk size');
      for (const item of documents) checkDocument(binding, item);
      if (!documents.length) return;
      const body = documents.map(({id, document}) => JSON.stringify({update: {_id: id, retry_on_conflict: 5}}) + '\n' +
        JSON.stringify({scripted_upsert: true, script: {lang: 'painless', source: UPSERT, params: {doc: document}}, upsert: {}}) + '\n').join('');
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Connector bulk exceeds limit');
      const result = await request('/_bulk', {body, contentType: 'application/x-ndjson'});
      if (!Array.isArray(result?.items) || result.items.length !== documents.length || result.items.some(item => !item.update || item.update.status < 200 || item.update.status >= 300)) {
        throw new Error('Connector bulk contained failed or missing items');
      }
    },
    async suppress(principal, binding, {kind, sourceId}) {
      scoped(principal, binding);
      if (!['message', 'channel', 'user', 'membership', 'file'].includes(kind) || typeof sourceId !== 'string' || sourceId.length > 250 || !sourceId) throw new Error('Invalid suppression identity');
      const id = documentId(binding, kind, sourceId);
      const tombstone = {tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId, provider: binding.provider, kind, sourceId, deleted: true};
      await request(`/_update/${id}`, {body: JSON.stringify({script: {source: "ctx._source.deleted = true; ctx._source.text = ''; ctx._source.title = '';"}, upsert: tombstone})});
    },
    async search(principal, bindings, {query, limit = 20, raw = false} = {}) {
      if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100) throw new Error('Authorized connections required');
      for (const binding of bindings) scoped(principal, binding);
      if (typeof query !== 'string' || !query.trim() || query.length > 4000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid connector query');
      const byConnection = new Map(bindings.map(b => [b.connectionId, b]));
      const hits = [], responses = []; let after, examined = 0, more = true;
      // Bound work even when channel visibility filters most candidates.
      while (hits.length < limit && examined < 1000 && more) {
        const result = await request('/_search', {body: JSON.stringify({size: 100, track_total_hits: false,
          query: {bool: {filter: [{term: {tenantId}}, {terms: {connectionId: [...byConnection.keys()]}}, {terms: {kind: SEARCHABLE_KINDS}}, {term: {deleted: false}}], must: [{multi_match: {query, fields: ['title^2', 'text', 'heading'], operator: 'and'}}]}},
          sort: [{_score: 'desc'}, {connectionId: 'asc'}, {sourceId: 'asc'}], ...(after ? {search_after: after} : {})})});
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
          if (hits.length >= limit) break;
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
        examined += candidates.length; more = candidates.length === 100; after = candidates.at(-1)?.sort;
        if (more && !after) throw new Error('Missing connector search cursor');
      }
      return raw ? {responses, examined, truncated: more} : {hits, examined, truncated: more};
    },
    /** Live source entities per kind, excluding passage revisions across authorized connections, for reporting. */
    async count(principal, bindings) {
      if (!Array.isArray(bindings) || !bindings.length || bindings.length > 100) throw new Error('Authorized connections required');
      for (const binding of bindings) scoped(principal, binding);
      const result = await request('/_search', {body: JSON.stringify({size: 0, track_total_hits: true,
        query: {bool: {filter: [{term: {tenantId}}, {terms: {connectionId: bindings.map(b => b.connectionId)}}, {term: {deleted: false}}], must_not: [{terms: {kind: ['passage', 'transcript', 'file_chunk']}}]}},
        aggs: {kinds: {terms: {field: 'kind', size: 30}}}})});
      if (!Array.isArray(result?.aggregations?.kinds?.buckets)) throw new Error('Invalid connector count response');
      return {total: result.hits.total?.value ?? 0, kinds: Object.fromEntries(result.aggregations.kinds.buckets.map(b => [b.key, b.doc_count]))};
    },
    refresh: () => request('/_refresh'),
  };
}
