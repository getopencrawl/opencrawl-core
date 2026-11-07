import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createPreviewServer} from '../tools/frontend-preview.mjs';

async function preview(t, options) {
  const server = createPreviewServer({publicOrigin: null, ...options});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const raw = (path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = request(origin, {path, method: body === undefined ? 'GET' : 'POST', headers}, response => {response.resume(); resolve(response.statusCode);});
    req.on('error', reject); req.end(body);
  });
  const browser = () => {
    let cookie;
    return async (path, {method = 'GET', body, headers = {}, ...rest} = {}) => {
      const response = await fetch(origin + path, {method, redirect: 'manual', ...rest, headers: {
        ...(cookie ? {cookie} : {}), ...(method === 'POST' ? {'content-type': 'application/json', origin} : {}), ...headers,
      }, ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})});
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
      return response;
    };
  };
  return {server, origin, browser, raw};
}

test('preview gates every workspace page and data API until all three receipts exist', async t => {
  const {browser} = await preview(t);
  const client = browser();
  for (const scenario of ['fresh', 'cli', 'mcp-only', 'connected', 'verified', 'history-only', 'error']) {
    assert.equal((await client('/__preview/state', {method: 'POST', body: {scenario}})).status, 200);
    for (const page of ['/search', '/integrations', '/usage']) {
      const response = await client(page);
      assert.equal(response.status, 303, `${scenario} ${page}`);
      assert.equal(response.headers.get('location'), '/');
    }
    for (const path of ['/api/integrations', '/api/usage']) assert.equal((await client(path)).status, 403, `${scenario} ${path}`);
    for (const [path, body] of [['/api/search', {query: 'search'}], ['/api/integrations/slack/connect', {}]]) {
      assert.equal((await client(path, {method: 'POST', body})).status, 403, `${scenario} ${path}`);
    }
  }
  assert.equal((await client('/api/onboarding')).status, 503);
  await client('/__preview/state', {method: 'POST', body: {scenario: 'complete'}});
  const completedSetup=await client('/');
  assert.equal(completedSetup.status,200);
  assert.equal(completedSetup.headers.get('location'),null);
  const html=await completedSetup.text();
  assert.match(html,/id="next-step" href="\/integrations"/);
  assert.doesNotMatch(html,/data-screen="ready"/);
  assert.equal((await client('/integrations')).status,200);
  for(const page of ['/search','/usage'])assert.equal((await client(page)).headers.get('location'),'/integrations');
  await client('/api/integrations/googledrive/connect',{method:'POST',body:{}});
  for(const page of ['/search','/integrations','/usage'])assert.equal((await client(page)).status,200);
});

test('demo operations and receipts are isolated per browser and reset by scenario', async t => {
  const {browser} = await preview(t);
  const a = browser(), b = browser();
  const initial = await a('/api/onboarding');
  assert.match(initial.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.deepEqual(await initial.json(), {data: {cli: null, mcp: null, mcpTest: null, session: null}});
  await a('/__preview/state', {method: 'POST', body: {scenario: 'complete'}});
  await a('/api/integrations/slack/connect',{method:'POST',body:{}});
  const result = await (await a('/api/search', {method: 'POST', body: {query: 'search'}})).json();
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].title, /^Demo:/);
  const sample = await (await a('/api/search', {method: 'POST', body: {query: 'What did we decide about onboarding?'}})).json();
  assert.ok(sample.results.some(item => item.title.includes('onboarding')));
  assert.equal((await b('/api/search', {method: 'POST', body: {query: 'search'}})).status, 403);
  assert.equal((await a('/api/search', {method: 'POST', body: {query: ''}})).status, 400);
  const sources = await (await a('/api/integrations')).json();
  assert.deepEqual(sources.items.map(item => item.name), ['Google Drive', 'Slack', 'Granola', 'Circleback', 'Notion', 'GitHub']);
  assert.equal((await a('/api/integrations/gmail/connect',{method:'POST',body:{}})).status,404);
  await a('/api/integrations/slack/connect', {method: 'POST', body: {}});
  assert.deepEqual(await (await a('/api/usage')).json(), {queries: 2, sessions: 1, sources: 1});
  await b('/__preview/state', {method: 'POST', body: {scenario: 'complete'}});
  assert.equal((await b('/api/usage')).status,403);
  assert.ok((await (await b('/api/integrations')).json()).items.every(item => item.state === 'disconnected'));
  await b('/__preview/state', {method: 'POST', body: {scenario: 'fresh'}});
  await a('/api/integrations/slack/disconnect', {method: 'POST', body: {}});
  assert.equal((await a('/api/usage')).status,403);
  await a('/__preview/state', {method: 'POST', body: {scenario: 'fresh'}});
  assert.equal((await a('/api/usage')).status, 403);
  assert.deepEqual((await (await b('/api/onboarding')).json()).data, {cli: null, mcp: null, mcpTest: null, session: null});
});

test('scenario and simulated source writes require same-origin JSON and a valid Host', async t => {
  const {browser, origin, raw} = await preview(t);
  const client = browser();
  for (const headers of [{origin: 'https://evil.example'}, {origin: ''}, {origin, 'sec-fetch-site': 'cross-site'}]) {
    assert.equal((await client('/__preview/state', {method: 'POST', body: {scenario: 'complete'}, headers})).status, 403);
  }
  assert.equal((await client('/__preview/state', {method: 'POST', body: {scenario: 'complete'}, headers: {'content-type': 'text/plain'}})).status, 415);
  assert.equal((await client('/__preview/state', {method: 'POST', body: {scenario: 'bogus'}})).status, 400);
  assert.equal((await client('/__preview/state', {method: 'POST', body: '{'})).status, 400);
  assert.equal((await client('/__preview/state')).status, 405);
  assert.equal(await raw('/api/onboarding', {host: 'evil.example'}), 421);
  assert.equal(await raw('/api/onboarding', {host: '127.0.0.1:1'}), 421);
  await client('/__preview/state', {method: 'POST', body: {scenario: 'complete'}});
  assert.equal((await client('/api/integrations/slack/connect', {method: 'POST', body: {}, headers: {origin: 'https://evil.example'}})).status, 403);
});

test('preview sign-out requires a same-origin POST and clears only its browser fixture', async t => {
  const {browser} = await preview(t);
  const a = browser(), b = browser();
  for (const client of [a,b]){await client('/__preview/state',{method:'POST',body:{scenario:'complete'}});await client('/api/integrations/googledrive/connect',{method:'POST',body:{}});}
  assert.equal((await a('/auth/logout')).status, 405);
  assert.equal((await a('/auth/logout', {method: 'POST', body: '', headers: {'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example'}})).status, 403);
  assert.equal((await a('/api/usage')).status, 200);
  const response = await a('/auth/logout', {method: 'POST', body: '', headers: {'content-type': 'application/x-www-form-urlencoded'}});
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/signed-out');
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.match(await (await a('/signed-out')).text(), /No real account was signed out/);
  assert.equal((await a('/api/usage')).status, 403);
  assert.equal((await b('/api/usage')).status, 200);
});

test('loading fixture delays concurrent status consumers consistently', async t => {
  const {browser} = await preview(t);
  const client = browser();
  await client('/__preview/state', {method: 'POST', body: {scenario: 'loading'}});
  const start = performance.now();
  const results = await Promise.all([0, 1].map(async () => {
    const response = await client('/api/onboarding');
    return {status: response.status, elapsed: performance.now() - start, body: await response.json()};
  }));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.ok(result.elapsed >= 3000, 'both consumers retain the initial loading state');
    assert.equal(result.body.data.cli, null);
  }
});

test('assets permit only explicit files and GET/HEAD, with no path traversal', async t => {
  const {browser, origin} = await preview(t);
  const client = browser();
  assert.equal((await client('/onboarding.css')).status, 200);
  const head = await client('/assets/opencrawl-mark.svg', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await client('/onboarding.css', {method: 'POST', body: {}})).status, 405);
  for (const path of ['/package.json', '/src/onboarding.mjs', '/assets/nope.svg', '/%2e%2e/package.json']) assert.equal((await client(path)).status, 404);
  const rawStatus = await new Promise((resolve, reject) => {
    const req = request(origin, {path: '/assets/../onboarding.css'}, response => {response.resume(); resolve(response.statusCode);});
    req.on('error', reject); req.end();
  });
  assert.equal(rawStatus, 404);
});

test('preview bounds request bodies and browser sessions', async t => {
  const {browser} = await preview(t, {maxSessions: 1, maxBodyBytes: 64});
  const a = browser(), b = browser();
  assert.equal((await a('/api/onboarding')).status, 200);
  assert.equal((await a('/__preview/state', {method: 'POST', body: {scenario: 'fresh', padding: 'x'.repeat(100)}})).status, 413);
  assert.equal((await b('/api/onboarding')).status, 429);
  assert.equal((await a('/api/onboarding')).status, 200);
});


test('explicit HTTPS preview origin works behind the local proxy without trusting forwarded hosts', async t => {
  const publicOrigin = 'https://deepanshus-mac-mini.tailfb40c3.ts.net:8447';
  const {raw, browser} = await preview(t, {publicOrigin});
  const body = JSON.stringify({scenario: 'complete'});
  const headers = {host: new URL(publicOrigin).host, origin: publicOrigin, 'content-type': 'application/json'};
  assert.equal(await raw('/__preview/state', headers, body), 200);
  assert.equal(await raw('/__preview/state', {...headers, origin: 'https://evil.example'}, body), 403);
  assert.equal(await raw('/__preview/state', {...headers, host: 'evil.example', 'x-forwarded-host': headers.host}, body), 421);
  assert.equal((await browser()('/__preview/state', {method: 'POST', body: {scenario: 'complete'}, headers: {origin: publicOrigin}})).status, 200);
});

test('history is optional and can be skipped only after recording is confirmed',async t=>{
 const {browser}=await preview(t),client=browser(),other=browser();
 await client('/__preview/state',{method:'POST',body:{scenario:'history-only'}});
 assert.equal((await client('/api/onboarding/history',{method:'POST',body:{choice:'skip'}})).status,403);
 assert.equal((await client('/search')).status,303);
 await client('/__preview/state',{method:'POST',body:{scenario:'complete'}});
 await client('/api/integrations/googledrive/connect',{method:'POST',body:{}});
 assert.equal((await client('/api/search',{method:'POST',body:{query:'onboarding'}})).status,200);
 assert.equal((await client('/onboarding?variant=panel')).status,200);
 assert.equal((await client('/api/onboarding/history',{method:'POST',body:{choice:'all'}})).status,400);
 const skipped=await client('/api/onboarding/history',{method:'POST',body:{choice:'skip'}});
 assert.equal((await skipped.json()).history.state,'skipped');
 assert.equal((await (await client('/api/onboarding')).json()).data.history.state,'skipped');
 assert.equal((await (await other('/api/onboarding')).json()).data.history,undefined);
 assert.equal((await client('/search')).status,200);
});


test('Sources stays in onboarding and workspace gates require a confirmed source',async t=>{
 const {browser}=await preview(t),client=browser();
 await client('/__preview/state',{method:'POST',body:{scenario:'complete'}});
 const sources=await (await client('/integrations')).text();
 assert.match(sources,/data-onboarding-step="sources"/);
 assert.match(sources,/class="header-account"/);
 assert.doesNotMatch(sources,/aria-label="Workspace"/);
 assert.match(sources,/id="connector-query"/);
 for(const path of ['/api/search','/api/usage'])assert.equal((await client(path,{...(path.endsWith('search')?{method:'POST',body:{query:'test'}}:{})})).status,403);
 assert.equal((await client('/api/integrations/unknown/connect',{method:'POST',body:{}})).status,404);
 assert.equal((await client('/search')).headers.get('location'),'/integrations');
 await client('/api/integrations/googledrive/connect',{method:'POST',body:{}});
 await client('/api/integrations/googledrive/connect',{method:'POST',body:{}});
 assert.equal((await (await client('/api/usage')).json()).sources,1,'Connect retries are idempotent');
 assert.equal((await client('/search')).status,200);
 await client('/api/integrations/googledrive/disconnect',{method:'POST',body:{}});
 assert.equal((await client('/search')).headers.get('location'),'/integrations');
});


test('failed source connection cannot unlock onboarding and can be retried',async t=>{
 const {browser}=await preview(t),client=browser();
 await client('/__preview/state',{method:'POST',body:{scenario:'source-connect-error'}});
 assert.equal((await client('/api/integrations/googledrive/connect',{method:'POST',body:{}})).status,503);
 assert.ok((await (await client('/api/integrations')).json()).items.every(item=>item.state==='disconnected'));
 assert.equal((await client('/search')).headers.get('location'),'/integrations');
 await client('/api/integrations/googledrive/connect',{method:'POST',body:{}});
 assert.equal((await client('/search')).status,200);
});


test('default setup URLs use the approved panel without a variant query',async t=>{
 const {browser}=await preview(t),client=browser();
 for(const scenario of ['fresh','complete']){
  await client('/__preview/state',{method:'POST',body:{scenario}});
  for(const path of ['/','/onboarding','/?variant=panel']){
   const response=await client(path);assert.equal(response.status,200);
   const html=await response.text();
   assert.match(html,/class="onboarding-flow onboarding-flow-panel"/,path);
   assert.match(html,/class="focus-content focus-panel"/,path);
  }
 }
});

test('optional invitations follow Sources and never gate the workspace',async t=>{
 const {browser}=await preview(t),client=browser();
 assert.equal((await client('/onboarding/invite')).headers.get('location'),'/');
 await client('/__preview/state',{method:'POST',body:{scenario:'complete'}});
 assert.equal((await client('/onboarding/invite')).headers.get('location'),'/integrations');
 assert.equal((await client('/api/onboarding/invites',{method:'POST',body:{emails:['alex@example.com']}})).status,403);
 await client('/api/integrations/googledrive/connect',{method:'POST',body:{}});
 const sources=await (await client('/integrations')).text();
 assert.match(sources,/id="next-step" href="\/onboarding\/invite"/);
 const invite=await (await client('/onboarding/invite')).text();
 assert.match(invite,/data-onboarding-step="invite"/);
 assert.match(invite,/class="header-account"/);
 assert.doesNotMatch(invite,/aria-label="Workspace"/);
 assert.match(invite,/Skip for now/);
 assert.equal((await client('/search')).status,200,'Skip is available without sending invitations');
});

test('preview invitations validate atomically, deduplicate and remain browser scoped',async t=>{
 const {browser}=await preview(t),a=browser(),b=browser();
 for(const client of [a,b])await client('/__preview/state',{method:'POST',body:{scenario:'invite'}});
 const invalid=await a('/api/onboarding/invites',{method:'POST',body:{emails:['alex@example.com','invalid']}});
 assert.equal(invalid.status,400);
 assert.deepEqual((await (await a('/api/onboarding/invites')).json()).items,[]);
 const response=await a('/api/onboarding/invites',{method:'POST',body:{emails:['Alex@example.com','alex@example.com','sam@example.com']}});
 const data=await response.json();assert.equal(response.status,200);assert.equal(data.simulated,true);assert.equal(data.addedCount,2);
 assert.deepEqual(data.items.map(item=>item.email),['alex@example.com','sam@example.com']);
 const repeated=await (await a('/api/onboarding/invites',{method:'POST',body:{emails:['alex@example.com']}})).json();
 assert.equal(repeated.addedCount,0);assert.equal(repeated.items.length,2);
 assert.deepEqual((await (await b('/api/onboarding/invites')).json()).items,[]);
 assert.equal((await a('/api/onboarding/invites',{method:'POST',body:{emails:Array.from({length:11},(_,i)=>`user${i}@example.com`)}})).status,400);
 assert.equal((await a('/api/onboarding/invites',{method:'POST',body:{emails:['alex@example.com']},headers:{origin:'https://evil.example'}})).status,403);
});

test('failed invitation sends retain an empty preview and succeed on retry',async t=>{
 const {browser}=await preview(t),client=browser();
 await client('/__preview/state',{method:'POST',body:{scenario:'invite-error'}});
 assert.equal((await client('/api/onboarding/invites',{method:'POST',body:{emails:['alex@example.com']}})).status,503);
 assert.deepEqual((await (await client('/api/onboarding/invites')).json()).items,[]);
 assert.equal((await client('/api/onboarding/invites',{method:'POST',body:{emails:['alex@example.com']}})).status,200);
});
