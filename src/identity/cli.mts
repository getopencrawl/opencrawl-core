import {errorInfo} from './types.mjs';
import type {WorkOS as Workos} from '@workos-inc/node';
import type {Principal} from './types.mjs';
import {workosDirectory} from './workos.mjs';
import type {IdentitySettings} from './types.mjs';
type CliResult = {status: 200; user: {id: string; email: string}; principal?: Principal} | {status: 401 | 403 | 503; code?: string};
import {userPrincipal, singleOrganizationPrincipal} from './principal.mjs';
import {currentVerifiedUser, currentUserSession} from './auth.mjs';
import {createRemoteJWKSet, jwtVerify} from 'jose';

// The public CLI speaks generic OAuth; this shared adapter implements WorkOS.
export function cliConfiguration(settings: Pick<IdentitySettings, 'clientId'>) {
  return {schemaVersion: 1, auth: {
    clientId: settings.clientId,
    deviceAuthorizationEndpoint: 'https://api.workos.com/user_management/authorize/device',
    tokenEndpoint: 'https://api.workos.com/user_management/authenticate',
  }, index: {available: false}};
}

export function cliIdentity(settings: Pick<IdentitySettings, 'clientId' | 'organizationId'>, workos: Workos) {
  const directory=workosDirectory(workos);
  const fixedPrincipal = settings.organizationId ? singleOrganizationPrincipal(directory, settings.organizationId) : null;
  let keys: ReturnType<typeof createRemoteJWKSet> | undefined;
  return identify;
  function identify(authorization: string | undefined, options: {capture: true}): Promise<Exclude<CliResult, {status: 200}> | {status: 200; user: {id: string; email: string}; principal: Principal}>;
  function identify(authorization: string | undefined, options?: {capture?: boolean}): Promise<CliResult>;
  async function identify(authorization: string | undefined, {capture = false} = {}): Promise<CliResult> {
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization || '')?.[1];
    if (!token || token.length > 16384) return {status: 401};
    let payload;
    try {
      keys ||= createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(settings.clientId)));
      ({payload} = await jwtVerify(token, keys, {
        issuer: `https://api.workos.com/user_management/${settings.clientId}`,
        algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'sid', 'auth_time'],
        clockTolerance: 5,
      }));
    } catch (error) {
      // A JWKS outage must not look like invalid credentials.
      return {status: ['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JOSE_GENERIC'].includes(errorInfo(error).code || '') || !errorInfo(error).code ? 503 : 401};
    }
    // WorkOS signs several token families with the same environment keys. A
    // widget or agent token must never become a full first-party user session.
    if (typeof payload.sub !== 'string' || !/^user_[A-Za-z0-9]+$/.test(payload.sub) ||
        typeof payload.sid !== 'string' || !payload.sid || !Number.isFinite(payload.auth_time) ||
        (payload.sub_profile !== undefined && payload.sub_profile !== 'user') || payload.sub_type !== undefined) return {status: 401};
    // Fresh server-side verification; CLI claims and token response user fields
    // never authorize access. Enrollment grants no index or browser-preview access.
    const current = await currentVerifiedUser(directory, payload.sub);
    if (current.status !== 200) return current;
    const session = await currentUserSession(directory, payload.sub, payload.sid);
    if (session.status !== 200) return session;
    const {user} = current;
    const result: CliResult = {status: 200, user: {id: user.id, email: user.email}};
    if (capture) {
      const principal = await (fixedPrincipal ? fixedPrincipal(user, payload.org_id) : userPrincipal(directory, user, payload.org_id));
      if (!principal) return {status:403, code:'ORGANIZATION_REQUIRED'};
      result.principal = {...principal, email:user.email,
        name:[user.firstName,user.lastName].filter(Boolean).join(' ') || null};
    }
    return result;
  };
}
