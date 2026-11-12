import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {realmIndex} from '../dist/src/search/realm.mjs';
import {createDriveAccess, drivePermissionsCover, workspaceDriveAudience, DRIVE_API} from '../dist/src/integrations/google-drive-access.mjs';
import {createGoogleDriveSource, DRIVE_SOURCE_ENDPOINT} from '../dist/src/integrations/google-drive-source.mjs';
import {normalizeGoogleDrive} from '../dist/src/connectors/google-drive.mjs';
import {createConnectorPipeline} from '../dist/src/connectors/pipeline.mjs';
import {createConnectorSearch} from '../dist/src/connectors/search.mjs';
import {createConnectorResolver} from '../dist/src/integrations/resolver.mjs';
import {createWorkspaceSearch} from '../dist/src/search/workspace.mjs';
import {digest, documentId} from '../dist/src/connectors/scope.mjs';

const tenantId = 'org_drive', connectionId = 'int_' + 'a'.repeat(26), at = Date.parse('2026-11-12T20:00:00Z');
const members = ['alice@example.com', 'bob@external.test'];
const grants = [{type:'domain',domain:'example.com',role:'reader'},{type:'user',emailAddress:'bob@external.test',role:'reader'}];
const binding = {tenantId, connectionId, workspaceId:tenantId, provider:'googledrive', access:'workspace-global', rawPrefix:`raw/v1/source=googledrive/workspace=${tenantId}/connection=${connectionId}/`};
const file = {id:'doc_1',name:'Team document',mimeType:'application/vnd.google-apps.document',version:'12',modifiedTime:new Date(at).toISOString(),capabilities:{canDownload:true}};
function sourceFixture({permissions=grants,body='Original body with violet lighthouse evidence',metadata=file,audience=async()=>members}={}) {
  const calls=[];
  const state={permissions,body,metadata};
  const request=async input=>{
    calls.push(input);
    const endpoint=input.endpoint;
    if(endpoint===DRIVE_API+'/drives')return {status:200,data:{drives:[]}};
    if(endpoint===DRIVE_API+'/about')return {status:200,data:{user:{emailAddress:'connector@gmail.com'}}};
    if(endpoint===DRIVE_API+'/files')return {status:200,data:{files:[{id:state.metadata.id}]}};
    if(endpoint===DRIVE_API+`/files/${state.metadata.id}`)return {status:200,data:{...state.metadata}};
    if(endpoint===DRIVE_API+`/files/${state.metadata.id}/permissions`)return {status:200,data:{permissions:state.permissions}};
    if(endpoint===DRIVE_API+`/files/${state.metadata.id}/export`)return {status:200,data:state.body};
    throw new Error('Unexpected provider request '+endpoint);
  };
  const options={tenantId,connectionId,request,audience,now:()=>at};
  return {state,calls,request,options,source:createGoogleDriveSource(options)};
}

test('Drive requires a current content grant covering every member, including outside-domain teammates',()=>{
  assert.equal(drivePermissionsCover(grants,members,at),true);
  assert.equal(drivePermissionsCover(grants.slice(0,1),members,at),false);
  assert.equal(drivePermissionsCover([{type:'group',emailAddress:'everyone@example.com',role:'reader'}],members,at),false);
  for(const change of [{deleted:true},{expirationTime:new Date(at-1).toISOString()},{expirationTime:'invalid'},{view:'metadata'},{role:'unknown'},{inheritedPermissionsDisabled:true}]) {
    assert.equal(drivePermissionsCover([{type:'anyone',role:'reader',...change}],members,at),false,JSON.stringify(change));
  }
  assert.equal(drivePermissionsCover([{type:'anyone',role:'reader'}],members,at),true);
  assert.equal(drivePermissionsCover([{type:'domain',domain:'sub.example.com',role:'reader'}],['a@example.com'],at),false);
  assert.throws(()=>drivePermissionsCover(grants,[],at),/membership/);
});

test('workspace audience comes from complete current memberships and verified matching identities',async()=>{
  let verified=true,pages=0;
  const directory={userManagement:{listOrganizationMemberships:async()=>({data:[],autoPagination:async()=>{pages++;return [{userId:'user_a',organizationId:tenantId,status:'active'}];}}),getUser:async id=>({id,email:'Alice@Example.com',emailVerified:verified})}};
  const audience=workspaceDriveAudience(directory,tenantId);
  assert.deepEqual(await audience(),['alice@example.com']); assert.equal(pages,1);
  verified=false;await assert.rejects(audience(),/verified/);
  await assert.rejects(workspaceDriveAudience({...directory,userManagement:{...directory.userManagement,listOrganizationMemberships:async()=>({data:Array(100).fill({})})}},tenantId)(),/pagination/);
});

test('private and metadata-only files never have their bodies exported or returned to the source',async()=>{
  for(const permissions of [[],[{type:'user',emailAddress:'alice@example.com',role:'owner'}],[{type:'anyone',role:'reader',view:'metadata'}]]) {
    const fixture=sourceFixture({permissions}),result=await fixture.source.read({endpoint:DRIVE_SOURCE_ENDPOINT});
    assert.deepEqual(result.data.documents,[]);assert.equal(result.data.excluded,1);
    assert.ok(!fixture.calls.some(call=>call.endpoint.endsWith('/export')));
  }
});

test('Drive source exports permitted bodies, binds the receipt, and rejects arbitrary proxy requests',async()=>{
  const fixture=sourceFixture(),result=await fixture.source.read({endpoint:DRIVE_SOURCE_ENDPOINT});
  const document=result.data.documents[0];assert.equal(document.text,fixture.state.body);
  assert.deepEqual([document.access.tenantId,document.access.connectionId,document.access.fileId],[tenantId,connectionId,file.id]);
  assert.equal(document.access.contentHash,digest(document.text));
  for(const input of [{endpoint:DRIVE_API+'/files'},{endpoint:DRIVE_SOURCE_ENDPOINT,query:{corpora:'allDrives'}},{endpoint:DRIVE_SOURCE_ENDPOINT,headers:{Authorization:'secret'}},{endpoint:DRIVE_SOURCE_ENDPOINT,method:'POST'}])await assert.rejects(fixture.source.read(input),{status:403});
});

test('Drive rechecks permission, version, and roster after body extraction',async()=>{
  for(const mode of ['permission','version','membership']) {
    let users=members;const fixture=sourceFixture({audience:async()=>users});
    const request=async input=>{const result=await fixture.request(input);if(input.endpoint.endsWith('/export')) {
      if(mode==='permission')fixture.state.permissions=[];
      if(mode==='version')fixture.state.metadata={...file,version:'13'};
      if(mode==='membership')users=[...members,'new@external.test'];
    }return result;};
    const source=createGoogleDriveSource({...fixture.options,request});
    if(mode==='permission')assert.deepEqual((await source.read({endpoint:DRIVE_SOURCE_ENDPOINT})).data.documents,[]);
    else await assert.rejects(source.read({endpoint:DRIVE_SOURCE_ENDPOINT}),/changed/);
  }
});

test('Drive permission pagination is exhausted and repeated/unknown cursors fail closed',async()=>{
  const fixture=sourceFixture();let loops=false;
  const request=async input=>input.endpoint.endsWith('/permissions')?{status:200,data:input.query.pageToken?{permissions:[grants[1]],...(loops?{nextPageToken:'again'}:{})}:{permissions:[grants[0]],nextPageToken:'again'}}:fixture.request(input);
  assert.ok(await createDriveAccess({...fixture.options,request}).inspect(file.id));
  loops=true;await assert.rejects(createDriveAccess({...fixture.options,request}).inspect(file.id),/cursor/);
  const missing=async input=>input.endpoint.endsWith('/permissions')?{status:200,data:{}}:fixture.request(input);
  await assert.rejects(createDriveAccess({...fixture.options,request:missing}).inspect(file.id),/metadata/);
});

test('Drive quota errors fail the sync instead of masquerading as private files',async()=>{
  for(const reason of ['rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded']){
    const request=async()=>({status:403,data:{error:{errors:[{reason}]}}});
    await assert.rejects(createDriveAccess({request,audience:async()=>members}).inspect(file.id),/403/);
  }
  assert.equal(await createDriveAccess({request:async()=>({status:404,data:{}}),audience:async()=>members}).inspect(file.id),null);
});

test('Drive inventory traverses empty user pages, each shared drive, and the domain corpus',async()=>{
  const fixture=sourceFixture(),visited=[];
  const request=async input=>{
    if(input.endpoint===DRIVE_API+'/drives')return {status:200,data:{drives:[{id:'shared_drive'}]}};
    if(input.endpoint===DRIVE_API+'/about')return {status:200,data:{user:{emailAddress:'alice@example.com'}}};
    if(input.endpoint===DRIVE_API+'/files'){
      visited.push(input.query);return {status:200,data:input.query.corpora==='domain'?{files:[{id:file.id}]}:{files:[]}};
    }
    return fixture.request(input);
  };
  const source=createGoogleDriveSource({...fixture.options,request}),found=[];
  let pageToken;do{const response=await source.read({endpoint:DRIVE_SOURCE_ENDPOINT,query:{pageToken}});found.push(...response.data.documents);pageToken=response.data.nextPageToken;}while(pageToken);
  assert.deepEqual(visited.map(query=>query.corpora),['user','drive','domain']);
  assert.equal(visited[1].driveId,'shared_drive');assert.equal(found.length,1);
});

test('Drive binary exports reject unsafe origins before any download',async()=>{
  const fixture=sourceFixture();let downloads=0;
  for(const url of ['http://127.0.0.1/internal','https://evil.test/file?X-Amz-Signature=x','https://bucket.s3.amazonaws.com/file']){
    const request=async input=>input.endpoint.endsWith('/export')?{status:200,data:null,binary_data:{url}}:fixture.request(input);
    await assert.rejects(createGoogleDriveSource({...fixture.options,request,fetch:async()=>{downloads++;throw new Error('unexpected download');}}).read({endpoint:DRIVE_SOURCE_ENDPOINT}),/origin/);
  }
  assert.equal(downloads,0);
});

test('Drive detects cursor cycles across independent source requests, including empty excluded pages',async()=>{
  const fixture=sourceFixture();let pages=0;
  const request=async input=>input.endpoint===DRIVE_API+'/files'?{status:200,data:{files:[],nextPageToken:++pages%2?'A':'B'}}:fixture.request(input);
  let pageToken;
  await assert.rejects(async()=>{
    for(let i=0;i<10;i++)pageToken=(await createGoogleDriveSource({...fixture.options,request}).read({endpoint:DRIVE_SOURCE_ENDPOINT,query:{pageToken}})).data.nextPageToken;
  },/cursor cycle/);
  assert.ok(pages<10);
});

test('Sheets ingestion includes every worksheet and cell notes, not only the first CSV tab',async()=>{
  const fixture=sourceFixture({metadata:{...file,mimeType:'application/vnd.google-apps.spreadsheet'}});
  const request=async input=>input.endpoint.startsWith('https://sheets.googleapis.com/')?{status:200,data:{spreadsheetId:file.id,sheets:[
    {properties:{title:'First'},data:[{rowData:[{values:[{formattedValue:'one'}]}]}]},
    {properties:{title:'Second'},data:[{startRow:3,startColumn:2,rowData:[{values:[{formattedValue:'last tab evidence',note:'cell note',userEnteredValue:{formulaValue:'=1+1'}}]}]}]},
  ]}}:fixture.request(input);
  const text=(await createGoogleDriveSource({...fixture.options,request}).read({endpoint:DRIVE_SOURCE_ENDPOINT})).data.documents[0].text;
  for(const expected of ['First','Second','last tab evidence','cell note','=1+1','R4C3'])assert.ok(text.includes(expected));
});

for (const engine of ['sqlite', 'opensearch']) test(`${engine}: permission-bearing raw records index and search with revocation, replay and tenant isolation`,{skip:engine==='opensearch'&&!process.env.OPENCRAWL_TEST_OPENSEARCH_URL},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'opencrawl-drive-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const endpoint=pathToFileURL(join(directory,'search.sqlite')).href.replace('file:','sqlite:');
  const source=sourceFixture({body:'A shared paragraph.\n'.repeat(400)+'distinctive tailword evidence'});
  const first=(await source.source.read({endpoint:DRIVE_SOURCE_ENDPOINT})).data.documents[0];
  const objects=new Map(),store={get:async key=>objects.get(key)||null,put:async(key,bytes)=>objects.set(key,bytes),listPage:async prefix=>({keys:[...objects.keys()].filter(key=>key.startsWith(prefix))})};
  const index=realmIndex('test','drive-'+randomUUID());
  const search=createConnectorSearch({endpoint:engine==='sqlite'?endpoint:process.env.OPENCRAWL_TEST_OPENSEARCH_URL,index,tenantId});await search.ensureIndex();
  if(engine==='opensearch')t.after(()=>fetch(process.env.OPENCRAWL_TEST_OPENSEARCH_URL+'/'+index,{method:'DELETE'}));
  const pipeline=createConnectorPipeline({binding,store,search});
  const put=async(data,name,observed=at)=>{const key=binding.rawPrefix+`stream=workspace_documents/date=2026-11-12/sync=test/${name}.jsonl.gz`;objects.set(key,gzipSync(JSON.stringify({_airbyte_extracted_at:observed,_airbyte_data:data})+'\n'));const result=await pipeline.processObject({key});await search.refresh();return {key,result};};
  const processed=await put(first,'first');assert.ok(processed.result.records>1);
  assert.equal((await pipeline.processObject({key:processed.key})).status,'already-indexed');
  const record={tenantId,userId:'user_owner',integrationId:connectionId,provider:'googledrive',scope:'team',status:'active',environment:'selfhost',workspace:tenantId,s3Prefix:binding.rawPrefix.slice(0,-1)};
  const registry={get:async()=>record,listTenant:async()=>[record]};
  const resolver=createConnectorResolver({environment:'selfhost',generation:'v1',registry,storage:async()=>store,search:()=>search,driveAccess:()=>createDriveAccess(source.options)});
  const principal={tenantId,userId:'user_member'},workspace=createWorkspaceSearch({connectors:resolver});
  const result=await workspace.search(principal,{query:'distinctive tailword',source:'connectors'});
  assert.equal(result.results.length,1);const found=result.results[0];
  assert.match((await workspace.fetch(principal,{id:found.id})).text,/distinctive tailword/);
  assert.equal((await search.search(principal,[binding],{query:'tailword'})).hits.length,0,'direct readers without the live access policy fail closed');
  source.state.permissions=[];
  assert.equal((await resolver.search(principal,{query:'tailword'})).hits.length,0);
  assert.equal((await resolver.search(principal,{query:'tailword',raw:true})).responses.flatMap(response=>response.hits.hits).length,0);
  await assert.rejects(workspace.fetch(principal,{id:found.id}));
  source.state.permissions=grants;
  await assert.rejects(resolver.search({tenantId:'org_other',userId:'user_x'},{query:'tailword'}),/scope/);
  const pendingText='A pending replacement paragraph.\n'.repeat(400)+'unpublishedword';
  const pending={...first,text:pendingText,version:'13',modifiedTime:new Date(at+500).toISOString(),access:{...first.access,checkedAt:at+500,contentHash:digest(pendingText)}};
  const pendingKey=binding.rawPrefix+'stream=workspace_documents/date=2026-11-12/sync=test/interrupted.jsonl.gz';
  objects.set(pendingKey,gzipSync(JSON.stringify({_airbyte_extracted_at:at+500,_airbyte_data:pending})+'\n'));
  const interrupted=createConnectorPipeline({binding,store,search:{...search,putDocuments:async(p,b,documents)=>{
    if(documents.some(item=>!item.document.parentId))throw new Error('simulated parent write failure');
    return search.putDocuments(p,b,documents);
  }}});
  await assert.rejects(interrupted.processObject({key:pendingKey}),/parent write failure/);await search.refresh();
  assert.equal((await resolver.search(principal,{query:'unpublishedword'})).hits.length,0);
  assert.equal((await resolver.search(principal,{query:'tailword'})).hits.length,1);
  assert.equal((await pipeline.processObject({key:pendingKey})).status,'indexed');await search.refresh();
  assert.equal((await resolver.search(principal,{query:'unpublishedword'})).hits.length,1);
  const shorter={...first,text:'Short replacement',version:'13',modifiedTime:new Date(at+1000).toISOString(),access:{...first.access,checkedAt:at+1000,contentHash:digest('Short replacement')}};
  await put(shorter,'new',at+1000);await put(first,'late-old');
  assert.equal((await resolver.search(principal,{query:'tailword'})).hits.length,0);
  assert.equal((await resolver.search(principal,{query:'Short replacement'})).hits.length,1);
  const invalid={...shorter,access:{...shorter.access,tenantId:'org_other'}};
  await assert.rejects(put(invalid,'forged',at+1000),/permission receipt/);
  assert.notEqual(documentId(binding,'file',file.id),documentId({...binding,tenantId:'org_other',workspaceId:'org_other',rawPrefix:binding.rawPrefix.replace(tenantId,'org_other')},'file',file.id));
  record.status='disconnecting';assert.equal((await resolver.search(principal,{query:'Short'})).hits.length,0);
});
