import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {searchFilters,searchSort} from '../dist/src/search/controls.mjs';
const principal={tenantId:'org',userId:'owner'};
const hit=(id,extra={})=>({id,tenantId:'org',userId:'owner',text:'deployment rollback evidence',sessionId:'s',kind:'message',role:'assistant',timestamp:'2026-01-01T00:00:00Z',...extra});
test('exact filters constrain the correct corpus and never widen an incompatible source',()=>{
  assert.deepEqual(searchFilters('session',{roles:['user'],authors:['alice'],before:'2026-01-02T00:00:00Z'}),[
    {terms:{'session.userId':['alice']}},{terms:{'session.role':['user']}},{range:{'session.timestamp':{lte:Date.parse('2026-01-02T00:00:00Z')}}}]);
  assert.deepEqual(searchFilters('connector',{roles:['user']}),[{match_none:{}}]);
  assert.deepEqual(searchFilters('memory',{projects:['p'],paths:['notes.md']}),[{terms:{'memory.project':['p']}},{terms:{'memory.path':['notes.md']}}]);
  assert.deepEqual(searchFilters('connector',{repositories:['org/repo'],providers:['github']}),[{terms:{'connector.provider':['github']}},{terms:{'connector.repository':['org/repo']}}]);
  assert.throws(()=>searchFilters('session',{after:'2026-02-01T00:00:00Z',before:'2026-01-01T00:00:00Z'}),/Invalid/);
  assert.deepEqual(searchSort('memory','oldest'),[{'memory.modifiedAt':{order:'asc',missing:'_last'}}]);
});
test('facets use authorized candidates, projections omit content, all controls bind pagination',async()=>{
  const calls=[], service=createWorkspaceSearch({sessions:{search:async(p,q)=>{calls.push(q);return {hits:[hit('a'),hit('b',{role:'user'})],total:120};}},connectors:{search:async()=>({hits:[]})}});
  const input={query:'rollback',limit:1,facets:['role','source'],select:['title'],filters:{roles:['assistant']}};
  const r=await service.search(principal,input);
  assert.equal(calls[0].filters.roles[0],'assistant');
  assert.equal(r.facetScope,'authorized_candidate_window');assert.equal(r.coverage[0].truncated,true);
  assert.deepEqual(r.facets.source.values,[{value:'sessions',count:2}]);
  assert.equal(r.results[0].text,undefined);assert.equal(r.results[0].provenance,undefined);assert.ok(r.results[0].id);
  for(const change of [{select:['text']},{facets:['source']},{filters:{roles:['user']}},{order:'newest'},{excerptChars:100}])
    await assert.rejects(service.search(principal,{...input,...change,cursor:r.next}),/cursor/);
  const denied=createWorkspaceSearch({connectors:{search:async()=>{throw Object.assign(new Error('forbidden'),{status:403});}}});
  await assert.rejects(denied.search(principal,{query:'x',facets:['author']}),/forbidden/);
});
test('time browsing merges source timestamps, puts unknown dates last, and rejects untimed empty search',async()=>{
  const s=createWorkspaceSearch({sessions:{search:async()=>({hits:[hit('a')]})},memories:{search:async()=>({hits:[hit('m',{timestamp:undefined,modifiedAt:'2026-02-01T00:00:00Z'})]})},connectors:{search:async()=>({hits:[hit('c',{timestamp:undefined})]})}});
  const r=await s.search(principal,{query:'',order:'newest'});
  assert.deepEqual(r.results.map(h=>h.id),['memories:m','sessions:a','connectors:c']);
  await assert.rejects(s.search(principal,{query:''}),/Invalid/);
});

test('legacy dedupe=false inspects all chunks and connector counters are not passage offsets',async()=>{
  const s=createWorkspaceSearch({sessions:{search:async()=>({hits:[hit('a',{eventId:'e',text:'first'}),hit('b',{eventId:'e',text:'second'})]})},connectors:{search:async()=>({hits:[hit('c',{chunkCount:0})]})}});
  assert.equal((await s.search(principal,{query:'x',source:'sessions'})).results.length,1);
  assert.equal((await s.search(principal,{query:'x',source:'sessions',dedupe:false})).results.length,2);
  assert.equal((await s.search(principal,{query:'x',source:'connectors'})).results[0].passage,undefined);
});
