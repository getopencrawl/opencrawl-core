export class CliError extends Error {
  constructor(public code: string, message: string, public exitCode = 1) { super(message); }
}

export type AuthConfig = {clientId: string; deviceAuthorizationEndpoint: string; tokenEndpoint: string};
export type Device = {device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval: number};
export type Tokens = {accessToken: string; refreshToken: string; expiresAt: number};

export function secureUrl(value: unknown): string {
  if (typeof value !== 'string') throw new CliError('INVALID_RESPONSE', 'The server returned an invalid URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new CliError('INVALID_RESPONSE', 'The server returned an invalid URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.hash) {
    throw new CliError('UNSAFE_URL', 'Use HTTPS, or HTTP on a loopback address for local development.');
  }
  return url.href;
}

export function apiOrigin(value: string): string {
  let url: URL;
  try { url = new URL(secureUrl(value)); }
  catch { throw new CliError('INVALID_USAGE', '--api must be an HTTPS origin, or an HTTP loopback origin for development.', 64); }
  if (url.pathname !== '/' || url.search) throw new CliError('INVALID_USAGE', '--api must be an origin without a path or query.', 64);
  return url.origin;
}

export async function jsonRequest(url: string, init: RequestInit = {}, fetcher = fetch) {
  let response: Response;
  try {
    response = await fetcher(url, {...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(15_000)});
  } catch { throw new CliError('NETWORK_ERROR', 'Could not reach the service. Check your connection and retry.'); }
  let body: any;
  try { body = await response.json(); }
  catch { if([403,407].includes(response.status))throw new CliError('NETWORK_BLOCKED', `The network proxy or service denied ${new URL(url).hostname} (HTTP ${response.status}). Add this host to your cloud environment network allowlist and retry.`); throw new CliError('INVALID_RESPONSE', 'The service returned an invalid response.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CliError('INVALID_RESPONSE', 'The service returned an invalid response.');
  return {response, body};
}

export async function discover(api: string, fetcher = fetch): Promise<AuthConfig> {
  const {response, body} = await jsonRequest(`${api}/.well-known/opencrawl-cli`, {}, fetcher);
  const auth = body.auth;
  if (!response.ok || body.schemaVersion !== 1 || !auth || typeof auth.clientId !== 'string' || !auth.clientId) {
    throw new CliError('DISCOVERY_UNAVAILABLE', 'This deployment does not provide OpenCrawl CLI authentication.');
  }
  return {clientId: auth.clientId, deviceAuthorizationEndpoint: secureUrl(auth.deviceAuthorizationEndpoint), tokenEndpoint: secureUrl(auth.tokenEndpoint)};
}

async function form(url: string, values: Record<string, string>, fetcher = fetch) {
  return jsonRequest(url, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(values)}, fetcher);
}

export async function startDevice(auth: AuthConfig, fetcher = fetch): Promise<Device> {
  const {response, body} = await form(auth.deviceAuthorizationEndpoint, {client_id: auth.clientId}, fetcher);
  if (!response.ok) throw new CliError('AUTH_UNAVAILABLE', 'The service could not start sign-in. Retry later.');
  if (typeof body.device_code !== 'string' || !body.device_code || typeof body.user_code !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.user_code) || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 3600 || (body.interval !== undefined && (!Number.isFinite(body.interval) || body.interval <= 0 || body.interval > body.expires_in))) {
    throw new CliError('INVALID_RESPONSE', 'The service returned an invalid sign-in request.');
  }
  const uri = secureUrl(body.verification_uri);
  const complete = body.verification_uri_complete === undefined ? undefined : secureUrl(body.verification_uri_complete);
  if (complete && new URL(complete).origin !== new URL(uri).origin) throw new CliError('INVALID_RESPONSE', 'Sign-in URLs must use the same origin.');
  return {device_code: body.device_code, user_code: body.user_code, verification_uri: uri, verification_uri_complete: complete, expires_in: body.expires_in, interval: body.interval ?? 5};
}

function tokens(body: any, now: number): Tokens {
  if (typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token) throw new CliError('INVALID_RESPONSE', 'The service did not return session credentials.');
  // Decoding exp only schedules refresh; the API verifies signature and identity.
  let exp: unknown;
  try { exp = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString()).exp; } catch {}
  const expiresAt = typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : now + (Number.isFinite(body.expires_in) && body.expires_in > 0 ? body.expires_in : 60) * 1000;
  return {accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt};
}

export async function pollDevice(auth: AuthConfig, device: Device, options: {fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number} = {}): Promise<Tokens> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + device.expires_in * 1000;
  let interval = device.interval * 1000;
  while (now() + interval < deadline) {
    await sleep(interval);
    if (now() >= deadline) break;
    const {response, body} = await form(auth.tokenEndpoint, {client_id: auth.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code}, options.fetcher);
    if (response.ok) return tokens(body, now());
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') { interval += 5000; continue; }
    if (body.error === 'access_denied') throw new CliError('AUTH_DENIED', 'Sign-in was denied in the browser.');
    if (body.error === 'expired_token' || body.error === 'invalid_grant') break;
    throw new CliError('AUTH_FAILED', 'Sign-in failed. Run opencrawl login again.');
  }
  throw new CliError('AUTH_EXPIRED', 'The sign-in request expired. Run opencrawl login again.');
}

export async function refresh(auth: AuthConfig, token: string, fetcher = fetch): Promise<Tokens> {
  const {response, body} = await form(auth.tokenEndpoint, {client_id: auth.clientId, grant_type: 'refresh_token', refresh_token: token}, fetcher);
  if (response.status === 400 || response.status === 401) throw new CliError('AUTH_REQUIRED', 'Your session expired. Run opencrawl login again.', 2);
  if (!response.ok) throw new CliError('AUTH_UNAVAILABLE', 'Session refresh is temporarily unavailable. Retry later.');
  return tokens(body, Date.now());
}
