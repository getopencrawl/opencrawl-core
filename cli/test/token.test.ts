import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createAgentToken, revokeAgentToken, tokenCommand} from '../src/token.ts';
import {saveSession} from '../src/session.ts';
import {redactText, SECRET_MASK} from '../src/capture/redact.ts';

// Synthetic fixtures, never working credentials.
const api = 'https://tokens.example.com', id = 'a'.repeat(64), token = 'oca1_' + 'b'.repeat(64);
const signIn = (origin = api) => saveSession(origin, {auth: {clientId: 'public', deviceAuthorizationEndpoint: `${origin}/device`, tokenEndpoint: `${origin}/token`}, accessToken: 'sign-in-access', refreshToken: 'sign-in-refresh', expiresAt: Date.now() + 300_000});
async function isolated<T>(operation: (directory: string) => Promise<T>) {
  const saved = {...process.env}, directory = mkdtempSync(join(tmpdir(), 'opencrawl-token-'));
  try {
    process.env.OPENCRAWL_CONFIG_HOME = directory;
    delete process.env.OPENCRAWL_TOKEN; delete process.env.OPENCRAWL_API_URL;
    return await operation(directory);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(directory, {recursive: true, force: true});
  }
}
const service = (reply: (request: {method: string; path: string; authorization: string | null}) => Response) => {
  const requests: {method: string; path: string; authorization: string | null}[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = {method: init?.method ?? 'GET', path: new URL(String(input)).pathname, authorization: new Headers(init?.headers).get('authorization')};
    requests.push(request);
    return reply(request);
  }) as unknown as typeof fetch;
  return {requests, fetcher};
};
const issued = () => Response.json({schemaVersion: 1, data: {id, token, expiresAt: '2027-11-12T00:00:00.000Z', access: 'agent',
  environment: {OPENCRAWL_API_URL: 'https://elsewhere.example', OPENCRAWL_TOKEN: 'substituted', OPENCRAWL_SESSIONS_TOKEN: 'substituted'}}});

test('a token is created with the saved sign-in and bound to the server that issued it', () => isolated(async () => {
  await signIn();
  process.env.OPENCRAWL_TOKEN = 'oca1_' + 'c'.repeat(64); process.env.OPENCRAWL_API_URL = api;
  const {requests, fetcher} = service(issued);
  const created = await createAgentToken(api, fetcher);
  // An environment token must never create another token, and the response cannot redirect the variables.
  expect(requests).toEqual([{method: 'POST', path: '/api/agent-tokens', authorization: 'Bearer sign-in-access'}]);
  expect(created).toEqual({id, token, expiresAt: '2027-11-12T00:00:00.000Z', environment: {OPENCRAWL_API_URL: api, OPENCRAWL_TOKEN: token, OPENCRAWL_SESSIONS_TOKEN: token}});
  const printed = await tokenCommand('create', api, undefined, {}, fetcher);
  expect(printed.data).toMatchObject({api, id, token, mcp: {url: api + '/mcp'}});
  expect(printed.human).toContain('OPENCRAWL_TOKEN=' + token);
  expect(printed.human).toContain('opencrawl token revoke ' + id);
}));

test('a machine with only an environment token cannot create or revoke tokens', () => isolated(async () => {
  process.env.OPENCRAWL_TOKEN = token; process.env.OPENCRAWL_API_URL = api;
  const {requests, fetcher} = service(issued);
  await expect(createAgentToken(api, fetcher)).rejects.toMatchObject({code: 'AUTH_REQUIRED', exitCode: 2});
  await expect(revokeAgentToken(api, id, fetcher)).rejects.toMatchObject({code: 'AUTH_REQUIRED'});
  await expect(createAgentToken(api, fetcher)).rejects.toThrow('opencrawl login');
  expect(requests).toEqual([]);
}));

test('deployments without agent tokens, refusals and malformed replies are reported plainly', () => isolated(async () => {
  await signIn();
  for (const [status, code] of [[404, 'AGENT_TOKENS_UNAVAILABLE'], [405, 'AGENT_TOKENS_UNAVAILABLE'], [403, 'AGENT_TOKEN_FORBIDDEN'], [503, 'AGENT_TOKENS_UNAVAILABLE']] as const) {
    const {fetcher} = service(() => Response.json({schemaVersion: 1, error: {code: 'FIXTURE'}}, {status}));
    await expect(createAgentToken(api, fetcher)).rejects.toMatchObject({code});
  }
  await expect(createAgentToken(api, service(() => new Response('Not found', {status: 404})).fetcher)).rejects.toThrow('opencrawl login');
  for (const data of [{id, token: '', expiresAt: '2027-01-01'}, {id: 'short', token, expiresAt: '2027-01-01'}, {id, token, expiresAt: 'never'}, {id, token: 'has spaces and\nnewlines', expiresAt: '2027-01-01'}]) {
    await expect(createAgentToken(api, service(() => Response.json({schemaVersion: 1, data})).fetcher)).rejects.toMatchObject({code: 'INVALID_RESPONSE'});
  }
  // A rejected sign-in is renewed once, then reported; it is never retried in a loop.
  const expired = service(() => Response.json({}, {status: 401}));
  await expect(createAgentToken(api, expired.fetcher)).rejects.toMatchObject({code: 'AUTH_REQUIRED'});
  expect(expired.requests.filter(request => request.path === '/api/agent-tokens').length).toBeLessThanOrEqual(2);
}));

test('--env-file writes a private file and prints no secret', () => isolated(async directory => {
  await signIn();
  const file = join(directory, 'agent.env');
  const {requests, fetcher} = service(request => request.method === 'DELETE' ? Response.json({schemaVersion: 1, data: {id, revoked: true}}) : issued());
  const result = await tokenCommand('create', api, undefined, {'env-file': file}, fetcher);
  expect(JSON.stringify(result)).not.toContain(token);
  expect(result.data).toMatchObject({api, id, envFile: resolve(file), variables: ['OPENCRAWL_API_URL', 'OPENCRAWL_TOKEN', 'OPENCRAWL_SESSIONS_TOKEN']});
  expect(readFileSync(file, 'utf8')).toBe(`OPENCRAWL_API_URL=${api}\nOPENCRAWL_TOKEN=${token}\nOPENCRAWL_SESSIONS_TOKEN=${token}\n`);
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  // An existing file is never replaced, and the token nobody received is revoked.
  writeFileSync(file, 'keep me');
  await expect(tokenCommand('create', api, undefined, {'env-file': file}, fetcher)).rejects.toMatchObject({code: 'TOKEN_FILE_ERROR'});
  expect(readFileSync(file, 'utf8')).toBe('keep me');
  expect(requests.at(-1)).toEqual({method: 'DELETE', path: '/api/agent-tokens/' + id, authorization: 'Bearer sign-in-access'});
}));

test('revoke takes the printed ID and nothing else', () => isolated(async () => {
  await signIn();
  const {requests, fetcher} = service(() => Response.json({schemaVersion: 1, data: {id, revoked: true}}));
  for (const bad of [undefined, '', 'not-an-id', token, id + '/../x']) await expect(revokeAgentToken(api, bad, fetcher)).rejects.toMatchObject({code: 'INVALID_USAGE', exitCode: 64});
  expect(requests).toEqual([]);
  expect(await tokenCommand('revoke', api, id, {}, fetcher)).toMatchObject({data: {api, id, revoked: true}});
  expect(requests).toEqual([{method: 'DELETE', path: '/api/agent-tokens/' + id, authorization: 'Bearer sign-in-access'}]);
  for (const [operation, extra] of [[undefined, undefined], ['list', undefined], ['create', 'extra']] as const) await expect(tokenCommand(operation, api, extra, {}, fetcher)).rejects.toMatchObject({code: 'INVALID_USAGE'});
}));

test('whoami and status accept an environment token on a machine with no saved sign-in', () => isolated(async directory => {
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request) {
    // Ignore anything but the identity route: local port probes must not affect the result.
    if (new URL(request.url).pathname !== '/api/cli/me') return new Response('Not found', {status: 404});
    return request.headers.get('authorization') === 'Bearer ' + token ? Response.json({schemaVersion: 1, data: {user: {id: 'user_agent', email: 'agent@example.com'}}}) : Response.json({schemaVersion: 1, error: {code: 'AUTH_REQUIRED'}}, {status: 401});
  }});
  try {
    const origin = server.url.origin;
    const run = async (args: string[], env: Record<string, string>) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args, '--json'], {env: {...process.env, OPENCRAWL_CONFIG_HOME: directory, OPENCRAWL_NO_UPDATE: '1', ...env}, stdout: 'pipe', stderr: 'pipe'});
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(output).not.toContain(token);
      return {code, body: JSON.parse(output)};
    };
    for (const command of ['whoami', 'status']) {
      const accepted = await run([command], {OPENCRAWL_TOKEN: token, OPENCRAWL_API_URL: origin});
      expect(accepted.code).toBe(0);
      expect(accepted.body.data).toMatchObject({api: origin, authenticated: true, credential: 'environment-token', user: {id: 'user_agent', email: 'agent@example.com'}});
    }
    // A token this service does not accept leaves the saved sign-in to decide, exactly as before.
    const rejected = await run(['whoami'], {OPENCRAWL_TOKEN: 'oca1_' + 'd'.repeat(64), OPENCRAWL_API_URL: origin});
    expect(rejected.code).toBe(2); expect(rejected.body.error.code).toBe('AUTH_REQUIRED');
    const signedOut = await run(['status'], {OPENCRAWL_TOKEN: 'oca1_' + 'd'.repeat(64), OPENCRAWL_API_URL: origin});
    expect(signedOut.code).toBe(0); expect(signedOut.body.data).toMatchObject({authenticated: false});
    // Without a named destination the token is sent nowhere, and whoami reports the missing sign-in as before.
    const unbound = await run(['whoami'], {OPENCRAWL_TOKEN: token});
    expect(unbound.code).toBe(2); expect(unbound.body.error.code).toBe('AUTH_REQUIRED');
    const usage = await run(['token'], {});
    expect(usage.code).toBe(64); expect(usage.body.error.code).toBe('INVALID_USAGE');
  } finally { await server.stop(true); }
}));

test('OpenCrawl credentials are masked in captured sessions', () => {
  for (const secret of [token, 'occ1_' + 'e'.repeat(64)]) {
    expect(redactText(`OPENCRAWL_TOKEN=${secret} done`)).not.toContain(secret);
    expect(redactText('printed ' + secret + ' here')).toBe('printed ' + SECRET_MASK + ' here');
  }
  // Hashes and credential IDs stay readable.
  for (const benign of [id, 'oca1_' + 'b'.repeat(63), 'occ1_notatoken']) expect(redactText('id ' + benign)).toBe('id ' + benign);
});
