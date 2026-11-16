import type {ApplicationDatabase} from './postgres.mjs';
import {createWorkloadState,type WorkloadState} from './workloads.mjs';
import {devinChallengeSchema,type DevinChallenge} from '../identity/workload-schema.mjs';
export type DevinState = WorkloadState<DevinChallenge>;
export const createDevinState = (database:ApplicationDatabase) => createWorkloadState(database,'devin',devinChallengeSchema);
