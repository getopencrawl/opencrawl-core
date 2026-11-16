import type {ApplicationDatabase} from './postgres.mjs';
import {createWorkloadState,type WorkloadState} from './workloads.mjs';
import {replicasChallengeSchema,type ReplicasChallenge} from '../identity/workload-schema.mjs';
export type ReplicasState = WorkloadState<ReplicasChallenge>;
/** Keep existing table names, schema and import semantics for the cutover. */
export const createReplicasState = (database:ApplicationDatabase) => createWorkloadState(database,'replicas',replicasChallengeSchema);
