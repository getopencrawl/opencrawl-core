import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';
import {createConnectorResolver} from '../dist/src/integrations/resolver.mjs';
import {realmResponse} from './realm-fixture.mjs';

const tenantId = 'org_count', principal = {tenantId, userId: 'user_reader'};
function bindingFor(index, tenant = tenantId) {
  const connectionId = 'int_' + index.toString(16).padStart(26, '0'), provider = index <= 2 ? 'github' : 'notion';
  return {tenantId: tenant, connectionId, workspaceId: tenant, provider, access: 'workspace-global',
    rawPrefix: `raw/v1/source=${provider}/workspace=${tenant}/connection=${connectionId}/`};
}
function fixture(count = 3, searchFactory) {
  const bindings = Array.from({length: count}, (_, i) => bindingFor(i + 1));
  const records = bindings.map(binding => ({tenantId, userId: 'user_owner', integrationId: binding.connectionId, provider: binding.provider,
    scope: 'team', status: 'active', environment: 'selfhost', workspace: tenantId, s3Prefix: binding.rawPrefix.slice(0, -1)}));
  const inventories = new Map(bindings.map((binding, i) => [binding.connectionId, i === count - 1 ? {} : {issue: i + 1, ...(i % 2 ? {comment: 1} : {})}]));
  const state = {requests: [], records, afterSearch: () => {}, reply: value => value};
  const buckets = kinds => Object.entries(kinds).map(([key, doc_count]) => ({key, doc_count}));
  const total = kinds => Object.values(kinds).reduce((sum, n) => sum + n, 0);
  const terms = buckets => ({buckets, doc_count_error_upper_bound: 0, sum_other_doc_count: 0});
  const search = searchFactory?.(bindings) || createConnectorSearch({endpoint: 'https://search.example.test', tenantId, fetch: async (url, options) => {
    assert.ok(url.pathname.endsWith('/_search'));
    const body = JSON.parse(options.body), filter = body.query.bool.must[0].bool.filter;
    assert.ok(body.query.bool.filter.some(value => value.term?.tenantId === tenantId));
    assert.ok(body.query.bool.filter.some(value => value.term?.corpus === 'connector'));
    assert.ok(filter.some(value => value.term?.tenantId === tenantId));
    assert.ok(filter.some(value => value.term?.['connector.deleted'] === false));
    assert.deepEqual(body.query.bool.must[0].bool.must_not, [{terms: {'connector.kind': ['passage', 'transcript', 'file_chunk']}}]);
    const ids = filter.find(value => value.terms?.['connector.connectionId'])?.terms['connector.connectionId'];
    assert.ok(Array.isArray(ids) && ids.length > 0 && ids.length <= 100);
    assert.equal(new Set(ids).size, ids.length);
    state.requests.push(ids);
    const kinds = {}, connections = [];
    for (const id of ids) {
      assert.ok(inventories.has(id), 'only authorized connections reach the search backend');
      const counts = inventories.get(id);
      for (const [kind, n] of Object.entries(counts)) kinds[kind] = (kinds[kind] || 0) + n;
      if (total(counts)) connections.push({key: id, doc_count: total(counts), kinds: terms(buckets(counts))});
    }
    state.afterSearch();
    return realmResponse('connector', state.reply({hits: {total: {value: total(kinds), relation: 'eq'}, hits: []},
      aggregations: {kinds: terms(buckets(kinds)), connections: terms(connections)}}));
  }});
  const registry = {
    listTenant: async tenant => {assert.equal(tenant, tenantId); return state.records;},
    get: async (tenant, user, id) => {assert.equal(tenant, tenantId); return state.records.find(record => record.integrationId === id && record.userId === user);},
  };
  const resolver = createConnectorResolver({environment: 'selfhost', generation: 'v1', registry, storage: async () => ({}), search: () => search});
  const expected = {total: 0, kinds: {}, providers: {}, connections: {}};
  const add = (target, kinds) => {target.total += total(kinds); for (const [kind, n] of Object.entries(kinds)) target.kinds[kind] = (target.kinds[kind] || 0) + n;};
  for (const binding of bindings) {
    const kinds = inventories.get(binding.connectionId);
    expected.connections[binding.connectionId] = {total: total(kinds), kinds};
    add(expected, kinds); add(expected.providers[binding.provider] ||= {total: 0, kinds: {}}, kinds);
  }
  return {bindings, inventories, state, search, resolver, expected};
}

test('connector inventory batches connection counts within the 100-binding query bound', async t => {
  const observed = [];
  for (const connections of [3, 101]) {
    const f = fixture(connections);
    assert.deepEqual(await f.resolver.count(principal), f.expected, 'same-provider and empty connections keep their own counts');
    observed.push({connections, searchRequests: f.state.requests.length, queryBindings: f.state.requests.map(ids => ids.length)});
  }
  for (const metrics of observed) t.diagnostic(JSON.stringify(metrics));
  assert.deepEqual(observed.map(value => value.searchRequests), [1, 2]);
  assert.deepEqual(observed.map(value => value.queryBindings), [[3], [100, 1]]);
});

test('the existing aggregate count contract remains unchanged', async () => {
  const f = fixture();
  assert.deepEqual(await f.search.count(principal, f.bindings), {total: f.expected.total, kinds: f.expected.kinds});
  await assert.rejects(f.search.count({...principal, tenantId: 'org_other'}, f.bindings), /scope/);
});

test('connector inventory rejects foreign and duplicate records and final disconnects', async t => {
  for (const reason of ['foreign', 'duplicate', 'disconnect']) await t.test(reason, async () => {
    const f = fixture();
    if (reason === 'foreign') f.state.records[0].tenantId = 'org_other';
    if (reason === 'duplicate') f.state.records.push(f.state.records[0]);
    if (reason === 'disconnect') f.state.afterSearch = () => {f.state.records[0].status = 'disconnected';};
    await assert.rejects(f.resolver.count(principal), error => error.status === 403);
    if (reason !== 'disconnect') assert.equal(f.state.requests.length, 0);
  });
});

test('connector inventory rejects incomplete search responses', async () => {
  for (const changed of [{timed_out: true}, {_shards: {failed: 1}}]) {
    const f = fixture(); f.state.reply = response => ({...response, ...changed});
    await assert.rejects(f.resolver.count(principal), /incomplete/);
  }
});

test('real SQLite counts match per-connection and provider inventory including empty connections', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'connector-count-efficiency-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const endpoint = pathToFileURL(join(directory, 'search.sqlite')).href.replace('file:', 'sqlite:');
  const f = fixture(3, () => createConnectorSearch({endpoint, tenantId}));
  await f.search.ensureIndex();
  for (const binding of f.bindings) {
    const documents = [];
    for (const [kind, count] of Object.entries(f.inventories.get(binding.connectionId))) {
      for (let i = 0; i < count; i++) {
        const sourceId = kind + '_' + i;
        documents.push({id: documentId(binding, kind, sourceId), document: {tenantId, connectionId: binding.connectionId,
          workspaceId: binding.workspaceId, provider: binding.provider, kind, sourceId, deleted: false,
          text: 'fixture', extractedAt: 1, contentHash: 'a'.repeat(64)}});
      }
    }
    for (const kind of ['passage', 'transcript', 'file_chunk']) documents.push({id: documentId(binding, kind, 'excluded'),
      document: {tenantId, connectionId: binding.connectionId, workspaceId: binding.workspaceId, provider: binding.provider,
        kind, sourceId: 'excluded', deleted: false, text: 'excluded', extractedAt: 1, contentHash: 'b'.repeat(64)}});
    await f.search.putDocuments(principal, binding, documents);
  }
  const foreign = bindingFor(1, 'org_other'), other = createConnectorSearch({endpoint, tenantId: foreign.tenantId});
  await other.ensureIndex();
  await other.putDocuments({tenantId: foreign.tenantId}, foreign, [{id: documentId(foreign, 'issue', 'foreign'), document: {
    tenantId: foreign.tenantId, connectionId: foreign.connectionId, workspaceId: foreign.workspaceId, provider: foreign.provider,
    kind: 'issue', sourceId: 'foreign', deleted: false, text: 'foreign', extractedAt: 1, contentHash: 'c'.repeat(64)}}]);
  assert.deepEqual(await f.resolver.count(principal), f.expected);
  assert.deepEqual(await f.search.count(principal, f.bindings), {total: f.expected.total, kinds: f.expected.kinds});
  await assert.rejects(f.search.count({tenantId: foreign.tenantId}, f.bindings), /scope/);
});
