import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalAirbyte, cronMatches, configuredCatalog, DECLARATIVE_IMAGE} from '../dist/src/integrations/local-airbyte.mjs';
import {tarball, lineSplitter} from '../dist/src/integrations/connector-runner.mjs';
import {landingDestinationConfiguration} from '../dist/src/integrations/destination.mjs';
import {createProvisioning, provisioningLabel} from '../dist/src/integrations/provisioning.mjs';
import {readRecords} from '../dist/src/connectors/records.mjs';

const WORKSPACE = '00000000-0000-0000-0000-000000000001', KEY = Buffer.alloc(32, 7);
const PREFIX = 'raw/v1/source=granola/workspace=org_team/connection=int_' + 'a'.repeat(26);
const manifest = {version: '6.0.0', spec: {connection_specification: {type: 'object'}}, streams: []};
const line = value => JSON.stringify(value);
const catalog = {type: 'CATALOG', catalog: {streams: [
  {name: 'notes', json_schema: {}, supported_sync_modes: ['full_refresh', 'incremental'], default_cursor_field: ['updated_at'], source_defined_primary_key: [['id']]},
  {name: 'folders', json_schema: {}, supported_sync_modes: ['full_refresh']},
]}};
const record = (stream, data, emitted_at = 1700000000000) => line({type: 'RECORD', record: {stream, data, emitted_at}});
const state = (name, cursor) => line({type: 'STATE', state: {type: 'STREAM', stream: {stream_descriptor: {name}, stream_state: {cursor}}}});

function memoryStore() {
  const objects = new Map(), puts = [];
  return {objects, puts, async put(key, body) {objects.set(key, Buffer.from(body)); puts.push(key);}, async get(key) {return objects.get(key) || null;}};
}
/** Scripted runner: answers discover with a catalog and read with the given lines, recording inputs. */
function fakeRunner(script) {
  const calls = [];
  return {calls, async run(input, emit) {
    calls.push(structuredClone({...input, signal: undefined}));
    const out = input.command === 'discover' ? {lines: [line(catalog)], exitCode: 0} : await script(input, calls.filter(c => c.command === 'read').length);
    for (const text of out.lines) await emit(text);
    return {exitCode: out.exitCode ?? 0, stderrBytes: 0};
  }};
}
async function fixture(t, script, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'opencrawl-local-airbyte-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = memoryStore(), runner = fakeRunner(script);
  const make = (extra = {}) => createLocalAirbyte({path: join(dir, 'connectors.sqlite'), workspaceId: WORKSPACE, secretKey: KEY, runner, store, ...options, ...extra});
  const airbyte = make();
  t.after(() => airbyte.close());
  return {dir, store, runner, airbyte, make};
}
/** The same calls service.mts makes while provisioning a declarative, key-based source. */
async function provision(airbyte) {
  const definition = await airbyte.createDeclarativeSource(WORKSPACE, 'OpenCrawl Granola (workspace API key)', manifest);
  assert.deepEqual((await airbyte.declarativeSources(WORKSPACE)).map(d => [d.id, d.name, d.manifest]), [[definition.id, 'OpenCrawl Granola (workspace API key)', manifest]]);
  const destination = await airbyte.createDestination({workspaceId: WORKSPACE, name: 'label', definitionId: undefined, configuration: {
    ...landingDestinationConfiguration({s3Bucket: 'opencrawl', s3Prefix: PREFIX}, 'us-east-1'), access_key_id: 'AKIA-secret', secret_access_key: 'landing-secret'}});
  const source = await airbyte.createSource({workspaceId: WORKSPACE, name: 'label', definitionId: definition.id, configuration: {api_key: 'grn_super_secret', start_date: '2026-01-01T00:00:00Z'}});
  const connection = await airbyte.createConnection({name: 'label', sourceId: source.sourceId, destinationId: destination.destinationId, namespaceDefinition: 'destination',
    schedule: {scheduleType: 'cron', cronExpression: '0 0/15 * * * ?'}, status: 'active',
    configurations: {streams: [{name: 'notes', syncMode: 'incremental_append', cursorField: ['updated_at']}, {name: 'folders', syncMode: 'full_refresh_append'}]}});
  return {definition, destination, source, connection};
}

test('a sync runs the declarative image and lands records exactly where and how indexing reads them', async t => {
  const f = await fixture(t, async (_input, n) => ({lines: n === 1
    ? [record('notes', {id: 1, title: 'first'}), record('folders', {id: 'f'}), state('notes', 'a'), record('notes', {id: 2, title: 'second'}), line({type: 'LOG', log: {level: 'INFO', message: 'grn_super_secret'}})]
    : [record('notes', {id: 3, title: 'third'}), state('notes', 'b')]}));
  const {connection} = await provision(f.airbyte);
  const job = await f.airbyte.sync(connection.connectionId);
  assert.equal(job.status, 'pending');
  await assert.rejects(f.airbyte.sync(connection.connectionId), {status: 409});
  await f.airbyte.tick();
  const [discover, read] = f.runner.calls;
  assert.equal(discover.image, DECLARATIVE_IMAGE);
  assert.equal(discover.command, 'discover');
  assert.deepEqual(read.files.config, {api_key: 'grn_super_secret', start_date: '2026-01-01T00:00:00Z', __injected_declarative_manifest: manifest});
  assert.deepEqual(read.files.catalog.streams.map(s => [s.stream.name, s.sync_mode, s.destination_sync_mode, s.cursor_field]), [['notes', 'incremental', 'append', ['updated_at']], ['folders', 'full_refresh', 'append', undefined]]);
  assert.equal(read.files.state, undefined);
  const keys = [...f.store.objects.keys()];
  assert.equal(keys.length, 3);
  const pattern = new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/stream=(notes|folders)/date=\\d{4}-\\d{2}-\\d{2}/sync=${job.jobId}/\\d+_\\d+\\.jsonl\\.gz$`);
  for (const key of keys) assert.match(key, pattern);
  const notes = [];
  for (const key of keys.filter(k => k.includes('stream=notes'))) await readRecords(f.store, key, envelope => notes.push(envelope));
  assert.deepEqual(notes.map(e => e._airbyte_data.title), ['first', 'second']);
  assert.equal(notes[0]._airbyte_extracted_at, 1700000000000);
  assert.equal(notes[0]._airbyte_meta.sync_id, job.jobId);
  assert.match(notes[0]._airbyte_raw_id, /^[0-9a-f-]{36}$/);
  const [done] = await f.airbyte.jobs(connection.connectionId);
  assert.deepEqual([done.status, done.rowsSynced], ['succeeded', 3]);
  assert.deepEqual(await f.airbyte.streamCounts(connection.connectionId), {notes: 2, folders: 1});
  // The next run resumes from the last checkpoint.
  await f.airbyte.sync(connection.connectionId); await f.airbyte.tick();
  assert.deepEqual(f.runner.calls.at(-1).files.state, [{type: 'STREAM', stream: {stream_descriptor: {name: 'notes'}, stream_state: {cursor: 'a'}}}]);
  await f.airbyte.sync(connection.connectionId); await f.airbyte.tick();
  assert.equal(f.runner.calls.at(-1).files.state[0].stream.stream_state.cursor, 'b');
  // Secrets are sealed at rest; storage credentials are never kept.
  const disk = await readFile(join(f.dir, 'connectors.sqlite'));
  for (const secret of ['grn_super_secret', 'landing-secret', 'AKIA-secret']) assert.equal(disk.includes(secret), false, secret);
});

test('a failed read keeps the previous checkpoint and records written before it', async t => {
  const f = await fixture(t, async (_input, n) => n === 1 ? {lines: [record('notes', {id: 1}), state('notes', 'a')]} : {lines: [record('notes', {id: 2}), state('notes', 'b'), record('notes', {id: 3}), line({type: 'TRACE', trace: {type: 'ERROR', error: {message: 'boom'}}})], exitCode: 1});
  const {connection} = await provision(f.airbyte);
  await f.airbyte.sync(connection.connectionId); await f.airbyte.tick();
  await f.airbyte.sync(connection.connectionId); await f.airbyte.tick();
  assert.deepEqual((await f.airbyte.jobs(connection.connectionId)).map(j => j.status), ['failed', 'succeeded']);
  await f.airbyte.sync(connection.connectionId); await f.airbyte.tick();
  // 'b' was committed after its records landed, even though the run later failed.
  assert.equal(f.runner.calls.filter(c => c.command === 'read')[2].files.state[0].stream.stream_state.cursor, 'b');
});

test('connector state survives restart, is bound to its workspace and needs its key', async t => {
  const f = await fixture(t, async () => ({lines: []}));
  const {connection, source, destination} = await provision(f.airbyte);
  await f.airbyte.sync(connection.connectionId);
  f.airbyte.close();
  const reopened = f.make(); t.after(() => reopened.close());
  assert.deepEqual((await reopened.connections(WORKSPACE)).map(c => [c.connectionId, c.sourceId, c.destinationId, c.name, c.workspaceId]), [[connection.connectionId, source.sourceId, destination.destinationId, 'label', WORKSPACE]]);
  assert.equal((await reopened.jobs(connection.connectionId))[0].status, 'pending');
  await assert.rejects(reopened.sources('00000000-0000-0000-0000-000000000002'), {status: 404});
  assert.throws(() => f.make({workspaceId: '00000000-0000-0000-0000-000000000002'}), /another workspace/);
  const keyless = f.make({secretKey: undefined}); t.after(() => keyless.close());
  await assert.rejects(keyless.sources(WORKSPACE), /key is required/);
});

test('removing a connection cancels pending work and resources disappear from listings', async t => {
  const f = await fixture(t, async () => assert.fail('A removed connection must not run'));
  const {connection, source, destination} = await provision(f.airbyte);
  await f.airbyte.sync(connection.connectionId);
  await f.airbyte.deleteConnection(connection.connectionId);
  await f.airbyte.deleteSource(source.sourceId); await f.airbyte.deleteDestination(destination.destinationId);
  await assert.rejects(f.airbyte.deleteConnection(connection.connectionId), {status: 404});
  await assert.rejects(f.airbyte.sync(connection.connectionId), {status: 404});
  await f.airbyte.tick();
  assert.deepEqual((await f.airbyte.jobs(connection.connectionId)).map(j => j.status), ['cancelled']);
  for (const kind of ['sources', 'destinations', 'connections']) assert.deepEqual(await f.airbyte[kind](WORKSPACE), []);
});

test('provisioning recovery finds an exact resource in the local listing', async t => {
  const f = await fixture(t, async () => ({lines: []}));
  const initial = {environment: 'selfhost', tenantId: 'org_team', userId: 'user_a', integrationId: 'int_' + 'a'.repeat(26), provider: 'granola', status: 'provisioning', provisionProtocol: 1};
  let current = structuredClone(initial);
  const registry = {get: async () => structuredClone(current), update: async (_r, fields) => {Object.assign(current, structuredClone(fields)); return structuredClone(current);}};
  const provisioning = createProvisioning({environment: 'selfhost', registry, airbyte: f.airbyte});
  const {definition} = await provision(f.airbyte);
  await assert.rejects(provisioning.ensure(initial, 'sourceId', WORKSPACE, async () => {
    await f.airbyte.createSource({workspaceId: WORKSPACE, name: provisioningLabel(initial), definitionId: definition.id, configuration: {}});
    throw new Error('Response lost');
  }), /Response lost/);
  const recovered = await provisioning.reconcile(current);
  assert.equal(recovered.airbyte.sourceId, (await f.airbyte.sources(WORKSPACE)).find(s => s.name === provisioningLabel(initial)).sourceId);
});

test('operator docker definitions resolve by name and run their own image', async t => {
  const f = await fixture(t, async () => ({lines: []}), {definitions: [{name: 'OpenCrawl GitHub (app)', docker: {repository: 'opencrawl/source-github', tag: 'local'}}]});
  const [github] = await f.airbyte.sourceDefinitions(WORKSPACE);
  assert.equal(github.name, 'OpenCrawl GitHub (app)');
  const destination = await f.airbyte.createDestination({workspaceId: WORKSPACE, name: 'd', configuration: {s3_bucket_path: PREFIX}});
  const source = await f.airbyte.createSource({workspaceId: WORKSPACE, name: 's', definitionId: github.id, configuration: {repositories: ['a/b']}});
  await assert.rejects(f.airbyte.createSource({workspaceId: WORKSPACE, name: 's', definitionId: '00000000-0000-0000-0000-00000000dead', configuration: {}}), {status: 404});
  const connection = await f.airbyte.createConnection({name: 'c', sourceId: source.sourceId, destinationId: destination.destinationId, configurations: {streams: [{name: 'notes', syncMode: 'full_refresh_append'}]}});
  await f.airbyte.sync(connection.connectionId); await f.airbyte.tick();
  assert.equal(f.runner.calls[0].image, 'opencrawl/source-github:local');
  assert.deepEqual(f.runner.calls[1].files.config, {repositories: ['a/b']});
});

test('the scheduler enqueues each due minute once', async t => {
  let clock = Date.parse('2026-11-10T10:15:10Z');
  const f = await fixture(t, async () => ({lines: []}), {now: () => clock});
  const {connection} = await provision(f.airbyte);
  await f.airbyte.tick(); await f.airbyte.tick();
  assert.equal((await f.airbyte.jobs(connection.connectionId)).length, 1);
  clock = Date.parse('2026-11-10T10:16:00Z'); await f.airbyte.tick();
  assert.equal((await f.airbyte.jobs(connection.connectionId)).length, 1);
  clock = Date.parse('2026-11-10T10:30:00Z'); await f.airbyte.tick();
  assert.equal((await f.airbyte.jobs(connection.connectionId)).length, 2);
});

test('quartz cron, catalog modes, archive and line framing', async () => {
  const at = new Date('2026-11-10T10:30:00Z');
  assert.equal(cronMatches('0 0/15 * * * ?', at), true);
  assert.equal(cronMatches('0 0 * * * ?', at), false);
  assert.equal(cronMatches('0 30 10 ? * 3', at), true);
  assert.throws(() => cronMatches('0 0 * * *', at), /Invalid cron/);
  assert.throws(() => cronMatches('0 0 * L * ?', at), /Invalid cron/);
  const streams = catalog.catalog.streams;
  assert.deepEqual(configuredCatalog(streams, [{name: 'notes', syncMode: 'incremental_deduped_history'}]).streams[0].primary_key, [['id']]);
  assert.throws(() => configuredCatalog(streams, [{name: 'missing', syncMode: 'full_refresh_append'}]), /does not offer/);
  const listing = execFileSync('tar', ['-tvf', '-'], {input: tarball('opencrawl-x', {'config.json': Buffer.from('{"a":1}')})}).toString();
  assert.match(listing, /opencrawl-x\/config\.json/);
  const extracted = execFileSync('tar', ['-xOf', '-', 'opencrawl-x/config.json'], {input: tarball('opencrawl-x', {'config.json': Buffer.from('{"a":1}')})}).toString();
  assert.equal(extracted, '{"a":1}');
  const seen = [], splitter = lineSplitter(text => seen.push(text), 16);
  await splitter.push(Buffer.from('{"a"')); await splitter.push(Buffer.from(':1}\n\n{"b":2}')); await splitter.end();
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
  await assert.rejects(lineSplitter(() => {}, 4).push(Buffer.from('123456')), /exceeds/);
});
