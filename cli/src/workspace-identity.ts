import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CliError, apiOrigin} from './oauth.ts';
import {assertTokenDestination, environmentToken} from './environment-token.ts';

const execute = promisify(execFile);
export function workspaceIdentityEnabled(): boolean {
  const mode = process.env.OPENCRAWL_AUTH;
  if (mode && mode !== 'replicas-workspace') throw new CliError('INVALID_AUTH_MODE', 'OPENCRAWL_AUTH must be replicas-workspace or unset.', 64);
  if (!mode) return false;
  if (process.env.OPENCRAWL_TOKEN || process.env.OPENCRAWL_SESSIONS_TOKEN) throw new CliError('AUTH_MODE_CONFLICT', 'Remove shared human tokens before enabling Replicas workspace identity.', 64);
  return true;
}

/** Tokens remain in memory. Only Replicas' supported helper mints them; the
 * receiving service verifies signatures and authorizes the exact environment.
 */
export function createWorkspaceTokenProvider({mint = async (audience: string) => {
  const {stdout} = await execute('replicas', ['identity', 'token', '--audience', audience], {timeout: 10000, maxBuffer: 32768, encoding: 'utf8'});
  return stdout.trim();
}, now = Date.now}: {mint?: (audience: string) => Promise<string>; now?: () => number} = {}) {
  const cache = new Map<string, {token: string; expiresAt: number}>();
  const pending = new Map<string, Promise<string>>();
  return async (api: string, rejected?: string): Promise<string> => {
    assertTokenDestination(api);
    const audience = apiOrigin(api), previous = cache.get(audience);
    if (previous && previous.token !== rejected && previous.expiresAt > now() + 60000) return previous.token;
    if (pending.has(audience)) return pending.get(audience)!;
    const request = (async () => {
      let token: string;
      try {token = await mint(audience);} catch {throw new CliError('WORKSPACE_IDENTITY_UNAVAILABLE', 'Replicas could not supply workspace identity. Keep queued data and retry from an active workspace.', 2);}
      try {
        const parts = token.split('.');
        if (parts.length !== 3 || token.length > 16384) throw new Error('Invalid token');
        const claims: Record<string, unknown> = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
        if (claims.iss !== 'https://api.replicas.dev' || claims.aud !== audience || typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) throw new Error('Invalid claims');
        cache.set(audience, {token, expiresAt: claims.exp * 1000});
      } catch {throw new CliError('WORKSPACE_IDENTITY_INVALID', 'Replicas returned an invalid or expired workspace identity.', 2);}
      return token;
    })();
    pending.set(audience, request);
    try {return await request;} finally {pending.delete(audience);}
  };
}
export const workspaceToken = createWorkspaceTokenProvider();
export const configuredToken = async (name: 'OPENCRAWL_TOKEN' | 'OPENCRAWL_SESSIONS_TOKEN', api: string, rejected?: string) =>
  workspaceIdentityEnabled() ? workspaceToken(api, rejected) : environmentToken(name, api);
