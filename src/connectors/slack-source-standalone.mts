import type {SlackCaptureRequest} from './temporal/source-client.mjs';
import type {ConnectionReference} from './temporal/types.mjs';
import type {connectorClient as ClientFactory} from './temporal/client.mjs';
import {readFile} from 'node:fs/promises';
import {connectorClient} from './temporal/client.mjs';
import {startSlackCapture} from './temporal/source-client.mjs';
// Compatibility entrypoint: the CLI now submits durable work and exits. Only the
// worker process loads Slack credentials, storage bindings and SQL state.
const [configPath,runId,mode='files']=process.argv.slice(2);
if(!configPath||!runId||!['files','messages','references'].includes(mode))throw new Error('Usage: node dist/src/connectors/slack-source-standalone.mjs config.json run-id [files|messages|references]');
const config=JSON.parse(await readFile(configPath,'utf8')) as {reference?:ConnectionReference;binding?:ConnectionReference;cutoff?:number;references?:SlackCaptureRequest['references'];temporal:Parameters<typeof ClientFactory>[0]&{taskQueue:string}};
const reference=config.reference||config.binding;
if(!reference||!config.temporal?.taskQueue)throw new Error('Configure a trusted connection reference and Temporal source task queue');
const runtime=await connectorClient(config.temporal);
try {
 const result=await startSlackCapture(runtime.client,{reference,taskQueue:config.temporal.taskQueue,runId,mode:mode as SlackCaptureRequest['mode'],cutoff:config.cutoff,references:config.references});
 console.log(JSON.stringify(result));if(!result.submitted)process.exitCode=2;
} finally {await runtime.connection.close();}
