import {test, expect} from 'bun:test';
import {discover, startDevice, pollDevice, refresh, secureUrl, apiOrigin, jsonRequest} from '../src/oauth.ts';
const auth = {clientId: 'public-client', deviceAuthorizationEndpoint: 'https://auth.example/device', tokenEndpoint: 'https://auth.example/token'};
const device = {device_code: 'secret-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.example/device', expires_in: 60, interval: 1};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

test('non-JSON HTTP errors preserve status without exposing response bodies',async()=>{
  for(const status of [400,401,408,425,429,500,502,503,504]){
    const result=await jsonRequest('https://example.com',{},(async()=>new Response('private proxy response',{status})) as unknown as typeof fetch);
    expect(result.response.status).toBe(status);expect(result.body).toEqual({});
  }
  await expect(jsonRequest('https://example.com',{},(async()=>new Response('private proxy response')) as unknown as typeof fetch)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
});

test('discovery accepts a portable OAuth deployment without provider dependencies', async () => {
  const fetcher: any = async (url: string) => { expect(url).toBe('https://api.example/.well-known/opencrawl-cli'); return response({schemaVersion: 1, auth}); };
  expect(await discover('https://api.example', fetcher)).toEqual(auth);
  for (const url of ['http://remote.example', 'https://user:pass@example.com', 'file:///tmp/a']) expect(() => secureUrl(url)).toThrow();
  expect(apiOrigin('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
  expect(() => apiOrigin('https://example.com/path')).toThrow();
});

test('device initiation uses only a public client ID and validates browser URLs', async () => {
  const fetcher: any = async (_: string, init: RequestInit) => {
    expect(new URLSearchParams(init.body as string).get('client_id')).toBe(auth.clientId);
    expect(String(init.body)).not.toContain('secret');
    return response(device);
  };
  expect((await startDevice(auth, fetcher)).user_code).toBe(device.user_code);
  await expect(startDevice(auth, (async () => response({...device, verification_uri_complete: 'https://evil.example'})) as any)).rejects.toThrow();
});

test('polling waits before requests, respects pending and slow_down, then returns tokens', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const replies = [response({error: 'authorization_pending'}, 400), response({error: 'slow_down'}, 400), response({access_token: 'access', refresh_token: 'rotated', expires_in: 300})];
  const fetcher: any = async (_: string, init: RequestInit) => {
    expect(new URLSearchParams(init.body as string).get('device_code')).toBe(device.device_code);
    return replies.shift();
  };
  const result = await pollDevice(auth, device, {fetcher, now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }});
  expect(sleeps).toEqual([1000, 1000, 6000]);
  expect(result.refreshToken).toBe('rotated');
});

test('polling survives dropped connections and temporary service failures until approval', async () => {
  let now = 0;
  const replies: Array<() => Response> = [
    () => { throw new TypeError('fetch failed'); },
    () => new Response('bad gateway', {status: 502}),
    () => new Response('', {status: 429}),
    () => response({error: 'authorization_pending'}, 400),
    () => response({access_token: 'access', refresh_token: 'approved', expires_in: 300}),
  ];
  const result = await pollDevice(auth, device, {now: () => now, sleep: async ms => { now += ms; }, fetcher: (async () => replies.shift()!()) as any});
  expect(result.refreshToken).toBe('approved');
  expect(replies).toHaveLength(0);
  // A persistent outage still ends at the device code's expiry, not in an endless loop.
  now = 0;
  await expect(pollDevice(auth, {...device, expires_in: 5}, {now: () => now, sleep: async ms => { now += ms; }, fetcher: (async () => { throw new TypeError('fetch failed'); }) as any})).rejects.toMatchObject({code: 'AUTH_EXPIRED'});
});

test('expiry and denial terminate; provider payloads never reach error messages', async () => {
  for (const error of ['access_denied', 'expired_token', 'invalid_grant', 'provider_private_secret']) {
    let now = 0;
    const promise = pollDevice(auth, device, {now: () => now, sleep: async ms => { now += ms; }, fetcher: (async () => response({error, error_description: 'sk_private_payload'}, 400)) as any});
    await expect(promise).rejects.toThrow();
    try { await promise; } catch (caught) { expect(String(caught)).not.toContain('sk_private_payload'); expect(String(caught)).not.toContain('provider_private_secret'); }
  }
  let now = 0, calls = 0;
  await expect(pollDevice(auth, {...device, expires_in: 2}, {now: () => now, sleep: async ms => { now += ms; }, fetcher: (async () => { calls++; return response({error: 'authorization_pending'}, 400); }) as any})).rejects.toThrow('expired');
  expect(calls).toBe(1);
});

test('refresh persists the rotated-token contract and redacts invalid grants', async () => {
  const result = await refresh(auth, 'old-refresh', (async (_: string, init: RequestInit) => {
    expect(new URLSearchParams(init.body as string).get('refresh_token')).toBe('old-refresh');
    return response({access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 300});
  }) as any);
  expect(result.refreshToken).toBe('new-refresh');
  await expect(refresh(auth, 'old', (async () => response({error: 'private-error'}, 401)) as any)).rejects.toMatchObject({code: 'AUTH_REQUIRED', exitCode: 2});
});

test('proxy rejection identifies the blocked host without echoing the response',async()=>{
  const {jsonRequest}=await import('../src/oauth.ts');
  try {await jsonRequest('https://capture.example.com/health',{},(async()=>new Response('proxy secret body',{status:403})) as unknown as unknown as typeof fetch);throw new Error('expected error');}
  catch(error:any){expect(error.code).toBe('NETWORK_BLOCKED');expect(error.message).toContain('capture.example.com');expect(error.message).not.toContain('secret body');}
});

test('refresh exposes bounded retry-after only for transient responses and preserves terminal denial',async()=>{
 for(const status of [429,502,503]){
  await expect(refresh(auth,'saved',(async()=>new Response('{}',{status,headers:{'retry-after':'45'}})) as any)).rejects.toMatchObject({code:'AUTH_UNAVAILABLE',retryAfterMs:45000});
 }
 await expect(refresh(auth,'saved',(async()=>new Response('{}',{status:429,headers:{'retry-after':'999999'}})) as any)).rejects.toMatchObject({retryAfterMs:120000});
 await expect(refresh(auth,'saved',(async()=>response({},403)) as any)).rejects.toMatchObject({code:'AUTH_FAILED',exitCode:2});
});
