import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRecentSessions, sessionMessage} from '../dist/src/sessions/recent.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {realmIndex, realmDocument} from '../dist/src/search/realm.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createBoard} from '../dist/src/board/board.mjs';
import {gunzipSync} from 'node:zlib';
import {createControls} from '../dist/src/sessions/controls.mjs';

test('snapshots extract only human and assistant text across both harness formats', () => {
  const message = (role, content) => ({kind: 'message', data: {role, content}});
  assert.deepEqual(sessionMessage(message('user', 'hello')), {role: 'user', text: 'hello'});
  assert.deepEqual(sessionMessage(message('user', ' \nhello\n ')), {role: 'user', text: ' \nhello\n '});
  assert.deepEqual(sessionMessage(message('assistant', [
    {type: 'thinking', thinking: 'private reasoning'}, {type: 'tool_use', name: 'Bash', input: {command: 'secret'}},
    {type: 'text', text: 'Visible answer'}, {type: 'output_text', text: 'More text'},
  ])), {role: 'assistant', text: 'Visible answer\nMore text'});
  assert.equal(sessionMessage(message('user', [{type: 'tool_result', content: 'Tool output'}])), null);
  assert.equal(sessionMessage(message('assistant', [{type: 'tool_use', name: 'Bash'}])), null);
  assert.equal(sessionMessage({kind: 'tool_result', data: {role: 'assistant', content: 'tool'}}), null);
  assert.equal(sessionMessage(message('system', 'instructions')), null);
  for (const text of ['# AGENTS.md instructions\nInjected project context', '<environment_context>cwd</environment_context>', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', '<subagent_notification>Agent finished</subagent_notification>', '<turn_aborted>Interrupted</turn_aborted>']) {
    assert.equal(sessionMessage(message('user', text)), null);
  }
  assert.equal(sessionMessage({kind: 'agent_message', data: {author: 'assistant', recipient: 'Bash', content: 'command'}}), null);
  assert.deepEqual(sessionMessage({kind: 'agent_message', data: {author: 'assistant', recipient: 'all', content: [{type: 'text', text: 'Latest commentary'}]}}), {role: 'assistant', text: 'Latest commentary'});
  assert.deepEqual(sessionMessage({kind: 'user_message', data: {message: 'User follow-up', images: ['ignored']}}), {role: 'user', text: 'User follow-up'});
});

test('snapshot scope checks precede all reads and reject malformed aggregation identities', async () => {
  const store = memorySessionStore(); let requests = 0;
  const recent = createRecentSessions({store, prefix: 'sessions', endpoint: 'http://localhost:9200',
    fetch: async () => {requests++; return Response.json({timed_out:false, _shards:{failed:0}, hits:{hits:[]}, aggregations:{recent:{buckets:[{key:['attacker'],lastActivity:{value:1}}]}}});}});
  await assert.rejects(recent.read(null), /Authentication/);
  await assert.rejects(recent.read({tenantId:'org',userId:'user',captureAccess:'write'}), /read access/);
  assert.equal(requests, 0);
  await assert.rejects(recent.read({tenantId:'org',userId:'user'}), /Invalid recent/);
});

test('sync uses session discovery without requesting transcripts; outages preserve posts', async () => {
  const objects = new Map(); let calls=0, failure=false, hang=false;
  const store={async readVersion(k){return objects.get(k)||{version:null,data:null};},async compareAndSet(k,v,data){objects.set(k,{version:1,data});return true;}};
  const principal={tenantId:'org',userId:'reader'}, snapshot=[{sessionId:'team-session',title:'Private context'}];
  const board=createBoard({store,prefix:'board',sessionTimeoutMs:10,recentSessions:{async read(){throw new Error('Sync must not load transcripts');},async list(who){assert.deepEqual(who,principal);calls++;if(failure)throw new Error('offline');if(hang)return new Promise(()=>{});return snapshot;}}});
  let read=await board.sync(principal,{workspace:'org',agent:'reader',topics:[]});
  assert.deepEqual(read.recentSessions,snapshot);assert.equal(read.recentSessionsStatus.state,'ready');
  read=await board.sync(principal,{workspace:'org',agent:'reader',topics:['unrelated'],after:read.cursor,leave:true});
  assert.deepEqual(read.recentSessions,snapshot);assert.equal(calls,2);
  assert.ok([...objects.values()].every(value=>!String(value.data).includes('Private context')));
  failure=true;
  read=await board.sync(principal,{workspace:'org',agent:'reader',posts:[{id:'outage',topic:'work',text:'Useful update'}]});
  assert.deepEqual(read.accepted,[1]);assert.equal(read.recentSessionsStatus.state,'unavailable');assert.deepEqual(read.recentSessions,[]);
  failure=false;hang=true;
  read=await board.sync(principal,{workspace:'org',agent:'reader'});assert.equal(read.recentSessionsStatus.state,'unavailable');
  await assert.rejects(board.sync(principal,{workspace:'foreign',agent:'reader'}),{status:403});assert.equal(calls,4);
});

const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
test('selected session fetch pages only requested text and detects changed content', async () => {
  let text = 'Evidence '.repeat(2000), calls = 0, activity = '2026-11-09T00:00:00Z';
  const snapshot = () => ({id:'session:selected', userId:'owner', harness:'codex', installationId:'one', sessionId:'one', title:'Selected work', titleSource:'captured', titleTimestamp:null, lastActivityAt:activity, partial:false,
    firstUserMessage:{text:'Original request',eventId:'first',timestamp:null,receivedAt:null}, lastUserMessage:null, latestAssistantMessage:{text,eventId:'last',timestamp:null,receivedAt:null}});
  const store={async readVersion(){return {data:null,version:null};},async compareAndSet(){return true;}};
  const board=createBoard({store,prefix:'board',recentSessions:{async list(){throw new Error('No discovery needed for selected fetch');},async fetch(who,id,options){calls++;assert.equal(who.tenantId,'org');assert.equal(id,'session:selected');assert.equal(options.field,'latestAssistantMessage');return snapshot();}}});
  const args={workspace:'org',id:'session:selected',field:'latestAssistantMessage',length:100};
  const first=await board.fetch({tenantId:'org',userId:'reader'},args);
  assert.ok(first.text.length===100);assert.ok(!first.text.includes('Original request'));
  activity='2026-11-09T00:00:01Z'; // New tool activity must not invalidate unchanged selected text.
  const next=await board.fetch({tenantId:'org',userId:'reader'},{...args,offset:first.nextOffset,version:first.version});
  assert.equal(next.offset,100);assert.equal(next.totalChars,first.totalChars);
  text+=' Changed';
  await assert.rejects(board.fetch({tenantId:'org',userId:'reader'},{...args,offset:next.nextOffset,version:first.version}),{status:409});
  assert.equal(calls,3);
});

test('selected reply fetch skips unrelated history reads and still rechecks visibility', async () => {
  const store=memorySessionStore(), prefix='sessions/selected', owner={tenantId:'team',userId:'alice'}, reader={...owner,userId:'bob'};
  const identity={userId:'alice',harness:'claude-code',installationId:'device',sessionId:'long-session'};
  const ingest=createSessionIngest({store,prefix}), docs=[];
  for (const [id,role,text] of [['first','user','Original request'],['answer','assistant','Latest answer']]) {
    await ingest.putBatch(owner,{schemaVersion:1,owner,...identity,origin:'desktop',attachments:[],events:[{
      id,kind:'message',timestamp:'2026-11-10T00:00:00Z',sequence:docs.length,data:{role,content:[{type:'text',text}]},
    }]});
    const key=[...store.data.keys()].filter(k=>k.endsWith('.json.gz')).at(-1), batch=JSON.parse(gunzipSync(store.data.get(key)));
    docs.push(batchDocuments({prefix,key,batch,principal:owner})[0]);
  }
  const id='session:'+Buffer.from(JSON.stringify([owner.tenantId,...Object.values(identity)])).toString('base64url');
  let queryCount=0, revoke=false;
  const controls=createControls({store,prefix});
  const readStore={...store,async get(key,options){
    const value=await store.get(key,options);
    if(revoke && key===docs[1].document.sourceKey) await controls.update(owner,'sessions','claude-code','long-session',()=>({visibility:'private',deletedAt:null}));
    return value;
  }};
  const recent=createRecentSessions({store:readStore,prefix,endpoint:'http://localhost:9200',fetch:async (_url,options)=>{
    queryCount++;
    const body=JSON.parse(options.body), query=JSON.stringify(body.query);
    assert.ok(query.includes('"tenantId":"team"'));
    const base={timed_out:false,_shards:{failed:0},hits:{hits:[]}};
    if(body.aggs) return Response.json({...base,aggregations:{recent:{buckets:[{key:Object.values(identity),lastActivity:{value:Date.parse('2026-11-10T00:00:00Z')}}]}}});
    if(query.includes('session_metadata'))return Response.json(base);
    const assistant=query.includes('"assistant"');
    // Simulates hundreds of user-role tool results. Reading this unrelated
    // history would fail the selected reply even though that reply is ready.
    if(!assistant && body.sort[0].timestamp==='desc')throw new Error('Unrelated last-user history must not be read');
    const item=docs[assistant?1:0];
    return Response.json({...base,hits:{hits:[{_id:'session:'+item.id,_source:realmDocument('session',item.id,item.document)}]}});
  }});
  const board=createBoard({store,prefix:'board',recentSessions:recent});
  const args={workspace:'team',id,field:'latestAssistantMessage'};
  const result=await board.fetch(reader,args);
  assert.equal(result.text,'Latest answer');assert.equal(result.session.title,'Original request');assert.equal(result.session.partial,false);
  assert.deepEqual(Object.keys(result.messages),['latestAssistantMessage']);
  assert.equal(queryCount,4);
  const before=queryCount;
  await assert.rejects(recent.fetch({...reader,tenantId:'foreign'},id,{field:'latestAssistantMessage'}),{status:404});
  assert.equal(queryCount,before);
  revoke=true;
  await assert.rejects(board.fetch(reader,args),{status:404});
});

test('real realm: newest ten org sessions, original first/last text, tool exclusion, timestamps and source isolation', {skip:!endpoint}, async t => {
  const environment='recent-'+randomUUID().slice(0,8), prefix='sessions/recent', store=memorySessionStore();
  const owner={tenantId:'team',userId:'alice'}, teammate={...owner,userId:'bob'}, foreign={...owner,tenantId:'foreign'};
  const search=createSessionSearch({endpoint,environment}), recent=createRecentSessions({endpoint,environment,store,prefix});
  t.after(async()=>{for(const who of [owner,foreign])await fetch(endpoint+'/'+realmIndex(environment,who.tenantId),{method:'DELETE'});});
  for(let attempt=0;;attempt++){try{await search.ensureIndex(owner);await search.ensureIndex(foreign);break;}catch(error){if(attempt>=60)throw error;await new Promise(resolve=>setTimeout(resolve,1000));}}
  const ingest=createSessionIngest({store,prefix});
  const event=(id,role,text,minute,extra={})=>({id,kind:'message',sequence:minute,timestamp:new Date(Date.UTC(2026,10,1,0,minute)).toISOString(),data:{role,content:[{type:'text',text}]},...extra});
  async function add(who,sessionId,events,harness='codex',installationId='device') {
    await ingest.putBatch(who,{schemaVersion:1,owner:who,harness,origin:'desktop',installationId,sessionId,events,attachments:[]});
    const key=[...store.data.keys()].filter(k=>k.endsWith('.json.gz')).at(-1);
    const batch=JSON.parse(gunzipSync(store.data.get(key)));
    await search.putDocuments(batchDocuments({prefix,key,batch,principal:who}),who);
    return {key,batch};
  }
  for(let i=0;i<12;i++)await add(owner,'session-'+i,[event('message','user','Session '+i,i)]);
  const firstText='Actual request '+ '🌿'.repeat(9000)+' FIRST-END';
  const lastText='Follow-up '+ 'x'.repeat(17000)+' LAST-END';
  const assistantText='Latest non-tool answer '+ 'y'.repeat(17000)+' ASSISTANT-END';
  const capturedTitle='Captured title '+ 't'.repeat(400)+' TITLE-END';
  const fallbackText='Other machine\n'+ 'm'.repeat(500)+' FALLBACK-END';
  const original=await add(teammate,'session-11',[
    event('context','user','# AGENTS.md instructions\nInjected context',19),
    event('first','user',firstText,20),event('answer','assistant','Earlier answer',21),event('last','user',lastText,22),
    {id:'native',kind:'agent_message',sequence:23,timestamp:'2026-11-01T00:23:00Z',data:{author:'assistant',recipient:'all',content:[{type:'text',text:assistantText}]}},
    ...Array.from({length:25},(_,i)=>event('tool-'+i,'assistant','',24+i,{data:{role:'assistant',content:[{type:'tool_use',name:'Bash',input:{command:'do not expose'}}]}})),
    event('tool-result','user','',49,{data:{role:'user',content:[{type:'tool_result',content:'not a user request'}]}}),
    event('notification','user','<subagent_notification>Agent finished</subagent_notification>',49),
    {id:'title',kind:'session_metadata',sequence:50,timestamp:'2026-11-01T00:50:00Z',data:{title:capturedTitle}},
  ]);
  await add(owner,'session-11',[event('claude','user','Other harness',51)],'claude-code');
  await add(owner,'session-11',[event('machine','user',fallbackText,52)],'codex','device-2');
  await add(foreign,'session-11',[event('secret','user','FOREIGN SECRET',59)]);
  // Re-upload old activity now: receivedAt must not determine recency.
  await add(owner,'ancient',[event('ancient','user','Historical backfill',0)]);
  await search.refresh(owner);await search.refresh(foreign);
  const rows=await recent.read(owner);
  assert.equal(rows.length,10);assert.equal(rows[0].installationId,'device-2');assert.equal(rows[1].harness,'claude-code');
  const row=rows[2];assert.equal(row.userId,'bob');assert.equal(row.sessionId,'session-11');assert.equal(row.title,capturedTitle);
  assert.equal(row.titleSource,'captured');assert.equal(row.titleTimestamp,'2026-11-01T00:50:00.000Z');assert.equal(row.lastActivityAt,row.titleTimestamp);
  assert.equal(row.firstUserMessage.text,firstText);assert.equal(row.firstUserMessage.timestamp,'2026-11-01T00:20:00.000Z');
  assert.equal(row.lastUserMessage.text,lastText);
  assert.equal(row.latestAssistantMessage.text,assistantText);assert.equal(row.latestAssistantMessage.timestamp,'2026-11-01T00:23:00.000Z');assert.equal(row.partial,false);
  assert.equal(rows[0].title,fallbackText.replace(/\s+/g,' ').trim());assert.equal(rows[0].titleSource,'first_user_message');assert.equal(rows[0].latestAssistantMessage,null);
  assert.ok(!JSON.stringify(rows).includes('FOREIGN SECRET'));assert.ok(!rows.some(r=>r.sessionId==='ancient'));
  assert.deepEqual(await recent.read({...owner,tenantId:'empty'}),[]);
  t.after(()=>fetch(endpoint+'/'+realmIndex(environment,'empty'),{method:'DELETE'}));
  assert.equal((await recent.read(foreign))[0].firstUserMessage.text,'FOREIGN SECRET');
  const discovery = await recent.list(owner);
  assert.equal(discovery.length, 10);
  assert.ok(discovery.every(item => item.title.length <= 120 && !('firstUserMessage' in item) && !('latestAssistantMessage' in item)));
  assert.ok(Buffer.byteLength(JSON.stringify(discovery)) < 6000);
  const selected = await recent.fetch(owner, discovery[2].id);
  assert.equal(selected.firstUserMessage.text, firstText);
  assert.equal(selected.latestAssistantMessage.text, assistantText);
  const selectedReply = await recent.fetch(owner, discovery[2].id, {field:'latestAssistantMessage'});
  assert.equal(selectedReply.latestAssistantMessage.text, assistantText);
  assert.equal(selectedReply.firstUserMessage, null);assert.equal(selectedReply.lastUserMessage, null);
  await assert.rejects(recent.fetch(foreign, discovery[2].id), {status: 404});
  const controls = createControls({store, prefix});
  await controls.update(teammate, 'sessions', 'codex', 'session-11', () => ({visibility: 'private', deletedAt: null}));
  // The index is intentionally stale: current owner controls must still deny.
  await assert.rejects(recent.fetch(owner, discovery[2].id), {status: 404});
  assert.ok(!(await recent.list(owner)).some(item => item.id === discovery[2].id));
  await controls.update(teammate, 'sessions', 'codex', 'session-11', () => ({visibility: 'team', deletedAt: null}));
  // Source ownership is revalidated; an index hit cannot authorize another org's batch.
  const poisoned={...original.batch,owner:foreign};
  const {gzipSync}=await import('node:zlib');store.data.set(original.key,gzipSync(JSON.stringify(poisoned)));
  await assert.rejects(recent.read(owner),/authorized scope/);
});
