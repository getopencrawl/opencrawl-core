import {createWorkloadConnections, type WorkloadConnection, type WorkloadConnectionOptions} from './workload-connections.mjs';
import type {DevinVerification} from './devin.mjs';

export type DevinConnection = WorkloadConnection;
import {workloadConnectionSchema,devinChallengeSchema} from './workload-schema.mjs';
export {devinChallengeSchema,type DevinChallenge} from './workload-schema.mjs';
export const devinConnectionSchema = workloadConnectionSchema('devin');
export function createDevinConnections(options: WorkloadConnectionOptions & {verify: (token: string) => Promise<DevinVerification>}) {
  // Devin has no legacy operator bindings. Only a real administrator's setup
  // capability plus a verified Cloud identity can create a connection.
  const {migrateApprovedConnections: _migration, ...connections} = createWorkloadConnections({...options, provider: 'devin', repository: options.state.devin, challengeSchema: devinChallengeSchema});
  return connections;
}
