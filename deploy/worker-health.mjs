import {sessionClient} from '../dist/src/sessions/temporal/client.mjs';
const {connection}=await sessionClient({address:process.env.TEMPORAL_ADDRESS,namespace:process.env.TEMPORAL_NAMESPACE});
try {
  for(const taskQueueType of [1,2]) {
    const result=await connection.workflowService.describeTaskQueue({namespace:process.env.TEMPORAL_NAMESPACE,
      taskQueue:{name:process.env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1'},taskQueueType});
    if(!result.pollers.some(p=>Number(p.lastAccessTime?.seconds)*1000>Date.now()-120000))throw new Error('Indexing worker is not polling.');
  }
} finally {await connection.close();}
