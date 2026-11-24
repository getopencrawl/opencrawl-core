import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createObjectStore} from '../dist/src/sessions/s3-store.mjs';
import {countCheckpointKey,readLegacyCountSnapshot,openCountSnapshot} from '../dist/src/connectors/count-snapshot.mjs';

const connectionId='int_'+'a'.repeat(26);
const rawPrefix='raw/v1/source=slack/workspace=T1/connection='+connectionId+'/';
const checkpoint=countCheckpointKey(connectionId);
const key=(stream,part)=>rawPrefix+'stream='+stream+'/date=2026-01-01/sync=8/'+part+'.jsonl.gz';
const hashes=['abcdefghijkl','ABCDEFGHIJKL','123456789012'];
const digest=b=>createHash('sha256').update(b).digest('hex');
function legacy(fields={}) {return {version:1,ids:{messages:[hashes[0]],empty:[]},read:[key('messages','a')],full:{channels:{sync:8,count:3},users:{sync:null,count:25}},...fields};}
function setup(initial=legacy()) {
  let bytes=initial===null ? null : gzipSync(JSON.stringify(initial)),writes=0;
  const options={rawPrefix,connectionId,store:{
    async readVersion(k,{maxBytes}){
      assert.equal(k,checkpoint);if(bytes)assert.ok(bytes.length<=maxBytes);
      return {data:bytes,version:bytes?digest(bytes):null};
    },
    async compareAndSet(k,expected,data,{signal,contentType}){
      assert.equal(k,checkpoint);assert.ok(signal instanceof AbortSignal);assert.equal(contentType,'application/gzip');
      if ((bytes?digest(bytes):null)!==expected) return false;
      bytes=Buffer.from(data);writes++;return true;
    },
  }};
  return {options,get writes(){return writes;},saved(){return JSON.parse(gunzipSync(bytes));}};
}
test('the original gzip stays readable across checkpoints, including rollback during a finished full-refresh scan',async()=>{
  const store=setup();
  const prior=await readLegacyCountSnapshot(store.options);
  assert.deepEqual(prior.counts,{channels:3,empty:0,messages:1,users:25});
  assert.equal(store.writes,0);
  const state=await openCountSnapshot(store.options);
  assert.equal(state.dirty,false);const same=await state.prepareSave();await same.write();
  assert.equal(same.pointer,prior.pointer);assert.equal(store.writes,0);
  assert.equal(state.hasPart('messages',null,key('messages','a')),true);
  state.selectFull('channels',8,true,'scan-A');assert.equal(state.hasPart('channels',8,key('channels','new')),true);
  state.selectFull('channels',9,true,'scan-A');
  await state.withPart('channels',9,key('channels','a'),async add=>add(hashes[2]));
  await assert.rejects(state.withPart('messages',null,key('messages','b'),async add=>{add(hashes[1]);throw Error('part truncated');}),/part truncated/);
  assert.equal(state.hasPart('messages',null,key('messages','b')),false);
  await state.withPart('messages',null,key('messages','b'),async add=>{add(hashes[0]);add(hashes[1]);add(hashes[1]);});
  const partial=await state.prepareSave();await partial.write();
  // This is exactly what an old API process reads after rollback.
  const v1=store.saved();
  assert.equal(v1.version,1);assert.deepEqual(v1.full.channels,{sync:8,count:3});
  assert.deepEqual(v1.read,[key('messages','a'),key('messages','b')]);
  assert.deepEqual(v1.ids.messages,hashes.slice(0,2));
  const resumed=await openCountSnapshot(store.options);
  resumed.selectFull('channels',9,true,'scan-A');
  assert.equal(resumed.hasPart('channels',9,key('channels','a')),true);
  await resumed.withPart('channels',9,key('channels','b'),async add=>add(hashes[0]));
  resumed.finalize();const completed=await resumed.prepareSave();await completed.write();
  assert.deepEqual(store.saved().full.channels,{sync:9,count:2});
  assert.deepEqual((await readLegacyCountSnapshot(store.options)).counts,{channels:2,empty:0,messages:2,users:25});
});
test('an interrupted S3-success/SQL-failure adopts the current object; stale CAS and semantic ABA cannot overwrite it',async()=>{
  const store=setup(null);
  assert.equal(await readLegacyCountSnapshot(store.options),null);
  const stale=await openCountSnapshot(store.options),first=await openCountSnapshot(store.options);
  for(const view of [stale,first])await view.withPart('messages',null,key('messages','a'),async add=>add(hashes[0]));
  const older=await stale.prepareSave(),newer=await first.prepareSave();
  assert.notEqual(older.pointer,newer.pointer);
  await newer.write(); // The following SQL transaction is interrupted.
  await assert.rejects(older.write(),/checkpoint changed/);
  const recovered=await openCountSnapshot(store.options);
  assert.equal(recovered.observedPointer,newer.pointer);
  assert.equal(recovered.hasPart('messages',null,key('messages','a')),true);
  assert.equal(recovered.summary().messages,1);
  await (await recovered.prepareSave()).write();assert.equal(store.writes,1);
});
test('a changed provisional measurement restarts; missing streams cannot finalize a past partial count',async()=>{
  const store=setup();
  const view=await openCountSnapshot(store.options);
  view.selectFull('users',9,false,'scan-A');
  await view.withPart('users',9,key('users','a'),async add=>add(hashes[0]));
  await (await view.prepareSave()).write();
  const next=await openCountSnapshot(store.options);
  next.selectFull('users',9,false,'scan-B');
  assert.equal(next.hasPart('users',9,key('users','a')),false);
  await next.withPart('users',9,key('users','a'),async add=>add(hashes[2]));
  await (await next.prepareSave()).write();
  const noLongerEligible=await openCountSnapshot(store.options);
  noLongerEligible.finalize();await (await noLongerEligible.prepareSave()).write();
  assert.deepEqual(store.saved().full.users,{sync:null,count:25});
  assert.equal(store.saved().pendingFull,undefined);
});
test('unchanged provisional full refresh reads the raw part but performs no object write',async()=>{
  const store=setup(legacy({full:{users:{sync:null,count:2}}}));
  const view=await openCountSnapshot(store.options);
  view.selectFull('users',9,false,'new-scan');
  await view.withPart('users',9,key('users','a'),async add=>{add(hashes[0]);add(hashes[1]);});
  view.finalize();assert.equal(view.dirty,false);
  const prepared=await view.prepareSave();await prepared.write();
  assert.equal(store.writes,0);assert.equal(prepared.pointer,view.observedPointer);
});
test('oversized parts retain the old measurement for a scoped higher-budget retry; malformed or foreign snapshots fail closed',async()=>{
  for(const fields of [{version:2},{read:[key('messages','a').replace('workspace=T1','workspace=T2')]},{ids:{messages:['bad']}},{full:{channels:{sync:8,count:-1}}}]){
    const store=setup(legacy(fields));await assert.rejects(readLegacyCountSnapshot(store.options),/Invalid count snapshot/);assert.equal(store.writes,0);
  }
  const store=setup(),prior=await readLegacyCountSnapshot(store.options);
  async function ingest(view){await view.withPart('messages',null,key('messages','b'),async add=>{for(let i=0;i<6000;i++)add(String(i).padStart(12,'0'));});}
  const limited=await openCountSnapshot({...store.options,maxSnapshotBytes:65536});
  await assert.rejects(ingest(limited),/worker budget/);assert.deepEqual(limited.summary(),prior.counts);assert.equal(store.writes,0);
  const retry=await openCountSnapshot({...store.options,maxSnapshotBytes:131072});
  await ingest(retry);await (await retry.prepareSave()).write();
  assert.equal(retry.summary().messages,6001);
});
test('conditional puts propagate gzip metadata and the caller deadline into the signed S3 fetch',async()=>{
  const abort=new AbortController();let seen;
  const s3=createObjectStore({bucket:'count-fixture',region:'us-west-2',credentials:{accessKeyId:'test',secretAccessKey:'test'},
    fetch:async (_url,init)=>{seen=init;init.signal.throwIfAborted();return new Response(null,{status:200});}});
  abort.abort(Error('test deadline'));
  await assert.rejects(s3.compareAndSet('item',null,Buffer.from('test'),{signal:abort.signal,contentType:'application/gzip'}),/test deadline/);
  assert.equal(seen.signal,abort.signal);assert.equal(seen.headers['if-none-match'],'*');assert.equal(seen.headers['content-type'],'application/gzip');
});
