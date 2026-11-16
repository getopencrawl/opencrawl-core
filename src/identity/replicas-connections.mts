import type {ApplicationState} from '../state/types.mjs';
import {createHash, randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {Principal} from '../sessions/types.mjs';
import type {DirectoryMembership} from './types.mjs';
import type {SharedInstallation} from '../onboarding-status.mjs';
import {replicasBindings, replicasSharedInstallations, replicasOwnerId, type ReplicasBinding, type ReplicasVerification} from './replicas.mjs';

const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const scope = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const installation = z.object({id: scope, tenantId: scope, userId: z.string().regex(/^workload_replicas_[a-f0-9]{64}$/), name: z.literal('Replicas')}).strict();
export const replicasConnectionSchema = z.object({schemaVersion: z.literal(1), organizationId: uuid, tenantId: scope,
  approvedBy: scope, approvedAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(), installations: z.array(installation).max(100)}).strict();
export type ReplicasConnection = z.infer<typeof replicasConnectionSchema>;
export const replicasChallengeSchema = z.object({schemaVersion: z.literal(1), tenantId: scope, userId: scope, issuedAt: z.number().int(), expiresAt: z.number().int(),
  claim: z.object({organizationId: uuid, environmentId: uuid, workspaceId: uuid}).strict().nullable()}).strict();
export type ReplicasChallenge=z.infer<typeof replicasChallengeSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(status: number, message: string): never {throw Object.assign(new Error(message), {status, expose: true});}

/** Normal product records. Global organization keys prevent two tenants from
 * claiming the same Replicas org. Tenant indexes only locate records: every read
 * checks the authoritative connection again. CAS makes enrollment restartable.
 * PostgreSQL commits connections and installation indexes together. */
export function createReplicasConnections({state, verify, isAdmin, tenantId, now = Date.now}: {
  state: ApplicationState; verify: (token: string) => Promise<ReplicasVerification>;
  isAdmin: (principal: Principal) => Promise<boolean>;
  /** Self-host pins its tenant; hosted chooses scope only from an approved connection. */
  tenantId?: string; now?: () => number;
}) {
  const repository=state.replicas;
  const checkTenant = (value: string) => {scope.parse(value); if (tenantId !== undefined && value !== tenantId) fail(403, 'Workspace access denied');};
  const read=async(org:string)=>(await repository.readConnection(uuid.parse(org))).record;
  async function saveConnection(org: string, tenant: string, by: string, installations: SharedInstallation[], approvalIssuedAt?: number) {
    checkTenant(tenant);
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await repository.readConnection(org);
      const previous = current.record;
      if (previous && previous.tenantId !== tenant) fail(409, 'This Replicas organization is already connected to another OpenCrawl workspace.');
      if (previous?.revokedAt && (approvalIssuedAt === undefined || approvalIssuedAt <= Date.parse(previous.revokedAt))) fail(409, 'This Replicas approval was revoked. A new administrator setup prompt is required.');
      const candidates = [...previous?.installations ?? [], ...installations];
      const unique = [...new Map(candidates.map(item => [item.userId, item])).values()];
      const next = replicasConnectionSchema.parse({schemaVersion: 1, organizationId: org, tenantId: tenant,
        approvedBy: previous && !previous.revokedAt ? previous.approvedBy : by,
        approvedAt: previous && !previous.revokedAt ? previous.approvedAt : new Date(now()).toISOString(),
        revokedAt: null, installations: unique});
      if (next.installations.some(item => item.tenantId !== tenant)) fail(403, 'Installation workspace mismatch');
      if (await repository.saveConnection(org, current.version, next)) {
        return next;
      }
    }
    return fail(503, 'Replicas setup is busy. Retry the same setup prompt.');
  }
  return {
    /** Runtime migration lookup; not exposed as an unauthenticated product route. */
    lookupOrganization: read,
    async resolveOrganization(org: string): Promise<string | null> {
      const record = await read(org);
      if (!record || record.revokedAt || tenantId !== undefined && record.tenantId !== tenantId) return null;
      return record.tenantId;
    },
    async list(principal: Principal): Promise<ReplicasConnection[]> {
      checkTenant(principal.tenantId);
      if (principal.captureAccess !== undefined) fail(403, 'Capture credentials cannot read connections');
      return (await repository.listConnections(principal.tenantId)).filter(record=>!record.revokedAt);
    },
    async sharedInstallations(principal: Principal, legacy: readonly ReplicasBinding[] = []): Promise<SharedInstallation[]> {
      const migrated = (await this.list(principal)).flatMap(record => record.installations);
      const remaining = await Promise.all(legacy.filter(row => row.tenantId === principal.tenantId).map(async row => await read(row.organizationId) ? null : row));
      return [...migrated, ...replicasSharedInstallations(remaining.filter((row): row is ReplicasBinding => row !== null))];
    },
    async issue(principal: Principal, member: Pick<DirectoryMembership, 'userId' | 'organizationId' | 'status' | 'role' | 'roles'>) {
      checkTenant(principal.tenantId);
      if (principal.captureAccess !== undefined || principal.owner?.kind === 'shared' || member.userId !== principal.userId || member.organizationId !== principal.tenantId || member.status !== 'active' ||
          ![member.role, ...member.roles ?? []].some(role => role?.slug === 'admin') || !await isAdmin(principal)) fail(403, 'Only a current workspace admin can connect Replicas.');
      const code = randomBytes(32).toString('hex'), expiresAt = now() + 30 * 60 * 1000;
      const record:ReplicasChallenge = {schemaVersion: 1, tenantId: principal.tenantId, userId: principal.userId, issuedAt: now(), expiresAt, claim: null};
      if (!await repository.saveSetup(digest(code), null, record)) throw new Error('Setup code collision');
      return {code, expiresAt: new Date(expiresAt).toISOString()};
    },
    async claim(code: string, token: string) {
      if (!/^[a-f0-9]{64}$/.test(code)) fail(400, 'Invalid Replicas setup code.');
      const verified = await verify(token);
      if (verified.status !== 200) fail(verified.status, 'A current Replicas workspace identity is required.');
      const workload = verified.workload;
      const claimed = {organizationId: workload.organizationId, environmentId: workload.environmentId, workspaceId: workload.workspaceId};
      const key = digest(code);
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await repository.readSetup(key);
        if (!current.record) fail(403, 'This setup code is invalid or expired. Copy a new prompt from OpenCrawl.');
        const setup = replicasChallengeSchema.parse(current.record);
        checkTenant(setup.tenantId);
        if (setup.expiresAt <= now() || !await isAdmin({tenantId: setup.tenantId, userId: setup.userId})) fail(403, 'This setup approval expired or its administrator no longer has access.');
        if (setup.claim && Object.keys(claimed).some(key => setup.claim![key as keyof typeof claimed] !== claimed[key as keyof typeof claimed])) fail(409, 'This setup code was already used by another workspace.');
        if (!setup.claim && !await repository.saveSetup(key, current.version, {...setup, claim: claimed})) continue;
        const connection = await saveConnection(workload.organizationId, setup.tenantId, setup.userId, [], setup.issuedAt);
        return {organizationId: connection.organizationId, tenantId: connection.tenantId, connected: true as const};
      }
      return fail(503, 'Replicas setup is busy. Retry the same setup prompt.');
    },
    /** Called only by the receipt writer after it reads durable CLI, MCP-test
     * and fresh-session receipts for this exact verified shared principal. */
    async confirmInstallation(principal: Principal) {
      const owner = principal.owner;
      if (!owner || owner.kind !== 'shared' || owner.provider !== 'replicas' ||
          principal.userId !== replicasOwnerId(owner.organizationId,owner.environmentId,owner.workspaceId)) fail(403,'Shared installation identity required.');
      const record = await read(owner.organizationId);
      if (!record) return; // An unmigrated legacy installation keeps its existing approval.
      if (record.revokedAt || record.tenantId !== principal.tenantId) fail(403,'Replicas organization is not connected.');
      if (record.installations.length) return;
      await saveConnection(owner.organizationId,principal.tenantId,record.approvedBy,[{id:owner.organizationId,tenantId:principal.tenantId,userId:principal.userId,name:'Replicas'}]);
    },
    /** Operator migration only, never exposed through a user-supplied HTTP body.
     * Validate the complete legacy set before writing anything. Never move a
     * connection, invent receipts, change owners, or resurrect revoked access. */
    async migrateLegacy(input: readonly ReplicasBinding[]) {
      const rows = replicasBindings(JSON.stringify(input), tenantId);
      const groups = new Map<string, {tenantId: string; installations: SharedInstallation[]}>();
      for (const row of rows) {
        const group = groups.get(row.organizationId) ?? {tenantId: row.tenantId, installations: []};
        if (group.tenantId !== row.tenantId) fail(409, 'Legacy environments in one Replicas organization belong to different OpenCrawl workspaces.');
        if (row.onboardingWorkspaceId) group.installations.push({id: row.environmentId, tenantId: row.tenantId,
          userId: replicasOwnerId(row.organizationId, row.environmentId, row.onboardingWorkspaceId), name: 'Replicas'});
        groups.set(row.organizationId, group);
      }
      for (const [org, group] of groups) {
        const previous = await read(org);
        if (previous && (previous.tenantId !== group.tenantId || previous.revokedAt)) fail(409, 'Legacy migration conflicts with an existing Replicas connection.');
      }
      const result = [];
      for (const [org, group] of groups) result.push(await saveConnection(org, group.tenantId, 'migration:legacy-config', group.installations));
      return result;
    },
    async revoke(principal: Principal, org: string) {
      checkTenant(principal.tenantId);
      if (principal.captureAccess !== undefined || !await isAdmin(principal)) fail(403, 'Only a current workspace admin can disconnect Replicas.');
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await repository.readConnection(uuid.parse(org)), record=current.record;
        if (!record || record.tenantId !== principal.tenantId) fail(404, 'Replicas connection not found.');
        if (record.revokedAt) return;
        if (await repository.saveConnection(org, current.version, {...record, revokedAt: new Date(now()).toISOString()})) return;
      }
      fail(503, 'Replicas connection is busy. Try again.');
    },
  };
}
