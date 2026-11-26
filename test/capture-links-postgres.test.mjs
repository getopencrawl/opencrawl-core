import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {captureLinkMatchesWorkspace,createCaptureLinks} from '../dist/src/state/capture-links.mjs';
import {createLibraryApi} from '../dist/src/sessions/library-http.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';

test('old capture keys and canonical IDs resolve with the same current scope and visibility', {skip:!postgresUrl},async t=>{
  const database=await applicationDatabaseFixture(t);
  const links=createCaptureLinks(database), second=createCaptureLinks(database);
  const key={userId:'owner',harness:'codex',name:'same-native-id'};
  const [[id],[again],[foreign],[memoryId]]=await Promise.all([
    links.register('alpha','sessions',[key]),second.register('alpha','sessions',[key]),
    links.register('beta','sessions',[key]),links.register('alpha','memories',[key]),
  ]);
  assert.match(id,/^oc_[A-Za-z0-9_-]{32}$/);
  assert.equal(again,id);assert.notEqual(foreign,id);assert.notEqual(memoryId,id);
  assert.equal(captureLinkMatchesWorkspace(id,'alpha'),true);
  assert.equal(captureLinkMatchesWorkspace(id,'beta'),false);
  assert.equal(captureLinkMatchesWorkspace(memoryId,'alpha'),true);
  assert.deepEqual(await second.resolve('alpha','sessions',id),key);
  assert.equal(await links.resolve('beta','sessions',id),null);
  assert.equal(await links.resolve('alpha','memories',id),null);

  let shared=true;
  const ref={userId:key.userId,harness:key.harness,sessionId:key.name};
  const owner={tenantId:'alpha',userId:key.userId},teammate={...owner,userId:'reader'};
  const sessions={async read(principal,input) {
    assert.equal(principal.tenantId,'alpha');assert.equal(input.userId,key.userId);
    assert.equal(input.harness,key.harness);assert.equal(input.sessionId,key.name);
    if (!shared && principal.userId!==key.userId) throw Object.assign(new Error('Session not found'),{status:404});
    return {session:ref,events:[],total:0,next:null};
  }};
  const api=createLibraryApi({links,sessions});
  const original=await api(owner,'sessions/read',ref);
  assert.equal(original.session.permalinkId,id);
  assert.deepEqual(await api(teammate,'sessions/read',{permalinkId:id}),original);
  shared=false;
  await assert.rejects(api(teammate,'sessions/read',{permalinkId:id}),{status:404});
  await assert.rejects(api({...owner,tenantId:'beta'},'sessions/read',{permalinkId:id}),{status:404});
  assert.equal((await api(owner,'sessions/read',{permalinkId:id})).session.permalinkId,id);

  const requests=[];
  const search=createWorkspaceSearch({links,sessions:{async search(p,request){
    requests.push(request);
    return {hits:[{tenantId:p.tenantId,id:'hit',...ref,eventId:'event',kind:'message',text:'hello'}]};
  }}});
  const browse={source:'sessions',sessionId:'/sessions/'+id,includeCurrentSession:true};
  const visible=await search.browse(owner,browse);
  assert.equal(visible.results[0].provenance.permalinkId,id);
  assert.equal(requests[0].sessionId,key.name);
  assert.deepEqual(requests[0].filters,{authors:[key.userId],harnesses:[key.harness]});
  assert.deepEqual((await search.browse({...owner,tenantId:'beta'},browse)).results,[]);
  assert.deepEqual((await search.browse(owner,{...browse,filters:{authors:['other']}})).results,[]);
  assert.equal(requests.length,1);
});
