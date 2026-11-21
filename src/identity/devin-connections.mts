import {admitActivity} from '../application/agent-activity.mjs';
import {createHash, randomBytes} from 'node:crypto';
import type {Principal} from '../sessions/types.mjs';
import type {DevinState} from '../state/devin.mjs';
import {devinOrganization,scope,connectionSchema,claimSchema,challengeSchema,type DevinConnection} from './devin-schema.mjs';
import type {DirectoryMembership} from './types.mjs';
import type {SharedInstallation} from '../onboarding-status.mjs';
import {devinOwnerId, type DevinVerification} from './devin.mjs';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status, expose: true});}

/** Normal product records. Global organization keys prevent two tenants from
 * claiming the same provider org. Tenant indexes only locate records: every read
 * checks the authoritative connection again. CAS makes enrollment restartable.
 * PostgreSQL commits the connection and installation records together. */
export function createDevinConnections({repository,verify,isAdmin,tenantId,now=Date.now}: {
  repository: DevinState; verify: (token: string) => Promise<DevinVerification>;
  isAdmin: (principal: Principal) => Promise<boolean>; tenantId?: string; now?: () => number;
}) {
  const checkTenant = (value: string) => {scope.parse(value); if (tenantId !== undefined && value !== tenantId) fail(403, 'Workspace access denied');};
  const read = async (org: string) => {
    const {record} = await repository.readConnection(devinOrganization.parse(org));
    if (!record) return null;
    const value = connectionSchema.parse(record);
    if (value.organizationId !== org || value.installations.some(item => item.tenantId !== value.tenantId)) throw new Error('Devin connection scope is invalid');
    return value;
  };
  async function saveConnection(org: string, tenant: string, by: string, installations: SharedInstallation[], approvalIssuedAt?: number) {
    checkTenant(tenant);
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await repository.readConnection(devinOrganization.parse(org));
      const previous = current.record;
      if (previous && previous.tenantId !== tenant) fail(409, `This Devin Cloud organization is already connected to another OpenCrawl workspace.`);
      if (previous?.revokedAt && (approvalIssuedAt === undefined || approvalIssuedAt <= Date.parse(previous.revokedAt))) fail(409, `This Devin Cloud approval was revoked. A new administrator setup prompt is required.`);
      if (approvalIssuedAt === undefined && previous?.installations.length) return previous;
      const retained = previous && !previous.revokedAt ? previous.installations : [];
      const candidates = [...retained, ...installations];
      const unique = [...new Map(candidates.map(item => [item.userId, item])).values()];
      const next = connectionSchema.parse({schemaVersion: 1, organizationId: org, tenantId: tenant,
        approvedBy: previous && !previous.revokedAt ? previous.approvedBy : by,
        approvedAt: previous && !previous.revokedAt ? previous.approvedAt : new Date(now()).toISOString(),
        revokedAt: null, installations: unique});
      if (next.installations.some(item => item.tenantId !== tenant)) fail(403, 'Installation workspace mismatch');
      if (await repository.saveConnection(org, current.version, next)) return next;
    }
    return fail(503, `Devin Cloud setup is busy. Retry the same setup prompt.`);
  }
  return {
    async resolveOrganization(org: string): Promise<string | null> {
      const record = await read(org);
      if (!record || record.revokedAt || tenantId !== undefined && record.tenantId !== tenantId) return null;
      return record.tenantId;
    },
    async list(principal: Principal): Promise<DevinConnection[]> {
      checkTenant(principal.tenantId);
      if (principal.captureAccess !== undefined) fail(403, 'Capture credentials cannot read connections');
      return (await repository.listConnections(principal.tenantId)).map(record => connectionSchema.parse(record))
        .filter(record => record.tenantId === principal.tenantId && !record.revokedAt);
    },
    async sharedInstallations(principal: Principal): Promise<SharedInstallation[]> {
      return (await this.list(principal)).flatMap(record => record.installations);
    },
    async issue(principal: Principal, member: Pick<DirectoryMembership, 'userId' | 'organizationId' | 'status' | 'role' | 'roles'>) {
      checkTenant(principal.tenantId);
      if (principal.captureAccess !== undefined || principal.owner?.kind === 'shared' || member.userId !== principal.userId || member.organizationId !== principal.tenantId || member.status !== 'active' ||
          ![member.role, ...member.roles ?? []].some(role => role?.slug === 'admin') || !await isAdmin(principal)) fail(403, `Only a current workspace admin can connect Devin Cloud.`);
      const code = randomBytes(32).toString('hex'), expiresAt = now() + 30 * 60 * 1000;
      const record = challengeSchema.parse({schemaVersion: 1, tenantId: principal.tenantId, userId: principal.userId, issuedAt: now(), expiresAt, claim: null});
      if (!await repository.saveSetup(digest(code), null, record)) throw new Error('Setup code collision');
      return {code, expiresAt: new Date(expiresAt).toISOString()};
    },
    async claim(code: string, token: string) {
      if (!/^[a-f0-9]{64}$/.test(code)) fail(400, `Invalid Devin Cloud setup code.`);
      const verified = await verify(token);
      if (verified.status !== 200) fail(verified.status, `A current Devin Cloud workspace identity is required.`);
      const workload = verified.workload;
      const claimed = claimSchema.parse({organizationId: workload.organizationId, sessionId: workload.sessionId});
      const key = digest(code);
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await repository.readSetup(key);
        if (!current.record) fail(403, 'This setup code is invalid or expired. Copy a new prompt from OpenCrawl.');
        const setup = challengeSchema.parse(current.record);
        checkTenant(setup.tenantId);
        if (setup.expiresAt <= now() || !await isAdmin({tenantId: setup.tenantId, userId: setup.userId})) fail(403, 'This setup approval expired or its administrator no longer has access.');
        admitActivity({tenantId:setup.tenantId,userId:setup.userId});
        if (setup.claim && Object.entries(claimed).some(([key, value]) => (setup.claim as Record<string, string>)[key] !== value)) fail(409, 'This setup code was already used by another workspace.');
        if (!setup.claim && !await repository.saveSetup(key, current.version, challengeSchema.parse({...setup, claim: claimed}))) continue;
        const connection = await saveConnection(workload.organizationId, setup.tenantId, setup.userId, [], setup.issuedAt);
        return {organizationId: connection.organizationId, tenantId: connection.tenantId, connected: true as const};
      }
      return fail(503, `Devin Cloud setup is busy. Retry the same setup prompt.`);
    },
    /** Called only by the receipt writer after it reads durable CLI, MCP-test
     * and fresh-session receipts for this exact verified shared principal. */
    async confirmInstallation(principal: Principal) {
      const owner = principal.owner;
      if (owner?.provider !== 'devin' || principal.userId !== devinOwnerId(owner.organizationId,owner.sessionId)) fail(403,'Shared installation identity required.');
      const record = await read(owner.organizationId);
      if (!record) fail(403, 'Devin organization is not connected.');
      if (record.revokedAt || record.tenantId !== principal.tenantId) fail(403,`Devin Cloud organization is not connected.`);
      if (record.installations.length) return;
      await saveConnection(owner.organizationId,principal.tenantId,record.approvedBy,[{id:owner.organizationId,tenantId:principal.tenantId,userId:principal.userId,name:'Devin Cloud'}]);
    },
    async revoke(principal: Principal, org: string) {
      checkTenant(principal.tenantId);
      if (principal.captureAccess !== undefined || principal.owner?.kind === 'shared' || !await isAdmin(principal)) fail(403, `Only a current workspace admin can disconnect Devin Cloud.`);
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await repository.readConnection(devinOrganization.parse(org)), record = current.record;
        if (!record || record.tenantId !== principal.tenantId) fail(404, `Devin Cloud connection not found.`);
        if (record.revokedAt) return;
        if (await repository.saveConnection(org, current.version, {...record, revokedAt: new Date(now()).toISOString()})) return;
      }
      fail(503, `Devin Cloud connection is busy. Try again.`);
    },
  };
}
