import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {containsToolOutput,TOOL_OUTPUT_KINDS} from '../dist/src/sessions/tool-output.mjs';
import {createRealm,realmMapping} from '../dist/src/search/realm.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {createSessionIngest} from '../dist/src/sessions/ingest.mjs';
import {batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {createControls} from '../dist/src/sessions/controls.mjs';
import {migrateSessionSearchContext} from '../dist/src/sessions/search-context-migration.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const currentSession={harness:'codex',sessionId:'current'};
test('semantic output classification covers native aliases and mixed messages without inspecting text or tool inputs',()=>{
  for(const kind of TOOL_OUTPUT_KINDS)assert.equal(containsToolOutput({kind,data:{output:'evidence'}}),true,kind);
  for(const role of ['tool','function'])assert.equal(containsToolOutput({kind:'message',data:{role,content:'evidence'}}),true);
  for(const type of ['tool_result','function_call_output','custom_tool_call_output']){
    assert.equal(containsToolOutput({kind:'message',data:{role:'user',content:[{type:'text',text:'Human note'},{type,content:'Tool evidence'}]}}),true);
  }
  assert.equal(containsToolOutput({kind:'message',data:{role:'user',content:[{type:'text',text:'The tool_result record contains output.'}]}}),false);
  assert.equal(containsToolOutput({kind:'tool_call',data:{type:'function_call',name:'test',arguments:{type:'tool_result',content:'sample input'}}}),false);
  assert.equal(containsToolOutput({kind:'message',data:{role:'assistant',content:[{type:'tool_use',name:'test',input:{type:'tool_result',content:'fixture'}}]}}),false);
  assert.equal(containsToolOutput({kind:'message',data:{role:'user',content:[{type:'container',content:[{type:'tool_result',content:'nested output'}]}]}}),true);
});

async function fixture(t,backend){
  const dir=await mkdtemp(join(tmpdir(),'search-context-'));
  const endpoint=backend==='sqlite'?pathToFileURL(join(dir,'search.sqlite')).href.replace('file:','sqlite:'):process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
  const principal={tenantId:'context-'+randomUUID(),userId:'alice'},store=memorySessionStore(),prefix='capture';
  const options={endpoint,environment:'test'},realm=createRealm({...options,tenantId:principal.tenantId});
  t.after(async()=>{if(backend==='opensearch')await fetch(endpoint+'/'+realm.index,{method:'DELETE'});await rm(dir,{recursive:true,force:true});});
  await realm.ensureIndex();
  return {principal,store,prefix,realm,options,sessions:createSessionSearch({...options,store,prefix})};
}
for(const backend of ['sqlite','opensearch']){
  test(backend+': search defaults filter before limits, totals and facets, preserving owner/harness and explicit access', {skip:backend==='opensearch'&&!process.env.OPENCRAWL_TEST_OPENSEARCH_URL},async t=>{
    const f=await fixture(t,backend),{principal,realm,sessions}=f;
    let sequence=0;
    const doc=(id,extra={})=>({id,document:{...principal,harness:'codex',sessionId:'past',installationId:'device',eventId:id,chunk:0,kind:'message',role:'assistant',private:false,
      text:'evidence '+id,receivedAt:'2026-11-01T00:00:00Z',timestamp:new Date(1700000000000+sequence++).toISOString(),...extra}});
    const candidates=[doc('past'),doc('peer',{userId:'bob',sessionId:'current'}),doc('other-harness',{harness:'claude-code',sessionId:'current'}),
      doc('private',{userId:'bob',private:true})];
    for(let i=0;i<110;i++)candidates.push(doc('current-'+i,{sessionId:'current'}));
    for(let i=0;i<110;i++)candidates.push(doc('output-'+i,{containsToolOutput:true}));
    for(const kind of TOOL_OUTPUT_KINDS)candidates.push(doc('legacy-'+kind,{kind}));
    candidates.push(doc('legacy-role',{role:'tool'}));
    await realm.collection('session').bulk(principal,candidates);await realm.refresh(principal);
    const foreign={...principal,tenantId:'context-'+randomUUID()},foreignRealm=createRealm({...f.options,tenantId:foreign.tenantId});
    if(backend==='opensearch')t.after(()=>fetch(f.options.endpoint+'/'+foreignRealm.index,{method:'DELETE'}));
    await foreignRealm.ensureIndex();
    const collision=doc('past');await foreignRealm.collection('session').bulk(foreign,[{...collision,document:{...collision.document,tenantId:foreign.tenantId,text:'foreign evidence'}}]);
    await foreignRealm.refresh(foreign);
    const search=createWorkspaceSearch({sessions});
    assert.equal((await search.fetch(foreign,{id:'sessions:past'})).text,'foreign evidence');
    assert.equal((await search.fetch(principal,{id:'sessions:past'})).text,'evidence past');
    const input={query:'evidence',source:'sessions',currentSession,order:'newest',dedupe:false,groupBy:'none',facets:['kind','author','sessionId'],limit:1};
    const first=await search.search(principal,input);
    assert.deepEqual(first.searchContext,{currentSession,currentSessionStatus:'excluded',currentSessionExcluded:true,toolOutputsIncluded:false,unclassifiedSessionCandidates:3,
      warning:'Some session candidates predate tool-output classification. Legacy embedded tool outputs may remain until the server metadata migration completes.'});
    assert.equal(first.coverage[0].candidates,3);assert.equal(first.coverage[0].truncated,false);
    assert.deepEqual(first.facets.kind.values,[{value:'message',count:3}]);
    assert.deepEqual(first.facets.author.values,[{value:'alice',count:2},{value:'bob',count:1}]);
    const seen=[];let page=first;
    for(;;){seen.push(...page.results.map(h=>h.id));if(!page.next)break;page=await search.search(principal,{...input,cursor:page.next});}
    assert.deepEqual(seen,['sessions:other-harness','sessions:peer','sessions:past']);
    for(const changed of [{includeCurrentSession:true},{includeToolOutputs:true},{currentSession:{...currentSession,sessionId:'other'}}])await assert.rejects(search.search(principal,{...input,...changed,cursor:first.next}),/cursor/);
    const same=await search.search(principal,{...input,includeCurrentSession:false,includeToolOutputs:false,cursor:first.next});assert.equal(same.results[0].id,'sessions:peer');
    const current=await search.search(principal,{...input,includeCurrentSession:true});assert.match(current.results[0].id,/sessions:current-/);assert.equal(current.searchContext.currentSessionStatus,'included');
    const tools=await search.search(principal,{...input,includeToolOutputs:true});assert.equal(tools.results[0].id,'sessions:legacy-role');assert.equal(tools.searchContext.toolOutputsIncluded,true);
    assert.equal((await search.search(principal,{...input,includeToolOutputs:true,filters:{kinds:['tool_result']}})).results[0].id,'sessions:legacy-tool_result');
    assert.equal((await search.search(principal,{...input,filters:{kinds:['tool_result']}})).results.length,0);
    assert.equal((await search.fetch(principal,{id:'sessions:output-0'})).text,'evidence output-0');
    assert.equal((await search.fetch(principal,{id:'sessions:current-0'})).text,'evidence current-0');
    await assert.rejects(search.fetch(principal,{id:'sessions:private'}),{status:404});
    assert.equal((await sessions.search(principal,{query:'evidence',order:'newest',limit:1})).hits[0].id,'legacy-role','internal library search keeps its prior behavior');
    const noContext=await search.search(principal,{query:'evidence',source:'sessions'});assert.equal(noContext.searchContext.currentSessionStatus,'unavailable');assert.equal(noContext.searchContext.currentSessionExcluded,false);
    await assert.rejects(search.search({...principal,captureAccess:'write'},input),{status:403});
    for(const context of [{...currentSession,userId:'bob'},{...currentSession,tenantId:'other'},{harness:'unknown',sessionId:'current'},{...currentSession,sessionId:'.invalid'}])await assert.rejects(search.search(principal,{...input,currentSession:context}),{status:400});
  });

  test(backend+': semantic metadata migration is bounded, resumable, idempotent and preserves content/privacy', {skip:backend==='opensearch'&&!process.env.OPENCRAWL_TEST_OPENSEARCH_URL},async t=>{
    const f=await fixture(t,backend),{principal,realm,store,prefix,sessions}=f,ingest=createSessionIngest({store,prefix});
    await ingest.putBatch(principal,{schemaVersion:1,owner:principal,harness:'claude-code',origin:'cli',installationId:'device',sessionId:'mixed',attachments:[],events:[
      {id:'mixed',kind:'message',data:{role:'user',content:[{type:'text',text:'Human context.'},{type:'tool_result',content:'evidence '.repeat(3000)}]}},
      {id:'human',kind:'message',data:{role:'user',content:[{type:'text',text:'evidence from a human'}]}},
    ]});
    const key=[...store.data.keys()].find(key=>key.endsWith('.json.gz')),raw=Buffer.from(store.data.get(key));
    const projected=batchDocuments({prefix,key,batch:JSON.parse(gunzipSync(raw)),principal});
    assert.ok(projected.filter(x=>x.document.eventId==='mixed').length>1);assert.ok(projected.filter(x=>x.document.eventId==='mixed').every(x=>x.document.containsToolOutput));
    const legacy=projected.map(({id,document})=>{const {containsToolOutput,...rest}=document;return {id,document:{...rest,private:true}};});
    const collection=realm.collection('session');await collection.bulk(principal,legacy);await realm.refresh(principal);
    const before=(await collection.mget(principal,legacy.map(d=>d.id))).docs;
    const migration={realm,principal,store,prefix};
    const dry=await migrateSessionSearchContext(migration);assert.equal(dry.passages,legacy.length);assert.equal(dry.complete,true);
    assert.deepEqual((await collection.mget(principal,legacy.map(d=>d.id))).docs,before);
    await assert.rejects(migrateSessionSearchContext({...migration,dryRun:false,maxPassages:1,onPage:async()=>{throw Error('Checkpoint unavailable');}}),/Checkpoint unavailable/);
    assert.equal((await collection.mget(principal,legacy.map(d=>d.id))).docs.filter(hit=>typeof hit._source.containsToolOutput==='boolean').length,1);
    // Replaying without a saved cursor skips the already committed classification.
    const first=await migrateSessionSearchContext({...migration,dryRun:false,maxPassages:1});assert.equal(first.passages,1);assert.equal(first.complete,false);assert.ok(first.after);
    const rest=await migrateSessionSearchContext({...migration,dryRun:false,pageSize:1,after:first.after});assert.equal(rest.passages,legacy.length-2);assert.equal(rest.complete,true);
    const migrated=(await collection.mget(principal,legacy.map(d=>d.id))).docs;
    for(let i=0;i<before.length;i++){const {containsToolOutput,...unchanged}=migrated[i]._source;assert.deepEqual(unchanged,before[i]._source);assert.equal(containsToolOutput,before[i]._source.eventId==='mixed');}
    assert.deepEqual(store.data.get(key),raw);assert.equal((await migrateSessionSearchContext({...migration,dryRun:false})).passages,0);
    const search=createWorkspaceSearch({sessions}),result=await search.search(principal,{query:'evidence',source:'sessions',groupBy:'none',dedupe:false});
    assert.equal(result.results.length,1);assert.equal(result.results[0].provenance.eventId,'human');
    assert.equal(result.searchContext.unclassifiedSessionCandidates,0);assert.equal(result.searchContext.warning,undefined);
    assert.ok((await search.search(principal,{query:'evidence',source:'sessions',includeToolOutputs:true,groupBy:'none',dedupe:false})).results.length>1);
    await assert.rejects(migrateSessionSearchContext({...migration,principal:{...principal,tenantId:'foreign'}}),{status:403});
    const target=legacy[0],patch={...target,document:{...target.document,containsToolOutput:true},policy:'session-search-context'};
    await assert.rejects(collection.bulk(principal,[{...patch,document:{...patch.document,userId:'other'}}]),/ownership|bulk/i);
    await collection.delete(principal,[target.id]);await collection.bulk(principal,[patch]);assert.equal((await collection.mget(principal,[target.id])).docs[0].found,false);
  });
}

test('migration reuses source classifications across interleaved pages without retaining them across invocations',async t=>{
  const {principal,realm,store,prefix}=await fixture(t,'sqlite'),ingest=createSessionIngest({store,prefix});
  for(const ids of [['event-1','event-3'],['event-2','event-4']])await ingest.putBatch(principal,{
    schemaVersion:1,owner:principal,harness:'claude-code',origin:'cli',installationId:'device',sessionId:'cached',attachments:[],
    events:ids.map((id,i)=>({id,kind:'message',data:{role:'user',content:[i?{type:'tool_result',content:'Tool evidence'}:{type:'text',text:'Human evidence'}]}})),
  });
  const raw=[...store.data].filter(([key])=>key.endsWith('.json.gz'));
  const legacy=raw.flatMap(([key,body])=>batchDocuments({prefix,key,batch:JSON.parse(gunzipSync(body)),principal}))
    .map(({id,document})=>{const {containsToolOutput,...rest}=document;return {id,document:rest};});
  assert.equal(legacy.length,4);
  const collection=realm.collection('session');await collection.bulk(principal,legacy);await realm.refresh(principal);
  const get=store.get,reads=new Map();store.get=async(key,options)=>{
    if(key.endsWith('.json.gz'))reads.set(key,(reads.get(key)??0)+1);
    return get(key,options);
  };
  const options={realm,principal,store,prefix,pageSize:1};
  for(let invocation=1;invocation<=2;invocation++){
    const report=await migrateSessionSearchContext(options);assert.equal(report.passages,4);assert.equal(report.complete,true);
    assert.deepEqual([...reads.values()],[invocation,invocation],'each source is read once per invocation despite interleaved pages');
  }
  await migrateSessionSearchContext({...options,dryRun:false});
  assert.deepEqual([...reads.values()],[3,3]);
  for(const hit of (await collection.mget(principal,legacy.map(item=>item.id))).docs)
    assert.equal(hit._source.containsToolOutput,['event-3','event-4'].includes(hit._source.eventId));
  for(const [key,body]of raw)assert.deepEqual(store.data.get(key),body);
});

test('session defaults never filter connector records and bind only session adapter inputs',async()=>{
  const principal={tenantId:'tenant',userId:'owner'},calls=[];
  const service=createWorkspaceSearch({sessions:{search:async(p,input)=>{calls.push(input);return {hits:[]};}},connectors:{search:async(p,input)=>{
    assert.equal(input.currentSession,undefined);assert.equal(input.includeToolOutputs,undefined);
    return {hits:[{id:'connector',tenantId:p.tenantId,kind:'tool_result',text:'evidence from a document'}]};
  }}});
  const result=await service.search(principal,{query:'evidence',currentSession});
  assert.equal(result.results[0].id,'connectors:connector');assert.equal(calls[0].includeToolOutputs,false);assert.deepEqual(calls[0].currentSession,currentSession);
});

for(const scenario of ['missing-source','foreign-source','deleted'])test('search context migration preserves data when '+scenario,async t=>{
  const f=await fixture(t,'sqlite'),{principal,realm,store,prefix}=f,ingest=createSessionIngest({store,prefix});
  await ingest.putBatch(principal,{schemaVersion:1,owner:principal,harness:'claude-code',origin:'cli',installationId:'device',sessionId:'retained',attachments:[],events:[{id:'event',kind:'message',data:{role:'user',content:[{type:'tool_result',content:'evidence'}]}}]});
  const key=[...store.data.keys()].find(key=>key.endsWith('.json.gz'));
  const projected=batchDocuments({prefix,key,batch:JSON.parse(gunzipSync(store.data.get(key))),principal});
  const legacy=projected.map(({id,document})=>{const {containsToolOutput,...rest}=document;return {id,document:rest};});
  if(scenario==='foreign-source')legacy[0].document.sourceKey=key.replace('/'+key.split('/')[2]+'/', '/'+ '0'.repeat(64)+'/');
  const collection=realm.collection('session');await collection.bulk(principal,legacy);await realm.refresh(principal);
  const before=(await collection.mget(principal,legacy.map(d=>d.id))).docs;
  if(scenario==='missing-source')await store.delete(key);
  if(scenario==='deleted')await createControls({store,prefix}).update(principal,'sessions','claude-code','retained',()=>({visibility:'team',deletedAt:'2026-11-15T00:00:00Z'}));
  const options={realm,principal,store,prefix,dryRun:false};
  if(scenario==='deleted'){const report=await migrateSessionSearchContext(options);assert.equal(report.passages,0);assert.equal(report.skippedDeleted,1);assert.equal(report.complete,true);}
  else await assert.rejects(migrateSessionSearchContext(options),/source|scope/i);
  assert.deepEqual((await collection.mget(principal,legacy.map(d=>d.id))).docs,before);
});

test('tool-output mapping upgrade adds only its field and refuses foreign or incompatible mappings before mutation',async()=>{
  for(const mode of ['valid','foreign','incompatible']){
    const mapping=structuredClone(realmMapping);delete mapping.properties.session.properties.containsToolOutput;
    mapping._meta={schema:1,tenantId:mode==='foreign'?'other':'tenant'};
    if(mode==='incompatible')mapping.properties.session.properties.containsToolOutput={type:'keyword'};
    let writes=0;
    const realm=createRealm({endpoint:'http://search.test',index:'test',tenantId:'tenant',fetch:async(url,options)=>{
      if(url.pathname.endsWith('/_mapping')){
        if(options.method==='PUT'){
          writes++;assert.deepEqual(JSON.parse(options.body),{properties:{session:{properties:{containsToolOutput:{type:'boolean'}}}}});
          mapping.properties.session.properties.containsToolOutput={type:'boolean'};return Response.json({acknowledged:true});
        }
        return Response.json({test:{mappings:mapping}});
      }
      return Response.json({error:{type:'resource_already_exists_exception'}},{status:400});
    }});
    if(mode==='valid'){await realm.ensureIndex();await realm.ensureIndex();assert.equal(writes,1);}
    else {await assert.rejects(realm.ensureIndex(),/mapping|mismatch/i);assert.equal(writes,0);}
  }
});
