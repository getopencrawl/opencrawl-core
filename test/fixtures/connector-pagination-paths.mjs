import {startConnectorIndexing} from '../../dist/src/connectors/temporal/client.mjs';
import {withTestState,stateFor} from './memory-application-state.mjs';
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
    pipeline: createConnectorPipeline(withTestState({binding, store, search})),
    raw(stream, data, name = '1') {
      const key = `${binding.rawPrefix}stream=${stream}/date=2026-11-05/sync=1/${name}.jsonl.gz`;
      objects.set(key, {bytes: gzipSync(JSON.stringify({_airbyte_extracted_at: 2000, _airbyte_data: data})), etag: '"raw"'});
      return key;
    },
    summary() {return {lists, cursors, refreshes, reads, documents: documents.length, maxSearching,
      receipts: [...stateFor(store).receiptValues].filter(([key])=>key.startsWith('derived/')).map(([,value])=>value), output};},
  };
}

async function standalone() {
  const output=[],requests=[];let closed=0;
  const context=vm.createContext({process:{argv:['node','standalone.mjs','index','fixture.json']},console:{log:value=>output.push(JSON.parse(value))}});
  const modules={
    '../search/realm.mjs':{realmIndex:()=>assert.fail('Submission cannot access search')},
    'node:fs/promises':{readFile:async()=>JSON.stringify({binding:{tenantId:'fixture-team',connectionId:'fixture-conn',secret:'PRIVATE_CONFIG'},s3:{secretAccessKey:'PRIVATE_CONFIG'},search:{password:'PRIVATE_CONFIG'},temporal:{address:'localhost:7233',namespace:'default',taskQueue:'indexing'}})},
    './search.mjs':{createConnectorSearch:()=>assert.fail('Submission cannot access search')},
    './scope.mjs':{validateBinding:()=>assert.fail('Worker owns full binding')},
    './temporal/client.mjs':{startConnectorIndexing,connectorClient:async()=>({client:{workflow:{start:async(...args)=>{requests.push(args);}}},connection:{close:async()=>{closed++;}}})},
  };
  const entry=new vm.SourceTextModule(await readFile(new URL('../../dist/src/connectors/standalone.mjs',import.meta.url),'utf8'),{context});
  await entry.link(specifier=>{const values=modules[specifier];assert.ok(values,specifier);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});});
  await entry.evaluate();return {output,requests,closed};
}

if (process.argv[2] === '--standalone-fixture') console.log(JSON.stringify(await standalone(process.argv[3])));
