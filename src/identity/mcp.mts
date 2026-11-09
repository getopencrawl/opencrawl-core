import {errorInfo} from './types.mjs';
import type {Workos} from './types.mjs';
import type {IdentitySettings} from './types.mjs';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {JWTVerifyGetKey} from 'jose';
import {userPrincipal, singleOrganizationPrincipal} from './principal.mjs';
import {createRemoteJWKSet, jwtVerify} from 'jose';

export function mcpMetadata(settings: Pick<IdentitySettings, 'url' | 'authOrigin'>) {
  return {resource: settings.url + '/mcp', authorization_servers: [settings.authOrigin],
    bearer_methods_supported: ['header'], scopes_supported: ['openid', 'offline_access'],
    resource_name: 'OpenCrawl'};
}

export function mcpIdentity(settings: Pick<IdentitySettings, 'url' | 'authOrigin' | 'organizationId'>, workos: Workos, keyResolver?: JWTVerifyGetKey) {
  const fixedPrincipal = settings.organizationId ? singleOrganizationPrincipal(workos, settings.organizationId) : null;
  const keys = keyResolver || createRemoteJWKSet(new URL(settings.authOrigin + '/oauth2/jwks'), {timeoutDuration: 5000});
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reject = (status: number, error?: string) => {
      if (status === 401 || status === 403) res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${settings.url}/.well-known/oauth-protected-resource/mcp"${error ? `, error="${error}"` : ''}${status === 403 ? ', scope="openid"' : ''}`);
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: error || 'authorization_required'}));
      return null;
    };
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!token || token.length > 16384) return reject(401);
    let payload;
    try {
      ({payload} = await jwtVerify(token, keys, {issuer: settings.authOrigin, audience: settings.url + '/mcp',
        algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5}));
    } catch (error) {
      const unavailable = ['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'].includes(errorInfo(error).code || '') || !errorInfo(error).code;
      return reject(unavailable ? 503 : 401, unavailable ? 'authorization_unavailable' : 'invalid_token');
    }
    if (typeof payload.sub !== 'string' || !/^user_[A-Za-z0-9]+$/.test(payload.sub)) return reject(401, 'invalid_token');
    if (typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('openid')) return reject(403, 'insufficient_scope');
    try {
      const user = await workos.userManagement.getUser(payload.sub);
      if (user.id !== payload.sub || !user.emailVerified) {
        res.writeHead(403, {'Content-Type': 'application/json'});res.end(JSON.stringify({error: 'verified_account_required'}));return null;
      }
      const principal = await (fixedPrincipal ? fixedPrincipal(user, payload.org_id) : userPrincipal(workos, user, payload.org_id));
      if (!principal) return reject(403, 'insufficient_scope');
      return principal;
    } catch (error) {
      return reject(errorInfo(error).status === 404 ? 401 : 503, errorInfo(error).status === 404 ? 'invalid_token' : 'authorization_unavailable');
    }
  };
}
