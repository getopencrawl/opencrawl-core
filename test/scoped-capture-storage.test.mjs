import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {memorySessionStore} from './session-store-fixture.mjs';
import {scopedCaptureStorage} from '../dist/src/sessions/s3-store.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');

test('two workspace destinations share trusted controls and reject unreceipted or modified raw content',async()=>{
  const control=memorySessionStore(),raw=memorySessionStore();
  const prefix='sessions/production/v1', owner={tenantId:'org_Customer',userId:'user_A'}, other={tenantId:'org_Managed',userId:'user_A'};
  let unavailable=false;
  const store=scopedCaptureStorage(control,prefix,async tenant=>{
    if(tenant!==sha(owner.tenantId))return null;
    if(unavailable)throw new Error('credentials unavailable');return raw;
  });
  const indexing=[],ingest=createSessionIngest({store,prefix,scheduleIndexing:async key=>indexing.push(key)});
  const session={harness:'codex',installationId:'machine',sessionId:'shared-local-id'}, bytes=Buffer.from('a private attachment');
  const batch=who=>({...session,owner:who,schemaVersion:1,origin:'cli',attachments:[{status:'captured',sha256:sha(bytes)}],events:[{id:'one',kind:'message',data:{role:'user',text:'some customer content'}}]});
  for(const who of [owner,other]){
    await ingest.putAttachment(who,sha(bytes),bytes,session);
    await ingest.putBatch(who,batch(who));
  }
  const [key,legacy]=indexing;
  assert.match((await control.get(key)).toString(),/^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(gunzipSync(await control.get(legacy))).owner.tenantId,other.tenantId);
  assert.equal(JSON.parse(gunzipSync(await store.get(key))).owner.tenantId,owner.tenantId);
  assert.equal([...raw.data].filter(([,v])=>v.equals(bytes)).length,1);
  const snapshot={schemaVersion:1,owner,installationId:'machine',host:'fixture',harness:'codex',generation:Date.now(),files:[{path:'memories/MEMORY.md',project:'',modifiedAt:'2026-11-07T00:00:00Z',text:'customer memory'}]};
  await ingest.putMemorySnapshot(owner,snapshot);
  const memory=indexing.at(-1),calls=[];
  await createSessionPipeline({store,prefix,principal:owner,search:{identity:'test',memories:{putSnapshot:async(...args)=>{calls.push(args);return 1;}}}}).processObject({key:memory});
  assert.equal(calls.length,1);
  const object=key+'/content-'+(await control.get(key)).toString(), original=await raw.get(object);
  await raw.put(object,Buffer.from('rewritten'));await assert.rejects(store.get(key),/differs/);
  await raw.put(object,original);
  const forged=key.replace(/[^/]+$/,'f'.repeat(64)+'.json.gz');
  await raw.put(forged,original);
  assert.equal(await store.get(forged),null);
  assert.ok(!(await store.listPage(key.slice(0,key.lastIndexOf('/')+1))).keys.includes(forged));
  unavailable=true;await assert.rejects(ingest.putBatch(owner,batch(owner)),/credentials unavailable/);
  unavailable=false;await ingest.putBatch(owner,batch(owner));
  await store.purgePrefix(key.slice(0,key.lastIndexOf('/')+1),{select:k=>k===key});
  assert.equal(await raw.get(object),null);assert.equal(await control.get(key),null);
  assert.ok(await control.get(legacy));assert.ok(await store.get(memory));
});
