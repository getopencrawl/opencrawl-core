import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {createLinearSource, LINEAR_API} from '../dist/src/integrations/linear-source.mjs';
import {createProviderCatalog} from '../dist/src/integrations/providers.mjs';
import {connectorManifest} from '../dist/src/integrations/manifests.mjs';
import {createComposioOAuth} from '../dist/src/integrations/composio.mjs';
import {normalizeLinear} from '../dist/src/connectors/linear.mjs';
import {createConnectorPipeline} from '../dist/src/connectors/pipeline.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {createConnectorResolver} from '../dist/src/integrations/resolver.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {realmIndex} from '../dist/src/search/realm.mjs';
import {documentId, validateBinding} from '../dist/src/connectors/scope.mjs';

const tenantId='org_linear', connectionId='int_'+'a'.repeat(26), workspaceId='11111111-1111-4111-8111-111111111111';
const issueId='22222222-2222-4222-8222-222222222222', commentId='33333333-3333-4333-8333-333333333333', teamId='44444444-4444-4444-8444-444444444444';
const at=Date.parse('2026-11-16T00:00:00Z');
const binding={tenantId,connectionId,workspaceId,provider:'linear',access:'workspace-global',rawPrefix:`raw/v1/source=linear/workspace=${workspaceId}/connection=${connectionId}/`};
const record={tenantId,userId:'user_owner',integrationId:connectionId,workspace:workspaceId,provider:'linear',scope:'team',status:'active',environment:'selfhost',connectedAccountId:'ca_linear',s3Prefix:binding.rawPrefix.slice(0,-1)};
const issue={id:issueId,identifier:'ENG-42',title:'Searchable issue',description:'A full issue body',url:'https://linear.app/example/issue/ENG-42',updatedAt:new Date(at).toISOString(),trashed:null,team:{id:teamId,visibility:'public',organization:{id:workspaceId}}};
const comment={id:commentId,body:'A complete comment body',url:issue.url+'#comment-'+commentId,updatedAt:issue.updatedAt,issue};
function fixture(){
  const state={issue:structuredClone(issue),comment:structuredClone(comment),organization:workspaceId,errors:false},calls=[];
  const request=async input=>{
    calls.push(input);assert.equal(input.endpoint,LINEAR_API);assert.equal(input.method,'POST');assert.match(input.body.query,/^query /);
    if(state.errors)return {status:200,data:{data:{},errors:[{message:'provider error'}]}};
    const q=input.body.query;
    const data=q.includes('OpenCrawlOrganization')?{organization:{id:state.organization}}:q.includes('OpenCrawlAccount')?{organization:{id:state.organization,name:'Example'}}:
      q.includes('OpenCrawlResource')?{resource:{nodes:[q.includes('comments(')?state.comment:state.issue].filter(Boolean)}}:
      {[q.includes('comments(')?'comments':'issues']:{nodes:[q.includes('comments(')?state.comment:state.issue],pageInfo:{hasNextPage:false,endCursor:null}}};
    return {status:200,data:{data}};
  };
  const options={tenantId,connectionId,workspaceId,request,now:()=>at};
  return {state,calls,request,options,source:createLinearSource(options)};
}
test('Linear catalog uses read OAuth, full snapshots and a gated complete adapter',async()=>{
  const definitions={linear:{name:'Linear',manifest:connectorManifest('linear')}};
  assert.match(createProviderCatalog(definitions).linear.unavailableReason,/permission adapter/);
  const provider=createProviderCatalog(definitions,{linearPublicAccess:true}).linear;
  assert.equal(provider.unavailableReason,undefined);assert.equal(provider.authConfig.credentials.scopes,'read');
  assert.deepEqual(provider.streams.map(s=>s.name),['issues','comments']);assert.ok(provider.streams.every(s=>s.syncMode==='full_refresh_append'));
  const f=fixture();assert.deepEqual(await provider.account(f.request),{label:'Example',workspace:workspaceId});
  assert.deepEqual(f.calls[0].headers,{'Content-Type':'application/json'});
  f.state.errors=true;await assert.rejects(provider.account(f.request),/read failed/);
});
test('Linear excludes private, restricted, unknown, foreign and trashed issues and comments',async()=>{
  for(const visibility of ['private','restricted',undefined]){
    const f=fixture();f.state.issue.team.visibility=visibility;f.state.comment.issue.team.visibility=visibility;
    for(const stream of ['issues','comments'])assert.deepEqual((await f.source.read({endpoint:'opencrawl://linear/'+stream})).data.documents,[]);
    assert.equal(await f.source.inspect('issue:'+issueId),false);assert.equal(await f.source.inspect('comment:'+commentId),false);
  }
  for(const change of [i=>i.team.organization.id='other',i=>i.trashed=true]){
    const f=fixture();change(f.state.issue);assert.deepEqual((await f.source.read({endpoint:'opencrawl://linear/issues'})).data.documents,[]);
  }
  const f=fixture();f.state.organization='other';await assert.rejects(f.source.read({endpoint:'opencrawl://linear/issues'}),/workspace changed/);
  const deleted=fixture();deleted.state.issue=null;deleted.state.comment=null;
  assert.equal(await deleted.source.inspect('issue:'+issueId),false);assert.equal(await deleted.source.inspect('comment:'+commentId),false);
});
test('Linear rejects arbitrary GraphQL, partial errors and invalid pagination; continues past excluded pages',async()=>{
  const f=fixture();
  for(const input of [{endpoint:LINEAR_API,method:'POST',body:{query:'mutation { issueDelete }'}},{endpoint:'opencrawl://linear/issues',query:{first:10000}},{endpoint:'opencrawl://linear/issues',headers:{Authorization:'bad'}}])await assert.rejects(f.source.read(input),/Unsupported/);
  f.state.errors=true;await assert.rejects(f.source.read({endpoint:'opencrawl://linear/issues'}),/read failed/);
  f.state.errors=false;delete f.state.issue.description;await assert.rejects(f.source.read({endpoint:'opencrawl://linear/issues'}),/Incomplete/);
  let pages=0;
  const request=async input=>input.body.query.includes('OpenCrawlOrganization')?f.request({...input,body:{query:'query OpenCrawlAccount'}}):{status:200,data:{data:{issues:{nodes:pages++? [issue]:[],pageInfo:{hasNextPage:pages===1,endCursor:'next'}}}}};
  f.state.errors=false;
  const source=createLinearSource({...f.options,request}),first=await source.read({endpoint:'opencrawl://linear/issues'});
  assert.equal(first.data.documents.length,0);assert.ok(first.data.nextPageToken);
  assert.equal((await source.read({endpoint:'opencrawl://linear/issues',query:{pageToken:first.data.nextPageToken}})).data.documents.length,1);
  await assert.rejects(source.read({endpoint:'opencrawl://linear/comments',query:{pageToken:first.data.nextPageToken}}),/cursor scope/);
  let calls=0;
  const cycle=async input=>input.body.query.includes('OpenCrawlOrganization')?f.request(input):{status:200,data:{data:{issues:{nodes:[],pageInfo:{hasNextPage:true,endCursor:++calls%2?'A':'B'}}}}};
  let pageToken;
  await assert.rejects(async()=>{for(let i=0;i<10;i++)pageToken=(await createLinearSource({...f.options,request:cycle}).read({endpoint:'opencrawl://linear/issues',query:{pageToken}})).data.nextPageToken;},/cursor cycle/);
  assert.ok(calls<10);
});
test('Linear source capabilities cannot cross connections, become arbitrary queries or survive disconnect',async()=>{
  const f=fixture(),active={...record};
  const oauth=createComposioOAuth({apiKey:'operator-key',organizationId:tenantId,proxyUrl:'https://operator.example',proxyKey:Buffer.alloc(32,3),registry:{list:async()=>[active]},fetch:async(url,options)=>{
    assert.ok(url.endsWith('/tools/execute/proxy'));const proxy=JSON.parse(options.body);return Response.json(await f.request({endpoint:proxy.endpoint,method:proxy.method,body:proxy.body}));
  }});
  const provider=createProviderCatalog({linear:{name:'Linear'}},{linearPublicAccess:true}).linear;
  const config=await oauth.sourceConfiguration(active,provider),read=input=>oauth.proxyCredential(config.connected_account_id,config.credential_proxy_api_key,config.user_id,input);
  assert.equal((await read({endpoint:'opencrawl://linear/issues'})).data.documents.length,1);
  await assert.rejects(oauth.proxyCredential('ca_other',config.credential_proxy_api_key,config.user_id,{endpoint:'opencrawl://linear/issues'}));
  await assert.rejects(read({endpoint:LINEAR_API,method:'POST',body:{query:'mutation { x }'}}));
  active.status='disconnected';await assert.rejects(read({endpoint:'opencrawl://linear/issues'}));
});
test('Linear landed records require scoped public-team proof and retain separate identities',async()=>{
  const f=fixture(),data=(await f.source.read({endpoint:'opencrawl://linear/issues'})).data.documents[0];
  const envelope={_airbyte_extracted_at:at,_airbyte_data:data};
  assert.equal(normalizeLinear(binding,'issues',envelope,'key').at(-1).document.kind,'issue');
  for(const bad of [{...data,access:undefined},{...data,text:'forged text'},{...data,access:{...data.access,tenantId:'org_other'}},{...data,access:{...data.access,connectionId:'other'}}])assert.throws(()=>normalizeLinear(binding,'issues',{...envelope,_airbyte_data:bad},'key'));
  assert.throws(()=>normalizeLinear(binding,'comments',envelope,'key'));
  for(const bad of [{...binding,tenantId:''},{...binding,access:'team-public'},{...binding,rawPrefix:'other/'}])assert.throws(()=>validateBinding(bad));
  assert.notEqual(documentId(binding,'issue',data.id),documentId({...binding,tenantId:'org_other'},'issue',data.id));
});
for(const engine of ['sqlite','opensearch'])test(`${engine}: Linear source to authenticated search and fetch, edits, replay and revocation`,{skip:engine==='opensearch'&&!process.env.OPENCRAWL_TEST_OPENSEARCH_URL},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-linear-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const index=realmIndex('test','linear-'+randomUUID());
  const search=createConnectorSearch({tenantId,index,endpoint:engine==='sqlite'?pathToFileURL(join(dir,'search.sqlite')).href.replace('file:','sqlite:'):process.env.OPENCRAWL_TEST_OPENSEARCH_URL});await search.ensureIndex();
  if(engine==='opensearch')t.after(()=>fetch(process.env.OPENCRAWL_TEST_OPENSEARCH_URL+'/'+index,{method:'DELETE'}));
  const f=fixture();f.state.issue.description='A long readable paragraph.\n'.repeat(400)+'distinctive tailword';
  const objects=new Map(),store={get:async key=>objects.get(key)||null,put:async(key,value)=>{objects.set(key,value);},listPage:async()=>({keys:[...objects.keys()]})};
  const pipeline=createConnectorPipeline({binding,store,search});
  const put=async(stream,name)=>{const data=(await f.source.read({endpoint:'opencrawl://linear/'+stream})).data.documents[0];const key=binding.rawPrefix+`stream=${stream}/date=2026-11-16/sync=test/${name}.jsonl.gz`;objects.set(key,gzipSync(JSON.stringify({_airbyte_extracted_at:at,_airbyte_data:data})+'\n'));await pipeline.processObject({key});await search.refresh();return key;};
  const key=await put('issues','first');await put('comments','first');assert.equal((await pipeline.processObject({key})).status,'already-indexed');
  const active={...record},registry={get:async()=>active,listTenant:async()=>[active]};
  const resolver=createConnectorResolver({environment:'selfhost',generation:'v1',registry,storage:async()=>store,search:()=>search,linearAccess:()=>f.source});
  const principal={tenantId,userId:'user_member'},workspace=createWorkspaceSearch({connectors:resolver});
  const result=await workspace.search(principal,{query:'tailword',source:'connectors'});assert.equal(result.results.length,1);
  const found=result.results[0];assert.match((await workspace.fetch(principal,{id:found.id})).text,/tailword/);
  assert.equal((await resolver.search(principal,{query:'complete comment'})).hits.length,1);
  assert.equal((await search.search(principal,[binding],{query:'tailword'})).hits.length,0);
  f.state.issue.team.visibility='restricted';f.state.comment.issue.team.visibility='restricted';
  assert.equal((await resolver.search(principal,{query:'tailword'})).hits.length,0);
  assert.equal((await resolver.search(principal,{query:'comment',raw:true})).responses.flatMap(r=>r.hits.hits).length,0);
  await assert.rejects(workspace.fetch(principal,{id:found.id}));
  f.state.issue.team.visibility='public';f.state.issue.description='Shorter replacement';f.state.issue.updatedAt=new Date(at+1000).toISOString();await put('issues','edited');
  assert.equal((await resolver.search(principal,{query:'tailword'})).hits.length,0);assert.equal((await resolver.search(principal,{query:'Shorter replacement'})).hits.length,1);
  await assert.rejects(resolver.search({tenantId:'org_other',userId:'user_other'},{query:'replacement'}));
  active.status='disconnected';await assert.rejects(workspace.fetch(principal,{id:found.id}));
});
