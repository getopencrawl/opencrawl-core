import {createHash} from 'node:crypto';
import {createRemoteJWKSet, decodeJwt, jwtVerify, errors} from 'jose';
import type {JWTVerifyGetKey} from 'jose';
import type {Principal} from './types.mjs';
import {devinOrganization} from './devin-schema.mjs';

export const DEVIN_ISSUER = 'https://app.devin.ai';
const nativeId = /^[A-Za-z0-9_-]{1,200}$/;
export interface DevinIdentity {organizationId: string; sessionId: string; expiresAt: number}
export type DevinVerification = {status: 200; workload: DevinIdentity} | {status: 401 | 503};
export type DevinWorkloadResult = {status: 200; user: {id: string; email: null}; principal: Principal; workload: DevinIdentity}
  | {status: 401 | 403 | 503; code?: string};

/** Routing hint only. It confers no access; verification pins issuer and key. */
export function isDevinToken(token: string | undefined): token is string {
  if (!token || token.length > 16384) return false;
  try {return decodeJwt(token).iss === DEVIN_ISSUER;} catch {return false;}
}
export function devinOwnerId(organizationId: string, sessionId: string) {
  return 'workload_devin_' + createHash('sha256').update(DEVIN_ISSUER + '\n' + JSON.stringify([organizationId, sessionId])).digest('hex');
}

/** Cloud's official helper exchanges the session token for this exact audience
 * and the org_id subject. Requester email, requester ID, and service-user claims
 * never grant human access. Enterprise custom issuers are not auto-discovered
 * from unverified claims or headers.
 * https://docs.devin.ai/product-guides/oidc
 */
export function createDevinVerifier({audience, key = createRemoteJWKSet(new URL(DEVIN_ISSUER + '/.well-known/jwks.json'), {timeoutDuration: 5000}), now = Date.now}: {
  audience: string; key?: JWTVerifyGetKey; now?: () => number;
}) {
  const origin = new URL(audience);
  if (origin.origin !== audience || !['https:', 'http:'].includes(origin.protocol) || origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Invalid workload audience');
  return async (token: string): Promise<DevinVerification> => {
    if (!token || token.length > 16384) return {status: 401};
    let payload;
    try {
      ({payload} = await jwtVerify(token, key, {issuer: DEVIN_ISSUER, audience, algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp', 'org_id', 'devin_id'], currentDate: new Date(now())}));
    } catch (error) {return {status: error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout) ? 401 : 503};}
    const org = payload.org_id, session = payload.devin_id;
    if (payload.aud !== audience || typeof org !== 'string' || !devinOrganization.safeParse(org).success ||
        typeof session !== 'string' || !nativeId.test(session) || payload.sub !== `org_id:${org}` ||
        typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) ||
        payload.exp <= payload.iat || payload.iat * 1000 > now()) return {status: 401};
    return {status: 200, workload: {organizationId: org, sessionId: session, expiresAt: payload.exp * 1000}};
  };
}

/** Admission requires an independently approved organization connection. The
 * resolver is authoritative, including null after revocation. There is no
 * fallback through a requester email, API-supplied tenant, or stored human login.
 */
export function createDevinWorkloads({audience, resolveOrganization, tenantId, key, now = Date.now}: {
  audience: string; resolveOrganization: (organizationId: string) => Promise<string | null>;
  tenantId?: string; key?: JWTVerifyGetKey; now?: () => number;
}) {
  const verify = createDevinVerifier({audience, key, now});
  const admitted = new WeakMap<Principal, DevinIdentity>();
  const tenant = async (identity: DevinIdentity) => {
    const resolved = await resolveOrganization(identity.organizationId);
    if (!resolved || tenantId !== undefined && resolved !== tenantId) return null;
    return resolved;
  };
  return {
    verify,
    async revalidate(principal: Principal, requested?: unknown): Promise<Principal> {
      const identity = admitted.get(principal);
      if (!identity || identity.expiresAt <= now() || requested !== undefined && requested !== principal.tenantId) throw Object.assign(new Error('Workload access denied'), {status: 403});
      if (await tenant(identity) !== principal.tenantId) throw Object.assign(new Error('Devin organization connection revoked'), {status: 403});
      return principal;
    },
    async identify(token: string): Promise<DevinWorkloadResult> {
      const verified = await verify(token);
      if (verified.status !== 200) return verified;
      const workload = verified.workload;
      let tenantId;
      try {tenantId = await tenant(workload);} catch {return {status: 503};}
      if (!tenantId) return {status: 403, code: 'DEVIN_NOT_CONNECTED'};
      const {organizationId, sessionId} = workload;
      const principal: Principal = {tenantId, userId: devinOwnerId(organizationId, sessionId),
        name: 'Devin session ' + sessionId, email: null,
        owner: {kind: 'shared', provider: 'devin', organizationId, sessionId}};
      admitted.set(principal, workload);
      return {status: 200, principal, user: {id: principal.userId, email: null}, workload};
    },
  };
}
