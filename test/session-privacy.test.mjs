import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {createPrivacyPreferences,redactPrivacyText} from '../dist/src/sessions/privacy.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

test('personal privacy rules, full message bodies, retry, and manual sharing',async()=>{
  const store=memorySessionStore(),prefix='capture',owner={tenantId:'org_dog',userId:'user_one'};
  const other={...owner,userId:'user_two'}, outside={...owner,tenantId:'org_else'};
  const preferences=createPrivacyPreferences(store,prefix,p=>p.tenantId===owner.tenantId&&!p.owner);
  assert.equal((await preferences.read(owner)).enabled,true);
  await preferences.change(owner,{...await preferences.read(owner),rules:'Keep my mobile private'});
  assert.equal((await preferences.read(other)).rules,'');
  await assert.rejects(preferences.read(outside),{status:404});
  const seen=[],documents=new Map(),controls=createControls({store,prefix});
  let retry=false;
  const pipeline=createSessionPipeline({store,prefix,principal:owner,privacy:{preferences,version:'test',score:async(body,rules)=>{
    assert.equal(rules,'Keep my mobile private');seen.push(body);
    if(retry)throw Error('Temporary provider outage');
    return Array.isArray(body)?0.8:0.1;
  }},search:{identity:'test',ensureIndex:async()=>{},putDocuments:async docs=>docs.forEach(d=>documents.set(d.id,d.document)),applySessionControl:async(_owner,key,c)=>{for(const doc of documents.values())if(doc.sessionId===key.sessionId)doc.private=c.visibility==='private';}}});
  let key;
  const ingest=createSessionIngest({store,prefix,privacy:preferences,scheduleIndexing:async value=>{key=value;}});
  const session={harness:'codex',sessionId:'test-session',installationId:'test-installation'};
  async function capture(id,body,overrides={}){
    const result=await ingest.putBatch(owner,{schemaVersion:1,owner,...session,origin:'cli',captureMode:'live',attachments:[],events:[{id,kind:'message',data:{role:'user',content:body}}],...overrides});
    return {...session,batchId:result.batchId,userId:owner.userId};
  }
  const safe=await capture('first','  fix the bug  ');
  assert.equal(await ingest.getBatch(other,safe),null);
  await pipeline.processObject({key});
  assert.ok(await ingest.getBatch(other,safe));
  const full=[{type:'input_text',text:'<send_user_message_question_reply>private phone</send_user_message_question_reply>'}];
  const sensitive=await capture('second',full);
  retry=true;await assert.rejects(pipeline.processObject({key}),/outage/);
  assert.equal(await ingest.getBatch(other,sensitive),null);
  retry=false;await pipeline.processObject({key});
  assert.deepEqual(seen,['  fix the bug  ',full,full]);
  assert.equal(await ingest.getBatch(other,safe),null);
  assert.ok([...documents.values()].every(d=>d.private));
  await controls.update(owner,'sessions',session.harness,session.sessionId,()=>({visibility:'team',visibilitySource:'manual',deletedAt:null}));
  const shared=await capture('third',full);
  await pipeline.processObject({key});
  assert.equal(seen.length,3);
  assert.ok(await ingest.getBatch(other,shared));
});
test('deterministic masking preserves escaped prose and masks escaped credentials',()=>{
  assert.equal(redactPrivacyText('a\\_b ctxt\\_secret\\_Synthetic0123'),'a\\_b [REDACTED]');
  assert.equal(redactPrivacyText('short-literal','password'),'[REDACTED]');
});
