import type {ConnectorBinding} from './types.mjs';
import type {MessageReference} from './capture-types.mjs';
import {guardConnectorWrites} from './write-barrier.mjs';
import {applicationDatabase} from '../state/settings.mjs';
import {createSlackRunCheckpoints} from '../state/slack-run-checkpoints.mjs';
import {readFile} from 'node:fs/promises';
import {createObjectStore,awsCredentials} from '../sessions/s3-store.mjs';
import {createSlackMessageCapture} from './slack-source-messages.mjs';
import {createSlackMessageReferenceCapture} from './slack-source-message-references.mjs';
import {createSlackFileCapture} from './slack-source-files.mjs';
import {createSlackHttpSource} from './slack-source-http.mjs';
// A stable run ID resumes the same scoped checkpoint after process interruption.
const [configPath,runId,mode='files']=process.argv.slice(2);
if(!configPath||!runId||!['files','messages','references'].includes(mode))throw new Error('Usage: SLACK_TOKEN=... node dist/src/connectors/slack-source-standalone.mjs config.json run-id [files|messages|references]');
const config=JSON.parse(await readFile(configPath,'utf8')) as {binding: ConnectorBinding; s3: Parameters<typeof createObjectStore>[0]; cutoff: number; references: MessageReference[]};
const store=createObjectStore({...config.s3,credentials:awsCredentials()});await store.checkAccess();
if(mode!=='references'&&!Number.isSafeInteger(config.cutoff))throw new Error('Set a stable capture cutoff in epoch milliseconds in the config');
const database=applicationDatabase();
try {
  const checkpointSource=createSlackRunCheckpoints(database).source({environment:'selfhost',binding:config.binding,bucket:store.bucket});
  const guarded=guardConnectorWrites({binding:config.binding,store});
  if ((await guarded.writeBarrier.inspect()).closed) throw new Error('Slack source connection is closed');
  await checkpointSource.adopt(store);
  const constructors={files:createSlackFileCapture,messages:createSlackMessageCapture,references:createSlackMessageReferenceCapture};
  const capture=constructors[mode as keyof typeof constructors]({binding:config.binding,checkpoints:checkpointSource.checkpoints,
    ...guarded,...createSlackHttpSource({token:process.env.SLACK_TOKEN,workspaceId:config.binding.workspaceId})});
  for(;;){
    const result=await capture.step({runId,cutoff:config.cutoff,references:config.references});
    if(result.done){console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;break;}
    if(result.waitMs)await new Promise(resolve=>setTimeout(resolve,result.waitMs));
  }
} finally {await database.close();}
