import {test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

const user = {id: 'user_fixture', email: 'fixture@example.com'};
const selected = {id: 'org_selected', name: 'Chosen team'};
const other = {id: 'org_other', name: 'Other team'};
const initialAccess = 'never-print-access-0', initialRefresh = 'never-print-refresh-0';
type Body = {schemaVersion: number; data?: {api?: string; authenticated?: boolean; user?: typeof user; workspace?: typeof selected};
  error?: {code: string; message: string; workspaces?: Array<{id: string; name: string | null}>}};
type State = {devices: number; polls: number; refreshes: number; activeRefreshes: number; maxActiveRefreshes: number;
  rejectedRefreshes: number; identityCalls: number; requests: number; denyStatus: number; mismatch: boolean;
  verificationFailure: boolean; omitWorkspace: boolean; deviceIdentityRejected: boolean; refreshDelayMs: number; workspaces: unknown[]; requested: string[]};
type Fixture = {api: string; file: string; state: State; seed: () => string;
  session: () => {accessToken: string; refreshToken: string; pendingOrganization?: string};
  run: (args: string[], options?: {human?: boolean; environmentToken?: string; interruptRefresh?: boolean}) => Promise<{code: number; body: Body; output: string}>};

async function fixture(operation: (context: Fixture) => Promise<void>) {
  const state: State = {devices: 0, polls: 0, refreshes: 0, activeRefreshes: 0, maxActiveRefreshes: 0,
    rejectedRefreshes: 0, identityCalls: 0, requests: 0, denyStatus: 0, mismatch: false, verificationFailure: false,
    omitWorkspace: false, deviceIdentityRejected: false, refreshDelayMs: 40, workspaces: [selected, other], requested: []};
  let expectedRefresh = initialRefresh;
  const scopes = new Map<string, string | null>([[initialAccess, null]]);
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
    state.requests++;
    const path = new URL(request.url).pathname;
    if (path === '/.well-known/opencrawl-cli') return Response.json({schemaVersion: 1, auth});
    if (path === '/device') {
      state.devices++;
      return Response.json({device_code: 'never-print-device', user_code: 'TEST-CODE', verification_uri: `${server.url.origin}/approve`, interval: 0.01, expires_in: 60});
    }
    if (path === '/token') {
      const form = new URLSearchParams(await request.text());
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        state.polls++;
        return Response.json({access_token: initialAccess, refresh_token: initialRefresh, expires_in: 3600});
      }
      if (form.get('grant_type') !== 'refresh_token') return Response.json({error: 'invalid_grant'}, {status: 400});
      const organizationId = form.get('organization_id');
      state.requested.push(organizationId ?? 'missing');
      if (state.denyStatus) return Response.json({error: 'organization_access_denied', error_description: 'never-print-provider-detail'}, {status: state.denyStatus});
      if (form.get('refresh_token') !== expectedRefresh) {
        state.rejectedRefreshes++;
        return Response.json({error: 'invalid_grant'}, {status: 400});
      }
      const sequence = ++state.refreshes;
      state.activeRefreshes++;
      state.maxActiveRefreshes = Math.max(state.maxActiveRefreshes, state.activeRefreshes);
      expectedRefresh = `never-print-refresh-${sequence}`;
      const token = `never-print-access-${sequence}`;
      scopes.set(token, state.mismatch ? other.id : organizationId);
      await new Promise(resolve => setTimeout(resolve, state.refreshDelayMs));
      state.activeRefreshes--;
      return Response.json({access_token: token, refresh_token: expectedRefresh, expires_in: 3600});
    }
    if (path === '/api/cli/me') {
      state.identityCalls++;
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!scopes.has(token)) return Response.json({schemaVersion: 1, error: {code: 'AUTH_REQUIRED'}}, {status: 401});
      if (state.deviceIdentityRejected && token === initialAccess) return Response.json({schemaVersion: 1, error: {code: 'EMAIL_VERIFICATION_REQUIRED'}}, {status: 403});
      if (state.verificationFailure && token !== initialAccess) return Response.json({schemaVersion: 1, error: {code: 'AUTH_UNAVAILABLE'}}, {status: 503});
      const organizationId = scopes.get(token);
      if (!organizationId) return Response.json({schemaVersion: 1, error: {code: 'ORGANIZATION_REQUIRED', workspaces: state.workspaces}}, {status: 403});
      return Response.json({schemaVersion: 1, data: {user, ...(state.omitWorkspace ? {} : {workspace: organizationId === selected.id ? selected : other})}});
    }
    return new Response('Not found', {status: 404});
  }});
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-selection-'));
  const api = server.url.origin;
  const auth = {clientId: 'public', deviceAuthorizationEndpoint: `${api}/device`, tokenEndpoint: `${api}/token`};
  const file = join(directory, 'opencrawl', createHash('sha256').update(api).digest('hex') + '.json');
  const env: NodeJS.ProcessEnv = {...process.env, OPENCRAWL_CONFIG_HOME: directory, OPENCRAWL_NO_UPDATE: '1'};
  delete env.OPENCRAWL_TOKEN;
  delete env.OPENCRAWL_SESSIONS_TOKEN;
  delete env.OPENCRAWL_API_URL;
  const seed = () => {
    const saved = JSON.stringify({auth, accessToken: initialAccess, refreshToken: initialRefresh, expiresAt: Date.now() + 3600_000});
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, saved, {mode: 0o600});
    return saved;
  };
  const run: Fixture['run'] = async (args, options = {}) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args, '--api', api, '--no-browser', ...(options.human ? [] : ['--json'])],
      {env: {...env, ...(options.environmentToken ? {OPENCRAWL_TOKEN: options.environmentToken} : {})}, stdout: 'pipe', stderr: 'pipe'});
    if (options.interruptRefresh) {
      const deadline = Date.now() + 3000;
      while (!state.activeRefreshes) {
        if (Date.now() > deadline) {child.kill(); await child.exited; throw new Error('Refresh did not start');}
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      child.kill('SIGTERM');
    }
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = stdout + stderr;
    expect(output).not.toContain('never-print');
    return {code, body: options.human || !stdout ? {} as Body : JSON.parse(stdout) as Body, output};
  };
  try { await operation({api, file, state, seed, session: () => JSON.parse(readFileSync(file, 'utf8')), run}); }
  finally { await server.stop(true); rmSync(directory, {recursive: true, force: true}); }
}

test('an ambiguous pending sign-in selects a verified workspace without repeating device approval', () => fixture(async ({api, state, session, run}) => {
  const pending = await run(['login']);
  expect(pending.code).toBe(2);
  expect(pending.body.error?.workspaces).toEqual([selected, other]);
  expect(pending.body.error?.message).toContain(`opencrawl login --organization ${selected.id} --api ${api}`);
  const result = await run(['login', '--organization', selected.id]);
  expect(result.code).toBe(0);
  expect(result.body.data).toEqual({api, authenticated: true, user, workspace: selected});
  expect(session().pendingOrganization).toBeUndefined();
  expect(session().refreshToken).toBe('never-print-refresh-1');
  expect((await run(['whoami'])).body.data?.workspace).toEqual(selected);
  expect(state.devices).toBe(1);
  expect(state.polls).toBe(1);
  expect(state.requested).toEqual([selected.id]);
}));

test('explicit selection signs in once when this deployment has no saved credentials', () => fixture(async ({state, session, run}) => {
  const result = await run(['login', '--organization', selected.id]);
  expect(result.code).toBe(0);
  expect(result.body.data?.workspace).toEqual(selected);
  expect(state.devices).toBe(1);
  expect(state.polls).toBe(1);
  expect(state.refreshes).toBe(1);
  expect(session().pendingOrganization).toBeUndefined();
}));

for (const status of [400, 403]) test(`provider denial (${status}) preserves the existing sign-in byte for byte`, () => fixture(async ({state, file, seed, run}) => {
  const before = seed();
  state.denyStatus = status;
  const result = await run(['login', '--organization', selected.id]);
  expect(result.code).toBe(2);
  expect(result.body.error?.code).toBe('ORGANIZATION_SELECTION_DENIED');
  expect(result.body.data).toBeUndefined();
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(state.devices).toBe(0);
  expect(state.identityCalls).toBe(0);
}));

test('denied selection after device approval preserves the verified sign-in for another choice without authorizing a workspace', () => fixture(async ({state, session, run}) => {
  state.denyStatus = 403;
  expect((await run(['login', '--organization', selected.id])).body.error?.code).toBe('ORGANIZATION_SELECTION_DENIED');
  expect(session()).toMatchObject({accessToken: initialAccess, refreshToken: initialRefresh, pendingOrganization: selected.id});
  expect((await run(['whoami'])).body.error?.code).toBe('ORGANIZATION_SELECTION_REQUIRED');
  expect(state.devices).toBe(1);
  expect(state.identityCalls).toBe(1);
  state.denyStatus = 0;
  const recovered = await run(['login', '--organization', other.id]);
  expect(recovered.code).toBe(0);
  expect(recovered.body.data?.workspace).toEqual(other);
  expect(state.devices).toBe(1);
  expect(state.polls).toBe(1);
  expect(session().pendingOrganization).toBeUndefined();
}));

for (const missing of [false, true]) test(`rotated credentials remain recoverable and unusable after ${missing ? 'missing' : 'mismatched'} workspace verification`, () => fixture(async ({state, seed, session, run}) => {
  seed();
  state.mismatch = !missing;
  state.omitWorkspace = missing;
  const result = await run(['login', '--organization', selected.id]);
  expect(result.code).toBe(2);
  expect(result.body.error?.code).toBe('ORGANIZATION_MISMATCH');
  expect(result.body.data).toBeUndefined();
  expect(session()).toMatchObject({refreshToken: 'never-print-refresh-1', pendingOrganization: selected.id});
  const requests = state.requests;
  for (const command of ['whoami', 'status']) expect((await run([command])).body.error?.code).toBe('ORGANIZATION_SELECTION_REQUIRED');
  expect(state.requests).toBe(requests);
  state.mismatch = false;
  state.omitWorkspace = false;
  expect((await run(['login', '--organization', selected.id])).body.data?.workspace).toEqual(selected);
  expect(session().refreshToken).toBe('never-print-refresh-2');
  expect(session().pendingOrganization).toBeUndefined();
  expect(state.rejectedRefreshes).toBe(0);
}));

test('a verification outage retains the rotated token for safe retry', () => fixture(async ({state, seed, session, run}) => {
  seed();
  state.verificationFailure = true;
  expect((await run(['login', '--organization', selected.id])).code).not.toBe(0);
  expect(session()).toMatchObject({refreshToken: 'never-print-refresh-1', pendingOrganization: selected.id});
  state.verificationFailure = false;
  expect((await run(['login', '--organization', selected.id])).code).toBe(0);
  expect(state.rejectedRefreshes).toBe(0);
}));

test('concurrent CLI selections serialize each one-use refresh token and verify before releasing the lock', () => fixture(async ({state, seed, session, run}) => {
  seed();
  const results = await Promise.all([run(['login', '--organization', selected.id]), run(['login', '--organization', selected.id])]);
  expect(results.map(result => result.code)).toEqual([0, 0]);
  expect(results.map(result => result.body.data?.workspace)).toEqual([selected, selected]);
  expect(state.refreshes).toBe(2);
  expect(state.maxActiveRefreshes).toBe(1);
  expect(state.rejectedRefreshes).toBe(0);
  expect(state.devices).toBe(0);
  expect(session().refreshToken).toBe('never-print-refresh-2');
  expect(session().pendingOrganization).toBeUndefined();
}));

test.skipIf(process.platform === 'win32')('cooperative shutdown waits until an in-flight organization refresh is safely stored', () => fixture(async ({state, seed, session, run}) => {
  seed();
  state.refreshDelayMs = 200;
  const result = await run(['login', '--organization', selected.id], {interruptRefresh: true});
  expect(result.code).toBe(143);
  expect(session().refreshToken).toBe('never-print-refresh-1');
  expect((await run(['login', '--organization', selected.id])).code).toBe(0);
  expect(state.rejectedRefreshes).toBe(0);
}));

test('invalid selection input and active environment tokens fail before network or saved-state changes', () => fixture(async ({state, file, run}) => {
  for (const args of [['login', '--organization', ''], ['login', '--organization', 'not-an-org'], ['login', '--organization', 'org_a/other'], ['whoami', '--organization', selected.id]]) {
    const result = await run(args);
    expect(result.code).toBe(64);
    expect(result.body.error?.code).toBe('INVALID_USAGE');
  }
  const result = await run(['login', '--organization', selected.id], {environmentToken: 'never-print-environment-token'});
  expect(result.code).toBe(2);
  expect(result.body.error?.code).toBe('ENVIRONMENT_TOKEN_ACTIVE');
  expect(state.requests).toBe(0);
  expect(existsSync(file)).toBe(false);
}));

test('device sign-in must pass server account verification before scoped refresh', () => fixture(async ({state, file, run}) => {
  state.deviceIdentityRejected = true;
  expect((await run(['login', '--organization', selected.id])).body.error?.code).toBe('AUTH_FORBIDDEN');
  expect(state.refreshes).toBe(0);
  expect(state.requested).toEqual([]);
  expect(existsSync(file)).toBe(false);
}));

test('workspace choices whitelist fields and cannot inject terminal controls or command arguments', () => fixture(async ({api, state, seed, run}) => {
  seed();
  state.workspaces = [{id: selected.id, name: '\u001b[31mChosen\nteam\u001b[0m', extra: 'never-print-extra'},
    {id: 'org_other --api https://elsewhere.example', name: 'Bad'}, {id: selected.id, name: 'Duplicate'}, {id: other.id, name: null}, {id: 'org_badname', name: {secret: 'never-print'}}];
  const result = await run(['whoami']);
  expect(result.body.error?.workspaces).toEqual([{id: selected.id, name: 'Chosen team'}, {id: other.id, name: null}]);
  expect(result.body.error?.message).toContain(`opencrawl login --organization ${selected.id} --api ${api}`);
  expect(result.output).not.toContain('elsewhere.example');
  const human = await run(['whoami'], {human: true});
  expect(human.code).toBe(2);
  expect(human.output).toContain(`opencrawl login --organization ${other.id} --api ${api}`);
  expect(human.output).not.toContain('\u001b');
  expect(human.output).not.toContain('elsewhere.example');
}));
