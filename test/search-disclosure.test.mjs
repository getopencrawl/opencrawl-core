import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceSearch} from '../src/search/workspace.mjs';
import {excerpt, groupDuplicates} from '../src/search/presentation.mjs';
import {createSessionSearch} from '../src/sessions/search.mjs';
import {createConnectorSearch} from '../src/connectors/search.mjs';
import {documentId} from '../src/connectors/scope.mjs';
import {realmResponse} from './realm-fixture.mjs';

const principal = {tenantId:'team', userId:'reader'};
test('compact excerpts preserve exact source text and find evidence beyond navigation', () => {
  const text = 'Navigation\n'.repeat(400) + 'The largest SSD is 500GB [add $300.00].\n' + 'Footer\n'.repeat(200);
  const result = excerpt(text, '500GB SSD');
  assert.ok(result.text.includes('$300.00'));
  assert.ok(result.text.length <= 800);
  assert.equal(result.text, text.slice(result.excerpt.start, result.excerpt.end));
  assert.equal(result.excerpt.totalChars, text.length);
  assert.equal(excerpt('short', 'short').text, 'short');
});

test('duplicate groups preserve changed values, distinct resources and roles, and count the candidate window', () => {
  const text = 'Original evidence about the rollout. '.repeat(5);
  const hit = (id, extra={}) => ({id, source:'sessions', text, provenance:{sessionId:'s',userId:'u',kind:'message',role:'user'}, ...extra});
  const input = [hit('one'), hit('two',{text:text.replaceAll(' ', '\n')}), hit('changed',{text:text+'It was canceled.'}), hit('other-role',{provenance:{sessionId:'s',userId:'u',kind:'message',role:'assistant'}}), hit('short',{text:'yes'}), hit('short-again',{text:'yes'})];
  const grouped = groupDuplicates(input);
  assert.equal(grouped.suppressed, 1); assert.equal(grouped.results.length, 5);
  assert.equal(grouped.results[0].duplicateCount, 1);assert.deepEqual(grouped.results[0].duplicateIds,['two']);
  assert.equal(input[0].duplicateCount, undefined);
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
  const sessions=createSessionSearch({endpoint:'http://example.test',tenantId:'team',fetch:async(url,init)=>{
    const body=JSON.parse(init.body);assert.ok(body.query.bool.filter.some(f=>f.term?.tenantId==='team'));
    assert.ok(body.query.bool.filter.some(f=>f.term?.corpus==='session'));
    assert.ok(body.query.bool.must[0].bool.filter.some(f=>f.term?.id==='specific'));
    return realmResponse('session',{hits:{total:{value:1},hits:[{_id:'specific',_source:{tenantId:'team',userId:'author',text:'source'}}]}});
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
