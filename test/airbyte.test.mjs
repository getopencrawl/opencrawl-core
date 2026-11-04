import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createAirbyteClient, applyOAuthPayload, oAuthInputConfiguration } from '../integrations/airbyte/client.mjs';

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const {pathname, search} = new URL(url);
    const method = init.method || 'GET';
    calls.push({method, pathname, search, headers: init.headers || {}, body: init.body && JSON.parse(init.body)});
    const route = routes[`${method} ${pathname}`];
    if (!route) return new Response(JSON.stringify({detail: 'not found'}), {status: 404});
    const [status, body] = route(calls.at(-1));
    return new Response(body === undefined ? '' : JSON.stringify(body), {status});
  };
  return {fetch, calls};
}

const token = () => [200, {access_token: 'tok', token_type: 'Bearer', expires_in: 900}];

test('exchanges application credentials once and reuses the token', async () => {
  const {fetch, calls} = fakeFetch({
    'POST /api/public/v1/applications/token': token,
    'GET /api/public/v1/workspaces': () => [200, {data: [{workspaceId: 'w1'}]}],
  });
  const airbyte = createAirbyteClient({url: 'http://airbyte.test/', clientId: 'id', clientSecret: 'secret', fetch});
  await airbyte.listWorkspaces();
  await airbyte.listWorkspaces();
  assert.equal(calls.filter(c => c.pathname.endsWith('/applications/token')).length, 1);
  assert.deepEqual(calls[0].body, {client_id: 'id', client_secret: 'secret', 'grant-type': 'client_credentials'});
  assert.equal(calls[1].headers.Authorization, 'Bearer tok');
});

test('reports Airbyte errors with status and detail', async () => {
  const {fetch} = fakeFetch({
    'POST /api/public/v1/applications/token': token,
    'POST /api/public/v1/sources': () => [422, {detail: 'The body of the request was not understood'}],
  });
  const airbyte = createAirbyteClient({url: 'http://airbyte.test', clientId: 'id', clientSecret: 'secret', fetch});
  await assert.rejects(airbyte.createSource({workspaceId: 'w1', name: 'x', configuration: {}}), error => {
    assert.equal(error.status, 422);
    assert.match(error.message, /POST \/sources failed with 422: The body of the request was not understood/);
    return true;
  });
});

test('source OAuth uses the config API, which works on self-managed Community', async () => {
  const {fetch, calls} = fakeFetch({
    'POST /api/public/v1/applications/token': token,
    'POST /api/v1/source_oauths/oauth_params/create': () => [200],
    'POST /api/v1/source_oauths/get_consent_url': () => [200, {consentUrl: 'https://provider.test/auth'}],
  });
  const airbyte = createAirbyteClient({url: 'http://airbyte.test', clientId: 'id', clientSecret: 'secret', fetch});
  assert.equal(await airbyte.setSourceOAuthApp('w1', 'd1', {client_id: 'a', client_secret: 'b'}), null);
  const {consentUrl} = await airbyte.getSourceConsentUrl({workspaceId: 'w1', sourceDefinitionId: 'd1', redirectUrl: 'http://127.0.0.1:8765/callback'});
  assert.equal(consentUrl, 'https://provider.test/auth');
  // Airbyte 2.4 fails with a 500 when oAuthInputConfiguration is missing.
  assert.deepEqual(calls.at(-1).body.oAuthInputConfiguration, {});
});

test('sync scopes list queries and posts a sync job', async () => {
  const {fetch, calls} = fakeFetch({
    'POST /api/public/v1/applications/token': token,
    'GET /api/public/v1/connections': () => [200, {data: []}],
    'POST /api/public/v1/jobs': () => [200, {jobId: 7, status: 'pending'}],
  });
  const airbyte = createAirbyteClient({url: 'http://airbyte.test', clientId: 'id', clientSecret: 'secret', fetch});
  await airbyte.listConnections({workspaceIds: ['w1', 'w2'], limit: 5});
  assert.equal(decodeURIComponent(calls.at(-1).search), '?workspaceIds=w1,w2&limit=5');
  assert.deepEqual(await airbyte.sync('c1'), {jobId: 7, status: 'pending'});
  assert.deepEqual(calls.at(-1).body, {connectionId: 'c1', jobType: 'sync'});
});

// Shape of source-google-drive's advancedAuth as served by Airbyte 2.4.
const driveSpec = {
  advancedAuth: {
    authFlowType: 'oauth2.0',
    predicateKey: ['credentials', 'auth_type'],
    predicateValue: 'Client',
    oauthConfigSpecification: {
      completeOAuthOutputSpecification: {properties: {
        refresh_token: {type: 'string', path_in_oauth_response: ['refresh_token'], path_in_connector_config: ['credentials', 'refresh_token']},
      }},
      completeOAuthServerInputSpecification: {properties: {client_id: {type: 'string'}, client_secret: {type: 'string'}}},
      completeOAuthServerOutputSpecification: {properties: {
        client_id: {type: 'string', path_in_connector_config: ['credentials', 'client_id']},
        client_secret: {type: 'string', path_in_connector_config: ['credentials', 'client_secret']},
      }},
    },
  },
};

test('places OAuth results where the connector expects them', () => {
  const configuration = {folder_url: 'https://drive.google.com/drive/folders/abc'};
  const result = applyOAuthPayload(driveSpec, configuration, {refresh_token: 'r', client_id: 'a', client_secret: 'b', ignored: 'x'});
  assert.deepEqual(result, {
    folder_url: 'https://drive.google.com/drive/folders/abc',
    credentials: {auth_type: 'Client', refresh_token: 'r', client_id: 'a', client_secret: 'b'},
  });
  assert.deepEqual(configuration, {folder_url: 'https://drive.google.com/drive/folders/abc'});
});

test('reads pre-consent OAuth input from configuration', () => {
  const spec = {advancedAuth: {oauthConfigSpecification: {oauthUserInputFromConnectorConfigSpecification: {properties: {
    shop: {type: 'string', path_in_connector_config: ['shop']},
  }}}}};
  assert.deepEqual(oAuthInputConfiguration(spec, {shop: 'acme'}), {shop: 'acme'});
  assert.deepEqual(oAuthInputConfiguration(driveSpec, {}), {});
});

test('integrations stay dependency-free and outside the core package', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(!pkg.files.includes('integrations'));
  const dir = new URL('../integrations/airbyte/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.mjs'))) {
    const source = await readFile(new URL(file, dir), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\()['"]([^'"]+)/g)) {
      assert.ok(match[1].startsWith('node:') || /^\.\/[^/]+$/.test(match[1]), `Forbidden dependency in ${file}: ${match[1]}`);
    }
  }
});
