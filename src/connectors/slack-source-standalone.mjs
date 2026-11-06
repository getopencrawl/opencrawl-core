import {readFile} from 'node:fs/promises';
import {createObjectStore,awsCredentials} from '../sessions/s3-store.mjs';
import {createSlackMessageCapture} from './slack-source-messages.mjs';
import {createSlackFileCapture} from './slack-source-files.mjs';
import {createSlackHttpSource} from './slack-source-http.mjs';
// A stable run ID resumes the same scoped checkpoint after process interruption.
const [configPath,runId,mode='files']=process.argv.slice(2);
if(!configPath||!runId||!['files','messages'].includes(mode))throw new Error('Usage: SLACK_TOKEN=... node src/connectors/slack-source-standalone.mjs config.json run-id [files|messages]');
const config=JSON.parse(await readFile(configPath,'utf8'));
const store=createObjectStore({...config.s3,credentials:awsCredentials()});await store.checkAccess();
const capture=(mode==='messages'?createSlackMessageCapture:createSlackFileCapture)({binding:config.binding,store,...createSlackHttpSource({token:process.env.SLACK_TOKEN,workspaceId:config.binding.workspaceId})});
if(!Number.isSafeInteger(config.cutoff))throw new Error('Set a stable capture cutoff in epoch milliseconds in the config');
for(;;){const result=await capture.step({runId,cutoff:config.cutoff});if(result.done){console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;break;}if(result.waitMs)await new Promise(resolve=>setTimeout(resolve,result.waitMs));}
