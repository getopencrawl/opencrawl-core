import type {Principal} from './types.mjs';
import type {SharedInstallation} from '../onboarding-status.mjs';
import {createWorkloadConnections, type WorkloadConnection, type WorkloadConnectionOptions} from './workload-connections.mjs';
import {replicasBindings, replicasSharedInstallations, replicasOwnerId, type ReplicasBinding, type ReplicasVerification} from './replicas.mjs';

export type ReplicasConnection = WorkloadConnection;
import {workloadConnectionSchema,replicasChallengeSchema} from './workload-schema.mjs';
export {replicasChallengeSchema,type ReplicasChallenge} from './workload-schema.mjs';
export const replicasConnectionSchema = workloadConnectionSchema('replicas');

/** Preserve the existing Replicas records, migration and public adapter API. */
export function createReplicasConnections(options: WorkloadConnectionOptions & {verify: (token: string) => Promise<ReplicasVerification>}) {
  const registry = createWorkloadConnections({...options, provider: 'replicas', repository: options.state.replicas, challengeSchema: replicasChallengeSchema});
  const {migrateApprovedConnections, ...connections} = registry;
  return {
    ...connections,
    async sharedInstallations(principal: Principal, legacy: readonly ReplicasBinding[] = []): Promise<SharedInstallation[]> {
      const migrated = await connections.sharedInstallations(principal);
      const remaining = await Promise.all(legacy.filter(row => row.tenantId === principal.tenantId).map(async row => await connections.lookupOrganization(row.organizationId) ? null : row));
      return [...migrated, ...replicasSharedInstallations(remaining.filter((row): row is ReplicasBinding => row !== null))];
    },
    async migrateLegacy(input: readonly ReplicasBinding[]) {
      const rows = replicasBindings(JSON.stringify(input), options.tenantId);
      const groups = new Map<string, {organizationId: string; tenantId: string; installations: SharedInstallation[]}>();
      for (const row of rows) {
        const group = groups.get(row.organizationId) ?? {organizationId: row.organizationId, tenantId: row.tenantId, installations: []};
        if (group.tenantId !== row.tenantId) throw Object.assign(new Error('Legacy environments in one Replicas organization belong to different OpenCrawl workspaces.'), {status: 409, expose: true});
        if (row.onboardingWorkspaceId) group.installations.push({id: row.environmentId, tenantId: row.tenantId,
          userId: replicasOwnerId(row.organizationId, row.environmentId, row.onboardingWorkspaceId), name: 'Replicas'});
        groups.set(row.organizationId, group);
      }
      return migrateApprovedConnections([...groups.values()]);
    },
  };
}
