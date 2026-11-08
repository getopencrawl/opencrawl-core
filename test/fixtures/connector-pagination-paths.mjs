import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {createObjectStore} from '../../dist/src/sessions/s3-store.mjs';
import {createConnectorPipeline} from '../../dist/src/connectors/pipeline.mjs';
import {guardConnectorWrites} from '../../dist/src/connectors/write-barrier.mjs';
import {validateBinding} from '../../dist/src/connectors/scope.mjs';
import * as pagination from '../../dist/src/connectors/workflow.mjs';

// The real S3 adapter, pipeline and write barrier run against a local fetch fixture.
// The bound makes a regressed infinite traversal fail without hanging the suite.
export function paginationFixture(provider, {list, maxLists = 40, failSearchAt} = {}) {
  const binding = {tenantId: 'fixture-team', connectionId: 'fixture-conn', workspaceId: 'workspace', provider,
    access: 'workspace-global', rawPrefix: `raw/v1/source=${provider}/workspace=workspace/connection=fixture-conn/`};
  const objects = new Map(), documents = [], reads = [], cursors = [], output = [];
  let lists = 0, refreshes = 0, writes = 0, searching = 0, maxSearching = 0, version = 0;
  const store = createObjectStore({endpoint: 'https://fixture.invalid', bucket: 'fixture',
    credentials: {accessKeyId: 'fixture', secretAccessKey: 'fixture'}, fetch: async (url, options) => {
      const key = decodeURIComponent(url.pathname.slice('/fixture/'.length));
      if (options.method === 'HEAD') return new Response(null, {status: 200});
      if (options.method === 'GET' && url.searchParams.get('list-type') === '2') {
        assert.equal(url.searchParams.get('prefix'), binding.rawPrefix);
        assert.ok(++lists <= maxLists, 'fixture page bound reached');
        const cursor = url.searchParams.get('continuation-token'); cursors.push(cursor);
        const page = list(cursor, lists);
        const xml = `<ListBucketResult><IsTruncated>${page.nextToken !== null}</IsTruncated>` +
          (page.nextToken === null ? '' : `<NextContinuationToken>${page.nextToken}</NextContinuationToken>`) +
          page.keys.map(key => `<Contents><Key>${key}</Key></Contents>`).join('') + '</ListBucketResult>';
        return new Response(xml);
      }
      const item = objects.get(key);
      if (options.method === 'GET') {
        if (key.startsWith(binding.rawPrefix)) reads.push(key);
        return item ? new Response(item.bytes, {headers: {etag: item.etag}}) : new Response(null, {status: 404});
      }
      assert.equal(options.method, 'PUT');
      const headers = new Headers(options.headers);
      assert.ok(headers.get('if-match') === null || headers.get('if-match') === item?.etag);
      assert.ok(headers.get('if-none-match') !== '*' || !item);
      const etag = `"${++version}"`;
      objects.set(key, {bytes: Buffer.from(options.body), etag});
      return new Response(null, {headers: {etag}});
    }});
  const search = {identity: 'fixture-index', ensureIndex: async () => {},
    refresh: async () => {refreshes++;}, putDocuments: async (_principal, _binding, items) => {
      maxSearching = Math.max(maxSearching, ++searching);
      try {
        await new Promise(resolve => setImmediate(resolve));
        if (++writes === failSearchAt) throw Object.assign(new Error('fixture search rejection'), {writeOutcome: 'not-applied'});
        documents.push(...items);
      } finally {searching--;}
    }};
  return {binding, store, search, reads, cursors, output, documents,
    pipeline: createConnectorPipeline({binding, store, search}),
    raw(stream, data, name = '1') {
      const key = `${binding.rawPrefix}stream=${stream}/date=2026-11-05/sync=1/${name}.jsonl.gz`;
      objects.set(key, {bytes: gzipSync(JSON.stringify({_airbyte_extracted_at: 2000, _airbyte_data: data})), etag: '"raw"'});
      return key;
    },
    summary() {return {lists, cursors, refreshes, reads, documents: documents.length, maxSearching,
      receipts: [...objects].filter(([key]) => key.startsWith('derived/')).map(([, item]) => JSON.parse(item.bytes)), output};},
  };
}

async function standalone(scenario) {
  let keys;
  const h = paginationFixture('github', {failSearchAt: scenario === 'fail-fast' ? 2 : undefined,
    list: cursor => scenario === 'cycle' ? {keys: [], nextToken: cursor === 'A' ? 'B' : 'A'} :
      scenario === 'fail-fast' ? {keys, nextToken: 'A'} :
      cursor === null ? {keys: [], nextToken: 'A'} :
      cursor === 'A' ? {keys: [h.binding.rawPrefix + 'ignored'], nextToken: 'B'} : {keys, nextToken: null}});
  keys = [1, 2, 3].slice(0, scenario === 'fail-fast' ? 3 : 2).map(number => h.raw('issues',
    {repository: 'team/repo', number, title: 'Fixture issue', body: 'Fixture text', updated_at: '2026-11-05T12:00:00Z'}, String(number)));
  const context = vm.createContext({process: {argv: ['node', 'standalone.mjs', 'index', 'fixture.json']},
    console: {log: value => h.output.push(JSON.parse(value))}});
  const modules = {
    './write-barrier.mjs': {guardConnectorWrites}, '../search/realm.mjs': {realmIndex: () => 'fixture-index'},
    'node:fs/promises': {readFile: async () => JSON.stringify({binding: h.binding, s3: {}, search: {}})},
    '../sessions/s3-store.mjs': {createObjectStore: () => h.store, awsCredentials: () => ({})},
    './search.mjs': {createConnectorSearch: () => h.search}, './pipeline.mjs': {createConnectorPipeline},
    './scope.mjs': {validateBinding}, './workflow.mjs': pagination,
  };
  const entry = new vm.SourceTextModule(await readFile(new URL('../../dist/src/connectors/standalone.mjs', import.meta.url), 'utf8'), {context});
  await entry.link(specifier => {
    const values = modules[specifier]; assert.ok(values, specifier);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, {context});
  });
  let error;
  try {await entry.evaluate();} catch (cause) {error = {name: cause.constructor.name, code: cause.code, message: cause.message};}
  return {...h.summary(), keys, error};
}

if (process.argv[2] === '--standalone-fixture') console.log(JSON.stringify(await standalone(process.argv[3])));
