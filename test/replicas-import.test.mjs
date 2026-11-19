import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createReplicasImport} from '../dist/src/integrations/replicas-import.mjs';
import {replicasImportRequest} from '../dist/src/application/replicas-import-http.mjs';
import {replicasApi} from '../dist/src/integrations/replicas-api.mjs';
import {replicasEvents} from '../dist/src/integrations/replicas-events.mjs';

const principal={tenantId:'org_test',userId:'admin'},organization={id:randomUUID(),name:'Own Replicas'};
const chat={chat_id:randomUUID(),workspace_id:randomUUID(),workspace_name:'Archived workspace',workspace_status:'archived',provider:'claude',title:'Historical example',created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'};
const event=(text,time='2026-10-01T00:00:00Z')=>({type:'claude-user',timestamp:time,payload:{message:{role:'user',content:[{type:'text',text}]}}});
async function fixture(t,{failHandoff=false,answer,schedule=async()=>{}}={}){
  const database=await applicationDatabaseFixture(t),key=randomBytes(32),store=memorySessionStore(),calls=[],handed=[];
  let handoffFails=failHandoff;
  const ingest=createSessionIngest({store,prefix:'history/v1',scheduleIndexing:async key=>{if(handoffFails){handoffFails=false;throw new Error('queue unavailable');}handed.push(key);}}).putBatch;
  const request=async(url,options)=>{
    calls.push(new URL(url));assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Replicas-Api-Version'],'2026-10-07');
    const path=new URL(url);
    const overridden=await answer?.(path);if(overridden)return overridden;
    if(path.pathname.endsWith('whoami'))return Response.json({organization,caller:'organization_api_key'});
    if(path.pathname.endsWith('conversations'))return Response.json({conversations:[chat],total:1,next_cursor:null});
    assert.equal(path.pathname,`/v1/replica/${chat.workspace_id}/history`);
    return Response.json(path.searchParams.has('before_cursor')?{events:[event('older message')],before_cursor:null,total:1,has_more:false}:{events:[event('newer message','2026-10-02T00:00:00Z')],before_cursor:'older',total:1,has_more:true});
  };
  const reopen=()=>createReplicasImport({database,key,ingest,request,schedule});
  return {database,store,calls,handed,reopen,service:reopen()};
}
const job=(id,owner=principal)=>({tenantId:owner.tenantId,id});
async function advance(service,id,owner=principal){await service.advance(job(id,owner));return service.status(owner);}
test('connect verifies read access and hands off before returning; checkpoint survives restart',async t=>{
  const jobs=[],f=await fixture(t,{schedule:async task=>jobs.push(task)});
  const {id,phase}=await f.service.action(principal,{action:'connect',apiKey:'private-org-key'});
  assert.equal(phase,'importing');assert.deepEqual(jobs,[job(id)]);assert.equal(f.calls.at(-1).searchParams.get('limit'),'1');
  const query=()=>f.database.pool.query('SELECT state,credential FROM opencrawl_replicas_imports WHERE namespace=$1',[f.database.namespace]);
  const row=(await query()).rows[0];assert.ok(row.credential);assert.ok(!row.credential.includes(Buffer.from('private-org-key')));assert.ok(!JSON.stringify(row.state).includes('private-org-key'));
  assert.equal(await f.service.advance(job(id,{tenantId:'other'})),true);
  assert.equal((await advance(f.service,id)).events,1);
  const done=await advance(f.reopen(),id);assert.equal(done.phase,'complete');assert.equal(done.events,2);assert.equal(done.imported,1);
  assert.equal((await query()).rows[0].credential,null);
});
test('Temporal rejection rolls back the connection and credential',async t=>{
  const f=await fixture(t,{schedule:async()=>{throw Error('Temporal unavailable');}});
  await assert.rejects(f.service.action(principal,{action:'connect',apiKey:'key'}),/Temporal unavailable/);
  assert.equal(await f.service.status(principal),null);
});
test('failed handoff retains its checkpoint; reconnect fences old activities',async t=>{
  const f=await fixture(t,{failHandoff:true});const connect=()=>f.service.action(principal,{action:'connect',apiKey:'key'});
  const {id}=await connect();await assert.rejects(f.service.advance(job(id)),/queue unavailable/);
  assert.equal((await f.service.status(principal)).events,0);assert.equal((await advance(f.reopen(),id)).events,1);
  await f.service.fail(job(id),'Reconnect to resume.');assert.equal((await f.service.source(principal)).state,'error');
  const resumed=await connect();assert.notEqual(resumed.id,id);assert.equal(resumed.events,1);
  assert.equal(await f.service.advance(job(id)),true);assert.equal((await advance(f.service,resumed.id)).events,2);
});
test('personal keys and upstream bodies never become accepted credentials or exposed error text',async t=>{
  const database=await applicationDatabaseFixture(t),key=randomBytes(32);
  const service=createReplicasImport({database,key,ingest:async()=>{throw new Error('not allowed');},request:async()=>Response.json({organization,caller:'personal_api_key'})});
  await assert.rejects(service.action(principal,{action:'connect',apiKey:'secret'}),/organization API key/);assert.equal(await service.status(principal),null);
  const api=replicasApi('secret',async()=>new Response('upstream secret',{status:403}));await assert.rejects(api.identity(),error=>!error.message.includes('upstream secret')&&error.message.includes('denied'));
});
test('Replicas empty terminal history may omit its cursor; nonterminal pages cannot',async()=>{
  const empty=replicasApi('key',async()=>Response.json({thread_id:null,events:[],total:0,has_more:false}));
  assert.equal((await empty.history(chat)).before_cursor,undefined);
  const malformed=replicasApi('key',async()=>Response.json({events:[event('not terminal')]}));await assert.rejects(malformed.history(chat),/unsupported history format/);
});
test('import HTTP checks exact active admin membership before parsing or accessing state',async()=>{
  let called=false;const imports={action:async()=>{called=true;return {};}};
  const member={userId:principal.userId,organizationId:principal.tenantId,status:'active',role:{slug:'admin'}};
  for(const changed of [{userId:'other'},{organizationId:'other'},{status:'inactive'},{role:{slug:'member'}}]){
    const result=await replicasImportRequest(Readable.from(['{}']),{imports,principal,member:{...member,...changed}});assert.equal(result.status,403);
  }
  assert.equal(called,false);
  assert.equal((await replicasImportRequest(Readable.from(['{"action":"step","id":"bad"}']),{imports,principal,member})).status,400);
});
test('all source events and page fields survive exactly, including identical events and unknown providers',()=>{
  const repeated={type:'future-event',payload:{nested:{unknown:[null,42,{content:'preserve me'}]}}};
  const history={thread_id:'native',events:[event('intermediate'),{type:'codex-item',payload:{item:{type:'toolCall',id:'tool',tool:'read',input:{path:'x'},output:'toolreceipt'}}},repeated,repeated],before_cursor:null,has_more:false,senders:[{id:'sender'}],goal:{text:'full history'},codex_asp_transcript:{turns:[{id:'turn',items:[{type:'future',output:'native turn receipt'}]}]},future_field:{keep:true}};
  for(const provider of ['claude','codex','cursor','muse','pi','opencode','future-agent',null]){
    const conversation={...chat,provider};const records=replicasEvents(conversation,history);
    assert.equal(records.length,6);assert.equal(new Set(records.map(x=>x.id)).size,6);
    assert.deepEqual(records[0].data.replicasPage.response,history);
    assert.deepEqual(records.slice(1,5).map(x=>x.data.replicas.record),history.events);
    assert.deepEqual(records[5].data.replicas.record,history.codex_asp_transcript.turns[0]);
    assert.deepEqual(replicasEvents(conversation,history),records);
  }
  const occurrences={};const a=replicasEvents(chat,{events:[repeated],before_cursor:'older'},occurrences);
  const b=replicasEvents(chat,{events:[repeated],before_cursor:null},occurrences,'older');
  assert.notEqual(a[1].id,b[1].id,'identical source occurrences on separate pages both survive');
});
test('API schema preserves unknown envelope and event fields without injecting defaults',async()=>{
  const history={events:[{unexpected:'record',payload:null}],has_more:false,future:{a:1},senders:[{native:'sender'}]};
  assert.deepEqual(await replicasApi('key',async()=>Response.json(history)).history(chat),history);
});
test('every exported agent is imported; unreadable chats pause without skipping or completing',async t=>{
  let denied=true;const second={...chat,chat_id:randomUUID(),workspace_id:randomUUID(),provider:'muse'};
  const f=await fixture(t,{answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json(url.searchParams.has('cursor')?{conversations:[second],total:2,next_cursor:null}:{conversations:[chat],total:2,next_cursor:'second-page'});
    if(url.pathname.endsWith('/history'))return denied?new Response('',{status:404}):Response.json({events:[{type:'muse-event',payload:{output:'complete retained event'}}],before_cursor:null});
  }});
  await assert.rejects(f.service.action(principal,{action:'connect',apiKey:'key'}),/Team workspace visibility/);
  assert.equal(await f.service.status(principal),null);denied=false;
  let state=await f.service.action(principal,{action:'connect',apiKey:'key'});denied=true;
  await assert.rejects(advance(f.service,state.id,principal),/Team workspace visibility/);
  assert.equal((await f.service.status(principal)).processed,0);assert.equal((await f.service.status(principal)).events,0);
  denied=false;
  for(let i=0;i<5&&state.phase!=='complete';i++)state=await advance(f.service,state.id,principal);
  assert.equal(state.phase,'complete');assert.equal(state.processed,2);assert.equal(state.imported,2);assert.equal(state.events,2);assert.equal(state.pages,2);
});
test('repeated history cursors and transient failures cannot advance or duplicate a checkpoint',async t=>{
  let failure=false;
  const f=await fixture(t,{answer:url=>{
    if(url.pathname.endsWith('/history'))return failure?new Response('do not expose secret',{status:500}):Response.json({events:[event('one')],before_cursor:'same'});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});await advance(f.service,id,principal);
  await assert.rejects(advance(f.service,id,principal),/repeated a history cursor/);assert.equal((await f.service.status(principal)).events,1);
  failure=true;await assert.rejects(advance(f.service,id,principal),/could not read/);assert.equal((await f.service.status(principal)).events,1);assert.equal(f.handed.length,1);
});
test('the same Replicas chat imported into two tenants gets separate immutable paths and owners',async t=>{
  const f=await fixture(t);
  for(const tenantId of ['org_a','org_b']){
    const owner={...principal,tenantId};let state=await f.service.action(owner,{action:'connect',apiKey:'key'});
    while(state.phase!=='complete')state=await advance(f.service,state.id,owner);
  }
  assert.equal(new Set(f.handed).size,4);assert.notEqual(f.handed[0].split('/users/')[0],f.handed[2].split('/users/')[0]);
});

test('full history round-trips through immutable ingest, search and the session library',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');
  const {gunzipSync}=await import('node:zlib');
  const {createSessionSearch}=await import('../dist/src/sessions/search.mjs');
  const {createSessionPipeline}=await import('../dist/src/sessions/indexer.mjs');
  const {createSessionLibrary}=await import('../dist/src/sessions/library.mjs');
  const directory=await mkdtemp(join(tmpdir(),'replicas-history-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const database=await applicationDatabaseFixture(t),store=memorySessionStore(),prefix='full-history/v1';
  const endpoint=pathToFileURL(join(directory,'search.sqlite')).href.replace('file:','sqlite:');
  const options={endpoint,store,prefix},search=createSessionSearch(options),library=createSessionLibrary(options);
  const pipeline=createSessionPipeline({...options,search,resolvePrincipal:async({batch})=>batch.owner});
  const long='output line\n'.repeat(5000)+'lossless_tail_receipt';
  const events=[
    {type:'claude-assistant',timestamp:'2026-10-01T01:00:00Z',payload:{uuid:'claude-1',message:{role:'assistant',content:[{type:'text',text:'intermediate_progress_receipt'},{type:'tool_use',id:'c1',name:'Read',input:{path:'retained_file'}},{type:'thinking',thinking:'retained reasoning',signature:'preserve signature'}]}}},
    {type:'claude-user',timestamp:'2026-10-01T01:01:00Z',payload:{uuid:'claude-2',message:{role:'user',content:[{type:'tool_result',tool_use_id:'c1',content:long},{type:'image',source:{type:'base64',media_type:'image/png',data:'exact-embedded-bytes'}}]},tool_result_meta:{duration:12}}},
    {type:'codex-item',timestamp:'2026-10-01T01:02:00Z',payload:{turnId:'turn',item:{type:'toolCall',id:'call',tool:'search',server:'test',input:{query:'native input'},output:'codex_tool_result_receipt',status:'completed'}}},
    {type:'codex-item',timestamp:'2026-10-01T01:03:00Z',payload:{item:{type:'commandExecution',id:'cmd',command:'echo execution',aggregatedOutput:'command_result_receipt',exitCode:0,status:'completed'}}},
    {type:'future-system',payload:{usage:{input:123},message:'future_event_receipt'}},
    {type:'future-system',payload:{usage:{input:123},message:'future_event_receipt'}},
  ];
  const history={events,before_cursor:null,has_more:false,senders:[{sender_user_id:'native-person'}],history_version:7,goal:{text:'whole session'},codex_asp_transcript:{turns:[{id:'t',items:[{type:'future',output:'asp_turn_receipt'}]}]},unknown:{retained:true}};
  const request=async url=>Response.json(String(url).endsWith('whoami')?{organization,caller:'organization_api_key'}:String(url).includes('organization/conversations')?{conversations:[{...chat,provider:'future-agent'}],total:1,next_cursor:null}:history);
  const service=createReplicasImport({database,schedule:async()=>{},key:randomBytes(32),request,ingest:createSessionIngest({store,prefix,scheduleIndexing:key=>pipeline.processObject({key})}).putBatch});
  async function run(){let s=await service.action(principal,{action:'connect',apiKey:'key'});return advance(service,s.id,principal);}
  const state=await run();assert.equal(state.phase,'complete');assert.equal(state.events,6);assert.equal(state.turns,1);assert.equal(state.pages,1);
  const batches=[...store.data].filter(([key])=>key.endsWith('.json.gz')).map(([,bytes])=>JSON.parse(gunzipSync(bytes)));
  assert.deepEqual(batches.flatMap(b=>b.events).find(e=>e.kind==='replicas_history_page').data.replicasPage.response,history);
  const listed=await library.list(principal,{});assert.equal(listed.sessions.length,1);assert.equal(listed.sessions[0].private,false);assert.equal(listed.sessions[0].harness,'replicas');assert.equal(listed.sessions[0].title,chat.title);
  const read=await library.read(principal,{...listed.sessions[0],limit:200});assert.equal(read.events.length,8);assert.deepEqual(read.events.find(e=>e.kind==='replicas_history_page').raw.response,history);
  assert.equal(read.events.filter(e=>e.raw?.type==='future-system').length,2);
  assert.ok(read.events.some(e=>e.entries.some(x=>x.type==='tool_call'&&x.name==='search')));
  assert.ok(read.events.some(e=>e.entries.some(x=>x.type==='tool_result'&&x.text.includes('codex_tool_result_receipt'))));
  for(const query of ['intermediate_progress_receipt','lossless_tail_receipt','codex_tool_result_receipt','command_result_receipt','future_event_receipt','asp_turn_receipt'])assert.ok((await search.search(principal,{query,includeToolOutputs:true})).hits.length>0,query);
  assert.equal((await search.search(principal,{query:'codex_tool_result_receipt',includeToolOutputs:false})).hits.length,0,'search exclusions classify tool results without deleting capture');
  const originalKeys=[...store.data.keys()].filter(k=>k.endsWith('.json.gz')).sort();await run();assert.deepEqual([...store.data.keys()].filter(k=>k.endsWith('.json.gz')).sort(),originalKeys);
  assert.equal((await library.read(principal,{...listed.sessions[0],limit:200})).events.length,8);
  assert.equal((await library.list({...principal,tenantId:'outside'},{})).sessions.length,0);
});

test('a large page splits into durable batches and a partial handoff retries without losing records',async t=>{
  const database=await applicationDatabaseFixture(t),store=memorySessionStore();const payload='x'.repeat(8*1024*1024);
  const history={events:[{type:'future-tool',payload:{output:payload}}],before_cursor:null};
  let calls=0,fail=true;const ingest=createSessionIngest({store,prefix:'large/v1',scheduleIndexing:async()=>{calls++;if(calls===2&&fail){fail=false;throw Error('second handoff failed');}}}).putBatch;
  const service=createReplicasImport({database,schedule:async()=>{},key:randomBytes(32),ingest,request:async url=>Response.json(String(url).endsWith('whoami')?{organization,caller:'organization_api_key'}:String(url).includes('organization/conversations')?{conversations:[chat],total:1,next_cursor:null}:history)});
  const {id}=await service.action(principal,{action:'connect',apiKey:'key'});
  await assert.rejects(advance(service,id,principal),/second handoff/);assert.equal((await service.status(principal)).events,0);
  const state=await advance(service,id,principal);assert.equal(state.phase,'complete');assert.equal(state.events,1);assert.equal(state.pages,1);
  assert.equal([...store.data.keys()].filter(k=>k.endsWith('.json.gz')).length,2);
});

test('duplicate catalog entries preserve their metadata while counting one distinct session',async t=>{
  const f=await fixture(t,{answer:url=>url.pathname.endsWith('conversations')?Response.json({conversations:[chat,{...chat,title:'Another catalog label',provider:'future-agent'}],total:2,next_cursor:null}):url.pathname.endsWith('history')?Response.json({events:[event('same native history')],before_cursor:null}):null});
  let status=await f.service.action(principal,{action:'connect',apiKey:'key'});
  for(let i=0;i<2;i++)status=await advance(f.service,status.id,principal);
  assert.equal(status.phase,'complete');assert.equal(status.processed,2);assert.equal(status.imported,1);assert.equal(status.pages,2);
  const {gunzipSync}=await import('node:zlib');const events=[...f.store.data].filter(([key])=>key.endsWith('.json.gz')).flatMap(([,bytes])=>JSON.parse(gunzipSync(bytes)).events);
  assert.equal(new Set(events.filter(e=>e.kind!=='replicas_history_page').map(e=>e.id)).size,1);
  assert.deepEqual(new Set(events.filter(e=>e.kind==='replicas_history_page').map(e=>e.data.replicasPage.conversation.title)),new Set([chat.title,'Another catalog label']));
  const card=await f.service.source(principal);
  assert.equal(card.state,'synced');assert.deepEqual(card.units,['conversation record','conversation records']);
  assert.equal(card.synced,2);assert.equal(card.total,2);assert.equal(card.rows.find(row=>row.label==='Sessions').count,1);
  assert.ok(card.rows.every(row=>row.done));
});

test('backfill resolves each authored message from the catalog or history, including previously archived batches',async()=>{
  const {historyActor,replicasSenderEvidence,chunkSenderEvidence}=await import('../dist/src/integrations/replicas-senders.mjs');
  const {participantProjection}=await import('../dist/src/sessions/participants.mjs');
  const first=randomUUID(),second=randomUUID(),native=randomUUID();
  const catalog={...chat,senders:[
    {message_id:'prompt-1',sender_user_id:first,sender_email:'one@example.test'},
    {message_id:native,sender_user_id:second,sender_email:'two@example.test'},
    {message_id:'conflict',sender_user_id:first},
  ]};
  const prompt=(id,content='hello')=>({type:'claude-user',payload:{uuid:randomUUID(),replicasMessageId:id,message:{role:'user',content}}});
  const history={senders:[
    {message_id:'prompt-1',sender_user_id:first,sender_display_name:'Person One'},
    {message_id:'conflict',sender_user_id:second},
  ],events:[prompt('prompt-1'),{type:'codex-item',payload:{item:{id:native,type:'userMessage',content:'hello'}}},prompt('missing'),prompt('conflict'),prompt('prompt-1',[{type:'tool_result',content:'tool output'}])]};
  const events=replicasEvents(catalog,history),batch={harness:'replicas',events,owner:{userId:'workload_replicas_test'}};
  assert.deepEqual(events.slice(1).map(event=>historyActor(event,batch)?.userId),[first,second,undefined,undefined,undefined]);
  const split=events.slice(1,3),metadata=chunkSenderEvidence(split,replicasSenderEvidence(catalog,history).replicasSenders);
  assert.deepEqual(Object.keys(metadata.replicasSenders.senders).sort(),['prompt-1',native].sort());
  assert.equal(historyActor(split[0],{...batch,...metadata,events:split}).name,'Person One');
  assert.equal(participantProjection(events[1],batch).participantName,'Person One');assert.equal(participantProjection(events[2],batch).participantName,'two@example.test');
});

test('an OpenCrawl storage denial retries without attributing it to the Replicas key',async()=>{
  const {replicasActivities}=await import('../dist/src/sessions/temporal/replicas.mjs');
  const {replicasApi}=await import('../dist/src/integrations/replicas-api.mjs');
  const job={tenantId:'team',id:'import'},messages=[];
  const fail=async(_,message)=>{messages.push(message);};
  const internal=replicasActivities({advance:async()=>{throw Object.assign(new Error('private detail'),{status:403});},fail});
  await assert.rejects(internal.importReplicasPage(job),{type:'ReplicasUnavailable',nonRetryable:false});
  assert.deepEqual(messages,[]);
  const denied=replicasApi('fixture',async()=>new Response(null,{status:403}));
  const upstream=replicasActivities({advance:()=>denied.conversations(),fail});
  await assert.rejects(upstream.importReplicasPage(job),{type:'ReplicasAccess',nonRetryable:true});
  assert.equal(messages.length,1);assert.match(messages[0],/Team workspace visibility/);
});

test('a real Temporal worker completes a paginated import after the request ends',async t=>{
  const {TestWorkflowEnvironment}=await import('@temporalio/testing'),{Worker}=await import('@temporalio/worker');
  const {replicasActivities}=await import('../dist/src/sessions/temporal/replicas.mjs');
  const {sessionIndexingScheduler}=await import('../dist/src/sessions/temporal/client.mjs');
  const env=await TestWorkflowEnvironment.createLocal(),taskQueue='replicas-'+randomUUID();
  const scheduler=sessionIndexingScheduler({address:env.address,namespace:env.namespace??'default',taskQueue,sourceId:'history',generation:'v1'});
  t.after(async()=>{await scheduler.close();await env.teardown();});
  const f=await fixture(t,{schedule:scheduler.scheduleReplicasImport,failHandoff:true});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'test-private-key'});
  assert.equal(f.handed.length,0);
  const worker=await Worker.create({connection:env.nativeConnection,namespace:env.namespace??'default',taskQueue,
    workflowsPath:new URL('../dist/src/sessions/temporal/workflows.cjs',import.meta.url).pathname,activities:replicasActivities(f.reopen())});
  const handle=env.client.workflow.getHandle('replicas-history-'+id);
  await worker.runUntil(()=>handle.result());
  const state=await f.service.status(principal);assert.equal(state.phase,'complete');assert.equal(state.events,2);assert.equal(state.pages,2);
  for(const event of (await handle.fetchHistory()).events){
    for(const payload of event.workflowExecutionStartedEventAttributes?.input?.payloads??event.activityTaskScheduledEventAttributes?.input?.payloads??[]){
      assert.deepEqual(JSON.parse(Buffer.from(payload.data).toString()),job(id));
    }
  }
});
