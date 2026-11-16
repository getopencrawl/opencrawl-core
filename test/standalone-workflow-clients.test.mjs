import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowExecutionAlreadyStartedError} from '@temporalio/client';
import {startSlackCapture} from '../dist/src/connectors/temporal/source-client.mjs';
import {startConnectorIndexing} from '../dist/src/connectors/temporal/client.mjs';
const reference={tenantId:'org_team',connectionId:'int_connection',userId:'user_owner',s3Bucket:'PRIVATE_BUCKET',apiKey:'PRIVATE_KEY'};
test('standalone submitters copy scoped references only and never serialize runtime configuration',async()=>{
 const requests=[],client={workflow:{start:async(...args)=>{requests.push(args);}}};
 await startConnectorIndexing(client,{reference,taskQueue:'indexing'});
 await startSlackCapture(client,{reference,taskQueue:'source',mode:'files',runId:'run',cutoff:1});
 await startSlackCapture(client,{reference,taskQueue:'source',mode:'references',runId:'refs',references:[{channelId:'C123',ts:'123.000001',text:'PRIVATE_BODY'}]});
 assert.doesNotMatch(JSON.stringify(requests),/PRIVATE/);assert.deepEqual(requests[2][1].args[0].references,[{channelId:'C123',ts:'123.000001'}]);
 assert.equal(requests[1][1].workflowId,requests[2][1].workflowId,'different capture modes cannot overlap on one connection');
});
test('an existing capture is reported without being replaced or claimed as newly submitted',async()=>{
 const client={workflow:{start:async()=>{throw new WorkflowExecutionAlreadyStartedError('already running','type','id');}}};
 assert.equal((await startConnectorIndexing(client,{reference,taskQueue:'indexing'})).submitted,false);
 assert.equal((await startSlackCapture(client,{reference,taskQueue:'source',mode:'messages',runId:'run',cutoff:1})).submitted,false);
 await assert.rejects(startSlackCapture(client,{reference,taskQueue:'source',mode:'messages',runId:'run'}),/cutoff/);
 await assert.rejects(startSlackCapture(client,{reference,taskQueue:'source',mode:'references',runId:'run',references:[{channelId:'D123',ts:'123.000001'}]}),/reference/);
});
