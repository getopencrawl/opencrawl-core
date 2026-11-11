import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker,Runtime,DefaultLogger} from '@temporalio/worker';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createLibraryApi} from '../dist/src/sessions/library-http.mjs';
import {createSessionDeletionRequests} from '../dist/src/sessions/deletion-requests.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {buildSessionWorkflows,createSessionWorker} from '../dist/src/sessions/temporal/worker.mjs';
import {startSessionDeletion,ensureSessionDeletionSchedule} from '../dist/src/sessions/temporal/client.mjs';
import {fixture,owner,batch} from './session-deletion-fixture.mjs';

const session={harness:'codex',sessionId:'native-session'};
const pause=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('request acceptance persists owner-authorized intent before revocation; no raw cleanup or provider error reaches the UI',async()=>{
  const f=fixture();await f.upload(batch());let submissions=0,erased=0;
  f.store.purgePrefix=async()=>{erased++;throw Error('must run on worker');};
  const library=createSessionLibrary({...f.options,scheduleDeletion:async()=>{submissions++;throw Error('TEMPORAL_PROVIDER_PRIVATE_BODY');}});
  const api=createLibraryApi({sessions:library});
  await assert.rejects(api({...owner,captureAccess:'write'},'sessions/delete',session),{status:403});
  await assert.rejects(api({...owner,userId:'intruder'},'sessions/delete',session),{status:404});
  const accepted=await api(owner,'sessions/delete',session);
  assert.equal(accepted.deleted,false);assert.equal(accepted.pending,true);assert.equal(erased,0);assert.equal(submissions,1);
  assert.equal((await f.search.search(owner)).hits.length,0);
  assert.equal((await f.ingest.putBatch(owner,batch())).discarded,'session_deleted');
  const requests=createSessionDeletionRequests(f.options),page=await requests.list();assert.equal(page.keys.length,1);
  assert.deepEqual((await requests.read(page.keys[0])).owner,owner);
  await api(owner,'sessions/delete',session);assert.equal((await requests.list()).keys.length,1);
  assert.equal((await library.list(owner)).deletions,undefined);
});

test('request storage failures do not expose provider details or masquerade as user access denial',async()=>{
  for(const boundary of ['/_deletions/v1/','/controls/sessions/']) {
    const f=fixture();await f.upload(batch());const compareAndSet=f.store.compareAndSet;
    f.store.compareAndSet=async(key,...args)=>{if(key.includes(boundary))throw Object.assign(Error('PRIVATE_STORAGE_PROVIDER_BODY'),{status:403,code:'AccessDenied'});return compareAndSet(key,...args);};
    let submissions=0;const library=createSessionLibrary({...f.options,scheduleDeletion:async()=>{submissions++;}});
    await assert.rejects(library.requestDeletion(owner,session),error=>{
      assert.equal(error.status,503);assert.doesNotMatch(error.message,/PRIVATE_STORAGE_PROVIDER_BODY|AccessDenied/);return true;
    });
    assert.equal(submissions,0);assert.equal((await createControls(f.options).read(owner,'sessions','codex',session.sessionId)),null);
    // An intent written before a failed tombstone remains available to recovery.
    assert.equal((await createSessionDeletionRequests(f.options).list()).keys.length,boundary.includes('controls')?1:0);
  }
});

test('deletion intent scope includes source, tenant, owner and harness; malformed queued records cannot select a principal',async()=>{
  const f=fixture(),requests=createSessionDeletionRequests(f.options);
  const keys=await Promise.all([owner,{...owner,tenantId:'other'},{...owner,userId:'other'}].map(p=>requests.put(p,session)));
  keys.push(await requests.put(owner,{...session,harness:'claude-code'}));assert.equal(new Set(keys).size,4);
  await assert.rejects(requests.read('sessions/other/_deletions/v1/'+keys[0].split('/').at(-1)),/scope denied/);
  const saved=JSON.parse((await f.store.get(keys[0])).toString());saved.owner.userId='forged';await f.store.put(keys[0],Buffer.from(JSON.stringify(saved)));
  await assert.rejects(requests.read(keys[0]),/identity mismatch/);
});

test('real Temporal deletion retries, survives worker replacement, recovers unsent intents, deduplicates and replays without content',{
  skip:process.env.OPENCRAWL_TEST_TEMPORAL!=='1',timeout:180000,
},async t=>{
  Runtime.install({logger:new DefaultLogger('ERROR')});
  const directory=await mkdtemp(join(tmpdir(),'opencrawl-deletion-temporal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const env=await TestWorkflowEnvironment.createLocal();t.after(()=>env.teardown());
  const bundlePath=join(directory,'workflows.cjs');await buildSessionWorkflows(bundlePath);
  const f=fixture(),peer={...owner,userId:'peer'},other={...owner,tenantId:'other'};
  await f.upload(batch({events:[{id:'event',kind:'message',data:{role:'user',content:'PRIVATE_TRANSCRIPT_SENTINEL'}}]}));
  await f.upload(batch({owner:peer}));await f.upload(batch({owner:other}));
  const config={sourceId:'deletion-fixture',taskQueue:'deletion-fixture'};
  const firstAttempt=pause();let archives=0;
  const binding={...f.options,purgeCopies:async()=>{archives++;if(archives===1){firstAttempt.resolve();throw Object.assign(Error('PRIVATE_PROVIDER_BODY'),{status:403,code:'AccessDenied'});}return 0;}};
  const resolveDeletion=async input=>{if(input.sourceId!==config.sourceId)throw Object.assign(new Error('denied'),{permanent:true});return binding;};
  const workerOptions={address:env.address,namespace:'default',taskQueue:config.taskQueue,bundlePath,resolve:async()=>{throw Error('not indexing');},resolveDeletion,maxConcurrentActivityTaskExecutions:1};
  const writeStarted=pause(),releaseWrite=pause(),put=f.store.put;
  f.store.put=async(key,bytes,type)=>{if(key.endsWith('.json.gz')){writeStarted.resolve();await releaseWrite.promise;}return put(key,bytes,type);};
  const lateUpload=createSessionIngest(f.options).putBatch(owner,batch({installationId:'late',events:[{id:'late',kind:'message',data:{content:'PRIVATE_TRANSCRIPT_SENTINEL'}}]}));
  await writeStarted.promise;t.after(()=>releaseWrite.resolve());
  let workflowId;
  const api=createLibraryApi({sessions:createSessionLibrary({...f.options,scheduleDeletion:async key=>{workflowId=await startSessionDeletion(env.client,{...config,key});}})});
  // Queue while no worker runs: immediate access revocation is independent of execution.
  await api(owner,'sessions/delete',session);assert.ok(workflowId);
  await api(owner,'sessions/delete',session);
  const requests=createSessionDeletionRequests(f.options),key=(await requests.list()).keys[0];
  assert.equal(await startSessionDeletion(env.client,{...config,key}),workflowId);
  const handle=env.client.workflow.getHandle(workflowId);
  let runtime=await createSessionWorker(workerOptions);
  await runtime.worker.runUntil(async()=>{
    let waiting=false;
    for(let i=0;i<100;i++){const status=await handle.describe();waiting=status.raw.pendingActivities?.some(a=>a.lastFailure?.applicationFailureInfo?.type==='SessionDeletionWritesPending');if(waiting)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(waiting,'Temporal retries a held writer without user action');assert.equal(archives,0);
    releaseWrite.resolve();await lateUpload;f.store.put=put;
    await firstAttempt.promise;
  });await runtime.connection.close();
  assert.equal(archives,1);assert.equal((await createControls(f.options).read(owner,'sessions','codex',session.sessionId)).deletion.state,'pending');
  // Replace the worker while the activity is waiting for its retry. Temporal owns the continuation.
  runtime=await createSessionWorker(workerOptions);
  assert.deepEqual(await runtime.worker.runUntil(()=>handle.result()),{completed:true});await runtime.connection.close();
  assert.equal(archives,2);assert.equal((await requests.list()).keys.length,0);
  const control=await createControls(f.options).read(owner,'sessions','codex',session.sessionId);assert.equal(control.deletion.state,'complete');
  assert.equal((await f.search.search(peer)).hits.length,1);assert.equal((await f.search.search(other)).hits.length,1);
  assert.equal((await f.ingest.putBatch(owner,batch({installationId:'new-install'}))).discarded,'session_deleted');
  const history=await handle.fetchHistory(),raw=JSON.stringify(history);
  assert.doesNotMatch(raw,/PRIVATE_TRANSCRIPT_SENTINEL|PRIVATE_PROVIDER_BODY/);
  function inspectPayloads(value) {
    if(value instanceof Uint8Array)assert.doesNotMatch(Buffer.from(value).toString(),/PRIVATE_TRANSCRIPT_SENTINEL|PRIVATE_PROVIDER_BODY/);
    else if(value&&typeof value==='object')for(const child of Object.values(value))inspectPayloads(child);
  }
  inspectPayloads(history);
  await Worker.runReplayHistory({workflowBundle:{codePath:bundlePath}},history);
  // A crash after intent persistence but before tombstone/Temporal submission is recovered without a browser.
  // A request that raced completion may have recreated this same intent.
  await requests.put(owner,session);
  const lostKey=await requests.put(peer,session);
  // Accepted authority survives search reindexing before revocation is written.
  for(const [id,doc] of f.docs)if(doc.tenantId===peer.tenantId&&doc.userId===peer.userId)f.docs.delete(id);
  const scheduleId=await ensureSessionDeletionSchedule(env.client,config);
  assert.equal(await ensureSessionDeletionSchedule(env.client,config),scheduleId);
  const schedule=env.client.schedule.getHandle(scheduleId);await schedule.pause('test owns trigger');
  let description;
  for(let i=0;i<50;i++){description=await schedule.describe();if(description.info.recentActions.length)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(description.spec.intervals[0].every,60000);
  const recovery=env.client.workflow.getHandle(description.info.recentActions.at(-1).action.workflow.workflowId);
  runtime=await createSessionWorker(workerOptions);
  await runtime.worker.runUntil(async()=>{
    await recovery.result();
    assert.deepEqual(await env.client.workflow.getHandle(workflowId).result(),{completed:true});
    const recovered=env.client.workflow.getHandle('session-delete-v1-'+lostKey.split('/').at(-1).slice(0,-5));
    assert.deepEqual(await recovered.result(),{completed:true});
  });await runtime.connection.close();
  assert.equal((await requests.list()).keys.length,0);assert.equal((await f.search.search(peer)).hits.length,0);
  assert.equal((await f.search.search(other)).hits.length,1);await schedule.delete();
  // Forged source binding is rejected before any object-store work.
  const bad=await env.client.workflow.start('deleteSessionV1',{workflowId:'wrong-source',taskQueue:config.taskQueue,args:[{sourceId:'forged',key:lostKey}]});
  runtime=await createSessionWorker(workerOptions);
  await assert.rejects(runtime.worker.runUntil(()=>bad.result()));await runtime.connection.close();
});
