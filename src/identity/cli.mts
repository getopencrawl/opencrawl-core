import {errorInfo} from './types.mjs';
import type {WorkOS as Workos} from '@workos-inc/node';
import type {Principal} from './types.mjs';
import {workosDirectory} from './workos.mjs';
import type {IdentitySettings} from './types.mjs';
type CliResult = {status: 200; user: {id: string; email: string}; principal?: Principal; workspaceName?:string} | {status: 401 | 403 | 503; code?: string; workspaces?: Array<{id: string; name: string | null}>};
import {principalMemberships, membershipPrincipal} from './principal.mjs';
import {currentVerifiedUser, currentUserSession, type SessionCheck} from './auth.mjs';
import {createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey} from 'jose';

// The public CLI speaks generic OAuth; this shared adapter implements WorkOS.
export function cliConfiguration(settings: Pick<IdentitySettings, 'clientId'>) {
  return {schemaVersion: 1, auth: {
    clientId: settings.clientId,
    deviceAuthorizationEndpoint: 'https://api.workos.com/user_management/authorize/device',
    tokenEndpoint: 'https://api.workos.com/user_management/authenticate',
  }, index: {available: false}};
}

export function cliIdentity(settings: Pick<IdentitySettings, 'clientId' | 'organizationId'>, workos: Workos, options?:{checkSession?:SessionCheck;keys?:JWTVerifyGetKey}) {
  const directory=workosDirectory(workos);
  const fixedOrganization = settings.organizationId;
  if (fixedOrganization && !/^org_[A-Za-z0-9]+$/.test(fixedOrganization)) throw new Error('Configure one organization');
  let keys:JWTVerifyGetKey | undefined=options?.keys;
  return identify;
  function identify(authorization: string | undefined, options: {capture: true}): Promise<Exclude<CliResult, {status: 200}> | {status: 200; user: {id: string; email: string}; principal: Principal; workspaceName?:string}>;
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
    // The live membership row can carry the account and organization name.
    const wrongOrganization = capture && fixedOrganization && payload.org_id != null && payload.org_id !== fixedOrganization;
    const membershipsRead = capture && !wrongOrganization
      ? principalMemberships(directory,payload.sub,fixedOrganization || payload.org_id) : Promise.resolve(null);
    const subject = payload.sub;
    const [session, admission] = await Promise.all([
      options?.checkSession ? options.checkSession(subject,payload.sid) : currentUserSession(directory,subject,payload.sid),
      membershipsRead.then(async memberships=>({memberships,current:await currentVerifiedUser(directory,subject,memberships?.[0]?.user)}),()=>null),
    ]);
    if (!admission) return {status:503};
    const {current,memberships} = admission;
    if (current.status !== 200) return current;
    if (session.status !== 200) return {status:session.status};
    const {user} = current;
    const result: CliResult = {status: 200, user: {id: user.id, email: user.email}};
    if (capture) {
      if (fixedOrganization && payload.org_id != null && payload.org_id !== fixedOrganization) return {status:403, code:'ORGANIZATION_REQUIRED', workspaces:[]};
      const principal = membershipPrincipal(user, memberships);
      if (!principal) {
        // Only current, user-bound membership facts establish eligible choices.
        // Names are display-only and must come back for the exact verified ID.
        const workspaces = await Promise.all([...new Map((memberships || []).map(member => [member.organizationId,member])).values()].map(async member => {
          const id=member.organizationId;
          if (typeof member.organizationName==='string') return {id,name:member.organizationName};
          let name: string | null = null;
          try {const organization = await directory.organizations.getOrganization(id);if (organization.id === id && typeof organization.name === 'string') name = organization.name;}
          catch { /* Display-name failure cannot grant access or invalidate verified membership facts. */ }
          return {id,name};
        }));
        return {status:403, code:'ORGANIZATION_REQUIRED', workspaces};
      }
      result.principal = {...principal, email:user.email,
        name:[user.firstName,user.lastName].filter(Boolean).join(' ') || null};
      if (typeof memberships?.[0]?.organizationName==='string') result.workspaceName=memberships[0].organizationName;
    }
    return result;
  };
}
