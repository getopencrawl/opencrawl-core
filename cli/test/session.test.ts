import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync, statSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveSession, sessionFile, accessToken, readSession, logout} from '../src/session.ts';

test('separate deployments, restrictive permissions, concurrent refresh and logout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-session-'));
  const previous = process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME = directory;
  try {
    const api = 'https://api.example';
    await saveSession(api, {auth: {clientId: 'public', deviceAuthorizationEndpoint: 'https://auth.example/device', tokenEndpoint: 'https://auth.example/token'}, accessToken: 'expired', refreshToken: 'refresh-1', expiresAt: 0});
    if (process.platform !== 'win32') expect(statSync(sessionFile(api)).mode & 0o777).toBe(0o600);
    expect(readSession('https://different.example')).toBeNull();
    let calls = 0;
    const fetcher: any = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return new Response(JSON.stringify({access_token: 'fresh', refresh_token: 'refresh-2', expires_in: 300})); };
    expect(await Promise.all([accessToken(api, undefined, fetcher), accessToken(api, undefined, fetcher)])).toEqual(['fresh', 'fresh']);
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(sessionFile(api), 'utf8')).refreshToken).toBe('refresh-2');
    await logout(api);
    expect(readSession(api)).toBeNull();
    await expect(accessToken(api)).rejects.toMatchObject({code: 'AUTH_REQUIRED'});
  } finally {
    if (previous === undefined) delete process.env.OPENCRAWL_CONFIG_HOME; else process.env.OPENCRAWL_CONFIG_HOME = previous;
    rmSync(directory, {recursive: true, force: true});
  }
});
