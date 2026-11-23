import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createSearchActivity} from '../dist/src/state/search-activity.mjs';
import {createSessionLibrary} from '../dist/src/sessions/library.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {createSessionPipeline} from '../dist/src/sessions/indexer.mjs';
import {agentSearchEntry,httpTool,isAgentHttpTool,observeAgentRequest,admitActivity,activityInput} from '../dist/src/application/agent-activity.mjs';
import {createContextCheck,lexicalCheckJudgment} from '../dist/src/search/check.mjs';
import {measuredCheck,measuredSuggestionEvents} from '../dist/src/search/check-activity.mjs';

const alice={tenantId:'org_a',userId:'alice'},bob={...alice,userId:'bob'},other={...alice,tenantId:'org_b'};
const ctx={harness:'codex',sessionId:'shared'};
const entry=(query,current=ctx)=>agentSearchEntry('opencrawl_search_v1',{query,currentSession:current});
const identity=async(_p,rows)=>rows;

test('the keyword counter seeds retained searches once and survives text erasure and mixed-version writes',async t=>{
  const db=await applicationDatabaseFixture(t);
  await db.transaction(async client=>{
    // The disposable namespace's own schema isolates the simulated installation from parallel tests.
    await client.query('set local search_path to "'+db.identitySchema+'"');
    const api=createSearchActivity({namespace:db.namespace,pool:client,transaction:run=>run(client)});
    await api.ready();
    await client.query('drop trigger opencrawl_count_keyword_searches on opencrawl_search_history; drop table opencrawl_keyword_search_days; drop function opencrawl_count_keyword_searches()');
    const write=queries=>api.search(alice,{kind:'agent',operation:'Workspace',queries,...ctx});
    await write(['older search']); await write(['  ']); await write([]);
    await api.ready(); await api.ready();
    await write(['later search']); await write(['']);
    assert.equal((await api.totals(alice)).agentSearches,2);
    assert.equal((await api.totals(alice)).daily.at(-1).agentSearches,2);
    assert.equal((await api.totals(other)).agentSearches,0);
    assert.equal((await api.page(alice,{kind:'agent'},identity)).rows.length,2);
    await api.forget(alice,ctx); await api.ready();
    assert.equal((await api.totals(alice)).agentSearches,2);
    assert.equal((await api.totals(alice)).calls,5);
  });
});

test('Overview pages through keyword queries and excludes chronological reads from search totals',async t=>{
  const db=await applicationDatabaseFixture(t),activity=createSearchActivity(db);
  await activity.ready();
  for(let i=0;i<26;i++)await activity.agentCall(alice,entry('keyword '+i));
  for(const query of ['', '  \t\n', null])await activity.agentCall(alice,entry(query));
  await activity.agentCall(bob,entry('unlinked private query',null));
  const request={kind:'agent',withQuery:true};
  const first=await activity.page(alice,request,identity);
  const last=await activity.page(alice,{...request,before:first.next},identity);
  assert.equal(first.rows.length,25);
  assert.equal(last.rows.length,1);
  assert.equal(last.next,null);
  const queries=[...first.rows,...last.rows].map(row=>row.queries[0]);
  assert.deepEqual(new Set(queries),new Set(Array.from({length:26},(_,i)=>'keyword '+i)));
  await assert.rejects(activity.page(alice,{kind:'agent',before:first.next},identity),/cursor/i);
  await assert.rejects(activity.page(other,{...request,before:first.next},identity),/cursor/i);
  assert.equal((await activity.totals(alice)).agentSearches,27);
});

test('authenticated call accounting, scoped paging and idempotent proactive outcomes on PostgreSQL',async t=>{
  const db=await applicationDatabaseFixture(t);
  const requests=[];
  const activity=createSearchActivity({...db,pool:{async query(sql,args){const result=await db.pool.query(sql,args);requests.push({sql,returned:result.rows.length});return result;}}});
  await activity.ready();
  const req={url:'/api/search',headers:{}},res={statusCode:200,writableEnded:true};
  await observeAgentRequest(activity,'search',req,res,async()=>{admitActivity(alice);admitActivity(alice);activityInput({query:'needle',currentSession:ctx});});
  await observeAgentRequest(activity,'board_sync',req,res,async()=>{});
  await Promise.all(Array.from({length:30},()=>activity.agentCall(bob,entry('indexed query'))));
  await Promise.all([activity.agentCall(bob),activity.agentCall(other,entry('foreign'))]);
  const raw={currentSession:ctx,eventId:'prompt-42',role:'user',message:'Where is the refund policy documented?'};
  const run=measuredCheck(activity,createContextCheck({search:{search:async()=>({results:[]}),fetch:async()=>assert.fail()},judge:lexicalCheckJudgment,authorize:async()=>{}}));
  await run(alice,raw,new AbortController().signal);
  await run(alice,raw,new AbortController().signal);
  await activity.search(alice,{kind:'proactive',operation:'Context check',queries:['refund'],...ctx,messageId:'prompt-43',returned:1,eventKey:'handoff'});
  await Promise.all([1,2].map(()=>measuredSuggestionEvents(activity)(alice,[{stage:'handoff',eventKey:'handoff'}])));
  const totals=await activity.totals(bob);
  const {daily,...counts}=totals;
  assert.deepEqual({...counts,since:null},{since:null,calls:32,agentSearches:31,proactiveChecks:2,nonSilent:1,delivered:1});
  // Thirty UTC days through today; tracking began today, so earlier days are not tracked rather than zero.
  const today=new Date().toISOString().slice(0,10);
  assert.equal(daily.length,30);assert.equal(daily.at(-1).date,today);
  assert.deepEqual(daily.at(-1),{date:today,agentSearches:31,nonSilent:1});
  assert.ok(daily.slice(0,-1).every(day=>day.agentSearches===null&&day.nonSilent===null));
  assert.equal(totals.since,today+'T00:00:00.000Z');
  const week=await activity.totals(bob,'7d');
  assert.equal(week.daily.length,7);assert.equal(week.agentSearches,31);
  const all=await activity.totals(bob,'all');
  assert.deepEqual(all.daily,[{date:today,agentSearches:31,nonSilent:1}]);
  await assert.rejects(activity.totals(bob,'90d'));
  assert.equal((await activity.totals(other)).calls,1);
  const proactive=await activity.page(bob,{kind:'proactive'},identity);
  assert.equal(proactive.rows.length,2);
  assert.equal(proactive.rows.find(r=>r.messageId==='prompt-42').message,raw.message);
  // A dense same-millisecond cohort exercises the ID tie breaker at the page boundary.
  await db.pool.query("update opencrawl_search_history set at=date_trunc('second',now()) where namespace=$1",[db.namespace]);
  requests.length=0;
  const first=await activity.page(alice,{kind:'agent'},identity);
  const next=await activity.page(alice,{kind:'agent',before:first.next},identity);
  assert.deepEqual(requests.map(q=>q.returned),[26,6]);
  assert.ok(requests.every(q=>!q.sql.toLowerCase().includes('offset')));
  const rows=[...first.rows,...next.rows];
  assert.equal(new Set(rows.map(r=>r.id)).size,31);
  assert.deepEqual(rows.map(r=>r.id),rows.map(r=>r.id).sort().reverse());
  assert.equal(next.next,null);
  await assert.rejects(activity.page(other,{kind:'agent',before:first.next},identity));
  const earlier=[{owner:alice.userId,id:'00000000-0000-4000-8000-000000000001',at:new Date().toISOString(),key:'a'.repeat(64),returned:1}];
  await Promise.all([activity.importChecks(alice.tenantId,earlier),activity.importChecks(alice.tenantId,earlier)]);
  assert.equal((await activity.totals(alice)).proactiveChecks,3);
  assert.equal((await activity.totals(alice)).calls,32);
  assert.equal((await activity.page(bob,{kind:'proactive'},identity)).rows.length,2);
  assert.equal((await activity.page(alice,{kind:'proactive'},identity)).rows.length,3);
  await activity.forget(bob,ctx);
  await activity.agentCall(bob,entry('late write'));
  assert.deepEqual((await activity.page(alice,{kind:'agent'},identity)).rows.map(r=>r.queries),[['needle']]);
  assert.equal((await activity.totals(alice)).calls,33);
  await assert.rejects(activity.page({}, {kind:'agent'},identity));
  await assert.rejects(activity.page(alice,{kind:'agent',tenantId:other.tenantId},identity));
});

test('a search page checks captured owners in bulk and rechecks private and deleted sessions',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'usage-search-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const endpoint=pathToFileURL(join(dir,'activity.sqlite')).href.replace('file:','sqlite:');
  const store=memorySessionStore(),prefix='sessions/usage';
  const options={endpoint,store,prefix};
  const search=createSessionSearch(options),ingest=createSessionIngest(options);
  const pipeline=createSessionPipeline({...options,search,resolvePrincipal:async({batch})=>batch.owner});
  await ingest.putBatch(alice,{schemaVersion:1,owner:alice,installationId:'device',origin:'cli',...ctx,events:[{id:'one',kind:'message',timestamp:new Date().toISOString(),data:{role:'user',content:'Display test'}}],attachments:[]});
  for(const key of store.data.keys())if(key.endsWith('.json.gz'))await pipeline.processObject({key});
  await search.refresh(alice);
  const library=createSessionLibrary(options);
  const controls=createControls(options);
  const rows=Array.from({length:22},(_,i)=>({id:String(i),userId:alice.userId,...ctx}));
  rows.push({id:'standalone',userId:alice.userId,harness:null,sessionId:null},{id:'missing',userId:alice.userId,...ctx,sessionId:'missing'});
  let reads=0;const read=store.readVersion.bind(store);store.readVersion=(...args)=>{reads++;return read(...args);};
  assert.equal((await library.visibleActivity(bob,rows)).length,22);
  assert.equal(reads,1,'duplicate rows share the authoritative session-control read');
  await controls.update(alice,'sessions',ctx.harness,ctx.sessionId,()=>({visibility:'private',deletedAt:null}));
  assert.deepEqual(await library.visibleActivity(bob,rows),[]);
  assert.equal((await library.visibleActivity(alice,rows)).length,24);
  await controls.update(alice,'sessions',ctx.harness,ctx.sessionId,()=>({visibility:'team',deletedAt:new Date().toISOString()}));
  assert.deepEqual((await library.visibleActivity(alice,rows)).map(r=>r.id),['standalone','missing']);
  assert.deepEqual(await library.visibleActivity({...bob,tenantId:other.tenantId},rows),[]);
});

test('history and summary query plans stay bounded with a large workspace and many unlinked searches',async t=>{
  const db=await applicationDatabaseFixture(t);
  const plans=[];
  const activity=createSearchActivity({...db,pool:{async query(sql,args){
    const result=await db.pool.query(sql,args);
    if(/^\s*(select|with)\b/.test(sql))plans.push((await db.pool.query('explain (analyze,buffers,format json) '+sql,args)).rows[0]['QUERY PLAN'][0]);
    return result;
  }}});
  await activity.ready();
  await db.pool.query(`insert into opencrawl_search_history(namespace,tenant_id,user_id,kind,id,at,operation,queries,harness,session_id,failed)
    select $1,$2,case when n%10=1 then 'alice' else 'another' end,'agent',gen_random_uuid(),now()-n*interval '2 seconds',
      'Workspace',array['sample query'],case when n%10=0 then 'codex' end,case when n%10=0 then 'shared' end,false
    from generate_series(1,100000) n`,[db.namespace,alice.tenantId]);
  await db.pool.query('analyze opencrawl_search_history');
  const page=await activity.page(alice,{kind:'agent'},identity);
  await activity.page(alice,{kind:'agent',before:page.next},identity);
  await activity.totals(alice);
  for(const plan of plans.slice(0,2)){
    const rendered=JSON.stringify(plan.Plan);
    assert.match(rendered,/opencrawl_search_history_linked/);
    assert.match(rendered,/opencrawl_search_history_personal/);
    assert.ok(plan.Plan['Shared Hit Blocks']+plan.Plan['Shared Read Blocks']<150,rendered);
  }
  assert.doesNotMatch(JSON.stringify(plans[2]),/opencrawl_search_history/);
  t.diagnostic('100,000-row fixture; PostgreSQL first/next/summary ms: '+plans.map(p=>p['Execution Time']).join(', '));
});


test('only foreground HTTP operations count as agent tool calls',async()=>{
  let calls=0;
  const activity={agentCall:async()=>{calls++;}};
  const observe=(method,path,headers={})=>observeAgentRequest(activity,httpTool(method,path),{method,url:path,headers},
    {statusCode:200,writableEnded:true},async()=>{admitActivity(alice);return 'served';});
  const digest='a'.repeat(64);
  const background=[
    ['GET','/api/sessions/identity'],['GET','/api/sessions/recording'],['HEAD','/api/sessions/recording'],
    ['POST','/api/sessions/batches'],['POST','/api/sessions/memories'],['PUT','/api/sessions/attachments/'+digest],
    ['POST','/api/context/suggestions'],['POST','/api/context/suggestions/events'],['GET','/api/cli/me'],
    ['GET','/api/setup'],['POST','/api/setup/verify'],['POST','/api/agent-tokens'],['DELETE','/api/sessions/credentials/'+digest],
    ...['bootstrap','ack','inbox','leave','profile','register','v2/inbox','v2/sync','v2/presence'].map(n=>['POST','/api/board/'+n]),
    ['POST','/api/new-worker'],
  ];
  for(const [method,path] of background){assert.equal(httpTool(method,path),undefined,path);assert.equal(await observe(method,path),'served');}
  assert.equal(await observe('POST','/api/search',{origin:'https://console.example'}),'served');
  assert.equal(calls,0);
  for(const [method,path] of [['POST','/api/search'],['POST','/api/search/fetch'],['GET','/api/sessions/batches'],['POST','/api/board/v2/post']]){
    assert.ok(isAgentHttpTool(httpTool(method,path)));await observe(method,path);
  }
  assert.equal(calls,4);
});

test('restored calls count once in their original tenant and day and expose only known facts to their owner',async t=>{
  const db=await applicationDatabaseFixture(t),activity=createSearchActivity(db);
  await activity.ready();
  const id='00000000-0000-4000-8000-000000000101',cutoff=await activity.trackingStart();
  const yesterday=new Date(Date.parse(cutoff)-86400000).toISOString();
  const search={id,at:yesterday,owner:alice.userId,operation:'Board'};
  const call={...search,id:id.slice(0,-1)+'2',operation:null};
  const input=[search,search,call,{...search,id:id.slice(0,-1)+'3',at:new Date(Date.parse(cutoff)+1000).toISOString()},
    {...search,id:id.slice(0,-1)+'4',at:new Date(Date.parse(cutoff)-31*86400000).toISOString()}];
  await Promise.all([1,2].map(()=>activity.importAgentCalls(alice.tenantId,input)));
  await activity.importAgentCalls(other.tenantId,[{...search,owner:other.userId}]);
  await activity.agentCall(alice);
  const totals=await activity.totals(bob);
  assert.deepEqual([totals.calls,totals.agentSearches,totals.proactiveChecks,totals.includesEarlierCalls],[3,0,0,true]);
  assert.equal((await activity.totals(other)).calls,1);
  const {rows}=await activity.page(alice,{kind:'agent'},identity);
  assert.deepEqual(rows,[]);
  assert.deepEqual((await activity.page(bob,{kind:'agent'},identity)).rows,[]);
});
