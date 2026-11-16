import type {createDevinConnections} from './devin-connections.mjs';
import {workloadConnectionHandler} from './workload-http.mjs';

export const devinConnectionHandler = (connections: ReturnType<typeof createDevinConnections>) => workloadConnectionHandler(connections, 'Devin Cloud');
