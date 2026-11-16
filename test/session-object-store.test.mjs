import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {applicationStateSettings} from '../dist/src/state/settings.mjs';
import {migrateApplicationState} from '../dist/src/state/migrate.mjs';
import {standaloneEventIdentities} from '../dist/src/sessions/postgres-identities.mjs';
import {signRequest} from '../dist/src/sessions/s3-store.mjs';
import {sessionStorage} from '../dist/src/sessions/storage.mjs';
import {startStandaloneCapture} from '../dist/tools/test-fixtures/capture.mjs';
import {digest,sessionScope} from '../dist/src/sessions/ingest.mjs';

test('self-hosted startup requires object storage and rejects incomplete or obsolete configuration',()=>{
  assert.throws(()=>sessionStorage({}),/BUCKET is required/);
  assert.throws(()=>sessionStorage({OPENCRAWL_SESSION_DIRECTORY:'/old/data'}),/Migrate existing objects/);
  assert.throws(()=>sessionStorage({OPENCRAWL_LANDING_S3_BUCKET:'capture',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'key'}),/Set both/);
  assert.throws(()=>sessionStorage({OPENCRAWL_LANDING_S3_BUCKET:'capture',OPENCRAWL_LANDING_S3_PATH:'../other'}),/Invalid/);
});

test('self-hosted S3 receiver round-trips all four surfaces, attachments and restart readback',{
  skip:!process.env.OPENCRAWL_TEST_S3_ENDPOINT||!process.env.OPENCRAWL_TEST_POSTGRES_URL,
},async t=>{
  const run=randomUUID(),namespace='s3-capture-'+run;
  const directory=await mkdtemp(join(tmpdir(),'opencrawl-capture-state-'));
  const env={
    OPENCRAWL_DATABASE_URL:process.env.OPENCRAWL_TEST_POSTGRES_URL,
    OPENCRAWL_LANDING_S3_ENDPOINT:process.env.OPENCRAWL_TEST_S3_ENDPOINT,
    OPENCRAWL_LANDING_S3_BUCKET:'capture-'+run,
    OPENCRAWL_APP_STATE_NAMESPACE:namespace,OPENCRAWL_EVENT_IDENTITY_NAMESPACE:namespace,
    OPENCRAWL_ORGANIZATION_ID:'org_capturetest',
    OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:process.env.OPENCRAWL_TEST_S3_ACCESS_KEY_ID||'capture-test',
    OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:process.env.OPENCRAWL_TEST_S3_SECRET_ACCESS_KEY||'capture-test-secret',
    OPENCRAWL_LANDING_S3_PATH:'sessions/test/v1/'+randomUUID(),
    OPENCRAWL_SESSIONS_TOKEN:'capture-test-token-01234567890123456789',
    // Capture must start and accept data while processing dependencies are unavailable.
    OPENCRAWL_OPENSEARCH_URL:'http://127.0.0.1:1',TEMPORAL_ADDRESS:'127.0.0.1:1',
    OPENCRAWL_TENANT_ID:'org_capturetest',OPENCRAWL_USER_ID:'owner',PORT:'0',
  };
  const {store,prefix}=sessionStorage(env);
  const credentials={accessKeyId:env.OPENCRAWL_LANDING_S3_ACCESS_KEY_ID,secretAccessKey:env.OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY};
  let server,created=false;
  async function bucket(method){
    const url=new URL(env.OPENCRAWL_LANDING_S3_ENDPOINT+'/'+env.OPENCRAWL_LANDING_S3_BUCKET+'/');
    const response=await fetch(url,{method,headers:signRequest({method,url,region:'us-east-1',...credentials})});
    assert.ok(response.ok,method+' fixture bucket failed: '+response.status);
  }
  // Register before the database fixture: stop API clients before removing its
  // isolated SQL namespace, and remove only this test's generated bucket/files.
  t.after(async()=>{
    if(server?.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    if(created){await store.purgePrefix(prefix+'/');await bucket('DELETE');}
    await rm(directory,{recursive:true,force:true});
  });
  for(let attempt=0;;attempt++) {
    try{await bucket('PUT');created=true;await store.checkAccess();break;}
    catch(error){if(attempt===30)throw error;await new Promise(r=>setTimeout(r,1000));}
  }
  const {source}=applicationStateSettings(env),database=await applicationDatabaseFixture(t,{namespace,sourceIdentity:source});
  await assert.rejects(startStandaloneCapture(env),/migration is incomplete/);
  const eventIdentities=standaloneEventIdentities(store,env);
  try{
    const migrated=await migrateApplicationState({database,store,source,eventIdentities,mode:'migrate',organizationId:env.OPENCRAWL_ORGANIZATION_ID,
      url:'http://localhost:8093',secret:'capture-migration-test-only-secret-32',identityPath:join(directory,'identity.sqlite'),registryPath:join(directory,'integrations.sqlite')});
    assert.equal(migrated.ready,true);assert.equal(migrated.fresh,true);
  }finally{await eventIdentities.close();}
  server=await startStandaloneCapture(env);
  let api='http://127.0.0.1:'+server.address().port;
  const headers={authorization:'Bearer '+env.OPENCRAWL_SESSIONS_TOKEN};
  const owner={tenantId:env.OPENCRAWL_TENANT_ID,userId:env.OPENCRAWL_USER_ID};
  const attachment=Buffer.from('same attachment bytes on all four surfaces'),sha=digest(attachment);
  const receipts=[];
  assert.equal((await fetch(api+'/api/sessions/identity')).status,401);
  let response=await fetch(api+'/api/sessions/attachments/'+sha,{method:'PUT',headers,body:attachment});
  assert.equal(response.status,409); // Legacy unscoped writes cannot bypass deletion.
  for(const harness of ['claude-code','codex'])for(const origin of ['cli','desktop']){
    const batch={schemaVersion:1,owner,installationId:'installation',sessionId:harness+'-'+origin,harness,origin,
      events:[{id:'event',kind:'message',data:{role:'user',content:[{type:'opencrawl_attachment',sha256:sha}]}}],
      attachments:[{status:'captured',sha256:sha,size:attachment.length}]};
    response=await fetch(api+'/api/sessions/attachments/'+sha+'?'+new URLSearchParams({harness,installationId:batch.installationId,sessionId:batch.sessionId}),{method:'PUT',headers,body:attachment});
    assert.equal(response.status,200);
    const send=body=>fetch(api+'/api/sessions/batches',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
    response=await send(batch);assert.equal(response.status,200);
    const receipt=(await response.json()).data;
    assert.deepEqual((await (await send(batch)).json()).data,receipt);
    assert.equal((await send({...batch,owner:{...owner,userId:'other'}})).status,403);
    const key=`${prefix}/${sessionScope(owner)}/${harness}/${digest(batch.installationId)}/${digest(batch.sessionId)}/${receipt.batchId}.json.gz`;
    assert.equal(JSON.parse(gunzipSync(await store.get(key))).origin,origin);
    receipts.push({harness,origin,installationId:batch.installationId,sessionId:batch.sessionId,batchId:receipt.batchId});
  }
  assert.equal(await store.get(`${prefix}/${sessionScope(owner)}/attachments/${sha}`),null);
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  server=await startStandaloneCapture(env);api='http://127.0.0.1:'+server.address().port;
  for(const {origin,...receipt} of receipts){
    response=await fetch(api+'/api/sessions/batches?'+new URLSearchParams(receipt),{headers});
    assert.equal(response.status,200);
    const batch=(await response.json()).data;
    assert.equal(batch.origin,origin);assert.equal(batch.attachments[0].sha256,sha);
  }
  const keys=(await store.list(prefix+'/')).keys;
  assert.equal(keys.length,8); // Four immutable batches and four session-scoped attachments.
  assert.ok(keys.every(key=>key.endsWith('.json.gz')||key.includes('/attachments/')));
  const ledgers=await database.pool.query('SELECT count(*) AS count FROM opencrawl_event_identity_sessions WHERE namespace=$1',[namespace]);
  assert.equal(Number(ledgers.rows[0].count),4);
  const status=await (await fetch(api+'/api/onboarding',{headers})).json();
  assert.equal(status.data.session.harness,'codex');
  assert.ok(status.data.session.observedAt);
  assert.equal(status.data.cli,null);
  assert.equal(status.data.mcp,null);
  await assert.rejects(startStandaloneCapture({...env,OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'wrong'}),/403|Signature|AccessDenied/);
});
