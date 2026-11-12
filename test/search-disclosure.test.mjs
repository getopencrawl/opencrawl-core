import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {approvalRecord, excerpt, groupDuplicates, groupResources} from '../dist/src/search/presentation.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {documentId} from '../dist/src/connectors/scope.mjs';
import {realmResponse} from './realm-fixture.mjs';

const principal = {tenantId:'team', userId:'reader'};
test('resource groups choose a matching content passage over a title-only parent without moving its slot',()=>{
  const parent={id:'parent',source:'connectors',title:'Fix fork identity',text:'Fix fork identity',sourceRank:1,provenance:{provider:'github',connectionId:'c',workspaceId:'w',sourceId:'repo:33',kind:'pull_request'}};
  const passage={...parent,id:'body',sourceRank:3,text:'Fix fork identity\nKeep the leading native session identity across resumed imports.',provenance:{...parent.provenance,sourceId:'repo:33:body:0',kind:'passage',parentId:'repo:33',parentKind:'pull_request'}};
  const unrelated={...parent,id:'other',provenance:{...parent.provenance,sourceId:'repo:34'}};
  const second={...passage,id:'validation',text:'Fix fork identity\nRegression tests passed.'};
  const input=[parent,unrelated,passage,second],grouped=groupResources(input,'resource');
  assert.deepEqual(grouped.results.map(h=>h.id),['body','other']);assert.equal(grouped.suppressed,2);
  assert.equal(grouped.results[0].sourceRank,3);assert.equal(grouped.results[0].groupedCount,2);
  assert.deepEqual(grouped.results[0].groupedIds,['parent','validation']);assert.equal(parent.groupedCount,undefined);
  assert.deepEqual(groupResources(input,'none').results,input);
  assert.equal(groupResources(input,'resource',false).results[0].id,'parent');
  assert.equal(groupResources([{...parent,text:'The full parent document contains useful detail.'},passage],'resource').results[0].id,'parent');
  assert.equal(groupResources([parent,{...passage,text:passage.title}],'resource').results[0].id,'parent');
  for(const field of ['connectionId','workspaceId','provider']){
    const foreign={...passage,provenance:{...passage.provenance,[field]:'different'}};
    assert.equal(groupResources([parent,foreign],'resource').results.length,2);
  }
  const session={...parent,source:'sessions',provenance:{userId:'owner',harness:'codex',sessionId:'s',eventId:'e',kind:'message'}};
  assert.equal(groupResources([session,{...session,id:'second-chunk',text:'More context'}],'resource').results[0].id,'parent');
});

test('recognized approval records follow evidence while remaining discoverable and fetchable', async () => {
  const text=JSON.stringify({risk_level:'low',user_authorization:'high',outcome:'allow',rationale:'Read-only WorkOS Better Auth inspection.'});
  const approval={id:'approval',tenantId:'team',userId:'author',sessionId:'s',eventId:'a',harness:'codex',origin:'subagent',kind:'message',role:'assistant',text,timestamp:'2026-11-10T10:00:00Z'};
  const evidence={...approval,id:'evidence',eventId:'b',text:'WorkOS provides hosted identity; Better Auth runs locally.',timestamp:'2026-11-09T10:00:00Z'};
  const hits=[approval,evidence], service=createWorkspaceSearch({sessions:{search:async(p,q)=>({hits:q.id?hits.filter(h=>h.id===q.id):hits,total:q.id?1:2})}});
  const first=await service.search(principal,{query:'WorkOS Better Auth',limit:1,facets:['kind']});
  assert.equal(first.results[0].id,'sessions:evidence');assert.equal(first.ranking,'source_rank_interleave_with_approval_demotion');
  assert.equal(first.facets.kind.values[0].count,2);
  const next=await service.search(principal,{query:'WorkOS Better Auth',limit:1,facets:['kind'],cursor:first.next});assert.equal(next.results[0].id,'sessions:approval');
  assert.equal((await service.fetch(principal,{id:'sessions:approval'})).text,text);
  for(const query of [{query:'approval WorkOS'},{query:'approved WorkOS'},{query:'deny deletion'},{query:'authorized command'},{query:'risk_level'},{query:'WorkOS',order:'newest'}])assert.equal((await service.search(principal,query)).results[0].id,'sessions:approval');
  const foreign=createWorkspaceSearch({sessions:{search:async()=>({hits:[{...approval,tenantId:'other'}],total:1})}});
  await assert.rejects(foreign.search(principal,{query:'WorkOS'}),/scope/);
});

test('approval classification preserves user text, other sources and incomplete lookalikes', () => {
  const record={risk_level:'low',user_authorization:'high',outcome:'allow',rationale:'Read-only inspection.'};
  const hit={source:'sessions',text:JSON.stringify(record),provenance:{harness:'codex',origin:'subagent',kind:'message',role:'assistant'}};
  assert.equal(approvalRecord(hit),true);
  for(const changed of [{...hit,source:'connectors'},{...hit,provenance:{...hit.provenance,role:'user'}},{...hit,provenance:{...hit.provenance,origin:'desktop'}},
    {...hit,text:'Quoted decision: '+hit.text},{...hit,text:hit.text+' broken'},
    {...hit,text:JSON.stringify({...record,detail:'substantive extra content'})},{...hit,text:JSON.stringify({...record,risk_level:['low']})}])assert.equal(approvalRecord(changed),false);
});

test('compact excerpts preserve exact source text and find evidence beyond navigation', () => {
  const text = 'Navigation\n'.repeat(400) + 'The largest SSD is 500GB [add $300.00].\n' + 'Footer\n'.repeat(200);
  const result = excerpt(text, '500GB SSD');
  assert.ok(result.text.includes('$300.00'));
  assert.ok(result.text.length <= 800);
  assert.equal(result.text, text.slice(result.excerpt.start, result.excerpt.end));
  assert.equal(result.excerpt.totalChars, text.length);
  assert.equal(excerpt('short', 'short').text, 'short');
});

test('whole keyword evidence outranks repeated substring navigation', () => {
  const text = 'Latest author navigation.\n'.repeat(300) + 'The AUTH test passed: verified checkpoint.\n' + 'Footer\n'.repeat(100);
  const result = excerpt(text, 'test auth', 300);
  assert.match(result.text, /verified checkpoint/);
  assert.equal(result.text, text.slice(result.excerpt.start, result.excerpt.end));
  assert.ok(result.text.length <= 300);
});

test('combining marks remain part of excerpt keywords and offsets stay verbatim', () => {
  const word = 'cafe\u0301';
  const text = 'cafeteria navigation.\n'.repeat(300) + `The ${word} record contains the approved detail.\n` + 'Footer\n'.repeat(100);
  const result = excerpt(text, word, 300);
  assert.match(result.text, /approved detail/);
  assert.equal(result.text, text.slice(result.excerpt.start, result.excerpt.end));
});

test('duplicate groups preserve changed values, distinct resources and roles, and count the candidate window', () => {
  const text = 'Original evidence about the rollout. '.repeat(5);
  const hit = (id, extra={}) => ({id, source:'sessions', text, provenance:{sessionId:'s',userId:'u',kind:'message',role:'user'}, ...extra});
  const input = [hit('one'), hit('two',{text:text+'  \r\n'}), hit('changed',{text:text+'It was canceled.'}), hit('other-role',{provenance:{sessionId:'s',userId:'u',kind:'message',role:'assistant'}}), hit('short',{text:'yes'}), hit('short-again',{text:'yes'})];
  const grouped = groupDuplicates(input);
  assert.equal(grouped.suppressed, 1); assert.equal(grouped.results.length, 5);
  assert.equal(grouped.results[0].duplicateCount, 1);assert.deepEqual(grouped.results[0].duplicateIds,['two']);
  assert.equal(input[0].duplicateCount, undefined);
  assert.equal(groupDuplicates([hit('code',{text:'if ready:\n    execute()\n'+text}),hit('changed-code',{text:'if ready:\nexecute()\n'+text})]).suppressed,0);
  const connector = {source:'connectors',text,provenance:{provider:'notion',connectionId:'c',workspaceId:'w',sourceId:'a',kind:'page'}};
  assert.equal(groupDuplicates([{...connector,id:'a'}, {...connector,id:'b',provenance:{...connector.provenance,sourceId:'b'}}]).suppressed,0);
});

test('fetch is scoped, paged, version checked and freshly authorized; grouped originals remain fetchable', async () => {
  let active = true, text = 'Important evidence. '.repeat(1000);
  const hit = id => ({id,tenantId:'team',userId:'author',sessionId:'s',text});
  const service = createWorkspaceSearch({sessions:{search:async(p,q)=>{
    assert.deepEqual(p,principal);
    if (!active) return {hits:[],total:0};
    return q.id ? {hits:q.id==='missing'?[]:[hit(q.id)],total:1} : {hits:[hit('a'),hit('b')],total:2};
  }}});
  const result = await service.search(principal,{query:'evidence'});
  assert.equal(result.results.length,1); assert.equal(result.deduplicated,1);assert.equal(result.results[0].text.length,800);
  assert.equal((await service.search(principal,{query:'evidence',dedupe:false})).results.length,2);
  const first = await service.fetch(principal,{id:'sessions:b',length:1000});
  assert.equal(first.text,text.slice(0,1000));assert.equal(first.nextOffset,1000);
  const second = await service.fetch(principal,{id:first.id,offset:first.nextOffset,length:16000,version:first.version});
  assert.equal(second.text,text.slice(1000,17000));
  const last = await service.fetch(principal,{id:first.id,offset:second.nextOffset,version:second.version});
  assert.equal(last.nextOffset,null);assert.equal(first.text+second.text+last.text,text);
  text += 'changed'; await assert.rejects(service.fetch(principal,{id:first.id,version:first.version}),e=>e.status===409);
  for (const input of [{id:'sessions:b',tenantId:'foreign'},{id:'../../../secret'},{id:'sessions:b',offset:-1},{id:'sessions:b',length:16001}]) await assert.rejects(service.fetch(principal,input),e=>e.status===400);
  await assert.rejects(service.fetch(null,{id:first.id}),e=>e.status===401);
  await assert.rejects(service.fetch({...principal,captureAccess:'write'},{id:first.id}),e=>e.status===403);
  active=false;await assert.rejects(service.fetch(principal,{id:first.id}),e=>e.status===404);
  for (const bad of [{...hit('b'),tenantId:'other'},{...hit('other')}]) {
    const service=createWorkspaceSearch({sessions:{search:async()=>({hits:[bad]})}});
    await assert.rejects(service.fetch(principal,{id:'sessions:b'}),/scope/);
  }
});

test('session ID fetch constrains both the corpus and tenant in the realm', async () => {
  const sessions=createSessionSearch({store:deletionTestStore(),prefix:"capture-v1",endpoint:'http://example.test',tenantId:'team',fetch:async(url,init)=>{
    const body=JSON.parse(init.body);assert.ok(body.query.bool.filter.some(f=>f.term?.tenantId==='team'));
    assert.ok(body.query.bool.filter.some(f=>f.term?.corpus==='session'));
    assert.ok(body.query.bool.must[0].bool.filter.some(f=>f.term?.id==='specific'));
    return realmResponse('session',{hits:{total:{value:1},hits:[{_id:'specific',_source:{tenantId:'team',userId:'author',harness:'codex',sessionId:'s',text:'source'}}]}});
  }});
  const result=await createWorkspaceSearch({sessions}).fetch(principal,{id:'sessions:specific'});assert.equal(result.text,'source');
  await assert.rejects(sessions.search({...principal,tenantId:'other'},{id:'specific'}),/scope/);
});

test('connector fetch still requires public channel and current available parent revision', async () => {
  let publicChannel=true, currentVersion='v1', available=true;
  const binding={tenantId:'team',connectionId:'c',workspaceId:'w',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=w/connection=c/'};
  const id=documentId(binding,'file_chunk','chunk');
  const base={tenantId:'team',connectionId:'c',workspaceId:'w',provider:'slack',deleted:false};
  const adapter=createConnectorSearch({endpoint:'http://example.test',tenantId:'team',fetch:async(url,init)=>{
    const body=JSON.parse(init.body);
    if(url.pathname.endsWith('/_search')) {
      assert.ok(body.query.bool.must[0].bool.filter.some(f=>f.term?.id===id));
      return realmResponse('connector',{hits:{hits:[{_id:id,_source:{...base,kind:'file_chunk',sourceId:'chunk',text:'private full text',channelId:'C',parentId:'F',parentKind:'file',resourceVersion:'v1'}}]}});
    }
    const channel=body.ids[0].includes(documentId(binding,'channel','C'));
    const d=channel?{...base,kind:'channel',sourceId:'C',publicChannel}:{...base,kind:'file',sourceId:'F',resourceVersion:currentVersion,available};
    return realmResponse('connector',{docs:[{_id:documentId(binding,d.kind,d.sourceId),found:true,_source:d}]});
  }});
  const service=createWorkspaceSearch({connectors:{search:(p,q)=>adapter.search(p,[binding],q)}});
  assert.equal((await service.fetch(principal,{id:'connectors:'+id})).text,'private full text');
  publicChannel=false;await assert.rejects(service.fetch(principal,{id:'connectors:'+id}),e=>e.status===404);
  publicChannel=true;currentVersion='v2';await assert.rejects(service.fetch(principal,{id:'connectors:'+id}),e=>e.status===404);
  currentVersion='v1';available=false;await assert.rejects(service.fetch(principal,{id:'connectors:'+id}),e=>e.status===404);
});
