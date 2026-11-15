import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {createAirbyteTransport} from '../dist/src/integrations/airbyte.mjs';

test('delayed 401 responses share the replacement for the token they rejected', async t => {
  const gates = Array.from({length: 10}, () => Promise.withResolvers()), started = Promise.withResolvers();
  let tokenRequests = 0, rejectedRequests = 0, retries = 0, cancelled = 0;
  const client = createAirbyteTransport({url: 'https://airbyte.example.test', clientId: 'fixture', clientSecret: 'fixture', fetch: async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/applications/token')) return Response.json({access_token: 'fixture-' + (++tokenRequests), expires_in: 900});
    if (url.pathname.endsWith('/prime')) return Response.json({ok: true});
    if (options.headers.Authorization === 'Bearer fixture-1') {
      const index = Number(url.pathname.split('/').at(-1));
      if (++rejectedRequests === gates.length) started.resolve();
      await gates[index].promise;
      return new Response(new ReadableStream({cancel() {cancelled++;}}), {status: 401});
    }
    retries++; return Response.json({ok: true});
  }});
  await client.request('GET', '/prime');
  const pending = gates.map((_, i) => client.request('GET', '/fixtures/' + i));
  try {
    await started.promise;
    // Each old response arrives after the preceding replacement has completed.
    // Pending-token single-flight alone cannot prevent this refresh storm.
    for (const [i, gate] of gates.entries()) {gate.resolve(); assert.deepEqual(await pending[i], {ok: true});}
  } finally {for (const gate of gates) gate.resolve(); await Promise.allSettled(pending);}
  t.diagnostic(JSON.stringify({staggered401s: rejectedRequests, tokenRequests, successfulRetries: retries}));
  assert.equal(retries, 10);
  assert.equal(tokenRequests, 2, 'one initial token and one replacement serve the entire rejected generation');
  assert.equal(cancelled, 10, 'replaced responses release their unread network bodies');
});

test('a rejected current replacement still refreshes, with only one retry per API request', async () => {
  let tokenRequests = 0, requests = 0, rejectReplacement = false;
  const client = createAirbyteTransport({url: 'https://airbyte.example.test', clientId: 'fixture', clientSecret: 'fixture', fetch: async (input, options) => {
    if (new URL(input).pathname.endsWith('/applications/token')) return Response.json({access_token: 'fixture-' + (++tokenRequests)});
    requests++;
    return new Response('', {status: rejectReplacement || options.headers.Authorization === 'Bearer fixture-1' ? 401 : 200});
  }});
  await client.request('GET', '/fixtures');
  assert.equal(tokenRequests, 2); assert.equal(requests, 2);
  rejectReplacement = true;
  await assert.rejects(client.request('GET', '/fixtures'), error => error.status === 401);
  assert.equal(tokenRequests, 3); assert.equal(requests, 4);
});

test('failed token acquisition does not poison later attempts or another client', async () => {
  let tokenRequests = 0, fail = true;
  const fetch = async input => {
    if (!new URL(input).pathname.endsWith('/applications/token')) return Response.json({ok: true});
    tokenRequests++;
    return fail ? new Response('', {status: 503}) : Response.json({access_token: 'fixture'});
  };
  const options = {url: 'https://airbyte.example.test', clientId: 'fixture', clientSecret: 'fixture', fetch};
  const first = createAirbyteTransport(options), second = createAirbyteTransport(options);
  await assert.rejects(first.request('GET', '/fixtures'), /token request failed/);
  fail = false;
  await first.request('GET', '/fixtures'); await second.request('GET', '/fixtures');
  assert.equal(tokenRequests, 3, 'client credentials never share token state across transport instances');
});

test('a delayed old 401 cannot reuse an expired replacement token', async () => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  let tokenRequests = 0;
  const client = createAirbyteTransport({url: 'https://airbyte.example.test', clientId: 'fixture', clientSecret: 'fixture', fetch: async (input, options) => {
    const path = new URL(input).pathname;
    if (path.endsWith('/applications/token')) {
      tokenRequests++;
      return Response.json({access_token: 'fixture-' + tokenRequests, expires_in: tokenRequests === 2 ? 1 : 900});
    }
    if (path.endsWith('/prime')) return Response.json({ok: true});
    if (options.headers.Authorization === 'Bearer fixture-1') {
      if (path.endsWith('/delayed')) {started.resolve(); await gate.promise;}
      return new Response('', {status: 401});
    }
    return Response.json({ok: true});
  }});
  await client.request('GET', '/prime');
  const pending = client.request('GET', '/delayed');
  try {await started.promise; await client.request('GET', '/first');}
  finally {gate.resolve();}
  assert.deepEqual(await pending, {ok: true});
  assert.equal(tokenRequests, 3);
});

test('a failed refresh can recover on a later API request without retrying writes repeatedly', async () => {
  let tokens = 0, requests = 0;
  const client = createAirbyteTransport({url: 'https://airbyte.example.test', clientId: 'fixture', clientSecret: 'fixture', fetch: async (input, options) => {
    if (new URL(input).pathname.endsWith('/applications/token')) {
      tokens++;
      return tokens === 2 ? new Response('', {status: 503}) : Response.json({access_token: 'fixture-' + tokens});
    }
    requests++;
    assert.equal(options.method, 'POST'); assert.equal(options.body, '{"name":"fixture"}');
    return options.headers.Authorization === 'Bearer fixture-1' ? new Response('', {status: 401}) : Response.json({ok: true});
  }});
  await assert.rejects(client.request('POST', '/fixtures', {name: 'fixture'}), /token request failed/);
  assert.deepEqual(await client.request('POST', '/fixtures', {name: 'fixture'}), {ok: true});
  assert.equal(tokens, 3); assert.equal(requests, 2, 'a later request does not resend the token already rejected');
});

test('a delayed old 401 waits when the replacement itself is already being refreshed', async () => {
  const oldGate = Promise.withResolvers(), oldStarted = Promise.withResolvers(), oldCancelled = Promise.withResolvers();
  const refreshGate = Promise.withResolvers(), refreshStarted = Promise.withResolvers();
  let tokens = 0, staleRetries = 0;
  const client = createAirbyteTransport({url: 'https://airbyte.example.test', clientId: 'fixture', clientSecret: 'fixture', fetch: async (input, options) => {
    const path = new URL(input).pathname, bearer = options.headers.Authorization;
    if (path.endsWith('/applications/token')) {
      const generation = ++tokens;
      if (generation === 3) {refreshStarted.resolve(); await refreshGate.promise;}
      return Response.json({access_token: 'fixture-' + generation});
    }
    if (path.endsWith('/prime')) return Response.json({ok: true});
    if (path.endsWith('/delayed') && bearer === 'Bearer fixture-1') {
      oldStarted.resolve(); await oldGate.promise;
      return new Response(new ReadableStream({cancel() {oldCancelled.resolve();}}), {status: 401});
    }
    if (bearer === 'Bearer fixture-1' || path.endsWith('/current') && bearer === 'Bearer fixture-2') return new Response('', {status: 401});
    if (path.endsWith('/delayed') && bearer === 'Bearer fixture-2') {staleRetries++; return new Response('', {status: 401});}
    return Response.json({ok: true});
  }});
  await client.request('GET', '/prime');
  const delayed = client.request('GET', '/delayed'); delayed.catch(() => {});
  await oldStarted.promise;
  await client.request('GET', '/replace');
  const current = client.request('GET', '/current'); current.catch(() => {});
  try {
    await refreshStarted.promise; oldGate.resolve(); await oldCancelled.promise;
    await setImmediate();
    assert.equal(staleRetries, 0, 'a rejected replacement is not reused while its successor is pending');
  } finally {oldGate.resolve(); refreshGate.resolve();}
  assert.deepEqual(await delayed, {ok: true}); assert.deepEqual(await current, {ok: true});
  assert.equal(tokens, 3);
});
