import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {onlineMigrationReference,onlineMigrationTaskQueue,onlineMigrationSharedTaskQueue} from '../dist/src/state/online-temporal/binding.mjs';
import {startOnlineMigration} from '../dist/src/state/online-temporal/client.mjs';
import {createOnlineMigrationWorker} from '../dist/src/state/online-temporal/worker.mjs';
const binding=()=>({epoch:randomUUID(),sourceId:'s3:'+'a'.repeat(64),targetId:'b'.repeat(64),shards:1});
test('shared queue isolates namespace epoch target while references retain each physical source',()=>{
 const b=binding(),q={namespace:'application-production',epoch:b.epoch,targetId:b.targetId},queue=onlineMigrationSharedTaskQueue(q);
 assert.equal(queue,onlineMigrationSharedTaskQueue({...q}));assert.notEqual(queue,onlineMigrationTaskQueue(b));
 for(const change of [{namespace:'another'},{epoch:randomUUID()},{targetId:'c'.repeat(64)}])assert.notEqual(queue,onlineMigrationSharedTaskQueue({...q,...change}));
 for(const change of [{namespace:''},{namespace:'x\0'},{epoch:'invalid'},{targetId:'bad'},{unknown:true}])assert.throws(()=>onlineMigrationSharedTaskQueue({...q,...change}));
 assert.notEqual(onlineMigrationReference(b,0).bindingId,onlineMigrationReference({...b,sourceId:'dynamodb:'+'d'.repeat(64)},0).bindingId);
});
test('shared client starts unchanged reference workflow and refuses existing wrong-queue execution',async()=>{
 const b=binding(),q={namespace:'application-production',epoch:b.epoch,targetId:b.targetId},queue=onlineMigrationSharedTaskQueue(q),calls=[];
 const client={workflow:{async start(type,options){calls.push({type,...options});return {describe:async()=>({taskQueue:queue})};}}};
 await startOnlineMigration(client,b,0,q);assert.equal(calls[0].type,'migrateApplicationShadowV1');assert.equal(calls[0].taskQueue,queue);assert.deepEqual(calls[0].args,[onlineMigrationReference(b,0)]);
 await assert.rejects(startOnlineMigration(client,b,0,{...q,targetId:'e'.repeat(64)}),/target mismatch/);assert.equal(calls.length,1);
 await assert.rejects(startOnlineMigration({workflow:{start:async()=>({describe:async()=>({taskQueue:onlineMigrationTaskQueue(b)})})}},b,0,q),/another task queue/);
 const old=[];await startOnlineMigration({workflow:{start:async(...args)=>{old.push(args);return {};}}},b,0);assert.equal(old[0][1].taskQueue,onlineMigrationTaskQueue(b));
});
test('router worker validates queue and budgets before preparation or connection',async()=>{
 const b=binding(),queue={namespace:'test',epoch:b.epoch,targetId:b.targetId};let ready=0;const marker=new Error('no connection requested');
 const router={queue,connectionCapacity:8,async ready(){ready++;throw marker;},async advance(){assert.fail();}};
 const input={address:'unused:7233',namespace:'test',bundleCode:'fixture',router};
 await assert.rejects(createOnlineMigrationWorker({...input,router:{...router,queue:{...queue,namespace:''}}}),/queue binding/);assert.equal(ready,0);
 await assert.rejects(createOnlineMigrationWorker({...input,concurrency:8}),/configuration required/);assert.equal(ready,0);
 await assert.rejects(createOnlineMigrationWorker({...input,bundlePath:'/also-a-path'}),/configuration required/);assert.equal(ready,0);
 await assert.rejects(createOnlineMigrationWorker({...input,controller:{}}),/configuration required/);assert.equal(ready,0);
 await assert.rejects(createOnlineMigrationWorker(input),error=>error===marker);assert.equal(ready,1);
});
