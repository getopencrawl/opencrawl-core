import {memorySessionStore as deletionTestStore} from './session-store-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoard} from '../dist/src/board/board.mjs';
import {createBoardSearch} from '../dist/src/board/search.mjs';
import {createRealm} from '../dist/src/search/realm.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';

const principal={tenantId:'tenant-a',userId:'author'};
const restrictedAccess=['write','read','',null,false,{}];
const binding={tenantId:principal.tenantId,connectionId:'connection',workspaceId:'workspace',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=workspace/connection=connection/'};
const denied=error=>error.status===403;

test('upload-only and unknown capabilities cannot read or mutate indexes through the core operations',async()=>{
  let requests=0;
  const options={endpoint:'https://search.example.test',tenantId:principal.tenantId,fetch:async()=>{requests++;throw new Error('Unexpected storage access');}};
  const realm=createRealm(options), collection=realm.collection('session'), sessions=createSessionSearch({...options,store:deletionTestStore(),prefix:"capture-v1"}), connectors=createConnectorSearch(options);
  for(const captureAccess of restrictedAccess){
  const delegated={...principal,captureAccess};
  const actions=[
    ()=>collection.search(delegated,{}),
    ()=>collection.mget(delegated,['known-id']),
    ()=>collection.bulk(delegated,[]),
    ()=>collection.update(delegated,'known-id',{upsert:{...principal}}),
    ()=>realm.refresh(delegated),
    ()=>sessions.ensureIndex(delegated),
    ()=>sessions.search(delegated,{query:'private transcript'}),
    ()=>sessions.search(delegated,{query:'',raw:true}),
    ()=>sessions.usage(delegated,{team:true}),
    ()=>sessions.putDocuments([],delegated),
    ()=>sessions.refresh(delegated),
    ()=>connectors.search(delegated,[binding],{query:'private source'}),
    ()=>connectors.count(delegated,[binding]),
    ()=>connectors.putDocuments(delegated,binding,[]),
    ()=>connectors.suppress(delegated,binding,{kind:'message',sourceId:'known-id'}),
  ];
  for(const action of actions)await assert.rejects(async()=>action(),denied);
  }
  assert.equal(requests,0);
});

test('upload-only and unknown capabilities cannot discover, read, post, or search the board',async()=>{
  let calls=0;
  const unexpected=async()=>{calls++;throw new Error('Unexpected board access');};
  const board=createBoard({store:{readVersion:unexpected,compareAndSet:unexpected},prefix:'board',search:{search:unexpected}});
  const input={workspace:principal.tenantId,agent:'capture',topics:['secret'],after:0,posts:[{id:'post',topic:'secret',text:'injected'}]};
  for(const captureAccess of restrictedAccess){
  const delegated={...principal,captureAccess};
  for(const action of [()=>board.topics(delegated),()=>board.sync(delegated,input),()=>board.search(delegated,{workspace:principal.tenantId,query:'secret'})])await assert.rejects(action,denied);
  const search=createBoardSearch({endpoint:'https://search.example.test',fetch:unexpected});
  await assert.rejects(search.search(delegated,[],'board',{workspace:principal.tenantId,query:'secret'}),denied);
  }
  assert.equal(calls,0);
});

test('session indexing cannot write another uploader or tenant under the current principal',async()=>{
  let requests=0;
  const search=createSessionSearch({store:deletionTestStore(),prefix:"capture-v1",endpoint:'https://search.example.test',fetch:async()=>{requests++;throw new Error('Unexpected index write');}});
  const doc={...principal,harness:'codex',receivedAt:'2026-11-06T00:00:00Z',text:'forged attribution'};
  for(const document of [{...doc,userId:'another-author'},{...doc,tenantId:'another-tenant'},{...doc,userId:undefined}]){
    await assert.rejects(search.putDocuments([{id:'colliding-id',document}],principal),denied);
  }
  assert.equal(requests,0);
});
