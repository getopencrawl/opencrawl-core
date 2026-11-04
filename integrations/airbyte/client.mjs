/**
 * Minimal client for the Airbyte public API (self-managed or Cloud).
 * Zero dependencies: uses global fetch. Credentials come from the caller.
 *
 *   const airbyte = createAirbyteClient({url, clientId, clientSecret});
 *   await airbyte.listWorkspaces();
 */
export function createAirbyteClient({url, clientId, clientSecret, fetch: fetchImpl = globalThis.fetch}) {
  if (!url) throw new Error('Airbyte url is required');
  if (!clientId || !clientSecret) throw new Error('Airbyte clientId and clientSecret are required');
  const base = url.replace(/\/+$/, '');
  const api = `${base}/api/public/v1`;
  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    // Refresh a minute early; tokens last 15 minutes on self-managed 2.x.
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const res = await fetchImpl(`${api}/applications/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({client_id: clientId, client_secret: clientSecret, 'grant-type': 'client_credentials'}),
    });
    if (!res.ok) throw await airbyteError(res, 'POST /applications/token');
    const body = await res.json();
    token = body.access_token;
    tokenExpiresAt = Date.now() + (body.expires_in || 900) * 1000;
    return token;
  }

  async function request(method, path, body, root = api) {
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await airbyteError(res, `${method} ${path}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const config = (path, body) => request('POST', path, body, `${base}/api/v1`);

  const query = params => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      search.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  return {
    request,
    health: async () => (await fetchImpl(`${api}/health`)).ok,

    listWorkspaces: () => request('GET', '/workspaces'),
    listSourceDefinitions: workspaceId => request('GET', `/workspaces/${workspaceId}/definitions/sources`),
    listDestinationDefinitions: workspaceId => request('GET', `/workspaces/${workspaceId}/definitions/destinations`),

    // Source OAuth. The public API's /sources/initiateOAuth and /workspaces/{id}/oauthCredentials
    // return 501 on self-managed Community, so these use the config API that the Airbyte UI uses.
    getSourceSpec: (workspaceId, sourceDefinitionId) =>
      config('/source_definition_specifications/get', {workspaceId, sourceDefinitionId}),
    /** Upserts the workspace's own OAuth app (e.g. {client_id, client_secret}) for a source definition. */
    setSourceOAuthApp: (workspaceId, sourceDefinitionId, params) =>
      config('/source_oauths/oauth_params/create', {workspaceId, sourceDefinitionId, params}),
    /** Returns {consentUrl}. The provider redirects to redirectUrl with ?code=...&state=... */
    getSourceConsentUrl: ({workspaceId, sourceDefinitionId, redirectUrl, oAuthInputConfiguration = {}}) =>
      config('/source_oauths/get_consent_url', {workspaceId, sourceDefinitionId, redirectUrl, oAuthInputConfiguration}),
    /** Returns {request_succeeded, request_error, auth_payload}; pass auth_payload to applyOAuthPayload. */
    completeSourceOAuth: ({workspaceId, sourceDefinitionId, redirectUrl, queryParams, oAuthInputConfiguration = {}}) =>
      config('/source_oauths/complete_oauth', {workspaceId, sourceDefinitionId, redirectUrl, queryParams, oAuthInputConfiguration}),

    listSources: ({workspaceIds, limit, offset} = {}) => request('GET', `/sources${query({workspaceIds, limit, offset})}`),
    getSource: sourceId => request('GET', `/sources/${sourceId}`),
    /** configuration must include sourceType, or pass definitionId. Pass secretId after an OAuth redirect. */
    createSource: ({workspaceId, name, configuration, definitionId, secretId}) =>
      request('POST', '/sources', {workspaceId, name, configuration, definitionId, secretId}),
    deleteSource: sourceId => request('DELETE', `/sources/${sourceId}`),

    listDestinations: ({workspaceIds, limit, offset} = {}) => request('GET', `/destinations${query({workspaceIds, limit, offset})}`),
    createDestination: ({workspaceId, name, configuration, definitionId}) =>
      request('POST', '/destinations', {workspaceId, name, configuration, definitionId}),
    deleteDestination: destinationId => request('DELETE', `/destinations/${destinationId}`),

    getStreams: ({sourceId, destinationId}) => request('GET', `/streams${query({sourceId, destinationId})}`),
    listConnections: ({workspaceIds, limit, offset} = {}) => request('GET', `/connections${query({workspaceIds, limit, offset})}`),
    createConnection: connection => request('POST', '/connections', connection),
    deleteConnection: connectionId => request('DELETE', `/connections/${connectionId}`),

    sync: connectionId => request('POST', '/jobs', {connectionId, jobType: 'sync'}),
    getJob: jobId => request('GET', `/jobs/${jobId}`),
    listJobs: ({connectionId, limit, offset} = {}) => request('GET', `/jobs${query({connectionId, limit, offset})}`),
  };
}

/** Values a connector needs before consent, e.g. a Shopify shop name, read from its configuration. */
export function oAuthInputConfiguration(spec, configuration) {
  const input = {};
  for (const [key, path] of oAuthPaths(spec, 'oauthUserInputFromConnectorConfigSpecification')) {
    const value = getPath(configuration, path);
    if (value !== undefined) input[key] = value;
  }
  return input;
}

/** Places a complete_oauth payload into connector configuration, as the Airbyte UI does. */
export function applyOAuthPayload(spec, configuration, authPayload) {
  const result = structuredClone(configuration || {});
  const auth = spec?.advancedAuth;
  if (auth?.predicateKey?.length && auth.predicateValue !== undefined) setPath(result, auth.predicateKey, auth.predicateValue);
  for (const name of ['completeOAuthServerOutputSpecification', 'completeOAuthOutputSpecification']) {
    for (const [key, path] of oAuthPaths(spec, name)) {
      if (authPayload?.[key] !== undefined) setPath(result, path, authPayload[key]);
    }
  }
  return result;
}

/** [[key, path_in_connector_config], ...] for one of a spec's advancedAuth.oauthConfigSpecification entries. */
export function oAuthPaths(spec, name) {
  const properties = spec?.advancedAuth?.oauthConfigSpecification?.[name]?.properties || {};
  return Object.entries(properties)
    .filter(([, property]) => Array.isArray(property.path_in_connector_config))
    .map(([key, property]) => [key, property.path_in_connector_config]);
}

function getPath(object, path) {
  return path.reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function setPath(object, path, value) {
  let target = object;
  for (const key of path.slice(0, -1)) {
    if (target[key] === null || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[path.at(-1)] = value;
}

async function airbyteError(res, operation) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      detail = json.detail || json.message || json.title || body;
    } catch {
      detail = body;
    }
  } catch {}
  const error = new Error(`Airbyte ${operation} failed with ${res.status}${detail ? `: ${String(detail).slice(0, 500)}` : ''}`);
  error.status = res.status;
  return error;
}
