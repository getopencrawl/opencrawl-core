import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

test('real CLI processes sign in, rotate once concurrently, verify identity and log out without leaking tokens', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-flow-'));
  let refreshes = 0, polls = 0;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/.well-known/opencrawl-cli') return Response.json({schemaVersion: 1, auth: {clientId: 'public', deviceAuthorizationEndpoint: `${server.url.origin}/device`, tokenEndpoint: `${server.url.origin}/token`}});
    if (path === '/device') return Response.json({device_code: 'never-print-device-secret', user_code: 'TEST-CODE', verification_uri: 'https://auth.example/device', interval: 1, expires_in: 60});
    if (path === '/token') {
      const form = new URLSearchParams(await request.text());
      if (form.get('grant_type') === 'refresh_token') {
        refreshes++;
        if (form.get('refresh_token') !== 'never-print-refresh-1' || refreshes > 1) return Response.json({error: 'invalid_grant'}, {status: 400});
        await new Promise(resolve => setTimeout(resolve, 100));
        return Response.json({access_token: 'never-print-access-2', refresh_token: 'never-print-refresh-2', expires_in: 300});
      }
      polls++;
      return Response.json({access_token: 'never-print-access-1', refresh_token: 'never-print-refresh-1', expires_in: 300});
    }
    if (path === '/api/cli/me') {
      if (!request.headers.get('authorization')?.startsWith('Bearer never-print-access-')) return Response.json({}, {status: 401});
      return Response.json({schemaVersion: 1, data: {user: {id: 'user_test', email: 'user@example.com'}}});
    }
    return Response.json({}, {status: 404});
  }});
  const env = {...process.env, OPENCRAWL_CONFIG_HOME: directory};
  async function run(command: string) {
    const child = Bun.spawn(['bun', resolve(import.meta.dir, '../src/cli.ts'), command, '--api', server.url.origin, '--json', '--no-browser'], {env, stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stdout + stderr).not.toContain('never-print');
    return {stdout, stderr, code};
  }
  try {
    const login = await run('login');
    expect(login.code).toBe(0);
    expect(login.stderr).toContain('TEST-CODE');
    expect(JSON.parse(login.stdout).data.authenticated).toBe(true);
    expect(polls).toBe(1);
    const file = join(directory, 'opencrawl', readdirSync(join(directory, 'opencrawl')).find(file => file.endsWith('.json'))!);
    const credentials = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({...credentials, expiresAt: 0}));
    const identities = await Promise.all([run('whoami'), run('whoami')]);
    expect(identities.map(result => result.code)).toEqual([0, 0]);
    expect(refreshes).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).refreshToken).toBe('never-print-refresh-2');
    expect((await run('logout')).code).toBe(0);
    expect((await run('whoami')).code).toBe(2);
  } finally { server.stop(true); rmSync(directory, {recursive: true, force: true}); }
});
