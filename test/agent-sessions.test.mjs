import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { signRequest, createObjectStore, awsCredentials } from '../integrations/agent-sessions/store.mjs';
import { createReceiver, storeFromEnv } from '../integrations/agent-sessions/receiver.mjs';
import { createReceiverClient, discover, syncFile, splitExport } from '../integrations/agent-sessions/collector.mjs';

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    bucket: 'test',
    ensureBucket: async () => {},
    put: async (key, body) => void objects.set(key, Buffer.from(body)),
    get: async key => objects.get(key) ?? null,
    delete: async key => void objects.delete(key),
    list: async (prefix, {delimiter} = {}) => {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      if (!delimiter) return {keys, prefixes: []};
      return {
        keys: keys.filter(k => !k.slice(prefix.length).includes(delimiter)),
        prefixes: [...new Set(keys.filter(k => k.slice(prefix.length).includes(delimiter)).map(k => k.slice(0, k.indexOf(delimiter, prefix.length) + 1)))],
      };
    },
  };
}

async function startReceiver(options = {}) {
  const store = memoryStore();
  const receiver = createReceiver({store, ...options});
  const server = createServer(receiver.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {store, url, close: () => server.close()};
}

/** Concatenates a session's segments in key order, as an indexer would. */
function reassemble(store, dir) {
  const keys = [...store.objects.keys()].filter(k => k.startsWith(dir) && k.endsWith('.gz') && !k.slice(dir.length).includes('/')).sort();
  return Buffer.concat(keys.map(k => gunzipSync(store.objects.get(k))));
}

const line = n => `${JSON.stringify({n, text: 'x'.repeat(n % 7)})}\n`;

test('signs requests exactly like the AWS SigV4 reference example', () => {
  const headers = signRequest({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: {Range: 'bytes=0-9'},
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(headers.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

/** Records S3 requests and answers from routes keyed by "METHOD host/path". */
function fakeS3(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({method: init.method || 'GET', url: u, headers: init.headers || {}});
    const route = routes[`${init.method || 'GET'} ${u.host}${u.pathname}`];
    return route ? route(u, init) : new Response('', {status: 200});
  };
  return {fetch, calls};
}

test('sessions go to the configured S3 bucket; there is no default bucket', () => {
  assert.throws(() => storeFromEnv({}), /OPENCRAWL_LANDING_S3_BUCKET is not set/);
  const {store, prefix} = storeFromEnv({OPENCRAWL_LANDING_S3_BUCKET: 'acme-context', OPENCRAWL_LANDING_S3_REGION: 'eu-west-1',
    OPENCRAWL_LANDING_S3_ACCESS_KEY_ID: 'AKIA', OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY: 's'});
  assert.equal(store.location, 's3://acme-context (eu-west-1)');
  assert.equal(prefix, 'opencrawl/agent-sessions');
  assert.equal(storeFromEnv({OPENCRAWL_LANDING_S3_BUCKET: 'b', OPENCRAWL_LANDING_S3_PATH: '/team/'}).prefix, 'team/agent-sessions');
});

test('addresses AWS S3 virtual-hosted and S3-compatible stores path-style, signing session tokens', async () => {
  const {fetch, calls} = fakeS3();
  const credentials = {accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 'tok'};
  await createObjectStore({bucket: 'acme', region: 'eu-west-1', credentials, fetch}).put('a b/c.json', '{}');
  assert.equal(calls[0].url.href, 'https://acme.s3.eu-west-1.amazonaws.com/a%20b/c.json');
  assert.equal(calls[0].headers['x-amz-security-token'], 'tok');
  assert.match(calls[0].headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  await createObjectStore({bucket: 'acme', endpoint: 'https://r2.example.com/', credentials, fetch}).get('k');
  assert.equal(calls[1].url.href, 'https://r2.example.com/acme/k');
});

test('reports a missing bucket clearly and never creates one', async () => {
  const {fetch, calls} = fakeS3({'HEAD acme.s3.us-east-1.amazonaws.com/': () => new Response('', {status: 404})});
  const store = createObjectStore({bucket: 'acme', credentials: {accessKeyId: 'a', secretAccessKey: 's'}, fetch});
  await assert.rejects(store.checkAccess(), /S3 bucket acme does not exist/);
  assert.deepEqual(calls.map(c => c.method), ['HEAD']);
  const denied = fakeS3({'HEAD acme.s3.us-east-1.amazonaws.com/': () => new Response('', {status: 403})});
  await assert.rejects(createObjectStore({bucket: 'acme', credentials: {accessKeyId: 'a', secretAccessKey: 's'}, fetch: denied.fetch}).checkAccess(), /403: AccessDenied/);
});

test('finds AWS credentials from the environment, containers, web identity and instance roles', async () => {
  const keys = await awsCredentials({env: {AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't'}})();
  assert.deepEqual(keys, {accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't'});

  const expiration = new Date(Date.now() + 3600_000).toISOString();
  const role = {AccessKeyId: 'ASIA', SecretAccessKey: 's', Token: 't', Expiration: expiration};
  const ecs = fakeS3({'GET 169.254.170.2/v2/credentials/x': () => Response.json(role)});
  assert.equal((await awsCredentials({env: {AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/x'}, fetch: ecs.fetch})()).sessionToken, 't');

  const dir = await mkdtemp(join(tmpdir(), 'oc-irsa-'));
  await writeFile(join(dir, 'token'), 'jwt\n');
  const sts = fakeS3({'GET sts.eu-west-1.amazonaws.com/': u => {
    assert.equal(u.searchParams.get('WebIdentityToken'), 'jwt');
    return new Response(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIA2</AccessKeyId>
      <SecretAccessKey>s2</SecretAccessKey><SessionToken>t2</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
  }});
  const irsa = await awsCredentials({env: {AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, 'token'), AWS_ROLE_ARN: 'arn:aws:iam::1:role/r', AWS_REGION: 'eu-west-1'}, fetch: sts.fetch})();
  assert.deepEqual([irsa.accessKeyId, irsa.sessionToken], ['ASIA2', 't2']);

  let fetched = 0;
  const imds = fakeS3({
    'PUT 169.254.169.254/latest/api/token': () => new Response('imds-token'),
    'GET 169.254.169.254/latest/meta-data/iam/security-credentials/': () => new Response('opencrawl-role\n'),
    'GET 169.254.169.254/latest/meta-data/iam/security-credentials/opencrawl-role': () => (fetched++, Response.json({...role, Expiration: new Date(Date.now() + 60_000).toISOString()})),
  });
  const instance = awsCredentials({env: {}, fetch: imds.fetch});
  assert.equal((await instance()).accessKeyId, 'ASIA');
  assert.equal(imds.calls[1].headers['X-aws-ec2-metadata-token'], 'imds-token');
  await instance();
  assert.equal(fetched, 2, 'credentials within five minutes of expiry are refreshed');

  const none = fakeS3({'PUT 169.254.169.254/latest/api/token': () => { throw new Error('no route'); }});
  await assert.rejects(awsCredentials({env: {}, fetch: none.fetch})(), /No S3 credentials/);
});

test('uploads append-only transcripts incrementally, holding back partial lines', async t => {
  const {store, url, close} = await startReceiver();
  t.after(close);
  const dir = await mkdtemp(join(tmpdir(), 'oc-sessions-'));
  const path = join(dir, 's1.jsonl');
  const client = createReceiverClient({url, machine: 'laptop'});
  const file = {agent: 'codex', session: 'proj/s1', path, format: 'jsonl'};
  const state = {files: {}};
  const session = 'agent-sessions/codex/laptop/proj/s1/';

  await writeFile(path, line(1) + line(2) + '{"partial":');
  assert.equal(await syncFile(client, file, state), line(1).length + line(2).length);
  assert.equal(await syncFile(client, file, state), 0, 'unchanged file is skipped');

  await appendFile(path, 'true}\n' + line(3));
  await syncFile(client, file, state);
  assert.deepEqual(reassemble(store, session), await readFile(path));

  const manifest = JSON.parse(store.objects.get(`${session}manifest.json`));
  assert.equal(manifest.length, (await readFile(path)).length);
  assert.equal(manifest.segments, 2);
  assert.equal(manifest.source.path, path);
});

test('heals from a lost local cache without re-uploading, and replaces rewritten files', async t => {
  const {store, url, close} = await startReceiver();
  t.after(close);
  const dir = await mkdtemp(join(tmpdir(), 'oc-sessions-'));
  const path = join(dir, 's.jsonl');
  const client = createReceiverClient({url, machine: 'laptop'});
  const file = {agent: 'claude-code', session: 's', path, format: 'jsonl'};
  const session = 'agent-sessions/claude-code/laptop/s/';

  const first = {files: {}};
  await writeFile(path, line(1) + line(2));
  await syncFile(client, file, first);
  await appendFile(path, line(3));
  // Fresh cache, as after a reinstall: resumes from the receiver's length.
  assert.equal(await syncFile(client, file, {files: {}}), line(3).length);

  // The first cache is now stale. The receiver's 409 moves it forward; only new bytes are sent.
  await appendFile(path, line(4));
  assert.equal(await syncFile(client, file, first), line(4).length);
  assert.deepEqual(reassemble(store, session), await readFile(path));

  // Rewritten rather than appended: the session is replaced.
  await writeFile(path, line(9));
  await syncFile(client, file, first);
  assert.deepEqual(reassemble(store, session), await readFile(path));
  assert.equal(JSON.parse(store.objects.get(`${session}manifest.json`)).generation, 2);
});

test('rejects gaps and malformed segments', async t => {
  const {url, close} = await startReceiver();
  t.after(close);
  const client = createReceiverClient({url, machine: 'laptop'});
  assert.deepEqual(await client.upload({agent: 'codex', session: 's', offset: 10, raw: Buffer.from(line(1)), format: 'jsonl'}), {conflict: 0});
  await assert.rejects(client.upload({agent: 'codex', session: 's', offset: 0, raw: Buffer.from('no newline'), format: 'jsonl'}), /must end with a newline/);
  await assert.rejects(client.upload({agent: 'Bad Agent', session: 's', offset: 0, raw: Buffer.from('{}'), format: 'json'}), /400/);
  const traversal = await fetch(`${url}/v1/sessions/codex/laptop/..%2Fetc/x`, {method: 'PUT', body: ''});
  assert.equal(traversal.status, 400);
});

test('requires the bearer token when one is configured', async t => {
  const {url, close} = await startReceiver({token: 'secret'});
  t.after(close);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/install.sh`)).status, 200);
  assert.equal((await fetch(`${url}/v1/sessions/codex/m/s`)).status, 401);
  assert.equal((await fetch(`${url}/v1/sessions/codex/m/s`, {headers: {Authorization: 'Bearer secret'}})).status, 404);
});

test('refuses browsers and DNS rebinding', async t => {
  const {url, close} = await startReceiver({publicUrl: 'https://sessions.example.com'});
  t.after(close);
  const call = headers => fetch(`${url}/mcp`, {method: 'POST', headers: {'Content-Type': 'text/plain', ...headers}, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}'});
  assert.equal((await call({})).status, 200);
  assert.equal((await call({Origin: 'https://evil.example'})).status, 403);
  assert.equal((await call({Origin: 'null'})).status, 403);
  assert.equal((await call({Origin: 'https://sessions.example.com'})).status, 200);
  // A rebound DNS name reaches loopback with the attacker's Host header.
  const rebound = await new Promise(resolve => {
    const {port} = new URL(url);
    request({port, path: '/v1/sessions/codex/m/s', headers: {Host: 'evil.example'}}, resolve).end();
  });
  assert.equal(rebound.statusCode, 403);
});

test('serves MCP tools that save conversations from chat apps', async t => {
  const {store, url, close} = await startReceiver();
  t.after(close);
  const client = createReceiverClient({url, machine: 'laptop'});
  const rpc = async (method, params, id = 1) => JSON.parse(await client.mcp(JSON.stringify({jsonrpc: '2.0', id, method, params})));

  const init = await rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}});
  assert.equal(init.result.serverInfo.name, 'opencrawl-agent-sessions');
  assert.equal(await client.mcp(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})), null);
  assert.deepEqual((await rpc('tools/list')).result.tools.map(t => t.name), ['save_conversation', 'capture_status']);

  const saved = await rpc('tools/call', {name: 'save_conversation', arguments: {
    app: 'Claude Desktop', conversation_id: 'c-1', title: 'Plan', messages: [{role: 'user', content: 'hi'}, {role: 'assistant', content: 'hello'}],
  }});
  assert.match(saved.result.content[0].text, /Saved 2 messages as conversation_id c-1/);
  const stored = JSON.parse(reassemble(store, 'agent-sessions/claude-desktop/mcp/c-1/'));
  assert.equal(stored.messages[1].content, 'hello');

  const status = await rpc('tools/call', {name: 'capture_status', arguments: {}});
  assert.deepEqual(JSON.parse(status.result.content[0].text), {'claude-desktop': {mcp: 1}});
  assert.equal((await rpc('nope')).error.code, -32601);
});

test('discovers Claude Code, Codex and Gemini CLI transcripts, including extra accounts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oc-home-'));
  const files = {
    '.claude/projects/-Users-me-app/0b1c.jsonl': 'claude-code',
    '.claude/projects/-Users-me-app/0b1c/subagents/agent-a1.jsonl': 'claude-code',
    '.claude/projects/-Users-me-app/0b1c/tool-results/out.txt': null,
    '.codex/sessions/2026/10/14/rollout-2026-10-14T01-09-32-abc.jsonl': 'codex',
    '.codex/archived_sessions/rollout-2026-09-01T00-00-00-def.jsonl': 'codex',
    '.gemini/tmp/9f2e/chats/session-2026-10-01T10-00-ab12.json': 'gemini-cli',
    '.gemini/tmp/9f2e/logs.json': null,
    // Paradev-style second accounts, and a copied config directory that repeats a session.
    '.claude-work/projects/-Users-me-paradev-worktrees-app-ws1/7e2f.jsonl': 'claude-code',
    '.codex-personal/sessions/2026/11/01/rollout-2026-11-01T09-00-00-aaa.jsonl': 'codex',
    '.claude-zbackup/projects/-Users-me-app/0b1c.jsonl': 'claude-code',
  };
  for (const rel of Object.keys(files)) {
    await mkdir(join(home, rel, '..'), {recursive: true});
    await writeFile(join(home, rel), '{}\n');
  }
  const found = await discover({env: {HOME: home}});
  assert.deepEqual(found.map(f => [f.agent, f.session, f.format]).sort(), [
    ['claude-code', '-Users-me-app/0b1c', 'jsonl'],
    ['claude-code', '-Users-me-app/0b1c/subagents/agent-a1', 'jsonl'],
    ['claude-code', '-Users-me-paradev-worktrees-app-ws1/7e2f', 'jsonl'],
    ['codex', 'rollout-2026-09-01T00-00-00-def', 'jsonl'],
    ['codex', 'rollout-2026-10-14T01-09-32-abc', 'jsonl'],
    ['codex', 'rollout-2026-11-01T09-00-00-aaa', 'jsonl'],
    ['gemini-cli', '9f2e/chats/session-2026-10-01T10-00-ab12', 'json'],
  ]);
  assert.equal(found.find(f => f.session === '-Users-me-app/0b1c').path, join(home, '.claude/projects/-Users-me-app/0b1c.jsonl'));
  assert.equal((await discover({env: {HOME: home}, exclude: ['-Users-me-app']})).length, 5);
});

test('splits ChatGPT and Claude.ai exports into conversations', () => {
  const chatgpt = splitExport([{id: 'g1', conversation_id: 'g1', title: 'A', mapping: {}}]);
  assert.deepEqual(chatgpt.map(c => [c.agent, c.session, c.title]), [['chatgpt', 'g1', 'A']]);
  const claude = splitExport([{uuid: 'u1', name: 'B', chat_messages: []}]);
  assert.deepEqual(claude.map(c => [c.agent, c.session]), [['claude-ai', 'u1']]);
  assert.throws(() => splitExport([{foo: 1}]), /Unrecognized export/);
});

test('agent session tooling stays dependency-free and outside the core package', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(!pkg.files.some(f => f.startsWith('integrations')));
  const dir = new URL('../integrations/agent-sessions/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.mjs'))) {
    const source = await readFile(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)/g)) {
      assert.ok(match[1].startsWith('node:') || /^\.\/[^/]+$/.test(match[1]), `Forbidden dependency in ${file}: ${match[1]}`);
    }
  }
  // The receiver serves collector.mjs on its own for one-line installs.
  assert.doesNotMatch(await readFile(new URL('collector.mjs', dir), 'utf8'), /from '\.\//);
});
