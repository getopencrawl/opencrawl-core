import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAirbyteTransport} from '../dist/src/integrations/airbyte.mjs';

test('delayed 401 responses share the replacement for the token they rejected', async t => {
  const gates = Array.from({length: 10}, () => Promise.withResolvers()), started = Promise.withResolvers();
  let tokenRequests = 0, rejectedRequests = 0, retries = 0;
  const client = createAirbyteTransport({url: 'https://airbyte.example.test', clientId: 'fixture', clientSecret: 'fixture', fetch: async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/applications/token')) return Response.json({access_token: 'fixture-' + (++tokenRequests), expires_in: 900});
    if (url.pathname.endsWith('/prime')) return Response.json({ok: true});
    if (options.headers.Authorization === 'Bearer fixture-1') {
      const index = Number(url.pathname.split('/').at(-1));
      if (++rejectedRequests === gates.length) started.resolve();
      await gates[index].promise;
      return new Response('', {status: 401});
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

test('failed token refresh does not poison later attempts or another client', async () => {
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
