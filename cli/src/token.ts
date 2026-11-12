import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {CliError, jsonRequest} from './oauth.ts';
import {accessToken} from './session.ts';

// Cloud coding platforms create a new machine for every task. A sign-in made on
// one machine never reaches the next, and a copied sign-in is revoked as soon as
// one copy renews. An agent access token is the credential such a platform can
// carry: created once from a real sign-in, stored in the platform's secrets, and
// injected into every new machine as environment variables and an MCP header.
export const agentTokenVariables = ['OPENCRAWL_API_URL', 'OPENCRAWL_TOKEN', 'OPENCRAWL_SESSIONS_TOKEN'] as const;
const unavailable = 'This deployment does not offer agent access tokens. Sign in on each machine with opencrawl login instead.';

// Creating or revoking always uses this machine's saved sign-in and never an
// environment token: a token must not be able to create or revoke tokens.
async function signedIn(api: string, method: 'POST' | 'DELETE', path: string, fetcher: typeof fetch) {
  let token: string;
  try {token = await accessToken(api, undefined, fetcher);}
  catch (error) {
    if (error instanceof CliError && error.code === 'AUTH_REQUIRED') throw new CliError('AUTH_REQUIRED', 'Managing agent access tokens needs your own sign-in on this machine: run opencrawl login. An environment token cannot create or revoke tokens.', 2);
    throw error;
  }
  const request = () => jsonRequest(`${api}${path}`, {method, headers: {authorization: `Bearer ${token}`}}, fetcher);
  let result = await request();
  if (result.response.status === 401) {token = await accessToken(api, token, fetcher); result = await request();}
  const status = result.response.status;
  if (status === 401) throw new CliError('AUTH_REQUIRED', 'Your sign-in expired. Run opencrawl login, then retry.', 2);
  if (status === 403) throw new CliError('AGENT_TOKEN_FORBIDDEN', result.body.error?.code === 'ORGANIZATION_REQUIRED' ? `Create or join a team at ${api}/organizations, then run opencrawl login again.` : 'This account cannot manage that agent access token.', 2);
  if (status === 404 || status === 405) throw new CliError('AGENT_TOKENS_UNAVAILABLE', unavailable, 2);
  if (!result.response.ok || result.body.schemaVersion !== 1 || !result.body.data || typeof result.body.data !== 'object') throw new CliError('AGENT_TOKENS_UNAVAILABLE', 'Agent access tokens are temporarily unavailable. Retry shortly.');
  return result.body.data as Record<string, unknown>;
}

export async function createAgentToken(api: string, fetcher = fetch) {
  const data = await signedIn(api, 'POST', '/api/agent-tokens', fetcher);
  if (typeof data.token !== 'string' || !/^[A-Za-z0-9_.-]{20,512}$/.test(data.token) || typeof data.id !== 'string' || !/^[a-f0-9]{64}$/.test(data.id) || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))) throw new CliError('INVALID_RESPONSE', 'The service returned an invalid agent access token.');
  // The destination is the server this CLI just authenticated to, never a value the response names.
  return {id: data.id, token: data.token, expiresAt: data.expiresAt,
    environment: {OPENCRAWL_API_URL: api, OPENCRAWL_TOKEN: data.token, OPENCRAWL_SESSIONS_TOKEN: data.token}};
}

export async function revokeAgentToken(api: string, id: string | undefined, fetcher = fetch) {
  if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new CliError('INVALID_USAGE', 'Use token revoke ID with the ID printed when the token was created.', 64);
  await signedIn(api, 'DELETE', `/api/agent-tokens/${id}`, fetcher);
  return {id, revoked: true};
}

export async function tokenCommand(operation: string | undefined, api: string, id: string | undefined, values: Record<string, unknown>, fetcher = fetch): Promise<{data: unknown; human: string}> {
  if (operation === 'revoke') {
    const data = await revokeAgentToken(api, id, fetcher);
    return {data: {api, ...data}, human: `Revoked agent access token ${id}. Machines using it lose access on their next request.`};
  }
  if (operation !== 'create' || id !== undefined) throw new CliError('INVALID_USAGE', 'Use token create [--env-file PATH] or token revoke ID.', 64);
  const file = values['env-file'];
  if (file !== undefined && (typeof file !== 'string' || !file.trim())) throw new CliError('INVALID_USAGE', '--env-file requires a path.', 64);
  const created = await createAgentToken(api, fetcher);
  const mcp = {url: `${api}/mcp`, header: 'Authorization: Bearer <OPENCRAWL_TOKEN>'};
  const scope = 'It acts as you in your current workspace: search, read, use the board and upload sessions. It cannot manage sessions, the team or billing, or create tokens.';
  const next = `Store ${agentTokenVariables.join(', ')} in the environment secrets of the platform that creates your machines, and give its MCP server ${mcp.url} the header "${mcp.header}". Keep the token out of chats and repositories. Revoke with opencrawl token revoke ${created.id}.`;
  if (typeof file === 'string') {
    const path = resolve(file);
    // Never replace an existing file, and never widen its permissions.
    try {writeFileSync(path, agentTokenVariables.map(name => `${name}=${created.environment[name]}\n`).join(''), {mode: 0o600, flag: 'wx'});}
    catch (error: any) {
      // The token exists server-side but was shown to no one: remove it rather than leave an unreachable credential.
      try {await revokeAgentToken(api, created.id, fetcher);} catch {}
      throw new CliError('TOKEN_FILE_ERROR', error?.code === 'EEXIST' ? `${path} already exists. Choose a new path for --env-file.` : `Could not write ${path}. Choose a writable path for --env-file.`, 2);
    }
    return {data: {api, id: created.id, expiresAt: created.expiresAt, envFile: path, variables: agentTokenVariables, mcp},
      human: `Agent access token created; it expires ${created.expiresAt.slice(0, 10)}. ${scope}\nWrote ${agentTokenVariables.join(', ')} to ${path} (readable only by you). Delete the file after storing the values.\n${next}`};
  }
  return {data: {api, ...created, mcp},
    human: `Agent access token created; it expires ${created.expiresAt.slice(0, 10)}. ${scope}\n\n${agentTokenVariables.map(name => `${name}=${created.environment[name]}`).join('\n')}\n\n${next}`};
}
