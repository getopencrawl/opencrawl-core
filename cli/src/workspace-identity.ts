import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CliError, apiOrigin} from './oauth.ts';
import {assertTokenDestination, environmentToken} from './environment-token.ts';

const execute = promisify(execFile);
type WorkloadProvider = 'replicas' | 'devin';
const providers = {
  replicas: {name: 'Replicas', issuer: 'https://api.replicas.dev'},
  devin: {name: 'Devin Cloud', issuer: 'https://app.devin.ai'},
} as const;
export function configuredProvider(env:NodeJS.ProcessEnv=process.env): WorkloadProvider | undefined {
  const mode = env.OPENCRAWL_AUTH;
  if (!mode) return undefined;
  if (mode === 'replicas-workspace') return 'replicas';
  if (mode === 'devin-cloud') return 'devin';
  throw new CliError('INVALID_AUTH_MODE', 'OPENCRAWL_AUTH must be replicas-workspace, devin-cloud, or unset.', 64);
}
export function workspaceIdentityEnabled(env:NodeJS.ProcessEnv=process.env): boolean {
  const provider = configuredProvider(env);
  if (!provider) return false;
  if (env.OPENCRAWL_TOKEN || env.OPENCRAWL_SESSIONS_TOKEN) throw new CliError('AUTH_MODE_CONFLICT', `Remove shared human tokens before enabling ${providers[provider].name} workspace identity.`, 64);
  return true;
}

/** Tokens remain in memory. Only the provider's supported helper mints them;
 * the receiving service verifies signatures and authorizes the exact workload.
 * The client-side claim check is cache hygiene, never proof of authorization.
 */
export function createWorkspaceTokenProvider({provider: fixedProvider, mint = async (audience: string, signal?: AbortSignal) => {
  const provider = fixedProvider ?? configuredProvider() ?? 'replicas';
  const command = provider === 'devin' ? 'devin-oidc' : 'replicas';
  const args = provider === 'devin' ? ['token', '--audience', audience, '--subject-keys', 'org_id'] : ['identity', 'token', '--audience', audience];
  const {stdout} = await execute(command, args, {timeout: 10000, maxBuffer: 32768, encoding: 'utf8', signal});
  return stdout.trim();
}, now = Date.now}: {provider?: WorkloadProvider; mint?: (audience: string, signal?: AbortSignal) => Promise<string>; now?: () => number} = {}) {
  const cache = new Map<string, {token: string; refreshAt: number}>();
  const pending = new Map<string, Promise<string>>();
  return async (api: string, rejected?: string, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    assertTokenDestination(api);
    const audience = apiOrigin(api), provider = fixedProvider ?? configuredProvider() ?? 'replicas';
    const key = provider + '\n' + audience, previous = cache.get(key);
    if (previous && previous.token !== rejected && previous.refreshAt > now()) return previous.token;
    if (pending.has(key)) return pending.get(key)!;
    const request = (async () => {
      let token: string;
      try {token = await mint(audience, signal);} catch {throw new CliError('WORKSPACE_IDENTITY_UNAVAILABLE', `${providers[provider].name} could not supply workspace identity. Keep queued data and retry from an active workspace.`, 2);}
      try {
        const parts = token.split('.');
        if (parts.length !== 3 || token.length > 16384) throw new Error('Invalid token');
        const claims: Record<string, unknown> = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
        if (claims.iss !== providers[provider].issuer || claims.aud !== audience || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) throw new Error('Invalid claims');
        const expiresAt = claims.exp * 1000;
        // Real Devin Cloud tokens last 60 seconds. A fixed 60-second margin
        // defeats caching and multiplies exchanges across ordinary tool calls.
        const margin = Math.min(60000, Math.max(5000, (expiresAt - now()) / 4));
        cache.set(key, {token, refreshAt: expiresAt - margin});
      } catch {throw new CliError('WORKSPACE_IDENTITY_INVALID', `${providers[provider].name} returned an invalid or expired workspace identity.`, 2);}
      return token;
    })();
    pending.set(key, request);
    try {return await request;} finally {pending.delete(key);}
  };
}
export const workspaceToken = createWorkspaceTokenProvider();
export const configuredToken = async (name: 'OPENCRAWL_TOKEN' | 'OPENCRAWL_SESSIONS_TOKEN', api: string, rejected?: string, signal?: AbortSignal) =>
  workspaceIdentityEnabled() ? workspaceToken(api, rejected, signal) : environmentToken(name, api);
