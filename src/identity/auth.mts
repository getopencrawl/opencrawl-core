import {errorInfo} from './types.mjs';
import type {Workos, HostedUser} from './types.mjs';
export interface LoginFlow {state: string; expiresAt: number; codeVerifier: string; returnTo?: string; invitationToken?: string; organizationId?: string}
export type VerifiedResult = {status: 200; user: HostedUser} | {status: 401 | 403 | 503};
export interface BrowserIdentity {authenticated: boolean; sessionId?: string; user?: HostedUser}
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function cookies(header = '') {
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1)); } catch {}
  }
  return result;
}

export function sealFlow(flow: LoginFlow, password: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(password).digest(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(flow), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function openFlow(value: string, state: string, password: string): LoginFlow | null {
  try {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(password).digest(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const flow = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as LoginFlow;
    const a = Buffer.from(flow.state), b = Buffer.from(state);
    if (a.length !== b.length || !timingSafeEqual(a, b) || flow.expiresAt <= Date.now()) return null;
    return flow;
  } catch { return null; }
}

export function verifiedUser(user: HostedUser | undefined | null) {
  return user?.emailVerified === true;
}

/** Sealed sessions contain a user snapshot; admission uses the current account. */
export async function currentVerifiedUser(workos: Workos, userId: unknown): Promise<VerifiedResult> {
  if (typeof userId !== 'string' || !/^user_[A-Za-z0-9]+$/.test(userId)) return {status: 401};
  try {
    const user = await workos.userManagement.getUser(userId);
    if (user?.id !== userId) return {status: 401};
    return verifiedUser(user) ? {status: 200, user} : {status: 403};
  } catch (error) {
    return {status: errorInfo(error).status === 404 ? 401 : 503};
  }
}

export async function currentUserSession(workos: Workos, userId: unknown, sessionId: unknown): Promise<{status: 200} | {status: 401 | 503}> {
  if (typeof userId !== 'string' || !/^user_[A-Za-z0-9]+$/.test(userId) ||
      typeof sessionId !== 'string' || !sessionId) return {status: 401};
  let after;
  const cursors = new Set();
  try {
    // Connect consent tokens can also carry sid/auth_time. Only a current
    // AuthKit user session grants browser or first-party CLI authority. Scan
    // later pages, with a bound on provider work per request.
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await workos.userManagement.listSessions(userId, {
        limit: 100, order: 'desc', ...(after ? {after} : {}),
      });
      if (!Array.isArray(page?.data) || !page.listMetadata) return {status: 503};
      const session = page.data.find(session => session?.id === sessionId);
      if (session) return {status: session.userId === userId && session.status === 'active' &&
        session.endedAt === null && new Date(session.expiresAt).getTime() > Date.now() ? 200 : 401};
      after = page.listMetadata.after;
      if (after == null) return {status: 401};
      if (typeof after !== 'string' || !after || cursors.has(after)) return {status: 503};
      cursors.add(after);
    }
    return {status: 503};
  } catch (error) {
    return {status: errorInfo(error).status === 404 ? 401 : 503};
  }
}

/** The SDK verifies the cookie JWT but does not look up current session state. */
export async function currentBrowserUser(workos: Workos, identity: BrowserIdentity | undefined): Promise<VerifiedResult> {
  if (identity?.authenticated !== true || typeof identity.sessionId !== 'string' || !identity.sessionId) return {status: 401};
  // Both lookups key on the JWT-verified user id, so they run concurrently.
  const [current, session] = await Promise.all([currentVerifiedUser(workos, identity.user?.id),
    currentUserSession(workos, identity.user?.id, identity.sessionId)]);
  if (current.status !== 200) return current;
  return session.status === 200 ? current : session;
}
