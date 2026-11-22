import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createDevinRecording} from '../dist/src/integrations/devin-recording.mjs';
import {createRecordingPolicy} from '../dist/src/state/recording.mjs';
import {createDevinState} from '../dist/src/state/devin.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {devinOwnerId} from '../dist/src/identity/devin.mjs';
import {Readable} from 'node:stream';
import {devinRecordingRequest} from '../dist/src/application/devin-recording-http.mjs';

const admin = {tenantId:'org_test1',userId:'user_admin'};
const organization = 'org-' + '1'.repeat(32);
const serviceKey = 'cog_test_org_key_for_recording';
const fixture = JSON.parse(await readFile(new URL('./fixtures/devin-first-turn.json',import.meta.url)));
const id = fixture.sessionId;
const start = Date.parse('2026-11-20T00:52:48Z');
const session = {session_id:id,org_id:organization,created_at:start/1000,updated_at:start/1000+18,status:'running',title:null};
const messages = [{event_id:'event-opening',source:'user',message:'Inspect the release package',created_at:start/1000},
  {event_id:'event-answer',source:'devin',message:'The package verified',created_at:start/1000+18}];

test('the console requires explicit recording consent and a current admin in this workspace',async ()=>{
  const member={id:'member1',organizationId:admin.tenantId,userId:admin.userId,status:'active',role:{slug:'admin'}};
  let calls=0;
  const action=async(input,actor=member,principal=admin)=>devinRecordingRequest(Readable.from([Buffer.from(JSON.stringify(input))]),{
    devinRecording:{connect:async()=>{calls++;return {health:'connected'};}},principal,member:actor,
  });
  const input={action:'connect',serviceKey,record:true};
  for(const change of [{status:'inactive'},{organizationId:'org_other'},{userId:'user_other'},{role:{slug:'member'}}])
    assert.equal((await action(input,{...member,...change})).status,403);
  assert.equal((await action(input,member,{...admin,captureAccess:'write'})).status,403);
  assert.equal((await action({...input,record:false})).status,400);
  assert.equal((await action({...input,organizationId:organization})).status,400);
  assert.equal(calls,0);
  assert.equal((await action(input)).status,200);
  assert.equal(calls,1);
});

async function environment(t) {
  const database = await applicationDatabaseFixture(t);
  const dir = await mkdtemp(join(tmpdir(),'devin-recording-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store = createLocalSessionStore(dir);
  const jobs = [], keys = [], events = [], deleted = [];
  const ingest = createSessionIngest({store,prefix:'test',scheduleIndexing:async key=>keys.push(key)});
  const provider = {time:start-1000, async catalog(){return Response.json({items:[session],has_next_page:false});},
    async messages(){return Response.json({items:messages,has_next_page:false});}};
  const request = async (target,init) => {
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+serviceKey);
    const url = new URL(target);
    if (url.pathname === '/v3/self') return Response.json({principal_type:'service_user',org_id:organization});
    if (url.pathname.endsWith('/sessions')) return provider.catalog();
    if (url.pathname.endsWith('/messages')) return provider.messages();
    assert.equal(url.href,'https://mcp.devin.ai/mcp');
    const {id,method,params} = JSON.parse(init.body);
    if (method === 'notifications/initialized') return new Response(null,{status:202});
    let result;
    if (method === 'initialize') result = {protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'devin',version:'1'}};
    else if (method === 'tools/list') result = {tools:[{name:'devin_session_events',inputSchema:{type:'object',properties:{}}}]};
    else {
      assert.equal(method,'tools/call');
      const input = params.arguments;
      const text = input.action === 'list' ? fixture.listLines : fixture.details.find(row=>row.id===input.event_ids[0]).response;
      result = {content:[{type:'text',text}]};
    }
    return Response.json({jsonrpc:'2.0',id,result});
  };
  const options = {database, key:randomBytes(32), audience:'https://oc.test', now:()=>provider.time, request,
    schedule:async job=>jobs.push(job), recording:createRecordingPolicy(database),
    ingest:(owner,batch)=>ingest.putBatch(owner,batch), incognito:async (owner,id)=>deleted.push({owner,id})};
  const pipeline = createSessionPipeline({store,prefix:'test',jobId:'devin-test',
    resolvePrincipal:async ({batch})=>({tenantId:batch.owner.tenantId,userId:batch.owner.userId}),
    search:{identity:'devin-test',ensureIndex:async()=>{},putDocuments:async docs=>events.push(...docs.map(item=>item.document))}});
  return {database,options,provider,jobs,keys,events,deleted,pipeline,recording:createDevinRecording(options)};
}

test('admin consent persists across workers and only indexed sessions count as verified capture',{skip:!postgresUrl},async t=>{
  const {database,options,provider,jobs,keys,events,pipeline,recording} = await environment(t);
  await assert.rejects(recording.connect(admin,serviceKey,async()=>false),{status:403});
  assert.equal(jobs.length,0);
  const connected = await recording.connect(admin,serviceKey);
  const scope = [database.namespace,admin.tenantId];
  assert.equal(connected.health,'connected');
  assert.equal(connected.latestSession,undefined);
  await assert.rejects(recording.connect({...admin,tenantId:'org_other'},serviceKey),{status:409});
  assert.equal(jobs.length,1);
  const saved = (await database.pool.query('SELECT credential FROM opencrawl_devin_api_connections WHERE namespace=$1 AND tenant=$2',scope)).rows[0];
  assert.ok(!saved.credential.includes(Buffer.from(serviceKey)));
  provider.time=start+30000;
  await recording.runStep(jobs[0]); // discover
  const restarted = createDevinRecording(options);
  await restarted.runStep(jobs[0]); // messages
  await restarted.runStep(jobs[0]); // native tool calls and results
  assert.equal(keys.length,2);
  assert.equal((await restarted.status(admin,async()=>false)).latestSession,undefined);
  for (const key of keys) await pipeline.processObject({key});
  const source = await restarted.source(admin,async key=>({events:events.filter(event=>event.sessionId===key.sessionId)}));
  assert.equal(source.devinRecording.latestSession.sessionId,id);
  assert.equal(source.devinRecording.latestSession.userId,devinOwnerId(organization,id));
  for (const kind of ['message','tool_call','tool_result']) assert.ok(events.some(event=>event.kind===kind));
  assert.ok(events.every(event=>event.tenantId===admin.tenantId && event.userId===devinOwnerId(organization,id)));
  provider.time+=5000;
  await restarted.runStep(jobs[0]); await restarted.runStep(jobs[0]);
  assert.equal(keys.length,2,'overlap never writes a second batch for known native IDs');
  assert.equal(await restarted.status({...admin,tenantId:'org_other'}),null);
});

test('disconnect fences an in-flight read and a reconnect starts a fresh consent window',{skip:!postgresUrl},async t=>{
  const {database,recording,provider,jobs,keys} = await environment(t);
  const {generation} = await recording.connect(admin,serviceKey);
  provider.time=start+30000;
  await recording.runStep(jobs[0]);
  const reading=Promise.withResolvers(),resume=Promise.withResolvers();
  provider.messages=async()=>{reading.resolve();await resume.promise;return Response.json({items:messages,has_next_page:false});};
  const inFlight=recording.runStep(jobs[0]);
  await reading.promise;
  const stopped=await recording.disconnect(admin,generation);
  assert.equal(stopped.health,'disconnected');
  resume.resolve();await inFlight;
  assert.equal(keys.length,0);
  assert.equal((await recording.runStep(jobs[0])).done,true);
  const rows=await database.pool.query('SELECT credential FROM opencrawl_devin_api_connections WHERE namespace=$1',[database.namespace]);
  assert.equal(rows.rows[0].credential,null);
  const next=await recording.connect(admin,serviceKey);
  assert.notEqual(next.generation,generation);
  await assert.rejects(recording.disconnect(admin,generation),{status:409});
  assert.equal((await recording.runStep(jobs[0])).done,true);
  await recording.runStep(jobs[1]);await recording.runStep(jobs[1]);
  assert.equal(keys.length,0,'the prior session predates the new grant');
});

test('one grant owns recording across legacy and API paths without duplicating transcripts',{skip:!postgresUrl},async t=>{
  const {database,recording}=await environment(t);
  const legacy=createDevinState(database,randomBytes(32));
  await legacy.ready();
  const approval={schemaVersion:1,tenantId:admin.tenantId,organizationId:organization,approvedBy:admin.userId,
    approvedAt:new Date(start-60000).toISOString(),revokedAt:null,installations:[]};
  assert.equal(await legacy.saveConnection(organization,null,approval),true);
  await assert.rejects(recording.connect({...admin,tenantId:'org_other'},serviceKey),{status:409});
  assert.equal((await legacy.readConnection(organization)).record.revokedAt,null);
  const connected=await recording.connect(admin,serviceKey);
  const previous=await legacy.readConnection(organization);
  assert.ok(previous.record.revokedAt);
  await assert.rejects(legacy.saveConnection(organization,previous.version,approval),{status:409});
  assert.equal((await recording.status(admin)).generation,connected.generation);
});

test('provider cooldown persists through restart and a private opening never enters ingest',{skip:!postgresUrl},async t=>{
  const {recording,options,provider,jobs,keys,deleted}=await environment(t);
  await recording.connect(admin,serviceKey);
  provider.time=start+30000;
  const normal=provider.catalog;
  provider.catalog=async()=>new Response(null,{status:429,headers:{'retry-after':'30'}});
  await recording.runStep(jobs[0]);
  const restarted=createDevinRecording(options);
  assert.equal((await restarted.status(admin)).health,'retrying');
  assert.equal((await restarted.runStep(jobs[0])).delayMs,30000);
  provider.catalog=normal;provider.time+=30000;
  await restarted.runStep(jobs[0]);
  provider.messages=async()=>Response.json({has_next_page:false,items:[{...messages[0],message:'/oc-incognito investigate the package'}]});
  await restarted.runStep(jobs[0]);
  assert.equal(keys.length,0);assert.equal(deleted.length,1);
  assert.equal(deleted[0].owner.userId,devinOwnerId(organization,id));
  assert.equal(deleted[0].id,id);
});
