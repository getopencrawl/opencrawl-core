import {test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

const user = {id: 'verified_user', email: 'user@example.com'};
const workspace = {id: 'verified_workspace', name: 'Verified team'};
const accessToken = 'never-print-approved-access';
const refreshToken = 'never-print-approved-refresh';
type Reply = {status: number; body: unknown};

async function fixture(operation: (context: {
  api: string;
  file: string;
  directory: string;
  env: NodeJS.ProcessEnv;
  auth: {clientId: string; deviceAuthorizationEndpoint: string; tokenEndpoint: string};
  state: {identity: Reply; holdApproval?: Promise<void>; oauthDenied: boolean; devices: number; polls: number; identityCalls: number; unexpected: string[]};
  run: (command: string, environmentToken?: string) => Promise<{code: number; body: {schemaVersion: number; data?: Record<string, unknown>; error?: {code: string; message: string}}; output: string}>;
}) => Promise<void>) {
  const state = {identity: {status: 403, body: {schemaVersion: 1, error: {code: 'ORGANIZATION_REQUIRED'}}} as Reply,
    oauthDenied: false, holdApproval: undefined as Promise<void> | undefined, devices: 0, polls: 0, identityCalls: 0, unexpected: [] as string[]};
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/.well-known/opencrawl-cli') return Response.json({schemaVersion: 1, auth});
    if (path === '/device') {
      state.devices++;
      return Response.json({device_code: 'never-print-device-secret', user_code: 'TEST-CODE', verification_uri: `${server.url.origin}/approve`, interval: 0.01, expires_in: 60});
    }
    if (path === '/token') {
      state.polls++;
      const form = new URLSearchParams(await request.text());
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code') return Response.json({error: 'invalid_grant'}, {status: 400});
      await state.holdApproval;
      if (state.oauthDenied) return Response.json({error: 'access_denied'}, {status: 400});
      return Response.json({access_token: accessToken, refresh_token: refreshToken, expires_in: 3600});
    }
    if (path === '/api/cli/me') {
      state.identityCalls++;
      if (request.headers.get('authorization') !== `Bearer ${accessToken}`) return Response.json({schemaVersion: 1, error: {code: 'AUTH_REQUIRED'}}, {status: 401});
      return Response.json(state.identity.body, {status: state.identity.status});
    }
    state.unexpected.push(`${request.method} ${path}`);
    return new Response('Not found', {status: 404});
  }});
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-onboarding-'));
  const api = server.url.origin;
  const auth = {clientId: 'public', deviceAuthorizationEndpoint: `${api}/device`, tokenEndpoint: `${api}/token`};
  const file = join(directory, 'opencrawl', createHash('sha256').update(api).digest('hex') + '.json');
  const env: NodeJS.ProcessEnv = {...process.env, OPENCRAWL_CONFIG_HOME: directory, OPENCRAWL_NO_UPDATE: '1'};
  delete env.OPENCRAWL_TOKEN;
  delete env.OPENCRAWL_SESSIONS_TOKEN;
  delete env.OPENCRAWL_API_URL;
  async function run(command: string, environmentToken?: string) {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), command, '--api', api, '--json', '--no-browser'],
      {env: {...env, ...(environmentToken ? {OPENCRAWL_TOKEN: environmentToken} : {})}, stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const output = stdout + stderr;
    expect(output).not.toContain('never-print');
    return {code, body: JSON.parse(stdout), output};
  }
  try { await operation({api, file, directory, env, auth, state, run}); }
  finally { await server.stop(true); rmSync(directory, {recursive: true, force: true}); }
}

// Bun's terminal API is POSIX-only. Replace the platform opener so no real browser is launched.
test.skipIf(process.platform === 'win32')('setup shows the code before opening a browser and supports cancellation and manual approval', () => fixture(async ({api, directory, env, state}) => {
  const opener = join(directory, process.platform === 'darwin' ? 'open' : 'xdg-open');
  const opened = join(directory, 'opened');
  writeFileSync(opener, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$OPENED"\n', {mode: 0o755});
  state.oauthDenied = true;
  // Linux supports the picker for previously enrolled profiles.
  if(process.platform==='linux'){
    const owner={tenantId:workspace.id,userId:user.id},scope={api,...owner},installationId='fixture-installation';
    const key=createHash('sha256').update(JSON.stringify([api,owner.tenantId,owner.userId])).digest('hex');
    const capture=join(directory,'opencrawl','capture','config.json'),state=join(directory,'opencrawl','setup',key+'.json');
    mkdirSync(dirname(capture),{recursive:true});mkdirSync(dirname(state),{recursive:true});
    writeFileSync(capture,JSON.stringify({schemaVersion:1,api,installationId,owner,roots:{codex:directory},harnesses:[]}));
    writeFileSync(state,JSON.stringify({schemaVersion:1,scope,installationId,acceptedAt:new Date().toISOString(),selections:{plugins:{},forward:{},history:{}}}));
  }
  for (const mode of ['cancel', 'open', 'no-browser', 'ssh']) {
    const local = mode === 'open' || mode === 'cancel';
    const before = state.polls;
    const approval = Promise.withResolvers<void>();
    state.holdApproval = approval.promise;
    const childEnv = {...env, PATH: directory, OPENED: opened, SSH_CONNECTION: mode === 'ssh' ? 'fixture' : '', SSH_TTY: ''};
    let output = '';
    const args = ['setup', '--api', api, ...(mode === 'no-browser' ? ['--no-browser'] : [])];
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args], {
      env: childEnv,
      terminal: {cols: 90, rows: 28, data: (_terminal, bytes) => {output += new TextDecoder().decode(bytes);}},
    });
    const waitFor = async (text: string) => {
      const deadline = Date.now() + 3000;
      while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(10);
      expect(output).toContain(text);
    };
    try {
      await waitFor('› [ Continue ]');
      child.terminal!.write('\r');
      await waitFor('Device code: TEST-CODE');
      if (local) {
        await waitFor('› [ Open browser ]');
        await Bun.sleep(80);
        expect(existsSync(opened)).toBe(false);
        expect(state.polls).toBe(before);
        child.terminal!.write(mode === 'open' ? '\r' : '\u001b');
      }
      if (mode !== 'cancel') {
        await waitFor(local ? 'Confirm the code in your browser.' : 'Open this link in your browser and confirm the code.');
        if (mode === 'open') {
          const deadline = Date.now() + 3000;
          while (!existsSync(opened) && Date.now() < deadline) await Bun.sleep(10);
          expect(readFileSync(opened, 'utf8')).toBe(api + '/approve\n');
        }
        approval.resolve();
        await waitFor('› [ Retry ]');
        expect(state.polls).toBe(before + 1);
        child.terminal!.write('\u001b');
      }
      expect(await child.exited).toBe(mode === 'cancel' ? 130 : 1);
      expect(output).not.toContain('never-print');
      if (mode === 'open') {
        expect(readFileSync(opened, 'utf8')).toBe(api + '/approve\n');
        rmSync(opened);
      } else expect(existsSync(opened)).toBe(false);
    } finally {
      approval.resolve();
      child.kill();
      child.terminal?.close();
      await child.exited;
    }
  }
}), 20000);

test('device-approved sign-in survives workspace setup and whoami succeeds without another approval', () => fixture(async ({api, file, state, run}) => {
  const pending = await run('login');
  expect(pending.code).toBe(2);
  expect(pending.body).toMatchObject({schemaVersion: 1, error: {code: 'ORGANIZATION_REQUIRED'}});
  expect(pending.body.data).toBeUndefined();
  expect(existsSync(file)).toBe(true);
  expect(pending.body.error?.message).toContain('saved on this machine');
  expect(pending.body.error?.message).toContain(`${api}/organizations`);
  expect(pending.body.error?.message).toContain('create or join a team');
  expect(pending.body.error?.message).toContain('opencrawl whoami');
  expect(pending.body.error?.message).not.toContain('login again');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({accessToken, refreshToken});
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  for (const command of ['whoami', 'status']) {
    const result = await run(command);
    expect(result.code).toBe(2);
    expect(result.body.error?.code).toBe('ORGANIZATION_REQUIRED');
    expect(result.body.data).toBeUndefined();
  }
  // The fixture models membership becoming visible to the verified server.
  // The client never supplies a workspace or changes the user's teams.
  state.identity = {status: 200, body: {schemaVersion: 1, data: {user, workspace}}};
  for (const command of ['whoami', 'status']) {
    const result = await run(command);
    expect(result.code).toBe(0);
    expect(result.body.data).toMatchObject({api, authenticated: true, user, workspace});
    expect(result.body.data?.user).toEqual(user);
  }
  expect(state.devices).toBe(1);
  expect(state.polls).toBe(1);
  expect(state.identityCalls).toBe(5);
  expect(state.unexpected).toEqual([]);
}));

test('login and environment-token identity expose only the verified workspace fields', () => fixture(async ({api, file, state, run}) => {
  state.identity = {status: 200, body: {schemaVersion: 1, data: {user, workspace: {...workspace, providerSecret: 'never-print-provider-secret'}}}};
  const login = await run('login');
  expect(login.code).toBe(0);
  expect(login.body.data).toEqual({api, authenticated: true, user, workspace});
  rmSync(file);
  for (const command of ['whoami', 'status']) {
    const result = await run(command, accessToken);
    expect(result.code).toBe(0);
    expect(result.body.data).toMatchObject({credential: 'environment-token', user, workspace});
    expect(result.body.data?.user).toEqual(user);
    expect(result.body.data?.workspace).toEqual(workspace);
  }
  expect(existsSync(file)).toBe(false);
}));

test('a verified workspace ID remains available when its display name is unavailable', () => fixture(async ({state, run}) => {
  state.identity = {status: 200, body: {schemaVersion: 1, data: {user, workspace: {id: workspace.id, name: null}}}};
  const result = await run('whoami', accessToken);
  expect(result.code).toBe(0);
  expect(result.body.data?.workspace).toEqual({id: workspace.id, name: null});
}));

test('identity remains compatible with servers that omit workspace or return unusable workspace metadata', () => fixture(async ({state, run}) => {
  for (const value of [undefined, null, {}, {id: workspace.id}, {id: '', name: workspace.name}, {id: 7, name: workspace.name}, {id: workspace.id, name: false}]) {
    state.identity = {status: 200, body: {schemaVersion: 1, data: {user, ...(value === undefined ? {} : {workspace: value})}}};
    const result = await run('whoami', accessToken);
    expect(result.code).toBe(0);
    expect(result.body.data?.user).toEqual(user);
    expect(result.body.data).not.toHaveProperty('workspace');
  }
}));

for (const rejection of [
  {name: 'expired credentials', status: 401, body: {schemaVersion: 1, error: {code: 'ORGANIZATION_REQUIRED'}}, code: 'AUTH_REQUIRED'},
  {name: 'unverified email', status: 403, body: {schemaVersion: 1, error: {code: 'EMAIL_VERIFICATION_REQUIRED'}}, code: 'AUTH_FORBIDDEN'},
  {name: 'denied account', status: 403, body: {schemaVersion: 1, error: {code: 'FORBIDDEN'}}, code: 'AUTH_FORBIDDEN'},
  {name: 'unversioned organization error', status: 403, body: {error: {code: 'ORGANIZATION_REQUIRED'}}, code: 'AUTH_FORBIDDEN'},
  {name: 'invalid identity', status: 200, body: {schemaVersion: 1, data: {user: {email: user.email}}}, code: 'INVALID_RESPONSE'},
  {name: 'service failure', status: 503, body: {schemaVersion: 1, error: {code: 'ORGANIZATION_REQUIRED'}}, code: 'INVALID_RESPONSE'},
]) test(`login does not save or overwrite credentials after ${rejection.name}`, () => fixture(async ({file, auth, state, run}) => {
  state.identity = rejection;
  const result = await run('login');
  expect(result.code).not.toBe(0);
  expect(result.body.error?.code).toBe(rejection.code);
  expect(result.body.data).toBeUndefined();
  expect(existsSync(file)).toBe(false);
  const previous = JSON.stringify({auth, accessToken: 'never-print-existing-access', refreshToken: 'never-print-existing-refresh', expiresAt: Date.now() + 3600_000});
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, previous, {mode: 0o600});
  expect((await run('login')).body.error?.code).toBe(rejection.code);
  expect(readFileSync(file, 'utf8')).toBe(previous);
}));

test('denied device approval never reaches identity or stores credentials', () => fixture(async ({file, state, run}) => {
  state.oauthDenied = true;
  const result = await run('login');
  expect(result.code).not.toBe(0);
  expect(result.body.error?.code).toBe('AUTH_DENIED');
  expect(existsSync(file)).toBe(false);
  expect(state.identityCalls).toBe(0);
}));
