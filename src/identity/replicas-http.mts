import type {createReplicasConnections} from './replicas-connections.mjs';
import {workloadConnectionHandler} from './workload-http.mjs';

export const replicasConnectionHandler = (connections: ReturnType<typeof createReplicasConnections>) => workloadConnectionHandler(connections, 'Replicas');
