import type {Fetch} from './ports.mjs';
import type {GithubInstallation, GithubRepository} from './types.mjs';
interface GitHubSettings {appId: string | number; slug: string; clientId: string; clientSecret: string; privateKey: string}
// An operator-owned GitHub App with repository selection and read-only access.
//
// Authorize first so an existing installation can be reused without reinstalling.
// A new installation still returns through the same bound OAuth callback.
import {createPrivateKey} from 'node:crypto';
import {SignJWT} from 'jose';

const API = 'https://api.github.com';

/** Parses the GITHUB_APP setting: base64 JSON {appId, slug, clientId, clientSecret, privateKey}. */
export function githubAppSettings(value: string | null | undefined): GitHubSettings | null {
  if (!value) return null;
  const app = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  for (const field of ['appId', 'slug', 'clientId', 'clientSecret', 'privateKey']) if (!app[field]) throw new Error(`GITHUB_APP is missing ${field}`);
  return app;
}

export function createGitHubApp({appId, slug, clientId, clientSecret, privateKey}: GitHubSettings, {fetch: fetchImpl = globalThis.fetch}: {fetch?: Fetch} = {}) {
  const key = createPrivateKey(privateKey);
  async function call<T>(path: string, {method = 'GET', token, body, base = API}: {method?: string; token?: string; body?: unknown; base?: string} = {}): Promise<{status: number; data: T}> {
    const res = await fetchImpl(path.startsWith('http') ? path : base + path, {method, headers: {
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenCrawl',
      ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body ? {'Content-Type': 'application/json'} : {}),
    }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000)});
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return {status: res.status, data: data as T};
  }
  // App JWTs live ten minutes; iat is backdated for clock drift, as GitHub recommends.
  const appToken = () => new SignJWT({}).setProtectedHeader({alg: 'RS256'}).setIssuer(String(appId))
    .setIssuedAt(Math.floor(Date.now() / 1000) - 60).setExpirationTime(Math.floor(Date.now() / 1000) + 540).sign(key);
  const fail = (what: string, {status}: {status: number}) => Object.assign(new Error(`GitHub ${what} failed with ${status}`), {status: status === 404 ? 404 : 502});

  return {
    slug,
    // The connector mints its own installation tokens from these.
    sourceSettings: () => ({app_id: String(appId), private_key: privateKey}),
    installUrl: (state: string) => `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`,
    authorizeUrl: (state: string, redirectUri: string) => 'https://github.com/login/oauth/authorize?' + new URLSearchParams({client_id: clientId, redirect_uri: redirectUri, state}),
    /** Exchanges the OAuth code from the install redirect for a short-lived user token. */
    async userToken(code: string, redirectUri?: string) {
      const {status, data} = await call<{access_token?: string; error?: string}>('https://github.com/login/oauth/access_token', {method: 'POST', body: {client_id: clientId, client_secret: clientSecret, code, ...(redirectUri ? {redirect_uri: redirectUri} : {})}});
      if (status !== 200 || !data?.access_token) throw Object.assign(new Error(`GitHub code exchange failed: ${data?.error || status}`), {status: 400});
      return data.access_token;
    },
    /** Visibility does not imply administration or access to every installed repository. */
    async userInstallations(userToken: string) {
      const installations: GithubInstallation[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await call<{installations: GithubInstallation[]}>(`/user/installations?per_page=100&page=${page}`, {token: userToken});
        if (res.status !== 200 || !Array.isArray(res.data?.installations)) throw fail('user installations', res);
        installations.push(...res.data.installations);
        if (res.data.installations.length < 100) return installations;
      }
      throw new Error('GitHub installation listing exceeded its limit');
    },
    async userRepositories(userToken: string, installationId: string) {
      const repositories: GithubRepository[] = [];
      for (let page = 1; page <= 50; page++) {
        const res = await call<{repositories: GithubRepository[]}>(`/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100&page=${page}`, {token: userToken});
        if (res.status !== 200 || !Array.isArray(res.data?.repositories)) throw fail('user repositories', res);
        repositories.push(...res.data.repositories);
        if (res.data.repositories.length < 100) return repositories;
      }
      throw new Error('GitHub repository listing exceeded its limit');
    },
    async userInstallation(userToken: string, installationId: string) {
      for (let page = 1; page <= 20; page++) {
        const res = await call<{installations: GithubInstallation[]}>(`/user/installations?per_page=100&page=${page}`, {token: userToken});
        if (res.status !== 200) throw fail('user installations', res);
        const found = res.data.installations.find(i => String(i.id) === String(installationId));
        if (found) return found;
        if (res.data.installations.length < 100) return null;
      }
      return null;
    },
    async revokeUserToken(userToken: string) {
      await fetchImpl(`${API}/applications/${clientId}/token`, {method: 'DELETE', headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'OpenCrawl', 'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      }, body: JSON.stringify({access_token: userToken}), redirect: 'error', signal: AbortSignal.timeout(15000)}).catch(() => {});
    },
    async installation(installationId: string) {
      const res = await call<GithubInstallation>(`/app/installations/${encodeURIComponent(installationId)}`, {token: await appToken()});
      if (res.status !== 200) throw fail('installation', res);
      return res.data;
    },
    /** Repositories the installation was granted (the owner's choice at install). */
    async repositories(installationId: string) {
      const created = await call<{token: string}>(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {method: 'POST', token: await appToken()});
      if (created.status !== 201) throw fail('installation token', created);
      const repos: GithubRepository[] = [];
      for (let page = 1; page <= 50; page++) {
        const res = await call<{repositories: GithubRepository[]; total_count: number}>(`/installation/repositories?per_page=100&page=${page}`, {token: created.data.token});
        if (res.status !== 200) throw fail('installation repositories', res);
        repos.push(...res.data.repositories);
        if (repos.length >= res.data.total_count || !res.data.repositories.length) break;
      }
      return repos;
    },
    /** Uninstalls the app from the account: GitHub's equivalent of revoking the grant. */
    async uninstall(installationId: string) {
      const res = await call(`/app/installations/${encodeURIComponent(installationId)}`, {method: 'DELETE', token: await appToken()});
      if (res.status !== 204 && res.status !== 404) throw fail('uninstall', res);
    },
  };
}

export type GithubApp = ReturnType<typeof createGitHubApp>;
