import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {SkillsClient} from '@modelcontextprotocol/client/ext/skills';
import {createOpenCrawlMcp} from '../src/mcp/server.mjs';
import {standaloneMcp} from '../src/mcp/standalone.mjs';

test('MCP serves a verified skill and exactly one tool through real SDK clients', async t => {
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createOpenCrawlMcp({origin, revision: 'test-revision', authenticate: async req => req.headers.authorization === 'Bearer local-secret' ? {userId: 'local'} : null});
  t.after(async () => {await handler.close(); await new Promise(resolve => server.close(resolve));});
  for (const mode of ['legacy', 'auto']) {
    const client = new Client({name: 'core-test', version: '1'}, {versionNegotiation: {mode}});
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {requestInit: {headers: {authorization: 'Bearer local-secret'}}}));
    try {
      assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['test_connection']);
      const result = await client.callTool({name: 'test_connection', arguments: {}});
      assert.equal(result.structuredContent.connected, true);
      assert.equal(result.structuredContent.revision, 'test-revision');
      assert.ok(Date.now() - Date.parse(result.structuredContent.serverTime) < 5000);
      const skills = new SkillsClient(client);
      const entries = (await skills.list()).skills;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].uri, 'skill://opencrawl/SKILL.md');
      const file = await skills.read(entries[0]);
      assert.equal(file.verified, true);
      assert.equal(file.frontmatter.name, 'opencrawl');
      assert.match(file.text, /does not\nexpose captured sessions/);
      assert.equal((await client.callTool({name: 'test_connection', arguments: {url: 'https://untrusted.test'}})).isError, true);
      await assert.rejects(client.readResource({uri: 'skill://opencrawl/../../package.json'}));
    } finally {await client.close();}
  }
  assert.equal((await fetch(origin + '/mcp')).status, 401);
  assert.equal((await fetch(origin + '/mcp', {headers: {origin: 'https://evil.test', authorization: 'Bearer local-secret'}})).status, 403);
  const post = body => fetch(origin + '/mcp', {method: 'POST', headers: {authorization: 'Bearer local-secret', 'content-type': 'application/json', accept: 'application/json, text/event-stream'}, body});
  assert.equal((await post('x'.repeat(65537))).status, 413);
  assert.equal((await post('{')).status, 400);
});

test('standalone adapter requires a secret and rejects anonymous and forged hosts', async t => {
  assert.throws(() => standaloneMcp({origin: 'http://127.0.0.1'}), /MCP_TOKEN/);
  const server = standaloneMcp({token: 'a'.repeat(32), origin: 'http://127.0.0.1:8093'});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  assert.equal((await fetch(url)).status, 403);
  const status = headers => new Promise((resolve, reject) => {
    const req = request(url, {headers}, res => {res.resume();resolve(res.statusCode);});req.on('error', reject);req.end();
  });
  assert.equal(await status({host: '127.0.0.1:8093'}), 401);
  assert.equal(await status({host: '127.0.0.1:8093', authorization: 'Bearer ' + 'a'.repeat(32)}), 405);
});
