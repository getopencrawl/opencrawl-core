import type {IdentityDirectory} from '../identity/types.mjs';
import type {Proxy, ProxyResponse} from './types.mjs';
import {digest} from '../connectors/scope.mjs';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_POLICY = 'workspace-members-v1';
export interface DriveFile {
  id: string; name: string; mimeType: string; version: string; modifiedTime: string;
  trashed?: boolean; driveId?: string; size?: string; description?: string;
  capabilities?: {canDownload?: boolean};
}
export interface DrivePermission {
  id?: string; type?: string; role?: string; emailAddress?: string; domain?: string;
  deleted?: boolean; expirationTime?: string; view?: string;
  inheritedPermissionsDisabled?: boolean;
  permissionDetails?: Array<{inherited?: boolean; role?: string}>;
}
export type DriveAudience = () => Promise<string[]>;
const readable = new Set(['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader']);
export function driveId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error('Invalid Google Drive identity');
}
export function driveAudience(emails: string[]) {
  if (!Array.isArray(emails) || !emails.length || emails.length > 10000 || emails.some(email => typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Complete verified workspace membership is required');
  return [...new Set(emails.map(email => email.toLowerCase()))].sort();
}
/** The runtime supplies its owning identity directory, never client email/domain claims. */
export function workspaceDriveAudience(directory: IdentityDirectory, tenantId: string): DriveAudience {
  return async () => {
    if (!/^org_[A-Za-z0-9]+$/.test(tenantId)) throw new Error('Drive requires a team workspace');
    const page = await directory.userManagement.listOrganizationMemberships({organizationId: tenantId, statuses: ['active'], limit: 100});
    if (!page.autoPagination && page.data.length >= 100) throw new Error('Workspace membership pagination is unavailable');
    const members = page.autoPagination ? await page.autoPagination() : page.data;
    if (!members.length || members.length > 10000 || members.some(member => member.organizationId !== tenantId || member.status !== 'active')) throw new Error('Invalid workspace membership');
    const emails: string[] = [];
    // Bound identity-service concurrency without caching authorization across requests.
    for (let start = 0; start < members.length; start += 8) {
      const users = await Promise.all(members.slice(start, start + 8).map(member => directory.userManagement.getUser(member.userId)));
      for (const [offset, user] of users.entries()) {
        if (user.id !== members[start + offset].userId || user.emailVerified !== true) throw new Error('Drive requires verified member email addresses');
        emails.push(user.email);
      }
    }
    return driveAudience(emails);
  };
}
export function drivePermissionsCover(permissions: DrivePermission[], members: string[], now = Date.now()) {
  const audience = driveAudience(members);
  if (!Array.isArray(permissions)) return false;
  const grants = permissions.filter(permission => {
    if (!permission || permission.deleted === true || !readable.has(permission.role || '') || permission.view !== undefined) return false;
    if (permission.expirationTime !== undefined && !(Date.parse(permission.expirationTime) > now)) return false;
    // Metadata-only inherited grants do not grant restricted-folder content access.
    if (permission.inheritedPermissionsDisabled === true && !['owner', 'organizer'].includes(permission.role || '') &&
      !permission.permissionDetails?.some(detail => detail.inherited === false && readable.has(detail.role || ''))) return false;
    return true;
  });
  return audience.every(email => grants.some(permission => permission.type === 'anyone' ||
    permission.type === 'user' && permission.emailAddress?.toLowerCase() === email ||
    permission.type === 'domain' && permission.domain?.toLowerCase() === email.split('@')[1]));
}
export function driveResponse<T>(result: ProxyResponse<T>): T {
  if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(`Google Drive returned ${result.status}`), {status: 503});
  if (result.data == null) throw new Error('Google Drive returned no data');
  return result.data;
}
function inaccessible(result: ProxyResponse<unknown>) {
  if (result.status === 404) return true;
  // Google also reports quota/rate-limit failures as 403. Those must fail the
  // sync instead of silently making an incomplete snapshot look successful.
  if (result.status !== 403 || !result.data || typeof result.data !== 'object') return false;
  const errors = (result.data as {error?: {errors?: Array<{reason?: string}>}}).error?.errors;
  return Array.isArray(errors) && errors.length > 0 && errors.every(error => ['insufficientFilePermissions', 'appNotAuthorizedToFile'].includes(error.reason || ''));
}
export const DRIVE_FIELDS = 'id,name,mimeType,version,modifiedTime,trashed,driveId,size,description,capabilities(canDownload)';
/** One bounded operation. Both ingestion and retrieval use the same live ACL policy. */
export function createDriveAccess({request, audience, now = Date.now}: {request: Proxy; audience: DriveAudience; now?: () => number}) {
  let snapshot: Promise<string[]> | undefined;
  const members = () => snapshot ||= audience().then(driveAudience);
  async function inspect(fileId: string) {
    driveId(fileId);
    const reply = await request<DriveFile>({endpoint: `${DRIVE_API}/files/${fileId}`, query: {supportsAllDrives: true, fields: DRIVE_FIELDS}});
    if (inaccessible(reply)) return null;
    const file = driveResponse(reply);
    if (file.id !== fileId || file.trashed === true || file.capabilities?.canDownload !== true) return null;
    if (typeof file.version !== 'string' || !/^\d+$/.test(file.version) || !Number.isFinite(Date.parse(file.modifiedTime))) throw new Error('Missing Drive source revision');
    const permissions: DrivePermission[] = [], seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await request<{permissions: DrivePermission[]; nextPageToken?: string}>({endpoint: `${DRIVE_API}/files/${fileId}/permissions`,
        query: {supportsAllDrives: true, pageSize: 100, pageToken, fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,deleted,expirationTime,view,inheritedPermissionsDisabled,permissionDetails(inherited,role))'}});
      if (inaccessible(response)) return null;
      const page = driveResponse(response);
      if (!Array.isArray(page.permissions)) throw new Error('Missing Drive permission metadata');
      permissions.push(...page.permissions);
      if (permissions.length > 10000) throw new Error('Drive permission inventory exceeds supported size');
      pageToken = page.nextPageToken;
      if (pageToken) {
        if (typeof pageToken !== 'string' || seen.has(pageToken)) throw new Error('Non-advancing Drive permission cursor');
        seen.add(pageToken);
      }
    } while (pageToken);
    if (!drivePermissionsCover(permissions, await members(), now())) return null;
    return {file, audienceHash: digest(await members()), permissionHash: digest(permissions), checkedAt: now()};
  }
  return {inspect, async validateAudience() {if (digest(await members()) !== digest(driveAudience(await audience()))) throw new Error('Workspace membership changed during Drive access');}};
}
