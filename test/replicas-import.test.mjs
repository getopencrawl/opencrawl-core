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
async function fixture(t,{failHandoff=false,answer,schedule=async()=>{},now=Date.now}={}){
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
  const reopen=()=>createReplicasImport({database,key,ingest,request,schedule,now});
  return {database,store,calls,handed,reopen,service:reopen()};
}
const job=(id,owner=principal)=>({tenantId:owner.tenantId,id});
async function advance(service,id,owner=principal){await service.advance(job(id,owner));return service.status(owner);}
test('connect verifies inventory and hands off before returning; checkpoint survives restart',async t=>{
  const jobs=[],f=await fixture(t,{schedule:async task=>jobs.push(task)});
  const {id,phase}=await f.service.action(principal,{action:'connect',apiKey:'private-org-key'});
  assert.equal(phase,'importing');assert.deepEqual(jobs,[job(id)]);assert.ok(f.calls.every(call=>!call.pathname.endsWith('/history')));
  const query=()=>f.database.pool.query('SELECT state,credential FROM opencrawl_replicas_imports WHERE namespace=$1',[f.database.namespace]);
  const row=(await query()).rows[0];assert.ok(row.credential);assert.ok(!row.credential.includes(Buffer.from('private-org-key')));assert.ok(!JSON.stringify(row.state).includes('private-org-key'));
  assert.equal(await f.service.advance(job(id,{tenantId:'other'})),true);
  assert.equal((await advance(f.service,id)).events,1);
  const done=await advance(f.reopen(),id);assert.equal(done.phase,'complete');assert.equal(done.events,2);assert.equal(done.imported,1);
  assert.ok((await query()).rows[0].credential,'daily sync retains the sealed organization key');
});
test('Temporal rejection rolls back the connection and credential',async t=>{
  const f=await fixture(t,{schedule:async()=>{throw Error('Temporal unavailable');}});
  await assert.rejects(f.service.action(principal,{action:'connect',apiKey:'key'}),/Temporal unavailable/);
  assert.equal(await f.service.status(principal),null);
});
test('failed handoff retains its checkpoint; reconnect fences old activities',async t=>{
  let clock=Date.now();
  const f=await fixture(t,{failHandoff:true,now:()=>clock});const connect=()=>f.service.action(principal,{action:'connect',apiKey:'key'});
  const {id}=await connect();const retry=await advance(f.service,id);
  assert.equal(retry.events,0);assert.match(retry.error,/ingest step will retry/);clock=Date.parse(retry.retryAt);
  assert.equal((await advance(f.reopen(),id)).events,1);
  await assert.rejects(f.service.action({...principal,tenantId:'unrelated'},{action:'stop',id}),/already stopped or changed/);
  const stopped=await f.service.action(principal,{action:'stop',id});assert.equal(stopped.phase,'disconnected');
  const stored=await f.database.pool.query('SELECT credential IS NULL AS erased FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);assert.equal(stored.rows[0].erased,true);
  const resumed=await connect();assert.notEqual(resumed.id,id);assert.equal(resumed.events,1);
  assert.equal(await f.service.advance(job(id)),true);assert.equal((await advance(f.service,resumed.id)).events,2);
});
test('personal keys and upstream bodies never become accepted credentials or exposed error text',async t=>{
  const database=await applicationDatabaseFixture(t),key=randomBytes(32);
  const service=createReplicasImport({database,key,ingest:async()=>{throw new Error('not allowed');},request:async()=>Response.json({organization,caller:'personal_api_key'})});
  await assert.rejects(service.action(principal,{action:'connect',apiKey:'secret'}),/organization API key/);assert.equal(await service.status(principal),null);
  const api=replicasApi('secret',async()=>new Response('upstream secret',{status:403}));await assert.rejects(api.identity(),error=>!error.message.includes('upstream secret')&&error.message.includes('HTTP 403'));
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
test('a blocked first chat keeps its cursor and key, later catalog pages import and restart recovers it',async t=>{
  let clock=Date.now(),blocked=true;
  const second={...chat,chat_id:randomUUID(),workspace_id:randomUUID(),provider:'muse'};
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json(url.searchParams.has('cursor')?{conversations:[second],total:2,next_cursor:null}:{conversations:[chat],total:2,next_cursor:'next'});
    if(url.pathname.endsWith('/history')){
      if(url.searchParams.get('chat_id')===second.chat_id)return Response.json({events:[event('other')],before_cursor:null});
      if(!url.searchParams.has('before_cursor'))return Response.json({events:[event('duplicate')],before_cursor:'saved'});
      return blocked?new Response('private upstream body',{status:404,headers:{'x-request-id':'11223344-5566-7788-9900-aabbccddeeff'}}):Response.json({events:[event('duplicate')],before_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'working-organization-key'});
  await advance(f.service,id);const partial=await advance(f.service,id);
  assert.equal(partial.blocked,1);assert.equal(partial.processed,0);
  await advance(f.service,id);await advance(f.service,id);
  const wait=await f.reopen().runStep(job(id));assert.equal(wait.done,false);assert.ok(wait.delayMs>0);
  const {rows:[row]}=await f.database.pool.query('SELECT state,credential FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
  assert.ok(row.credential);assert.equal(row.state.processed,1);
  assert.equal(row.state.recentIssues.at(-1).httpStatus,404);assert.equal(row.state.recentIssues.at(-1).chatId,chat.chat_id);
  assert.equal(row.state.recentIssues.at(-1).requestId,'11223344-5566-7788-9900-aabbccddeeff');
  assert.ok(!JSON.stringify(row.state.recentIssues.at(-1)).includes('saved'));assert.ok(!JSON.stringify(row.state).includes('private upstream body'));
  blocked=false;clock+=wait.delayMs;const done=await advance(f.reopen(),id);
  assert.equal(done.phase,'complete');assert.equal(done.processed,2);assert.equal(done.blocked,0);assert.equal(done.events,3);
  assert.equal(f.calls.at(-1).searchParams.get('before_cursor'),'saved');
});
test('due missing pages share retries between foreground pages and preserve every catalog checkpoint',async t=>{
  let clock=Date.now(),missing=true;
  const aliases=[chat,{...chat,title:'Second catalog label'}];
  const long={...chat,chat_id:randomUUID(),workspace_id:randomUUID(),title:'Long foreground chat'};
  const seen=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:[...aliases,long],total:3,next_cursor:null});
    if(!url.pathname.endsWith('history'))return;
    const id=url.searchParams.get('chat_id'),before=url.searchParams.get('before_cursor');
    seen.push([id,before]);
    if(id===chat.chat_id){
      if(missing)return new Response(null,{status:404});
      return Response.json({events:[event('duplicate')],before_cursor:before?null:'alias-older'});
    }
    const page=Number(before??0);
    return Response.json({events:[event('foreground')],before_cursor:page<12?String(page+1):null});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await advance(f.service,id);const both=await advance(f.service,id);
  assert.equal(both.blocked,2);assert.equal(both.blockedChats,1);
  assert.deepEqual(seen,[[chat.chat_id,null]],'equivalent catalog entry shares the first backoff');
  await advance(f.service,id);assert.deepEqual(seen.at(-1),[long.chat_id,null]);
  // A previously deployed worker left due rows with no scheduling counter or import ID.
  const scope=[f.database.namespace,principal.tenantId];
  await f.database.pool.query("UPDATE opencrawl_replicas_imports SET state=state-'freshSteps' WHERE namespace=$1 AND tenant=$2",scope);
  await f.database.pool.query("UPDATE opencrawl_replicas_deferred SET issue=issue-'importId' WHERE namespace=$1 AND tenant=$2",scope);
  clock+=60_000;
  await advance(f.reopen(),id);assert.deepEqual(seen.at(-1),[chat.chat_id,null]);
  const group=await f.database.pool.query(`SELECT count(*)::int n,count(DISTINCT retry_at)::int times,min((checkpoint->>'chatAttempts')::int) attempts
    FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2`,scope);
  assert.deepEqual(group.rows[0],{n:2,times:1,attempts:2});
  clock+=120_000;missing=false;
  for(let i=0;i<4;i++)await advance(f.service,id);
  assert.deepEqual(seen.slice(-4),[1,2,3,4].map(n=>[long.chat_id,String(n)]));
  await advance(f.service,id);assert.deepEqual(seen.at(-1),[chat.chat_id,null]);
  let status=await f.service.status(principal);
  for(let i=0;i<50&&status.phase!=='complete';i++)status=await advance(f.reopen(),id);
  assert.equal(status.phase,'complete');assert.equal(status.processed,3);assert.equal(status.imported,2);
  assert.deepEqual(seen.filter(([cid])=>cid===long.chat_id).map(([,cursor])=>cursor),[null,...Array.from({length:12},(_,i)=>String(i+1))]);
  assert.equal(seen.filter(([cid,cursor])=>cid===chat.chat_id&&cursor==='alias-older').length,2);
  const {gunzipSync}=await import('node:zlib');
  const pages=[...f.store.data].filter(([key])=>key.endsWith('.json.gz')).flatMap(([,bytes])=>JSON.parse(gunzipSync(bytes)).events)
    .filter(e=>e.kind==='replicas_history_page'&&e.data.replicasPage.conversation.chat_id===chat.chat_id);
  assert.deepEqual(new Set(pages.map(p=>p.data.replicasPage.conversation.title)),new Set(aliases.map(a=>a.title)));
});

test('a cached 404 cannot suppress a different workspace, another tenant or a new credential generation',async t=>{
  const otherWorkspace={...chat,workspace_id:randomUUID()};
  let missing=true;
  const f=await fixture(t,{answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:[chat,chat,otherWorkspace],total:3,next_cursor:null});
    if(url.pathname.endsWith('history'))return missing&&url.pathname.includes(chat.workspace_id)?new Response(null,{status:404}):Response.json({thread_id:'confirmed',events:[],before_cursor:null});
  }});
  const first=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await advance(f.service,first.id);
  const secondTenant={tenantId:'isolated',userId:'admin'};
  missing=false;
  const other=await f.service.action(secondTenant,{action:'connect',apiKey:'other'});
  assert.equal((await advance(f.service,other.id,secondTenant)).processed,1);
  await f.service.action(principal,{action:'stop',id:first.id});
  const resumed=await f.service.action(principal,{action:'connect',apiKey:'replacement'});
  assert.equal((await advance(f.service,resumed.id)).processed,1,'new credential must actually read the alias');
  missing=true;assert.equal((await advance(f.service,resumed.id)).processed,2,'different workspace must actually read');
  assert.equal((await f.service.status(secondTenant)).blockedChats,undefined);
});
test('polling the Replicas card reads a bounded summary of a large in-flight checkpoint',async t=>{
  const f=await fixture(t);
  await f.service.action(principal,{action:'connect',apiKey:'key'});
  const occurrences=Object.fromEntries(Array.from({length:4096},(_,i)=>[String(i).padStart(64,'0'),1]));
  await f.database.pool.query("UPDATE opencrawl_replicas_imports SET state=state||$3::jsonb WHERE namespace=$1 AND tenant=$2",
    [f.database.namespace,principal.tenantId,JSON.stringify({occurrences,processed:75,imported:30})]);
  const query=f.database.pool.query.bind(f.database.pool);
  let bytes=0;
  f.database.pool.query=async(...args)=>{
    const result=await query(...args);
    bytes+=Buffer.byteLength(JSON.stringify(result.rows));
    return result;
  };
  try{
    const card=await f.service.source(principal);
    assert.equal(card.synced,30);assert.equal(card.history.processed,75);assert.equal(card.state,'syncing');
    assert.ok(bytes>0&&bytes<2048,`status read ${bytes} bytes from the database`);
  }finally{f.database.pool.query=query;}
});

test('repeated history 404 samples the workspace inventory once and waking history stays pending',async t=>{
  let clock=Date.now(),mode='missing';
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('/chats'))return Response.json({chats:[{id:chat.chat_id,title:'private title'}]});
    if(url.pathname.endsWith('/history')){
      if(mode==='missing')return Response.json({error:'Chat not found',details:'sensitive upstream detail'},{status:404});
      if(mode==='waking')return Response.json({events:[],waking:true,has_more:false});
      return Response.json({events:[event('recovered')],before_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  for(let i=0;i<4;i++){await advance(f.service,id);clock+=10*60_000;}
  const diagnostics=await f.database.pool.query('SELECT state FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
  const checks=diagnostics.rows[0].state.recentIssues.flatMap(issue=>issue.workspaceInventory??[]);
  assert.equal(diagnostics.rows[0].state.recentIssues.at(-1).missingResource,'chat');
  assert.ok(!JSON.stringify(diagnostics.rows[0].state.recentIssues).includes('sensitive upstream detail'));
  assert.deepEqual(checks,[{result:'listed',chats:1,savedChats:0}]);
  assert.equal(f.calls.filter(url=>url.pathname.endsWith('/chats')).length,1);
  mode='waking';
  const waking=await advance(f.service,id);assert.equal(waking.processed,0);assert.equal(waking.phase,'importing');assert.equal(f.handed.length,0);
  mode='ready';clock+=24*60*60_000;
  let done=await advance(f.service,id);
  for(let i=0;i<8&&done.phase!=='complete';i++)done=await advance(f.service,id);assert.equal(done.phase,'complete');assert.equal(done.events,1);
});

test('empty history cannot complete a chat with recorded messages or an unconfirmed null thread',async t=>{
  let clock=Date.now(),available=false,readable=false;
  const empty={...chat,chat_id:randomUUID()};
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:[{...chat,senders:[{message_id:'source-message'}]},empty],total:2,next_cursor:null});
    if(url.pathname.endsWith('/chats'))return Response.json({chats:available?[{id:empty.chat_id}]:[]});
    if(url.pathname.endsWith('/history'))return Response.json(readable&&url.searchParams.get('chat_id')===chat.chat_id
      ?{events:[event('restored')],before_cursor:null}:{thread_id:null,events:[],total:0,before_cursor:null});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await advance(f.service,id);const waiting=await advance(f.service,id);
  assert.equal(waiting.processed,0);assert.equal(waiting.imported,0);assert.equal(waiting.blocked,2);assert.equal(f.handed.length,0);
  available=true;readable=true;clock+=60_000;
  await advance(f.service,id);const done=await advance(f.service,id);
  assert.equal(done.phase,'complete');assert.equal(done.processed,2);assert.equal(done.events,1);
});

test('workspace diagnostics compare only the requested export scope and never skip the missing chat',async t=>{
  let clock=Date.now();
  const other={...chat,workspace_id:randomUUID()};
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('/chats'))return Response.json({chats:[]});
    if(url.pathname.endsWith('/history'))return Response.json({error:'Chat not found'},{status:404});
    if(url.searchParams.has('workspace_id')){
      assert.equal(url.searchParams.get('workspace_id'),chat.workspace_id);
      return Response.json({conversations:[other],total:1,next_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  for(let i=0;i<3;i++){await advance(f.service,id);clock+=10*60_000;}
  const {rows:[row]}=await f.database.pool.query('SELECT state FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
  assert.ok(row.state.recentIssues.some(issue=>issue.workspaceExport?.result==='scope_mismatch'));
  assert.equal(row.state.blocked,1);assert.equal(row.state.processed,0);
  assert.equal(f.calls.some(url=>url.pathname.includes(other.workspace_id)),false);
});

test('repeated history cursor defers the exact checkpoint without duplicate handoff',async t=>{
  const f=await fixture(t,{answer:url=>url.pathname.endsWith('/history')?Response.json({events:[event('one')],before_cursor:'same'}):null});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});await advance(f.service,id);
  const partial=await advance(f.service,id);assert.equal(partial.blocked,1);assert.equal(partial.events,1);assert.equal(f.handed.length,1);
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
  let calls=0,fail=true,clock=Date.now();const ingest=createSessionIngest({store,prefix:'large/v1',scheduleIndexing:async()=>{calls++;if(calls===2&&fail){fail=false;throw Error('second handoff failed');}}}).putBatch;
  const service=createReplicasImport({database,schedule:async()=>{},key:randomBytes(32),ingest,now:()=>clock,request:async url=>Response.json(String(url).endsWith('whoami')?{organization,caller:'organization_api_key'}:String(url).includes('organization/conversations')?{conversations:[chat],total:1,next_cursor:null}:history)});
  const {id}=await service.action(principal,{action:'connect',apiKey:'key'});
  const partial=await advance(service,id);assert.equal(partial.events,0);clock=Date.parse(partial.retryAt);
  const state=await advance(service,id,principal);assert.equal(state.phase,'complete');assert.equal(state.events,1);assert.equal(state.pages,1);
  assert.equal([...store.data.keys()].filter(k=>k.endsWith('.json.gz')).length,2);
});

test('a single oversized history event survives checkpoints, indexing and authorized readback',async t=>{
  const {createSessionIngest}=await import('../dist/src/sessions/ingest.mjs');
  const {createSessionPipeline}=await import('../dist/src/sessions/indexer.mjs');
  const {gunzipSync}=await import('node:zlib');
  const large='z'.repeat(17*1024*1024)+'tail of original record';
  const history={events:[{type:'future-record',payload:{message:large}}],before_cursor:null};
  const db=await applicationDatabaseFixture(t),store=memorySessionStore(),prefix='replicas/oversized';
  const indexed=[];
  const pipeline=createSessionPipeline({store,prefix,resolvePrincipal:async({batch})=>batch.owner,
    search:{identity:'test',ensureIndex:async()=>{},putDocuments:async docs=>{indexed.push(docs.some(d=>d.document.text?.includes('tail of original record')));}}});
  const receiver=createSessionIngest({store,prefix,scheduleIndexing:key=>pipeline.processObject({key})});
  const service=createReplicasImport({database:db,key:randomBytes(32),schedule:async()=>{},ingest:receiver.putBatch,request:async input=>{
    const url=new URL(input);
    if(url.pathname.endsWith('whoami'))return Response.json({organization,caller:'organization_api_key'});
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:[chat],total:1,next_cursor:null});
    return url.searchParams.get('limit')==='1'?Response.json(history):new Response(null,{status:413});
  }});
  let status=await service.action(principal,{action:'connect',apiKey:'key'});
  for(let i=0;i<12&&status.phase==='importing';i++)status=await advance(service,status.id);
  assert.equal(status.phase,'complete');assert.equal(status.events,1);
  assert.ok(indexed.includes(true),'the event body is searchable through its final characters');
  const batches=[...store.data].filter(([key])=>key.endsWith('.json.gz'));
  assert.equal(batches.length,2);
  for(const [key,bytes] of batches){
    const stored=JSON.parse(gunzipSync(bytes)),receipt={userId:stored.owner.userId,harness:stored.harness,installationId:stored.installationId,sessionId:stored.sessionId,batchId:key.split('/').at(-1).split('.')[0]};
    assert.ok(stored.events[0].data.replicasPayloadV1);assert.ok(stored.attachments.every(a=>a.objectKey.startsWith(key.slice(0,key.lastIndexOf('/')+1)+'attachments/')));
    const restored=await receiver.getBatch(principal,receipt);
    assert.deepEqual(restored.events[0].data.replicasPage?.response??restored.events[0].data.replicas.record,stored.events[0].kind==='replicas_history_page'?history:history.events[0]);
    assert.equal(await receiver.getBatch({...principal,tenantId:'outside'},receipt),null);
  }
  const [key,bytes]=batches[0],manifest=JSON.parse(gunzipSync(bytes));
  const {expandReplicasPayload}=await import('../dist/src/sessions/replicas-payload.mjs');
  const part=manifest.attachments[0].objectKey;
  manifest.attachments[0].objectKey='outside/attachments/'+manifest.attachments[0].sha256;
  await assert.rejects(expandReplicasPayload(store,prefix,manifest.owner,key,manifest),/scoped/);
  manifest.attachments[0].objectKey=part;store.data.set(part,Buffer.from('changed'));
  await assert.rejects(expandReplicasPayload(store,prefix,manifest.owner,key,manifest),/missing or changed/);
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
  assert.equal(card.state,'synced');assert.deepEqual(card.units,['session','sessions']);
  assert.equal(card.synced,1);assert.equal(card.total,undefined);assert.equal(card.rows.find(row=>row.label==='Sessions').count,1);
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

test('history 403 verifies identity: a valid key defers just the chat, an identity denial requires reconnect',async t=>{
  for(const valid of [true,false]){
    let connected=false;
    const f=await fixture(t,{answer:url=>{
      if(url.pathname.endsWith('whoami')&&connected&&!valid)return new Response('secret',{status:401});
      if(url.pathname.endsWith('history'))return new Response('secret',{status:403});
    }});
    const {id}=await f.service.action(principal,{action:'connect',apiKey:'private-fixture'});connected=true;
    const state=await advance(f.service,id);
    const {rows:[row]}=await f.database.pool.query('SELECT state,credential IS NOT NULL AS retained FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
    assert.equal(row.retained,valid);assert.equal(state.phase,valid?'importing':'failed');
    assert.equal(row.state.recentIssues.at(-1).decision,valid?'defer':'reconnect');assert.equal(row.state.recentIssues.at(-1).httpStatus,valid?403:401);
    if(!valid)assert.equal(row.state.recentIssues.at(-1).originalHttpStatus,403);
  }
});
test('identity verification outage keeps the original history error and credential until it recovers',async t=>{
  let clock=Date.now(),identities=0,healthy=false;
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('whoami')&&++identities>1&&!healthy)return new Response(null,{status:503});
    if(url.pathname.endsWith('history'))return healthy?Response.json({thread_id:'confirmed',events:[],before_cursor:null}):new Response(null,{status:403});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  const wait=await f.service.runStep(job(id));assert.ok(wait.delayMs>0);assert.equal(wait.done,false);
  const {rows:[row]}=await f.database.pool.query('SELECT state,credential IS NOT NULL AS retained FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
  const issue=row.state.recentIssues.at(-1);
  assert.equal(row.retained,true);assert.equal(issue.operation,'identity');assert.equal(issue.originalHttpStatus,403);assert.equal(issue.httpStatus,503);
  healthy=true;clock+=wait.delayMs;assert.equal((await advance(f.reopen(),id)).phase,'complete');
});

test('reconnecting a pre-upgrade failed checkpoint succeeds even when its first chat still returns 404',async t=>{
  const f=await fixture(t,{answer:url=>url.pathname.endsWith('history')?new Response(null,{status:404}):null});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await f.database.pool.query(`UPDATE opencrawl_replicas_imports SET credential=NULL,state=state||$3::jsonb WHERE namespace=$1 AND tenant=$2`,
    [f.database.namespace,principal.tenantId,JSON.stringify({phase:'failed',events:9,processed:3})]);
  const resumed=await f.service.action(principal,{action:'connect',apiKey:'key'});
  assert.notEqual(resumed.id,id);assert.equal(resumed.phase,'importing');assert.equal(resumed.events,9);assert.equal(resumed.processed,3);
  assert.equal(f.calls.filter(call=>call.pathname.endsWith('history')).length,0);
  assert.equal((await advance(f.service,resumed.id)).blocked,1);assert.equal(await f.service.advance(job(id)),true);
});
test('temporary failure of the initial catalog schedules the import with its verified key',async t=>{
  let clock=Date.now(),unavailable=true;const jobs=[];
  const f=await fixture(t,{now:()=>clock,schedule:async job=>jobs.push(job),answer:url=>{
    if(url.pathname.endsWith('conversations')&&unavailable)return new Response(null,{status:503});
  }});
  const pending=await f.service.action(principal,{action:'connect',apiKey:'key'});
  assert.equal(pending.phase,'importing');assert.deepEqual(jobs,[job(pending.id)]);assert.match(pending.error,/catalog.*HTTP 503/);
  clock=Date.parse(pending.retryAt);unavailable=false;
  assert.equal((await advance(f.reopen(),pending.id)).total,1);
  await advance(f.service,pending.id);assert.equal((await advance(f.service,pending.id)).phase,'complete');
});
test('rate limit respects Retry-After; oversized pages shrink in place without losing the key',async t=>{
  let clock=Date.now(),count=0;
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(!url.pathname.endsWith('history'))return;
    count++;
    if(count===1)return new Response(null,{status:429,headers:{'retry-after':'120'}});
    if(count===2)return new Response(null,{status:413});
    assert.equal(url.searchParams.get('limit'),'50');return Response.json({thread_id:'confirmed',events:[],before_cursor:null});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  assert.deepEqual(await f.service.runStep(job(id)),{done:false,delayMs:120000});
  await advance(f.service,id);assert.equal(count,1);clock+=120000;
  await advance(f.service,id);assert.equal((await advance(f.service,id)).phase,'complete');
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
  await worker.runUntil(async()=>{
    for(let i=0;i<200;i++){
      if((await f.service.status(principal)).phase==='complete'&&(await handle.fetchHistory()).events.some(e=>e.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toNumber()>=86395))return;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.fail('workflow did not reach its durable daily timer');
  });
  const state=await f.service.status(principal);assert.equal(state.phase,'complete');assert.equal(state.events,2);assert.equal(state.pages,2);
  for(const event of (await handle.fetchHistory()).events){
    for(const payload of event.workflowExecutionStartedEventAttributes?.input?.payloads??event.activityTaskScheduledEventAttributes?.input?.payloads??[]){
      assert.deepEqual(JSON.parse(Buffer.from(payload.data).toString()),job(id));
    }
  }
});

test('matching empty responses share the retry and retain the provider request identifier',async t=>{
  let clock=Date.now(),restored=false,reads=0;
  const aliases=[{...chat,senders:[{message_id:'a'}]},{...chat,senders:[{sender_user_id:'member',recorded_at:'2026-10-01'}]}];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:aliases,total:2,next_cursor:null});
    if(url.pathname.endsWith('history')){
      reads++;
      return Response.json({thread_id:'known',events:restored?[event('returned')]:[],before_cursor:null},
        {headers:{'x-request-id':'req_123456789abcdef'}});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await advance(f.service,id);await advance(f.service,id);
  const scope=[f.database.namespace,principal.tenantId];
  clock+=60_000;
  await advance(f.service,id);
  const {rows}=await f.database.pool.query("SELECT issue,checkpoint,retry_at FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2",scope);
  assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.retry_at.getTime())).size,1);
  for(const row of rows){assert.equal(row.checkpoint.chatAttempts,2);assert.equal(row.issue.httpStatus,200);assert.equal(row.issue.requestId,'req_123456789abcdef');}
  await advance(f.service,id);assert.equal(reads,3);
  restored=true;clock+=120_000;
  await advance(f.service,id);const done=await advance(f.service,id);
  assert.equal(done.phase,'complete');assert.equal(done.imported,1);assert.equal(done.processed,2);
});

test('canceled messages permit a confirmed empty chat and a workspace access error leaves other imports runnable',async t=>{
  let clock=Date.now();
  const canceled={...chat,chat_id:randomUUID(),senders:[{message_id:'discarded'}]};
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:[chat,canceled],total:2,next_cursor:null});
    if(url.pathname.endsWith('history')){
      if(url.searchParams.get('chat_id')===canceled.chat_id)return Response.json({thread_id:'confirmed',events:[],removed_message_ids:['discarded'],before_cursor:null});
      return Response.json({events:[],has_more:false});
    }
    if(url.pathname.endsWith('/chats'))return new Response(null,{status:403});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  const inaccessible=await advance(f.service,id);assert.equal(inaccessible.blocked,1);assert.equal(inaccessible.imported,0);
  const progress=await advance(f.service,id);assert.equal(progress.processed,1);assert.equal(progress.imported,1);
  const {rows:[row]}=await f.database.pool.query("SELECT issue FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2",[f.database.namespace,principal.tenantId]);
  assert.equal(row.issue.operation,'workspace_chats');assert.equal(row.issue.identityCheck,'verified');assert.equal(row.issue.httpStatus,403);
});

test('one retained inventory postpones absent chats across a workspace and releases a chat that reappears',async t=>{
  let clock=Date.now(),restored=false,inventoryReads=0;
  const second={...chat,chat_id:randomUUID()};
  const active={...chat,chat_id:randomUUID()};
  const chats=[chat,second,active].map(c=>({...c,senders:[{message_id:'retained-message'}]}));
  const historyReads=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:chats,total:3,next_cursor:null});
    if(url.pathname.endsWith('/chats')){
      inventoryReads++;return Response.json({chats:(restored?[active,second]:[active]).map(c=>({id:c.chat_id}))});
    }
    if(url.pathname.endsWith('/history')){
      const requested=url.searchParams.get('chat_id');historyReads.push(requested);
      const present=requested===active.chat_id||(restored&&requested===second.chat_id);
      return Response.json({thread_id:present?'native':null,events:present?[event('content')]:[],before_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  for(let i=0;i<3;i++)await advance(f.service,id);
  assert.equal(historyReads.length,3);assert.equal(inventoryReads,0);
  clock+=60_000;await advance(f.service,id);
  const review=await f.service.runStep(job(id));assert.equal(review.delayMs,0);
  const sleep=await f.service.runStep(job(id));
  assert.equal(inventoryReads,1);assert.equal(historyReads.length,4);assert.ok(sleep.delayMs>=86_400_000-60_000&&sleep.delayMs<=86_400_000);
  const card=await f.service.source(principal);
  const {sourceStatus}=await import('../dist/src/application/source-model.mjs');
  assert.equal(card.history.waitingForSource,true);assert.equal(sourceStatus(card).label,'Connected');
  assert.equal(card.synced,1);assert.equal(card.history.phase,'importing');
  // The next direct probe is chosen by the durable queue. Arrange for the
  // absent chat to lead so only the inventory can release its returning peer.
  const scope=[f.database.namespace,principal.tenantId];
  await f.database.pool.query("UPDATE opencrawl_replicas_deferred SET retry_at=retry_at+interval '1 hour' WHERE namespace=$1 AND tenant=$2 AND chat->>'chat_id'=$3",[...scope,second.chat_id]);
  restored=true;clock+=86_400_000;
  for(let i=0;i<5&&inventoryReads===1;i++)await advance(f.reopen(),id);assert.equal(inventoryReads,2);
  let next=await advance(f.service,id);
  if(next.processed<2)next=await advance(f.service,id); // A newly changed inventory may verify its export first.
  assert.equal(historyReads.at(-1),second.chat_id);
  assert.equal(next.imported,2);assert.equal(next.processed,2);assert.equal(next.blocked,1);assert.notEqual(next.waitingForSource,true);
  assert.ok(f.handed.length>=2);
});

test('a small successful continuation grows the page size and clears the stale oversized failure',async t=>{
  let clock=Date.now();
  const sizes=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(!url.pathname.endsWith('/history'))return;
    const size=Number(url.searchParams.get('limit')),cursor=url.searchParams.get('before_cursor');
    sizes.push(size);
    if(!cursor&&size>1)return new Response(null,{status:413});
    if(!cursor&&sizes.filter(s=>s===1).length===1)return new Response(null,{status:413});
    const n=Number(cursor??0);
    return Response.json({events:[event('page '+n)],before_cursor:n===4?null:String(n+1)});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  for(let i=0;i<7;i++)await advance(f.service,id);
  assert.deepEqual(sizes,[100,50,25,12,6,3,1]);clock+=60_000;
  await advance(f.reopen(),id);
  const {rows:[row]}=await f.database.pool.query('SELECT issue,checkpoint FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
  assert.equal(row.issue.reason,'page_saved');assert.equal(row.issue.decision,'continue');assert.equal(row.issue.httpStatus,undefined);
  assert.equal(row.checkpoint.before,'1');assert.equal(row.checkpoint.pageLimit,4);
  let status;
  for(let i=0;i<4;i++)status=await advance(f.reopen(),id);
  assert.deepEqual(sizes.slice(-5),[1,4,16,64,100]);
  assert.equal(status.phase,'complete');assert.equal(status.processed,1);assert.equal(status.events,5);
});

test('a recovered long transcript makes progress alongside older unavailable chats',async t=>{
  const clock=Date.now(),others=Array.from({length:8},()=>({...chat,chat_id:randomUUID()})),reads=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('/history')){
      const id=url.searchParams.get('chat_id');reads.push(id);
      if(id!==chat.chat_id)return new Response(null,{status:404});
      const page=Number(url.searchParams.get('before_cursor')??1);
      return Response.json({events:[event('page '+page)],before_cursor:page>=7?null:String(page+1)});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  const scope=[f.database.namespace,principal.tenantId];
  const cp={before:null,historyCursors:[],occurrences:{},pageLimit:100,chatAttempts:1};
  const issue={at:new Date(clock-60_000).toISOString(),attempt:1,importId:id,operation:'history',httpStatus:404,reason:'provider_http',decision:'defer'};
  await f.database.pool.query("UPDATE opencrawl_replicas_imports SET state=state||$3::jsonb WHERE namespace=$1 AND tenant=$2",[...scope,JSON.stringify({queue:[],total:9,blocked:9})]);
  for(const other of others)await f.database.pool.query('INSERT INTO opencrawl_replicas_deferred(namespace,tenant,retry_at,chat,checkpoint,issue) VALUES($1,$2,$3,$4,$5,$6)',[...scope,new Date(clock-1000),other,cp,issue]);
  await f.database.pool.query('INSERT INTO opencrawl_replicas_deferred(namespace,tenant,retry_at,chat,checkpoint,issue) VALUES($1,$2,$3,$4,$5,$6)',[...scope,new Date(clock),chat,{...cp,before:'1'},{...issue,continuation:true}]);
  for(let i=0;i<6;i++)await advance(f.reopen(),id);
  assert.deepEqual(reads.slice(0,4),Array(4).fill(chat.chat_id));assert.ok(others.some(o=>o.chat_id===reads[4]));assert.equal(reads[5],chat.chat_id);
});

test('a workspace-only chat must reappear in its exact retained organization export before history is read',async t=>{
  let clock=Date.now();
  const retained={...chat,chat_id:randomUUID()},listedOnly={...chat,chat_id:randomUUID()},alreadyImported={...chat,chat_id:randomUUID()};
  const reads=[],scopedPages=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('/conversations')){
      if(!url.searchParams.has('workspace_id'))return Response.json({conversations:[chat,alreadyImported],total:2,next_cursor:null});
      assert.equal(url.searchParams.get('workspace_id'),chat.workspace_id);
      const cursor=url.searchParams.get('cursor');scopedPages.push(cursor);
      return Response.json(cursor?{conversations:[retained,chat],total:3,next_cursor:null}:{conversations:[alreadyImported],total:3,next_cursor:'next-page'});
    }
    if(url.pathname.endsWith('/chats'))return Response.json({chats:[retained,listedOnly,alreadyImported].map(c=>({id:c.chat_id}))});
    if(url.pathname.endsWith('/history')){
      const id=url.searchParams.get('chat_id');reads.push(id);
      if(id===chat.chat_id)return Response.json({error:'Chat not found'},{status:404});
      assert.ok([retained.chat_id,alreadyImported.chat_id].includes(id));
      return Response.json({events:[event('retained transcript')],before_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await advance(f.service,id);await advance(f.service,id);clock+=60_000;
  for(let i=0;i<12;i++)await advance(f.reopen(),id);
  const status=await f.service.status(principal);assert.equal(status.imported,2);assert.equal(status.processed,2);assert.equal(status.total,3);assert.equal(status.blocked,1);
  assert.ok(scopedPages.includes('next-page'));assert.equal(reads.filter(id=>id===retained.chat_id).length,1);assert.ok(!reads.includes(listedOnly.chat_id));
  const {rows:[row]}=await f.database.pool.query('SELECT export_check FROM opencrawl_replicas_workspace_inventories WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
  assert.equal(row.export_check.phase,'complete');assert.equal(row.export_check.added,1);assert.deepEqual(row.export_check.outside,[listedOnly.chat_id]);
});

test('catalog disagreement also verifies the original workspaces whose first history reads all succeeded',async t=>{
  let clock=Date.now();
  const other={...chat,workspace_id:randomUUID(),chat_id:randomUUID()},hidden={...other,chat_id:randomUUID()};
  const fetched=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations')){
      const workspace=url.searchParams.get('workspace_id');
      if(!workspace)return Response.json({conversations:[chat,other],total:2,next_cursor:null});
      const conversations=workspace===other.workspace_id?[hidden,other]:[chat];return Response.json({conversations,total:conversations.length,next_cursor:null});
    }
    // The scoped export can advertise readable history that the native
    // workspace inventory still omits.
    if(url.pathname.endsWith('/chats'))return Response.json({chats:url.pathname.includes(other.workspace_id)?[{id:other.chat_id}]:[]});
    if(url.pathname.endsWith('history')){
      const id=url.searchParams.get('chat_id');fetched.push(id);
      return id===chat.chat_id?Response.json({error:'Chat not found'},{status:404}):Response.json({events:[event('available')],before_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await advance(f.service,id);await advance(f.service,id);clock+=60_000;
  for(let i=0;i<16;i++)await advance(f.reopen(),id);
  assert.equal(fetched.filter(id=>id===hidden.chat_id).length,1);
  const result=await f.service.status(principal);assert.equal(result.imported,2);assert.equal(result.total,3);assert.equal(result.blocked,1);
});

test('workspace absence cannot keep postponing a direct history check or override provider Retry-After',async t=>{
  const now=Date.now(),at=new Date(now-25*60*60_000).toISOString();
  const f=await fixture(t);
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  const scope=[f.database.namespace,principal.tenantId],later=new Date(now+8*60*60_000).toISOString();
  const cp={before:null,historyCursors:[],occurrences:{},pageLimit:100,chatAttempts:6};
  const issue={at,attempt:6,importId:id,operation:'history',httpStatus:404,reason:'provider_http',decision:'defer'};
  const peer={...chat,chat_id:randomUUID()};
  for(const [c,err] of [[chat,issue],[peer,{...issue,providerRetryAt:later}]]){
    await f.database.pool.query('INSERT INTO opencrawl_replicas_deferred(namespace,tenant,retry_at,chat,checkpoint,issue) VALUES($1,$2,$3,$4,$5,$6)',[...scope,new Date(now),c,cp,err]);
  }
  const {observeReplicasWorkspace}=await import('../dist/src/integrations/replicas-inventory.mjs');
  await f.database.transaction(client=>observeReplicasWorkspace(client,{namespace:scope[0],tenant:scope[1],importId:id,workspace:chat.workspace_id},now,async()=>({chats:[]})));
  const {rows}=await f.database.pool.query("SELECT chat->>'chat_id' id,retry_at FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2",scope);
  assert.ok(rows.find(r=>r.id===chat.chat_id).retry_at.getTime()<=now);
  assert.equal(rows.find(r=>r.id===peer.chat_id).retry_at.toISOString(),later);
});

test('a failed export owns its wakeup, retains scoped rows and restarts from page one when totals change',async t=>{
  let clock=Date.now(),firstPass=true;
  const extra={...chat,chat_id:randomUUID()},reads=[],cursors=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('history')){
      reads.push(url.searchParams.get('chat_id'));return Response.json({events:[event('saved')],before_cursor:null});
    }
    if(url.pathname.endsWith('conversations')&&url.searchParams.has('workspace_id')){
      const cursor=url.searchParams.get('cursor');cursors.push(cursor);
      const total=cursor&&firstPass?3:2;
      if(cursor)firstPass=false;
      return Response.json({conversations:cursor?[extra]:[chat],total,next_cursor:cursor?null:'second'},
        {headers:{'x-request-id':'11223344-5566-7788-9900-aabbccddeeff'}});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  const scope=[f.database.namespace,principal.tenantId];
  // Upgrade an existing import whose last version recorded only the failure phase.
  await f.database.pool.query("UPDATE opencrawl_replicas_workspace_inventories SET result='ready',chat_ids='{}',export_check=$3 WHERE namespace=$1 AND tenant=$2",[...scope,{phase:'inconsistent_catalog'}]);
  await f.database.pool.query("UPDATE opencrawl_replicas_imports SET state=state||$3::jsonb WHERE namespace=$1 AND tenant=$2",[...scope,JSON.stringify({workspaceChecks:[{id:chat.workspace_id,at:clock}]})]);
  for(let i=0;i<6;i++)await advance(f.reopen(),id);
  const check=async()=>(await f.database.pool.query('SELECT export_check FROM opencrawl_replicas_workspace_inventories WHERE namespace=$1 AND tenant=$2',scope)).rows[0].export_check;
  const failed=await check();
  assert.equal(failed.phase,'inconsistent_catalog');assert.equal(failed.lastFailure.reason,'total_changed');
  assert.equal(failed.lastFailure.previousTotal,2);assert.equal(failed.lastFailure.reportedTotal,3);assert.equal(failed.lastFailure.examined,2);
  assert.equal(failed.lastFailure.httpStatus,200);assert.equal(failed.lastFailure.requestId,'11223344-5566-7788-9900-aabbccddeeff');
  assert.deepEqual(cursors,[null,'second']);assert.deepEqual(reads,[chat.chat_id,extra.chat_id]);
  const waiting=await f.reopen().runStep(job(id));assert.equal(waiting.done,false);assert.equal(waiting.delayMs,60_000);
  clock+=waiting.delayMs;
  for(let i=0;i<3;i++)await advance(f.reopen(),id);
  assert.deepEqual(cursors,[null,'second',null,'second']);assert.deepEqual(reads,[chat.chat_id,extra.chat_id]);
  assert.equal((await check()).fullCatalog,true);assert.equal((await check()).phase,'complete');
  assert.equal((await f.service.status(principal)).phase,'complete');
});

test('an unavailable filtered export resumes its saved cursor after Retry-After',async t=>{
  let clock=Date.now(),unavailable=true;
  const cursors=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('history'))return Response.json({events:[event('saved')],before_cursor:null});
    if(url.pathname.endsWith('conversations')&&url.searchParams.has('workspace_id')){
      const cursor=url.searchParams.get('cursor');cursors.push(cursor);
      if(cursor&&unavailable)return new Response(null,{status:429,headers:{'Retry-After':'600'}});
      return Response.json({conversations:[chat],total:2,next_cursor:cursor?null:'later'});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  const scope=[f.database.namespace,principal.tenantId];
  await f.database.pool.query("UPDATE opencrawl_replicas_workspace_inventories SET result='ready',chat_ids='{}' WHERE namespace=$1 AND tenant=$2",scope);
  await f.database.pool.query("UPDATE opencrawl_replicas_imports SET state=state||$3::jsonb WHERE namespace=$1 AND tenant=$2",[...scope,JSON.stringify({workspaceChecks:[{id:chat.workspace_id,at:clock}]})]);
  for(let i=0;i<4;i++)await advance(f.reopen(),id);
  const waiting=await f.reopen().runStep(job(id));assert.equal(waiting.delayMs,600_000);
  unavailable=false;clock+=waiting.delayMs;
  await advance(f.reopen(),id);
  assert.deepEqual(cursors,[null,'later','later']);assert.equal((await f.service.status(principal)).phase,'complete');
});

test('a short terminal export shifts its next page boundary and compares the rows actually returned',async t=>{
  let clock=Date.now(),fixed=false;
  const hidden={...chat,chat_id:randomUUID()},pages=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('history'))return Response.json({events:[event('available')],before_cursor:null});
    if(url.pathname.endsWith('conversations')&&url.searchParams.has('workspace_id')){
      const limit=Number(url.searchParams.get('limit')),cursor=url.searchParams.get('cursor');
      pages.push([limit,cursor]);
      // Return the same ordered rows under two different page boundaries.
      if(limit===100&&!cursor)return Response.json({conversations:[chat],total:3,next_cursor:'p2'});
      const conversations=limit===99?[chat,chat]:[chat];
      return Response.json({conversations:fixed?[...conversations,hidden]:conversations,total:3,next_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  const scope=[f.database.namespace,principal.tenantId];
  await f.database.pool.query("UPDATE opencrawl_replicas_workspace_inventories SET result='ready',chat_ids='{}' WHERE namespace=$1 AND tenant=$2",scope);
  await f.database.pool.query("UPDATE opencrawl_replicas_imports SET state=state||$3::jsonb WHERE namespace=$1 AND tenant=$2",[...scope,JSON.stringify({workspaceChecks:[{id:chat.workspace_id,at:clock}]})]);
  const failure=async()=>(await f.database.pool.query("SELECT export_check->'lastFailure' f FROM opencrawl_replicas_workspace_inventories WHERE namespace=$1 AND tenant=$2",scope)).rows[0].f;
  for(let i=0;i<4;i++)await advance(f.reopen(),id);
  const first=await failure();assert.equal(first.reason,'terminal_count');assert.equal(first.pageLimit,100);
  clock+=60_000;await advance(f.reopen(),id);
  const second=await failure();assert.equal(second.pageLimit,99);assert.equal(second.catalogHash,first.catalogHash);
  const pause=await f.reopen().runStep(job(id));assert.equal(pause.delayMs,86_400_000-60_000);
  fixed=true;clock+=86_400_000;
  for(let i=0;i<10;i++)await advance(f.reopen(),id);
  const status=await f.service.status(principal);assert.equal(status.phase,'complete');assert.equal(status.imported,2);
  assert.deepEqual(pages,[[100,null],[100,'p2'],[99,null],[100,null],[100,'p2']]);
});

test('a growing native chat is refreshed from the exact retained row and only its source delta is credited',async t=>{
  let clock=Date.now(),changed=false,allowOlder=false;
  const oldTime='2026-10-01T00:00:00Z',newTime='2026-10-03T00:00:00Z';
  const missing={...chat,chat_id:randomUUID()},wrong={...chat,created_at:'2026-09-01T00:00:00Z'};
  const reads=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations')){
      const rows=url.searchParams.has('workspace_id')?[wrong,chat,missing]:[chat,missing];
      return Response.json({conversations:rows,total:rows.length,next_cursor:null});
    }
    if(url.pathname.endsWith('chats'))return Response.json({chats:[{id:chat.chat_id,created_at:chat.created_at,updated_at:changed?newTime:oldTime}]});
    if(url.pathname.endsWith('history')){
      if(url.searchParams.get('chat_id')===missing.chat_id)return new Response(null,{status:404});
      const cursor=url.searchParams.get('before_cursor');reads.push(cursor);
      if(!changed)return Response.json({events:[event('old',oldTime)],before_cursor:null});
      if(cursor&&!allowOlder)return new Response(null,{status:429,headers:{'retry-after':'2'}});
      return Response.json(cursor?{events:[event('old',oldTime)],before_cursor:null}:{events:[event('new',newTime)],before_cursor:'older'});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  for(let i=0;i<4;i++)await advance(f.reopen(),id);
  clock+=60_000;for(let i=0;i<9;i++)await advance(f.reopen(),id);
  assert.deepEqual(reads,[null]);assert.equal((await f.service.status(principal)).events,1);
  changed=true;clock+=86_400_000;
  for(let i=0;i<15;i++)await advance(f.reopen(),id);
  assert.deepEqual(reads,[null,null,'older']);
  assert.equal((await f.service.status(principal)).events,1);
  allowOlder=true;clock+=3_000;
  for(let i=0;i<10;i++)await advance(f.reopen(),id);
  const status=await f.service.status(principal);
  assert.equal(status.imported,1);assert.equal(status.events,2);assert.equal(status.pages,2);
  assert.equal(status.total,3);assert.equal(status.processed,2);assert.equal(status.blocked,1);
  const {rows:[snap]}=await f.database.pool.query('SELECT source_version,counts FROM opencrawl_replicas_snapshots WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
  assert.equal(snap.source_version.toISOString(),new Date(newTime).toISOString());assert.deepEqual(snap.counts,{events:2,turns:0,pages:2});
  clock+=86_400_000;for(let i=0;i<8;i++)await advance(f.reopen(),id);
  assert.deepEqual(reads,[null,null,'older','older']);
});

test('a completed legacy chat can verify a newly observed native revision once without recounting the original import',async t=>{
  let clock=Date.now();
  const version='2026-10-08T00:00:00Z',missing={...chat,chat_id:randomUUID()},reads=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:[chat,missing],total:2,next_cursor:null});
    if(url.pathname.endsWith('chats'))return Response.json({chats:[{id:chat.chat_id,created_at:chat.created_at,updated_at:version}]});
    if(url.pathname.endsWith('history')){
      if(url.searchParams.get('chat_id')===missing.chat_id)return new Response(null,{status:404});
      reads.push(chat.chat_id);return Response.json({events:[event('saved')],before_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});await advance(f.service,id);await advance(f.service,id);
  await f.database.pool.query('DELETE FROM opencrawl_replicas_snapshots WHERE namespace=$1 AND tenant=$2',[f.database.namespace,principal.tenantId]);
  clock+=60_000;for(let i=0;i<12;i++)await advance(f.reopen(),id);
  assert.equal(reads.length,2);assert.equal((await f.service.status(principal)).imported,1);assert.equal((await f.service.status(principal)).events,1);
  clock+=86_400_000;for(let i=0;i<8;i++)await advance(f.reopen(),id);
  assert.equal(reads.length,2);
});

test('an explicit snapshot recheck still requires the matching retained native chat and rejects an empty placeholder',async t=>{
  let clock=Date.now(),placeholder=false;
  const missing={...chat,chat_id:randomUUID()},reads=[];
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json({conversations:[chat,missing],total:2,next_cursor:null});
    if(url.pathname.endsWith('chats'))return Response.json({chats:[{id:chat.chat_id,created_at:chat.created_at,updated_at:chat.updated_at}]});
    if(url.pathname.endsWith('history')){
      if(url.searchParams.get('chat_id')===missing.chat_id)return new Response(null,{status:404});
      reads.push(chat.chat_id);
      return Response.json({thread_id:chat.chat_id,events:placeholder?[]:[event('real',chat.updated_at)],before_cursor:null});
    }
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});await advance(f.service,id);await advance(f.service,id);
  const scope=[f.database.namespace,principal.tenantId];
  await f.database.pool.query('UPDATE opencrawl_replicas_snapshots SET verify_next=true WHERE namespace=$1 AND tenant=$2',scope);
  placeholder=true;clock+=60_000;for(let i=0;i<12;i++)await advance(f.reopen(),id);
  const {rows:[snap]}=await f.database.pool.query('SELECT verify_next,counts FROM opencrawl_replicas_snapshots WHERE namespace=$1 AND tenant=$2',scope);
  assert.equal(snap.verify_next,true);assert.equal(snap.counts.events,1);assert.ok(reads.length>1);
  const status=await f.service.status(principal);assert.equal(status.imported,1);assert.equal(status.events,1);
  placeholder=false;clock+=31*60_000;for(let i=0;i<15;i++)await advance(f.reopen(),id);
  assert.equal((await f.database.pool.query('SELECT verify_next FROM opencrawl_replicas_snapshots WHERE namespace=$1 AND tenant=$2',scope)).rows[0].verify_next,false);
});

test('a long light transcript resumes from its cursor with fewer history requests',async t=>{
  const total=1800,records=Array.from({length:total},(_,i)=>event('message '+i));
  const windows=[];
  const f=await fixture(t,{answer:url=>{
    if(!url.pathname.endsWith('/history'))return;
    const before=Number(url.searchParams.get('before_cursor')??total),limit=Number(url.searchParams.get('limit'));
    const start=Math.max(0,before-limit);
    windows.push({before,limit});
    return Response.json({events:records.slice(start,before),before_cursor:start?String(start):null,has_more:start>0,total});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  let state;
  for(let i=0;i<total/100+2;i++){
    state=await advance(f.reopen(),id);
    if(state.phase==='complete')break;
  }
  assert.equal(state.phase,'complete');assert.equal(state.imported,1);assert.equal(state.events,total);
  assert.deepEqual(windows.map(w=>w.before),[1800,1700,1300,900,500,100]);
  assert.equal(state.pages,6);
});

test('a rejected larger history window retries the same saved cursor and remembers the supported limit',async t=>{
  const records=Array.from({length:550},(_,i)=>event('record '+i)),windows=[];
  let clock=Date.now();
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(!url.pathname.endsWith('/history'))return;
    const before=Number(url.searchParams.get('before_cursor')??records.length),limit=Number(url.searchParams.get('limit'));
    windows.push([before,limit]);
    if(limit>100)return new Response(null,{status:422,headers:{'Retry-After':'3'}});
    const start=Math.max(0,before-limit);
    return Response.json({events:records.slice(start,before),before_cursor:start?String(start):null,has_more:start>0});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  let state;
  for(let i=0;i<10;i++){
    state=await advance(f.reopen(),id);
    if(state.phase==='complete')break;
    if(state.retryAt){
      assert.equal(Date.parse(state.retryAt)-clock,3000);
      const reads=windows.length;await advance(f.reopen(),id);assert.equal(windows.length,reads);
      clock=Date.parse(state.retryAt);
    }
    if(state.phase==='complete')break;
  }
  assert.deepEqual(windows,[[550,100],[450,400],[450,100],[350,100],[250,100],[150,100],[50,100]]);
  assert.equal(state.phase,'complete');assert.equal(state.events,550);assert.equal(state.pages,6);
});

test('a daily catalog scan skips unchanged history, resumes changed chats and disconnects while idle',async t=>{
  let clock=Date.parse('2026-11-19T12:00:00Z'),changed=false;
  const day=86_400_000,second={...chat,chat_id:randomUUID()};
  const f=await fixture(t,{now:()=>clock,answer:url=>{
    if(url.pathname.endsWith('/chats'))return Response.json({chats:[chat,second].map(c=>({id:c.chat_id,updated_at:c.updated_at,created_at:c.created_at}))});
    if(url.pathname.endsWith('/conversations'))return Response.json({total:2,next_cursor:null,conversations:[chat,changed?{...second,updated_at:new Date(clock).toISOString()}:second]});
    if(url.pathname.endsWith('/history'))return Response.json({events:[event('first'),...(changed?[event('new',new Date(clock).toISOString())]:[])],before_cursor:null});
  }});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await advance(f.service,id);await advance(f.service,id);
  const before=f.calls.length,handoffs=f.handed.length;
  assert.deepEqual(await f.reopen().runStep(job(id)),{done:false,delayMs:day});
  assert.equal(f.calls.length,before);
  clock+=day;
  assert.deepEqual(await f.reopen().runStep(job(id)),{done:false,delayMs:0});
  assert.deepEqual(await f.reopen().runStep(job(id)),{done:false,delayMs:day});
  assert.equal(f.calls.length,before+2);assert.equal(f.handed.length,handoffs);
  changed=true;clock+=day;
  await f.service.runStep(job(id));await f.reopen().runStep(job(id));await f.service.runStep(job(id));
  assert.deepEqual(f.calls.slice(before+2).map(url=>[url.pathname.split('/').at(-1),url.searchParams.get('chat_id')]),[['chats',null],['conversations',null],['history',second.chat_id]]);
  const state=await f.service.status(principal);assert.equal(state.imported,2);assert.equal(state.events,3);
  await f.service.action(principal,{action:'stop',id});clock+=day;
  assert.equal((await f.reopen().runStep(job(id))).done,true);assert.equal(f.calls.length,before+5);
});

test('Replicas and native captures group only inside the verified thread and the current reader’s visibility',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{pathToFileURL}=await import('node:url');
  const {createSessionSearch}=await import('../dist/src/sessions/search.mjs');
  const {createSessionPipeline}=await import('../dist/src/sessions/indexer.mjs');
  const {createSessionLibrary}=await import('../dist/src/sessions/library.mjs');
  const {createWorkspaceSearch}=await import('../dist/src/search/workspace.mjs');
  const dir=await mkdtemp(join(tmpdir(),'replicas-capture-pair-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const database=await applicationDatabaseFixture(t),store=memorySessionStore(),prefix='capture/v1';
  const options={endpoint:pathToFileURL(join(dir,'search.sqlite')).href.replace('file:','sqlite:'),store,prefix};
  const search=createSessionSearch(options),pipeline=createSessionPipeline({...options,search,resolvePrincipal:async({batch})=>batch.owner});
  const ingest=createSessionIngest({store,prefix,scheduleIndexing:key=>pipeline.processObject({key})}).putBatch;
  const thread=randomUUID(),nativeId=randomUUID(),timestamp='2026-11-19T14:00:00.000Z';
  const message={role:'user',content:[{type:'text',text:'overlap_needle'}]};
  const history={events:[{type:'claude-user',timestamp,payload:{uuid:nativeId,session_id:thread,message}},
    event('historyonlyneedle')],before_cursor:null};
  const request=async url=>Response.json(String(url).endsWith('/whoami')?{organization,caller:'organization_api_key'}:String(url).includes('/conversations')?{total:1,conversations:[chat],next_cursor:null}:history);
  const service=createReplicasImport({database,schedule:async()=>{},key:randomBytes(32),request,ingest});
  const library=createSessionLibrary({...options,capturePairs:service.capturePairs});
  const workspace=createWorkspaceSearch({sessions:search,capturePairs:service.capturePairs});
  const owner={...principal,userId:'native-owner'};
  const uploaded={owner,schemaVersion:1,harness:'claude-code',installationId:'native',sessionId:thread,origin:'desktop',events:[{id:'live1',kind:'message',nativeId,timestamp,data:message}],attachments:[]};
  const {id}=await service.action(principal,{action:'connect',apiKey:'key'});await advance(service,id);
  assert.equal((await library.list(principal)).sessions.length,1);
  await ingest(owner,uploaded);
  const rows=await library.list(principal);
  assert.equal(rows.sessions.length,1);assert.equal(rows.sessions[0].sessionId,thread);
  assert.equal(rows.sessions[0].historyCapture.sessionId,'replicas-chat:'+chat.chat_id);
  const other=await library.read(principal,rows.sessions[0].historyCapture);
  assert.ok(other.events.some(e=>e.entries.some(item=>item.text==='historyonlyneedle')));
  const input={query:'overlap_needle',source:'sessions',groupBy:'none'};
  const normalized=await workspace.search(principal,input);
  assert.equal(normalized.results.filter(h=>h.provenance.kind==='message').length,1);
  const raw=await workspace.search(principal,{...input,dedupe:false});
  assert.equal(raw.results.filter(h=>h.provenance.kind==='message').length,2);
  const legacyReads=[];
  const legacy=createWorkspaceSearch({capturePairs:service.capturePairs,sessions:{...search,
    search:async(...args)=>{const result=await search.search(...args);for(const hit of result.hits)delete hit.captureHash;return result;},
    captureFingerprints:async(p,hits)=>{legacyReads.push(hits.length);return search.captureFingerprints(p,hits);}
  }});
  assert.equal((await legacy.search(principal,input)).results.filter(h=>h.provenance.kind==='message').length,1);
  assert.deepEqual(legacyReads,[2]);
  await ingest(owner,{...uploaded,sessionId:randomUUID()});
  assert.equal((await library.list(principal)).sessions.length,2);
  assert.equal((await workspace.search(principal,input)).results.filter(h=>h.provenance.kind==='message').length,2);
  const racing=createWorkspaceSearch({sessions:search,capturePairs:async(tenant,keys)=>{
    const pairs=await service.capturePairs(tenant,keys);
    await library.setVisibility(owner,{harness:'claude-code',sessionId:thread,visibility:'private'});
    return pairs;
  }});
  const raced=await racing.search(principal,input);
  assert.ok(raced.results.every(r=>r.provenance.sessionId!==thread&&!r.duplicateIds?.some(id=>raw.results.some(h=>h.id===id&&h.provenance.sessionId===thread))));
  assert.equal((await library.list(principal)).sessions.some(s=>s.historyCapture||s.sessionId===thread),false);
  assert.ok((await library.list(owner)).sessions.some(s=>s.historyCapture));
  assert.deepEqual(await service.capturePairs('another-tenant',[rows.sessions[0],rows.sessions[0].historyCapture]),[]);
});

test('archived thread backfill resumes without Replicas or indexing and withdraws conflicting native identities',async t=>{
  const {backfillReplicasEvidence}=await import('../dist/src/integrations/replicas-archive-evidence.mjs');
  const {replicasThread,combineThreads,saveReplicasThread}=await import('../dist/src/integrations/replicas-threads.mjs');
  const thread=randomUUID(),events=[{type:'claude-user',payload:{session_id:thread,message:{role:'user',content:'a'}}}];
  const f=await fixture(t,{answer:url=>url.pathname.endsWith('/history')?Response.json({events,before_cursor:null}):undefined});
  const {id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  await advance(f.service,id);
  const scope=[f.database.namespace,principal.tenantId,id],calls=f.calls.length,handed=f.handed.length;
  await f.database.pool.query('UPDATE opencrawl_replicas_snapshots SET evidence_complete=false WHERE namespace=$1 AND tenant=$2 AND import_id=$3',scope);
  const original=(await f.database.pool.query('SELECT owner_id,session_id FROM opencrawl_replicas_threads WHERE namespace=$1 AND tenant=$2',scope.slice(0,2))).rows[0];
  await f.database.pool.query('DELETE FROM opencrawl_replicas_threads WHERE namespace=$1 AND tenant=$2',scope.slice(0,2));
  const visible=[{userId:original.owner_id,harness:'replicas',sessionId:original.session_id},{userId:'u',harness:'claude-code',sessionId:thread}];
  let reads=0;
  const store={...f.store,listPage:async(root,options)=>{reads++;return f.store.listPage(root,{...options,maxKeys:1});}};
  const repair=()=>f.database.transaction(c=>backfillReplicasEvidence(c,{store,prefix:'history/v1'},scope,organization.id,Date.now()));
  for(let i=0;i<20&&await repair();i++);
  const completeReads=reads;
  assert.ok(completeReads>0);assert.equal(await repair(),false);assert.equal(reads,completeReads);
  assert.equal((await f.service.capturePairs(principal.tenantId,visible)).length,1);
  assert.equal(f.calls.length,calls);assert.equal(f.handed.length,handed);
  assert.equal(replicasThread({events,thread_id:randomUUID(),coding_agent:'claude'}),'conflict');
  assert.equal(replicasThread({events:[{type:'future',payload:{session_id:thread}}]}),undefined);
  const ambiguous=combineThreads(replicasThread({events}),{harness:'codex',id:thread});
  assert.equal(ambiguous,'conflict');
  await saveReplicasThread(f.database.pool,...scope.slice(0,2),original.owner_id,original.session_id,ambiguous);
  await saveReplicasThread(f.database.pool,...scope.slice(0,2),original.owner_id,original.session_id,{harness:'claude-code',id:thread});
  assert.deepEqual(await f.service.capturePairs(principal.tenantId,visible),[]);
});

test('daily rosters park repeatedly absent chats without rewriting the same retry or overriding Retry-After',async t=>{
  const f=await fixture(t),{id}=await f.service.action(principal,{action:'connect',apiKey:'key'});
  const scope=[f.database.namespace,principal.tenantId],now=Date.now(),at=new Date(now).toISOString(),day=86_400_000;
  await f.database.pool.query('INSERT INTO opencrawl_replicas_deferred(namespace,tenant,retry_at,chat,checkpoint,issue) VALUES($1,$2,$3,$4,$5,$6)',
    [...scope,at,chat,{before:null},{at,importId:id,operation:'history',httpStatus:404,attempt:3,workspaceAbsentAt:at}]);
  const {observeReplicasWorkspace}=await import('../dist/src/integrations/replicas-inventory.mjs');
  const observe=(n,chats)=>f.database.transaction(c=>observeReplicasWorkspace(c,{namespace:scope[0],tenant:scope[1],importId:id,workspace:chat.workspace_id},now+n*day,async()=>({chats})));
  assert.equal((await observe(0,[])).moved,1);
  for(let i=1;i<5;i++)assert.equal((await observe(i,[])).moved,0);
  const retry=async()=>(await f.database.pool.query('SELECT retry_at FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2',scope)).rows[0].retry_at.getTime();
  assert.equal(await retry(),now+7*day);
  const provider=new Date(now+6*day).toISOString();
  await f.database.pool.query("UPDATE opencrawl_replicas_deferred SET issue=issue||jsonb_build_object('providerRetryAt',$3::text) WHERE namespace=$1 AND tenant=$2",[...scope,provider]);
  assert.equal((await observe(5,[{id:chat.chat_id}])).released,1);
  assert.equal(await retry(),Date.parse(provider));
});
