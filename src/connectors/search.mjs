import {signRequest} from '../sessions/s3-store.mjs';
import {authorize, digest, documentId, validateBinding} from './scope.mjs';
import {relevanceQuery} from '../search/relevance.mjs';

export const connectorMapping = {dynamic: 'strict', properties: {
  ...Object.fromEntries(['tenantId', 'connectionId', 'workspaceId', 'provider', 'kind', 'sourceId', 'channelId', 'threadTs', 'timestamp', 'authorId', 'contentHash'].map(key => [key, {type: 'keyword'}])),
  title: {type: 'text'}, text: {type: 'text'}, extractedAt: {type: 'long'}, deleted: {type: 'boolean'}, publicChannel: {type: 'boolean'},
  sourceKey: {type: 'keyword', index: false, doc_values: false},
}};
export function connectorIndex(environment, tenantId, generation = 'v1') {
  if (!/^[a-z][a-z0-9-]{0,24}$/.test(environment) || !/^v[1-9][0-9]*$/.test(generation) || typeof tenantId !== 'string' || !tenantId) throw new Error('Invalid index scope');
  return `opencrawl-${environment}-connectors-${digest(tenantId).slice(0, 32)}-${generation}`;
}

// Atomic comparison at the destination protects against retries and concurrent,
// out-of-order files. Suppressions persist across source replay.
const UPSERT = `if (ctx._source.deleted == true) { ctx.op = 'none'; }
else if (ctx._source.extractedAt == null || params.doc.extractedAt > ctx._source.extractedAt ||
 (params.doc.extractedAt == ctx._source.extractedAt && params.doc.contentHash.compareTo(ctx._source.contentHash) > 0)) {
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
      if (mapping?.dynamic !== 'strict' || Object.entries(connectorMapping.properties).some(([key, value]) => mapping.properties?.[key]?.type !== value.type)) throw new Error('Connector mapping mismatch; use a new index generation');
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
      if (!['message', 'channel', 'user', 'membership'].includes(kind) || typeof sourceId !== 'string' || sourceId.length > 250 || !sourceId) throw new Error('Invalid suppression identity');
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
          query: {bool: {filter: [{term: {tenantId}}, {terms: {connectionId: [...byConnection.keys()]}}, {term: {kind: 'message'}}, {term: {deleted: false}}], must: [relevanceQuery(query, {stemmed: false})]}},
          sort: [{_score: 'desc'}, {connectionId: 'asc'}, {sourceId: 'asc'}], ...(after ? {search_after: after} : {})})});
        const candidates = result?.hits?.hits;
        if (!Array.isArray(candidates)) throw new Error('Invalid connector search response');
        for (const hit of candidates) {
          const d = hit._source, binding = byConnection.get(d?.connectionId);
          if (!binding || d.tenantId !== tenantId || d.workspaceId !== binding.workspaceId || d.deleted || hit._id !== documentId(binding, d.kind, d.sourceId)) throw new Error('Search returned an invalid connector scope');
        }
        const ids = [...new Set(candidates.map(hit => documentId(byConnection.get(hit._source.connectionId), 'channel', hit._source.channelId)))];
        const channels = ids.length ? await request('/_mget', {body: JSON.stringify({ids})}) : {docs: []};
        if (!Array.isArray(channels.docs)) throw new Error('Missing channel visibility metadata');
        const allowed = new Set();
        for (const item of channels.docs) {
          if (!item.found) continue;
          const d = item._source, binding = byConnection.get(d?.connectionId);
          if (!binding || d.tenantId !== tenantId || d.workspaceId !== binding.workspaceId || d.kind !== 'channel' || !ids.includes(item._id) || item._id !== documentId(binding, 'channel', d.sourceId)) throw new Error('Channel metadata scope mismatch');
          if (d.publicChannel === true && !d.deleted) allowed.add(item._id);
        }
        const visible = [];
        for (const hit of candidates) {
          if (hits.length >= limit) break;
          if (allowed.has(documentId(byConnection.get(hit._source.connectionId), 'channel', hit._source.channelId))) {
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
    refresh: () => request('/_refresh'),
  };
}
