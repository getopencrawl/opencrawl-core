import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createServer} from 'node:http';
import {createRegistry} from '../dist/src/integrations/registry.mjs';
import {createSources} from '../dist/src/integrations/service.mjs';
import {createSourcesHandler} from '../dist/src/integrations/http.mjs';
import {createSourceSync} from '../dist/src/integrations/sync.mjs';
import {configuredWorkspaceSearch} from '../dist/src/search/config.mjs';

const KEY = 'composio_test_key_1';
const json = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

/** Composio v3.1 fake: auth configs, links, accounts and a Slack proxy. */
function fakeComposio({accountStatus = 'ACTIVE', team = 'T0TEST1'} = {}) {
  const calls = [], accounts = new Map(), configs = [];
  const fetch = async (url, init = {}) => {
    const {pathname, searchParams} = new URL(url), path = pathname.replace('/api/v3.1', ''), body = init.body ? JSON.parse(init.body) : null;
    calls.push([init.method || 'GET', path]);
    if (init.headers['x-api-key'] !== KEY) return json(401, {error: {message: 'invalid key'}});
    if (path === '/auth_configs' && init.method === 'GET') return json(200, {items: configs.filter(c => !searchParams.get('toolkit_slug') || c.toolkit.slug === searchParams.get('toolkit_slug'))});
    if (path === '/auth_configs') { configs.push({id: 'ac_' + configs.length, name: body.auth_config.name, toolkit: body.toolkit, status: 'ENABLED', is_composio_managed: !body.auth_config.authScheme, auth_scheme: body.auth_config.authScheme}); return json(201, {auth_config: {id: configs.at(-1).id}}); }
    if (path === '/connected_accounts/link') { const id = 'ca_' + (accounts.size + 1); accounts.set(id, {id, user_id: body.user_id, status: accountStatus, toolkit: {slug: configs.find(c => c.id === body.auth_config_id).toolkit.slug}}); return json(201, {redirect_url: 'https://connect.composio.dev/link/' + id, connected_account_id: id}); }
    const account = /^\/connected_accounts\/(ca_\w+)$/.exec(path);
    if (account && init.method === 'DELETE') { accounts.delete(account[1]); return json(200, {}); }
    if (account) return accounts.has(account[1]) ? json(200, accounts.get(account[1])) : json(404, {error: {message: 'missing'}});
    if (path === '/tools/execute/proxy') return json(200, {status: 200, data: {ok: true, team: 'Test', user: 'ada', team_id: team}});
    return json(404, {});
  };
  return {fetch, calls, accounts};
}

async function fixture(options) {
  const dir = await mkdtemp(join(tmpdir(), 'opencrawl-sources-'));
  const registry = createRegistry(join(dir, 'sources.sqlite'));
  const composio = fakeComposio(options);
  const sources = createSources({registry, tenantId: 'self-hosted', origin: 'http://127.0.0.1:8094', fetch: composio.fetch});
  return {dir, registry, composio, sources, close: async () => { registry.close(); await rm(dir, {recursive: true, force: true}); }};
}
const pending = registry => registry.list(['connecting']).at(-1);
const callback = record => new URLSearchParams({integration: record.id, state: record.nonce, connected_account_id: record.connectedAccountId});

test('OAuth sources need a checked Composio key, then connect through a one-time state', async () => {
  const f = await fixture();
  try {
    assert.equal(f.sources.list().items.find(i => i.id === 'slack').state, 'unavailable');
    await assert.rejects(f.sources.connect('slack'), /Add a Composio API key/);
    await assert.rejects(f.sources.setComposioKey('wrong_key_value'), /didn’t accept/);
    await f.sources.setComposioKey(KEY);
    const {redirectUrl} = await f.sources.connect('slack');
    assert.match(redirectUrl, /^https:\/\/connect\.composio\.dev\//);
    const record = pending(f.registry);
    assert.deepEqual(await f.sources.complete('slack', new URLSearchParams({integration: record.id, state: 'forged', connected_account_id: record.connectedAccountId})), {ok: false, reason: 'invalid'});
    assert.deepEqual(await f.sources.complete('notion', callback(record)), {ok: false, reason: 'invalid'});
    assert.deepEqual(await f.sources.complete('slack', callback(record)), {ok: true, reason: 'connected'});
    assert.deepEqual(await f.sources.complete('slack', callback(record)), {ok: true, reason: 'done'});
    const active = f.registry.get(record.id);
    assert.equal(active.status, 'active'); assert.equal(active.workspaceId, 'T0TEST1'); assert.equal(active.nonce, null);
    assert.deepEqual(f.sources.bindings(), [{tenantId: 'self-hosted', connectionId: record.id, workspaceId: 'T0TEST1', provider: 'slack', access: 'team-public', rawPrefix: `raw/v1/source=slack/workspace=T0TEST1/connection=${record.id}/`}]);
    await assert.rejects(f.sources.connect('slack'), /already connected/);
    // Disconnect revokes the grant and removes search access before raw data is deleted.
    await f.sources.disconnect('slack');
    assert.equal(f.composio.accounts.size, 0);
    assert.equal(f.registry.get(record.id).status, 'disconnecting');
    assert.deepEqual(f.sources.bindings(), []);
  } finally { await f.close(); }
});

test('a declined or inactive sign-in never activates a connection', async () => {
  const f = await fixture({accountStatus: 'INITIATED'});
  try {
    await f.sources.setComposioKey(KEY);
    await f.sources.connect('slack');
    const record = pending(f.registry);
    assert.deepEqual(await f.sources.complete('slack', callback(record)), {ok: false, reason: 'declined'});
    assert.equal(f.registry.get(record.id).status, 'connecting');
    const params = callback(record); params.set('status', 'failed');
    assert.deepEqual(await f.sources.complete('slack', params), {ok: false, reason: 'declined'});
    assert.equal(f.registry.get(record.id).status, 'abandoned');
    assert.deepEqual(f.sources.bindings(), []);
  } finally { await f.close(); }
});

test('Granola connects with a workspace key and refuses personal keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencrawl-sources-'));
  const registry = createRegistry(join(dir, 'sources.sqlite'));
  let personal = true;
  const fetch = async url => {
    const {pathname} = new URL(url);
    if (pathname === '/v1/spaces') return json(200, {spaces: [{name: 'Team'}]});
    if (pathname === '/v1/notes') return json(200, {notes: [{id: 'not_1'}]});
    return json(200, personal ? {id: 'not_1', private_notes_text: 'mine'} : {id: 'not_1'});
  };
  try {
    const sources = createSources({registry, tenantId: 'self-hosted', origin: 'http://127.0.0.1:8094', fetch});
    assert.equal(sources.list().items.find(i => i.id === 'granola').state, 'available');
    await assert.rejects(sources.connect('granola', {apiKey: 'short'}), /doesn’t look like/);
    await assert.rejects(sources.connect('granola', {apiKey: 'grn_personal_key_1'}), /personal API key/);
    personal = false;
    assert.deepEqual(await sources.connect('granola', {apiKey: 'grn_workspace_key_1'}), {ok: true});
    const [record] = registry.list(['active']);
    assert.equal(record.workspaceId, 'self-hosted'); assert.equal(record.label, 'Spaces: Team');
    assert.equal(registry.syncInput(record.id).apiKey, 'grn_workspace_key_1');
    await sources.disconnect('granola');
    assert.equal(registry.syncInput(record.id).apiKey, null);
  } finally { registry.close(); await rm(dir, {recursive: true, force: true}); }
});

test('HTTP routes require the operator token except the state-checked callback', async () => {
  const f = await fixture();
  const handler = createSourcesHandler({sources: f.sources, authenticate: async req => req.headers.authorization === 'Bearer ok' ? {tenantId: 'self-hosted', userId: 'owner'} : null});
  const server = createServer((req, res) => handler(req, res).then(owned => { if (!owned) { res.writeHead(404); res.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, auth = {authorization: 'Bearer ok'};
  try {
    assert.equal((await fetch(base + '/api/onboarding/sources')).status, 401);
    assert.equal((await fetch(base + '/api/integrations/slack/connect', {method: 'POST'})).status, 401);
    const listed = await (await fetch(base + '/api/onboarding/sources', {headers: auth})).json();
    assert.deepEqual(listed.items.map(i => [i.id, i.state]), [['slack', 'unavailable'], ['notion', 'unavailable'], ['circleback', 'unavailable'], ['granola', 'available']]);
    assert.equal((await fetch(base + '/api/integrations/composio', {method: 'PUT', headers: auth, body: JSON.stringify({apiKey: KEY})})).status, 200);
    assert.equal((await fetch(base + '/api/integrations/nope/connect', {method: 'POST', headers: auth})).status, 404);
    const {redirectUrl} = await (await fetch(base + '/api/integrations/slack/connect', {method: 'POST', headers: auth})).json();
    assert.ok(redirectUrl);
    const response = await fetch(`${base}/integrations/slack/callback?${callback(pending(f.registry))}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /^Connected/);
    assert.equal((await fetch(base + '/elsewhere')).status, 404);
  } finally { server.close(); await f.close(); }
});

/** Stands in for `source-declarative-manifest`: one discover, then a read with a checkpoint. */
const FAKE_CONNECTOR = `
const [command] = process.argv.slice(2);
const out = message => console.log(JSON.stringify(message));
if (command === 'discover') out({type: 'CATALOG', catalog: {streams: ['channels', 'users', 'messages', 'threads'].map(name => ({name, json_schema: {}, supported_sync_modes: name.endsWith('s') && name !== 'users' && name !== 'channels' ? ['full_refresh', 'incremental'] : ['full_refresh']}))}});
else {
  out({type: 'LOG', log: {level: 'INFO', message: 'starting'}});
  out({type: 'RECORD', record: {stream: 'messages', data: {ts: '1.000001', channel_id: 'C1', text: 'hello'}, emitted_at: 1000}});
  out({type: 'STATE', state: {type: 'STREAM', stream: {stream_descriptor: {name: 'messages'}, stream_state: {ts: '1.000001'}}}});
  if (process.env.FAIL) { out({type: 'TRACE', trace: {type: 'ERROR', error: {message: 'Slack rejected composio_test_key_1'}}}); process.exit(1); }
  out({type: 'RECORD', record: {stream: 'channels', data: {id: 'C1', name: 'general'}, emitted_at: 1001}});
}`;

test('sync lands Airbyte envelopes under the connection prefix and commits state after upload', async () => {
  const f = await fixture();
  const objects = new Map();
  const store = {put: async (key, bytes) => { objects.set(key, bytes); }, delete: async key => { objects.delete(key); },
    listPage: async prefix => ({keys: [...objects.keys()].filter(k => k.startsWith(prefix)), nextToken: null})};
  const manifests = join(f.dir, 'manifests'); await mkdir(manifests);
  await writeFile(join(manifests, 'slack.json'), '{"version": "7.28.2"}');
  const script = join(f.dir, 'connector.mjs'); await writeFile(script, FAKE_CONNECTOR);
  let fail = false, configs = [];
  const run = args => {
    const config = args[args.indexOf('--config') + 1];
    configs.push(config);
    return spawn(process.execPath, [script, ...args], {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...(fail ? {FAIL: '1'} : {})}});
  };
  // The registry stamps real time, so the injected clock starts there.
  let clock = Date.now();
  const date = new Date(clock).toISOString().slice(0, 10);
  const sync = createSourceSync({registry: f.registry, store, manifests, run, now: () => clock});
  try {
    await f.sources.setComposioKey(KEY);
    await f.sources.connect('slack');
    const record = pending(f.registry);
    await f.sources.complete('slack', callback(record));
    await sync.tick();
    const keys = [...objects.keys()].sort();
    const prefix = `raw/v1/source=slack/workspace=T0TEST1/connection=${record.id}/`;
    assert.deepEqual(keys, [`${prefix}stream=channels/date=${date}/sync=${clock}/part-00000.jsonl.gz`, `${prefix}stream=messages/date=${date}/sync=${clock}/part-00000.jsonl.gz`]);
    const [line] = gunzipSync(objects.get(keys[1])).toString().trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual({...line, _airbyte_raw_id: 'id'}, {_airbyte_raw_id: 'id', _airbyte_extracted_at: 1000, _airbyte_meta: {changes: [], sync_id: clock}, _airbyte_generation_id: 0, _airbyte_data: {ts: '1.000001', channel_id: 'C1', text: 'hello'}});
    assert.equal(f.registry.get(record.id).lastSyncStatus, 'succeeded');
    assert.deepEqual(f.registry.syncInput(record.id).state.map(s => s.stream.stream_descriptor.name), ['messages']);
    // Temporary config files holding keys are removed after each run.
    await assert.rejects(writeFile(configs[0], 'x', {flag: 'r+'}), {code: 'ENOENT'});
    // Not due again until the provider interval passes.
    await sync.tick();
    assert.equal(objects.size, 2);
    // A failed run records a redacted error and keeps the earlier committed checkpoint.
    clock += 16 * 60_000; fail = true;
    await sync.tick();
    const failed = f.registry.get(record.id);
    assert.equal(failed.lastSyncStatus, 'failed');
    assert.equal(failed.lastSyncError, 'Slack rejected [redacted]');
    assert.equal(f.sources.list().items.find(i => i.id === 'slack').state, 'error');
    // Disconnect deletes this connection's raw data on the next pass.
    await f.sources.disconnect('slack');
    await sync.tick();
    assert.equal(objects.size, 0);
    assert.equal(f.registry.get(record.id).status, 'disconnected');
  } finally { await f.close(); }
});

test('operator search config re-resolves runtime connector bindings on every call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencrawl-sources-'));
  try {
    const path = join(dir, 'search.json');
    await writeFile(path, JSON.stringify({principal: {tenantId: 'self-hosted', userId: 'owner'}, connectors: {search: {endpoint: 'http://127.0.0.1:9', environment: 'selfhost'}}}));
    let calls = 0;
    const {search} = await configuredWorkspaceSearch(path, {connectorBindings: () => { calls++; return []; }});
    const result = await search.search({tenantId: 'self-hosted', userId: 'owner'}, {query: 'anything', source: 'connectors'});
    assert.deepEqual(result.results, []);
    assert.equal(calls, 1);
    const foreign = await configuredWorkspaceSearch(path, {connectorBindings: () => [{tenantId: 'other', connectionId: 'int_x', workspaceId: 'T1', provider: 'slack', access: 'team-public', rawPrefix: 'raw/v1/source=slack/workspace=T1/connection=int_x/'}]});
    // A binding outside the deployment's tenant fails closed: no results, source unavailable.
    const denied = await foreign.search.search({tenantId: 'self-hosted', userId: 'owner'}, {query: 'anything', source: 'connectors'});
    assert.deepEqual(denied.results, []);
    assert.equal(denied.coverage[0].state, 'unavailable');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
