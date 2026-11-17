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
async function fixture(t,{failHandoff=false,answer}={}){
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
  const reopen=()=>createReplicasImport({database,key,ingest,request});
  return {database,store,calls,handed,reopen,service:reopen()};
}
test('preview has no history reads; encrypted checkpoint survives restart, imports all pages and erases key',async t=>{
  const f=await fixture(t);let status=await f.service.action(principal,{action:'preview',apiKey:'private-org-key'});
  assert.equal(status.phase,'preview');assert.equal(f.calls.length,2);assert.equal(f.handed.length,0);
  const row=(await f.database.pool.query('SELECT state,credential FROM opencrawl_replicas_imports WHERE namespace=$1',[f.database.namespace])).rows[0];
  assert.ok(row.credential);assert.ok(!row.credential.includes(Buffer.from('private-org-key')));assert.ok(!JSON.stringify(row.state).includes('private-org-key'));
  await assert.rejects(f.service.action(principal,{action:'step',id:status.id}),/approve/);
  await assert.rejects(f.service.action({...principal,tenantId:'org_other'},{action:'start',id:status.id}),/changed/);
  assert.equal(await f.service.status({...principal,tenantId:'org_other'}),null);
  await f.service.action(principal,{action:'start',id:status.id});
  status=await f.service.action(principal,{action:'step',id:status.id});assert.equal(status.messages,1);assert.equal(status.phase,'importing');
  status=await f.reopen().action(principal,{action:'step',id:status.id});assert.equal(status.phase,'complete');assert.equal(status.messages,2);assert.equal(status.imported,1);
  assert.equal((await f.database.pool.query('SELECT credential FROM opencrawl_replicas_imports WHERE namespace=$1',[f.database.namespace])).rows[0].credential,null);
  const previous=[...f.handed];status=await f.service.action(principal,{action:'preview',apiKey:'private-org-key'});await f.service.action(principal,{action:'start',id:status.id});
  for(let i=0;i<2;i++)await f.service.action(principal,{action:'step',id:status.id});
  assert.deepEqual(f.handed.slice(2),previous,'repeat import reuses immutable batch paths');
});
test('failed durable indexing handoff leaves cursor unchanged and resume retries the same batch',async t=>{
  const f=await fixture(t,{failHandoff:true});const {id}=await f.service.action(principal,{action:'preview',apiKey:'private-org-key'});await f.service.action(principal,{action:'start',id});
  await assert.rejects(f.service.action(principal,{action:'step',id}),/queue unavailable/);
  assert.equal((await f.service.status(principal)).messages,0);
  assert.equal((await f.reopen().action(principal,{action:'step',id})).messages,1);
  assert.equal(f.calls.filter(url=>url.pathname.endsWith('history')&&!url.searchParams.has('before_cursor')).length,2);
  const disconnected=await f.service.action(principal,{action:'disconnect',id});assert.equal(disconnected.phase,'disconnected');
  await assert.rejects(f.service.action(principal,{action:'step',id}),/approve/);
});
test('personal keys and upstream bodies never become accepted credentials or exposed error text',async t=>{
  const database=await applicationDatabaseFixture(t),key=randomBytes(32);
  const service=createReplicasImport({database,key,ingest:async()=>{throw new Error('not allowed');},request:async()=>Response.json({organization,caller:'personal_api_key'})});
  await assert.rejects(service.action(principal,{action:'preview',apiKey:'secret'}),/organization API key/);assert.equal(await service.status(principal),null);
  const api=replicasApi('secret',async()=>new Response('upstream secret',{status:403}));await assert.rejects(api.identity(),error=>!error.message.includes('upstream secret')&&error.message.includes('denied'));
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
test('decoder preserves message content and timestamps, ignores duplicate Codex echo and metadata',()=>{
  const history={events:[{type:'event_msg',payload:{type:'user_message',message:'same'}},{type:'codex-item',timestamp:'2026-10-01',payload:{item:{type:'userMessage',id:'x',content:[{type:'text',text:'same'}]}}},{type:'codex-item',timestamp:'2026-10-02',payload:{item:{type:'agentMessage',id:'y',text:'answer'}}}],before_cursor:null};
  const events=replicasEvents({...chat,provider:'codex'},history);assert.equal(events.length,2);assert.equal(events[0].data.role,'user');assert.equal(events[1].data.content[0].text,'answer');assert.equal(events[0].timestamp,'2026-10-01');assert.deepEqual(replicasEvents({...chat,provider:'codex'},history),events);
  const native=structuredClone(history);native.events[1].payload.item.content='same';assert.deepEqual(replicasEvents({...chat,provider:'codex'},native),events,'native retained Codex uses string userMessage content');
});
test('export pagination continues past unavailable retained entries and reports coverage honestly',async t=>{
  const second={...chat,chat_id:randomUUID(),workspace_id:randomUUID()},unsupported={...chat,chat_id:randomUUID(),provider:'muse'};
  const f=await fixture(t,{answer:url=>{
    if(url.pathname.endsWith('conversations'))return Response.json(url.searchParams.has('cursor')?{conversations:[unsupported,second],total:3,next_cursor:null}:{conversations:[chat],total:3,next_cursor:'second-page'});
    if(url.pathname===`/v1/replica/${chat.workspace_id}/history`)return new Response('',{status:404});
    if(url.pathname===`/v1/replica/${second.workspace_id}/history`)return Response.json({events:[event('retained second conversation')],before_cursor:null});
  }});
  let state=await f.service.action(principal,{action:'preview',apiKey:'key'});await f.service.action(principal,{action:'start',id:state.id});
  for(let i=0;i<8&&state.phase!=='complete';i++)state=await f.service.action(principal,{action:'step',id:state.id});
  assert.equal(state.phase,'complete');assert.equal(state.processed,3);assert.equal(state.imported,1);assert.equal(state.unavailable,1);assert.equal(state.unsupported,1);assert.equal(state.skipped,2);
});
test('repeated history cursors and transient failures cannot advance or duplicate a checkpoint',async t=>{
  let failure=false;
  const f=await fixture(t,{answer:url=>{
    if(url.pathname.endsWith('/history'))return failure?new Response('do not expose secret',{status:500}):Response.json({events:[event('one')],before_cursor:'same'});
  }});
  const {id}=await f.service.action(principal,{action:'preview',apiKey:'key'});await f.service.action(principal,{action:'start',id});await f.service.action(principal,{action:'step',id});
  await assert.rejects(f.service.action(principal,{action:'step',id}),/repeated a history cursor/);assert.equal((await f.service.status(principal)).messages,1);
  failure=true;await assert.rejects(f.service.action(principal,{action:'step',id}),/could not read/);assert.equal((await f.service.status(principal)).messages,1);assert.equal(f.handed.length,1);
});
test('the same Replicas chat imported into two tenants gets separate immutable paths and owners',async t=>{
  const f=await fixture(t);
  for(const tenantId of ['org_a','org_b']){
    const owner={...principal,tenantId};let state=await f.service.action(owner,{action:'preview',apiKey:'key'});await f.service.action(owner,{action:'start',id:state.id});
    while(state.phase!=='complete')state=await f.service.action(owner,{action:'step',id:state.id});
  }
  assert.equal(new Set(f.handed).size,4);assert.notEqual(f.handed[0].split('/users/')[0],f.handed[2].split('/users/')[0]);
});
