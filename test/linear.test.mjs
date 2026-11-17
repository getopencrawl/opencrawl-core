import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {createLinearAccess, LINEAR_API} from '../dist/src/integrations/linear-access.mjs';
import {LINEAR_STREAMS, LINEAR_KINDS, LINEAR_QUERIES, linearRecordPath, linearQueryStream} from '../dist/src/integrations/linear-upstream.mjs';
import {createProviderCatalog} from '../dist/src/integrations/providers.mjs';
import {connectorManifest} from '../dist/src/integrations/manifests.mjs';
import {createComposioOAuth} from '../dist/src/integrations/composio.mjs';
import {normalizeLinear, linearResourceId} from '../dist/src/connectors/linear.mjs';
import {createConnectorPipeline} from '../dist/src/connectors/pipeline.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {createConnectorResolver} from '../dist/src/integrations/resolver.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {realmIndex} from '../dist/src/search/realm.mjs';
import {digest} from '../dist/src/connectors/scope.mjs';

const uuid=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
const tenantId='org_linear', connectionId='int_'+'a'.repeat(26),workspaceId=uuid(100),teamId=uuid(101),issueId=uuid(1),at=Date.parse('2026-11-17T00:00:00Z');
const binding={tenantId,connectionId,workspaceId,provider:'linear',access:'workspace-global',rawPrefix:`raw/v1/source=linear/workspace=${workspaceId}/connection=${connectionId}/`};
const record={tenantId,userId:'user_admin',integrationId:connectionId,provider:'linear',environment:'selfhost',scope:'team',status:'active',workspace:workspaceId,connectedAccountId:'ca_linear',s3Prefix:binding.rawPrefix.slice(0,-1),s3Bucket:'test'};
const queryFor=stream=>[...LINEAR_QUERIES].find(([,name])=>name===stream)[0];
function fixture(){
  const team={id:teamId,name:'Engineering',visibility:'public',organization:{id:workspaceId}};
  const issue={id:issueId,identifier:'ENG-42',title:'Shared issue',description:'Complete issue description',url:'https://linear.app/example/issue/ENG-42',updatedAt:new Date(at).toISOString(),trashed:null,team,state:{name:'In Progress',type:'started'},assignee:{name:'Avery'},priorityLabel:'High'};
  const project={id:uuid(7),name:'Launch project',content:'Project rationale and plans',url:'https://linear.app/example/project/launch',updatedAt:issue.updatedAt,trashed:null,teams:{nodes:[team],pageInfo:{hasNextPage:false}},status:{name:'Started'},lead:{name:'Morgan'}};
  const initiative={id:uuid(17),name:'Company initiative',visibility:'public',trashed:null,organization:{id:workspaceId},url:'https://linear.app/example/initiative/growth'};
  const rows=Object.fromEntries(LINEAR_STREAMS.map((stream,i)=>[stream,{id:uuid(i+1),name:stream+' record',updatedAt:issue.updatedAt}]));
  rows.issues=issue;rows.projects=project;rows.initiatives=initiative;
  Object.assign(rows.comments,{body:'Complete comment body',issue,user:{name:'Taylor'},url:issue.url+'#comment'});
  rows.teams=team;Object.assign(rows.cycles,{team});Object.assign(rows.issue_labels,{team});Object.assign(rows.workflow_states,{team});
  for(const stream of ['project_updates','project_milestones'])Object.assign(rows[stream],{project,user:{name:'Alex'},body:'Project status narrative'});
  Object.assign(rows.attachments,{issue,title:'Design attachment',url:'https://example.com/design'});
  Object.assign(rows.issue_relations,{issue,relatedIssue:{...issue,id:uuid(200),identifier:'ENG-43',title:'Release'},type:'blocks'});
  Object.assign(rows.customer_needs,{issue,project:null,customer:{name:'Acme'}});
  Object.assign(rows.initiative_to_projects,{initiative,project});
  Object.assign(rows.issue_history,{issueId,fromTitle:'Old title',toTitle:'Shared issue'});
  const state={rows,organization:workspaceId,errors:false,hasNextPage:false},calls=[];
  async function request(input){
    calls.push(input);assert.equal(input.endpoint,LINEAR_API);assert.equal(input.method,'POST');
    const {query,variables={}}=input.body;
    if(state.errors)return {status:200,data:{data:{partial:true},errors:[{extensions:{code:'INTERNAL_SERVER_ERROR'}}]}};
    if(query.includes('OpenCrawlOrganization')||query.includes('OpenCrawlAccount'))return {status:200,data:{data:{organization:{id:state.organization,name:'Example'}}}};
    if(query.includes('OpenCrawlAccess')){
      const data={},errors=[];
      for(const match of query.matchAll(/r(\d+): (\w+)\(id: \$id(\d+)\)/g)){
        const value=Object.values(rows).find(r=>r?.id===variables['id'+match[3]]);
        if(value)data['r'+match[1]]=value;else errors.push({path:['r'+match[1]],extensions:{code:'ENTITY_NOT_FOUND'}});
      }
      return {status:200,data:errors.length?{data:null,errors}:{data}};
    }
    if(query.includes('OpenCrawlHistoryAccess'))return {status:200,data:{data:{issue:{...issue,history:{nodes:[{id:rows.issue_history.id}],pageInfo:{hasNextPage:false}}}}}};
    const stream=linearQueryStream(query);assert.ok(stream,'unexpected query '+query);
    const data={},path=linearRecordPath(stream);let current=data;
    for(const part of path.slice(0,-1))current=current[part]??={};
    current.nodes=rows[stream]?[rows[stream]]:[];current.pageInfo={hasNextPage:state.hasNextPage,endCursor:'next'};
    return {status:200,data};
  }
  return {state,calls,request,access:createLinearAccess({tenantId,connectionId,workspaceId,request})};
}

test('all upstream streams and operations survive the OAuth transport adapter',async()=>{
  const upstream=JSON.parse(await readFile(new URL('../src/integrations/upstream/linear/manifest.json',import.meta.url),'utf8'));
  const manifest=connectorManifest('linear');assert.equal(LINEAR_STREAMS.length,20);
  assert.deepEqual(manifest.streams,upstream.streams);assert.deepEqual(manifest.schemas,upstream.schemas);
  assert.deepEqual(manifest.definitions.incremental_sync_updated_at,upstream.definitions.incremental_sync_updated_at);
  for(const name of LINEAR_STREAMS){
    const a=structuredClone(manifest.definitions.streams[name]),b=structuredClone(upstream.definitions.streams[name]);
    if(a.retriever?.requester){a.retriever.requester.path=b.retriever.requester.path;a.retriever.requester.request_headers=b.retriever.requester.request_headers;}
    assert.deepEqual(a,b,name+' changed beyond transport');
  }
  const provider=createProviderCatalog({linear:{name:'Linear',manifest}},{linearPublicAccess:true}).linear;
  assert.equal(provider.streams.filter(s=>s.syncMode==='incremental_append').length,14);
  assert.deepEqual(provider.streams.map(s=>s.name),LINEAR_STREAMS);
  assert.equal(provider.authConfig.credentials.scopes,'read');assert.equal(provider.authConfig.name,'OpenCrawl Linear full user read');
  for(const enabled of [true,false]){
    const account=await provider.account(async()=>({status:200,data:{data:{organization:{id:workspaceId,name:'Test',customersEnabled:enabled}}}}));
    const selected=provider.streamsFor({settings:account.settings});assert.equal(selected.length,enabled?20:18);
    assert.equal(selected.some(s=>s.name==='customers'),enabled);assert.equal(selected.some(s=>s.name==='customer_needs'),enabled);
    assert.ok(selected.some(s=>s.name==='customer_statuses'));
  }
  await assert.rejects(provider.account(async()=>({status:200,data:{data:{organization:{id:workspaceId,name:'Test'}}}})),/feature availability/);
});

test('all twenty record types have real access policies and retain their content',async()=>{
  const f=fixture();
  for(const stream of LINEAR_STREAMS){
    const data=f.state.rows[stream],id=linearResourceId(stream,data),context=(await f.access.describeMany([id])).get(id);
    assert.ok(context,stream+' is not supported by access checks');
    const docs=normalizeLinear(binding,stream,{_airbyte_data:data,_airbyte_extracted_at:at},'test',context);
    assert.equal(docs.at(-1).document.kind,LINEAR_KINDS[stream]);assert.equal(docs.at(-1).document.sourceId,id);
    assert.ok(docs.some(d=>[d.document.title,d.document.text].join('\n').includes(data.description||data.content||data.body||data.title||data.name||data.fromTitle)),stream);
  }
  const context=(await f.access.describeMany(['issue:'+issueId])).get('issue:'+issueId);
  assert.ok(context.lines.includes('Status: In Progress'));assert.ok(context.lines.includes('Assignee: Avery'));
});

test('private, restricted, foreign, deleted and ambiguous resources fail closed without hiding valid peers',async()=>{
  for(const visibility of ['private','restricted',undefined]){
    const f=fixture();f.state.rows.issues.team.visibility=visibility;
    for(const stream of ['issues','comments','teams','cycles','workflow_states','issue_labels','projects','project_updates','project_milestones','attachments','issue_relations','customer_needs','initiative_to_projects','issue_history'])assert.equal(await f.access.inspect(linearResourceId(stream,f.state.rows[stream])),false,stream);
  }
  const f=fixture();f.state.rows.projects.teams.pageInfo.hasNextPage=true;assert.equal(await f.access.inspect('project:'+f.state.rows.projects.id),false);
  f.state.rows.initiatives.visibility='private';assert.equal(await f.access.inspect('initiative:'+f.state.rows.initiatives.id),false);
  f.state.rows.issues.trashed=true;assert.equal(await f.access.inspect('issue:'+issueId),false);
  f.state.rows.issues.trashed=null;
  const id=linearResourceId('comments',f.state.rows.comments);delete f.state.rows.comments;
  const visible=await f.access.describeMany([id,'issue:'+issueId]);assert.equal(visible.size,1);assert.ok(visible.has('issue:'+issueId));
  f.state.organization=uuid(999);await assert.rejects(f.access.inspect('issue:'+issueId),/workspace changed/);
});

test('historical raw records retain identity and require valid scope receipts plus fresh access',async()=>{
  const f=fixture(),raw={id:'issue:'+issueId,kind:'issue',title:'ENG-42: Shared issue',text:'Historical complete body',url:f.state.rows.issues.url,updatedAt:new Date(at).toISOString()};
  const data={...raw,access:{policy:'linear-public-team-v1',tenantId,connectionId,workspaceId,teamId,checkedAt:at,contentHash:digest(raw)}};
  const context=(await f.access.describeMany([linearResourceId('issues',data)])).get(raw.id);
  const envelope={_airbyte_data:data,_airbyte_extracted_at:at};
  const old=normalizeLinear(binding,'issues',envelope,'historical',context).at(-1);
  const next=normalizeLinear(binding,'issues',{_airbyte_data:f.state.rows.issues,_airbyte_extracted_at:at},'upstream',context).at(-1);
  assert.equal(old.id,next.id);assert.equal(old.document.sourceId,next.document.sourceId);
  assert.match(old.document.text,/Historical complete body/);
  for(const change of [{tenantId:'org_other'},{connectionId:'int_other'},{contentHash:'invalid'}])
    assert.throws(()=>normalizeLinear(binding,'issues',{...envelope,_airbyte_data:{...data,access:{...data.access,...change}}},'historical',context),/historical Linear/);
  assert.throws(()=>normalizeLinear(binding,'issues',{...envelope,_airbyte_data:{...data,text:'tampered'}},'historical',context),/historical Linear/);
  f.state.rows.issues.team.visibility='private';assert.equal((await f.access.describeMany([raw.id])).size,0);
});

test('source transport permits only upstream reads, rejects partial data and preserves filtered page cursors',async()=>{
  const f=fixture(),input={endpoint:LINEAR_API,method:'POST',body:{query:queryFor('issues'),variables:{orderBy:'updatedAt',filter:{updatedAt:{gte:'1970-01-01T00:00:00Z'}}}}};
  const result=await f.access.read(input);assert.equal(result.data.data.issues.nodes.length,1);
  f.state.rows.issues.team.visibility='private';f.state.hasNextPage=true;
  const excluded=await f.access.read(input);assert.equal(excluded.data.data.issues.nodes.length,0);assert.equal(excluded.data.data.issues.pageInfo.endCursor,'next');
  for(const body of [{query:'mutation { issueDelete(id:"x") { success } }'},{query:queryFor('issues'),variables:{filter:{team:{id:{eq:teamId}}}}},{query:queryFor('issues')+' query Steal { viewer { email } }'}])await assert.rejects(f.access.read({...input,body}));
  f.state.errors=true;await assert.rejects(f.access.read(input),/read failed/);
});

test('source capabilities cannot cross connections or survive disconnect',async()=>{
  const f=fixture(),active={...record};
  const oauth=createComposioOAuth({apiKey:'operator-key',organizationId:tenantId,proxyUrl:'https://operator.example',proxyKey:Buffer.alloc(32,3),registry:{list:async()=>[active]},fetch:async(url,options)=>{
    const proxy=JSON.parse(options.body);return Response.json(await f.request({endpoint:proxy.endpoint,method:proxy.method,body:proxy.body}));
  }});
  const provider=createProviderCatalog({linear:{name:'Linear'}},{linearPublicAccess:true}).linear,config=await oauth.sourceConfiguration(active,provider);
  const input={endpoint:LINEAR_API,method:'POST',body:{query:queryFor('issues')}};
  assert.equal((await oauth.proxyCredential(config.connected_account_id,config.credential_proxy_api_key,config.user_id,input)).data.data.issues.nodes.length,1);
  await assert.rejects(oauth.proxyCredential('ca_other',config.credential_proxy_api_key,config.user_id,input));
  active.status='disconnected';await assert.rejects(oauth.proxyCredential(config.connected_account_id,config.credential_proxy_api_key,config.user_id,input));
});

for(const engine of ['sqlite','opensearch'])test(`${engine}: upstream records through authenticated search/fetch, edits, replay and revocation`,{skip:engine==='opensearch'&&!process.env.OPENCRAWL_TEST_OPENSEARCH_URL},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-linear-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const index=realmIndex('test','linear-'+randomUUID());
  const search=createConnectorSearch({tenantId,index,endpoint:engine==='sqlite'?pathToFileURL(join(dir,'search.sqlite')).href.replace('file:','sqlite:'):process.env.OPENCRAWL_TEST_OPENSEARCH_URL});await search.ensureIndex();
  if(engine==='opensearch')t.after(()=>fetch(process.env.OPENCRAWL_TEST_OPENSEARCH_URL+'/'+index,{method:'DELETE'}));
  const f=fixture();f.state.rows.issues.description='A long readable paragraph.\n'.repeat(400)+'distinctive tailword';
  const objects=new Map(),store={get:async key=>objects.get(key)||null,put:async(key,value)=>{objects.set(key,value);},listPage:async()=>({keys:[...objects.keys()]})};
  assert.throws(()=>createConnectorPipeline({binding,store,search}),/permission adapter/);
  const pipeline=createConnectorPipeline({binding,store,search,linear:f.access});
  // The source selects only parent IDs; live permission responses include richer parents.
  const put=async(stream,name)=>{const key=binding.rawPrefix+`stream=${stream}/date=2026-11-17/sync=test/${name}.jsonl.gz`;const data=structuredClone(f.state.rows[stream]);for(const parent of ['issue','project','team','state','assignee','user','lead'])if(data[parent]){data[parent+'Id']=data[parent].id;delete data[parent];}objects.set(key,gzipSync(JSON.stringify({_airbyte_extracted_at:at,_airbyte_data:data})+'\n'));await pipeline.processObject({key});await search.refresh();return key;};
  const key=await put('issues','first');await put('comments','first');await put('projects','first');await put('project_updates','first');
  assert.equal((await pipeline.processObject({key})).status,'already-indexed');
  const active={...record},registry={get:async()=>active,listTenant:async()=>[active]};
  const resolver=createConnectorResolver({environment:'selfhost',generation:'v1',registry,storage:async()=>store,search:()=>search,linearAccess:()=>f.access});
  const principal={tenantId,userId:'user_member'},workspace=createWorkspaceSearch({connectors:resolver});
  const result=await workspace.search(principal,{query:'tailword',source:'connectors'});assert.equal(result.results.length,1);
  const found=result.results[0];assert.match((await workspace.fetch(principal,{id:found.id})).text,/tailword/);
  assert.equal((await resolver.search(principal,{query:'Project rationale'})).hits.length,1);
  assert.equal((await search.search(principal,[binding],{query:'tailword'})).hits.length,0);
  f.state.rows.issues.team.visibility='restricted';
  assert.equal((await resolver.search(principal,{query:'tailword'})).hits.length,0);
  assert.equal((await resolver.search(principal,{query:'Project rationale',raw:true})).responses.flatMap(r=>r.hits.hits).length,0);
  await assert.rejects(workspace.fetch(principal,{id:found.id}));
  f.state.rows.issues.team.visibility='public';f.state.rows.issues.description='Shorter replacement';f.state.rows.issues.updatedAt=new Date(at+1000).toISOString();await put('issues','edited');
  assert.equal((await resolver.search(principal,{query:'tailword'})).hits.length,0);assert.equal((await resolver.search(principal,{query:'Shorter replacement'})).hits.length,1);
  await assert.rejects(resolver.search({tenantId:'org_other',userId:'user_other'},{query:'replacement'}));
  active.status='disconnected';await assert.rejects(workspace.fetch(principal,{id:found.id}));
});
