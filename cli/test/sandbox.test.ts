import {test, expect} from 'bun:test';
import {chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {accessToken, readSession, saveSession, sessionFile} from '../src/session.ts';
import {filesystemError} from '../src/filesystem.ts';
import {CliError} from '../src/oauth.ts';

test('permission errors remain distinct from corrupt credentials and never echo raw errors', () => {
  for (const code of ['EPERM', 'EACCES', 'EROFS']) {
    const error = filesystemError(Object.assign(new Error('never-print-secret-path'), {code}));
    expect(error).toMatchObject({code: 'PERMISSION_DENIED', exitCode: 1});
    expect((error as Error).message).toContain(code);
    expect((error as Error).message).not.toContain('never-print');
    expect((error as Error).message).not.toContain('login to repair');
  }
  const known = new CliError('AUTH_REQUIRED', 'Sign in.', 2);
  expect(filesystemError(known)).toBe(known);
  const unrelated = Object.assign(new Error('disk full'), {code: 'ENOSPC'});
  expect(filesystemError(unrelated)).toBe(unrelated);
});

test('valid tokens need no state writes; a rejected snapshot still rotates once under lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-token-read-'));
  const previous = process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME = directory;
  const api = 'https://api.example';
  try {
    await saveSession(api, {auth: {clientId: 'public', deviceAuthorizationEndpoint: 'https://auth.example/device', tokenEndpoint: 'https://auth.example/token'}, accessToken: 'never-print-current', refreshToken: 'never-print-refresh', expiresAt: Date.now() + 300_000});
    const root = join(directory, 'opencrawl');
    const file = sessionFile(api), before = readFileSync(file, 'utf8');
    let refreshes = 0;
    const fetcher = (async () => {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json({access_token: 'never-print-next', refresh_token: 'never-print-rotated', expires_in: 300});
    }) as unknown as typeof fetch;
    // Remove the disposable setup lock to prove the fast path creates no files.
    for (const entry of readdirSync(root)) if (entry !== file.split(/[\\/]/).pop()) rmSync(join(root, entry));
    expect(await accessToken(api, undefined, fetcher)).toBe('never-print-current');
    expect(readdirSync(root)).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(refreshes).toBe(0);
    expect(await Promise.all([accessToken(api, 'never-print-current', fetcher), accessToken(api, 'never-print-current', fetcher)])).toEqual(['never-print-next', 'never-print-next']);
    expect(refreshes).toBe(1);
    writeFileSync(file, '{broken');
    expect(() => readSession(api)).toThrow('Could not read saved credentials');
    try { readSession(api); } catch (error) { expect(error).toMatchObject({code: 'CREDENTIALS_ERROR'}); }
  } finally {
    if (previous === undefined) delete process.env.OPENCRAWL_CONFIG_HOME; else process.env.OPENCRAWL_CONFIG_HOME = previous;
    rmSync(directory, {recursive: true, force: true});
  }
});

// This is the actual macOS operation denied by Codex, even when chmod would
// leave a 0600 file unchanged. Mode bits alone cannot reproduce that boundary.
test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))('CLI uses a read-only login in a macOS sandbox and reports denied writes before refresh', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-sandbox-'));
  const previous = process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME = directory;
  let refreshes = 0;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/token') { refreshes++; return Response.json({error: 'must-not-rotate'}, {status: 400}); }
    if (request.headers.get('authorization') !== 'Bearer never-print-current') return Response.json({}, {status: 401});
    const data = path === '/api/cli/me' ? {user: {id: 'sandbox-user'}}
      : path === '/api/board/register' ? {workspace:'sandbox',agent:'a'.repeat(64),name:'codex:sandbox'}
      : path === '/api/board/directory' ? {agents: []}
      : path === '/api/search' ? {results: [], coverage: [{source: 'sessions', state: 'ready'}], partial: false}
      : {id: 'sessions:fixture', text: 'Fixture passage', version: 'a'.repeat(64), offset: 0, totalChars: 15, nextOffset: null};
    return Response.json({schemaVersion: 1, data});
  }});
  const api = server.url.origin;
  try {
    await saveSession(api, {auth: {clientId: 'public', deviceAuthorizationEndpoint: `${api}/device`, tokenEndpoint: `${api}/token`}, accessToken: 'never-print-current', refreshToken: 'never-print-refresh', expiresAt: Date.now() + 300_000});
    const file = sessionFile(api), before = readFileSync(file, 'utf8');
    // Resolve /var -> /private/var so the profile matches kernel paths.
    const profile = `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(directory.replace(/^\/var\//, '/private/var/'))}))`;
    const run = async (args: string[], json = true) => {
      const child = Bun.spawn(['/usr/bin/sandbox-exec', '-p', profile, process.execPath, resolve(import.meta.dir, '../src/cli.ts'), ...args, '--api', api, ...(json ? ['--json'] : [])], {env: process.env, stdout: 'pipe', stderr: 'pipe'});
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(output + error).not.toContain('never-print');
      return {output, error, code};
    };
    for (const mode of [0o400, 0o600]) {
      chmodSync(file, mode);
      for (const args of [['whoami'], ['status'], ['search', 'fixture'], ['fetch', 'sessions:fixture'], ['board', 'directory']]) {
        const result = await run(args);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.output)).toMatchObject({schemaVersion: 1, data: {}});
      }
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    for (const args of [['logout'], ['board', 'register', '--session', 'sandbox', '--name', 'codex:sandbox', '--task', 'Test denied state write'], ['board', 'watch', '--session', 'sandbox', '--timeout-ms', '10']]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.output)).toMatchObject({schemaVersion: 1, error: {code: 'PERMISSION_DENIED'}});
      expect(result.error).toBe('');
    }
    chmodSync(file, 0o644);
    const insecure = await run(['whoami']);
    expect(JSON.parse(insecure.output).error.code).toBe('PERMISSION_DENIED');
    chmodSync(file, 0o000);
    const unreadable = await run(['status']);
    expect(JSON.parse(unreadable.output).error.code).toBe('PERMISSION_DENIED');
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify({...JSON.parse(before), expiresAt: 0}));
    const expired = await run(['whoami']);
    expect(expired.code).toBe(1);
    expect(JSON.parse(expired.output).error.code).toBe('PERMISSION_DENIED');
    expect(refreshes).toBe(0);
    const human = await run(['whoami'], false);
    expect(human.output).toBe('');
    expect(human.error).toContain('Permission denied');
    expect(human.error).not.toContain('login to repair');
    const preload = join(directory, 'registry-fixture.cjs');
    writeFileSync(preload, `global.fetch = async () => Response.json({name: '@getopencrawl/cli', version: '0.0.0'});`);
    const update = Bun.spawn(['/usr/bin/sandbox-exec', '-p', profile, Bun.which('node')!, '--require', preload, resolve(import.meta.dir, '../bin/opencrawl.cjs'), 'update', '--json'], {env: {...process.env, XDG_CACHE_HOME: directory}, stdout: 'pipe', stderr: 'pipe'});
    expect(await update.exited).toBe(1);
    const updateOutput = await new Response(update.stdout).text();
    expect(JSON.parse(updateOutput)).toMatchObject({schemaVersion: 1, error: {code: 'PERMISSION_DENIED'}});
    expect(updateOutput).toContain('cache directory');
    expect(await new Response(update.stderr).text()).toBe('');
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env.OPENCRAWL_CONFIG_HOME; else process.env.OPENCRAWL_CONFIG_HOME = previous;
    rmSync(directory, {recursive: true, force: true});
  }
}, 20_000);
