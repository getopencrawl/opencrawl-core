import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {connectorManifest} from '../dist/src/integrations/manifests.mjs';
import {LINEAR_STREAMS,linearStream,linearRecordPath,linearQueryStream} from '../dist/src/integrations/linear-upstream.mjs';

const run=promisify(execFile);
const pin=JSON.parse(await readFile(new URL('../dev/pins.json',import.meta.url),'utf8')).declarative;

test('the development Airbyte and the GitHub connector image pin the same declarative runtime',async()=>{
  const from=/^FROM airbyte\/source-declarative-manifest:(\S+)@(sha256:[a-f0-9]{64})$/m.exec(await readFile(new URL('../connectors/github/Dockerfile',import.meta.url),'utf8'));
  assert.ok(from,'the GitHub connector image pins the declarative runtime by digest');
  assert.deepEqual(pin,{version:from[1],imageSha:from[2]});
});

test('real runtime image: full upstream Linear extraction, excluded pages, transforms and incremental state',{skip:!process.env.OPENCRAWL_TEST_CONNECTOR_RUNTIME},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-linear-runtime-'));await chmod(dir,0o755);t.after(()=>rm(dir,{recursive:true,force:true}));
  const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111',updatedAt='2026-11-17T00:00:00.000000Z',seen=[];
  const rows=Object.fromEntries(LINEAR_STREAMS.map((name,i)=>{
    const value={id:id(i+1),updatedAt,createdAt:updatedAt,name,title:name,description:'Full issue prose',content:'Full project plan',body:'Full comment body'};
    for(const key of ['assignee','creator','cycle','state','team','parent','project','projectMilestone','sourceComment','status','tier','user','resolvingComment','resolvingUser','inheritedFrom','comment','customer','attachment','convertedFromIssue','lead','owner','activeCycle','defaultIssueState','triageIssueState','issue','relatedIssue','initiative','parentInitiative'])value[key]={id:id(99)};
    for(const key of ['attachments','labels','subscribers','relations','teams','uncompletedIssuesUponClose'])value[key]={nodes:[{id:id(99)}]};
    return [name,value];
  }));
  const server=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    const input=JSON.parse(body),stream=linearQueryStream(input.query);seen.push({stream,variables:input.variables||{}});
    if(!stream||req.url!=='/api/connector-proxy'||req.headers['x-api-key']!=='fixture-source-capability'||req.headers['x-opencrawl-linear-account']!=='ca_fixture'||req.headers['x-opencrawl-linear-user']!=='selfhost:org_fixture:user_fixture'){res.writeHead(403);return res.end('{}');}
    const data={},path=linearRecordPath(stream);let target=data;for(const part of path.slice(0,-1))target=target[part]??={};
    const next=input.variables?.after==='next';target.nodes=next?[rows[stream]]:[];target.pageInfo={hasNextPage:!next,endCursor:next?'done':'next'};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
  });
  await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const manifest=connectorManifest('linear'),host=process.platform==='linux'?'127.0.0.1':'host.docker.internal';
  const config={__injected_declarative_manifest:manifest,credential_proxy_base_url:`http://${host}:${server.address().port}`,credential_proxy_api_key:'fixture-source-capability',connected_account_id:'ca_fixture',user_id:'selfhost:org_fixture:user_fixture',start_date:'1970-01-01T00:00:00.000Z',num_workers:1,credentials:{auth_type:'OAuth2.0'}};
  const catalog={streams:LINEAR_STREAMS.map(name=>({stream:{name,json_schema:manifest.schemas[name],supported_sync_modes:['full_refresh',...(linearStream(name).incremental_sync?['incremental']:[])]},sync_mode:linearStream(name).incremental_sync?'incremental':'full_refresh',cursor_field:linearStream(name).incremental_sync?['updatedAt']:[],destination_sync_mode:'append'}))};
  for(const [name,value]of [['config',config],['catalog',catalog]]){await writeFile(join(dir,name+'.json'),JSON.stringify(value));await chmod(join(dir,name+'.json'),0o644);}
  const image=`airbyte/source-declarative-manifest:${pin.version}@${pin.imageSha}`;
  async function read(state=false){
    const result=await run('docker',['run','--rm',...(process.platform==='linux'?['--network','host']:[]),'-v',`${dir}:/fixture:ro`,image,'read','--config','/fixture/config.json','--catalog','/fixture/catalog.json',...(state?['--state','/fixture/state.json']:[])],{maxBuffer:32*1024*1024,timeout:240000}).catch(error=>({stdout:String(error.stdout||''),stderr:String(error.stderr||'')}));
    const messages=result.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}),errors=messages.filter(m=>m.type==='TRACE'&&m.trace?.error);
    assert.deepEqual(errors.map(e=>e.trace.error.message),[]);return messages;
  }
  const messages=await read(),records=messages.filter(m=>m.type==='RECORD').map(m=>m.record);
  assert.deepEqual([...new Set(records.map(r=>r.stream))].sort(),[...LINEAR_STREAMS].sort());
  assert.equal(records.find(r=>r.stream==='issues').data.assigneeId,id(99));
  assert.equal(records.find(r=>r.stream==='comments').data.body,'Full comment body');
  assert.equal(records.find(r=>r.stream==='projects').data.content,'Full project plan');
  assert.equal(records.find(r=>r.stream==='issue_history').data.issueId,rows.issues.id);
  const latest=new Map(messages.filter(m=>m.type==='STATE').map(m=>[m.state.stream?.stream_descriptor.name||m.state.type,m.state]));
  await writeFile(join(dir,'state.json'),JSON.stringify([...latest.values()]));await chmod(join(dir,'state.json'),0o644);
  seen.length=0;await read(true);
  for(const stream of LINEAR_STREAMS.filter(name=>linearStream(name).incremental_sync))assert.ok(seen.some(r=>r.stream===stream&&Date.parse(r.variables.filter?.updatedAt?.gte)>Date.parse('1970-01-01')),stream+' did not resume its upstream cursor');
});

test('real runtime image: Drive continues past excluded pages and emits complete permission-bearing records',{skip:!process.env.OPENCRAWL_TEST_CONNECTOR_RUNTIME},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-drive-runtime-'));
  await chmod(dir,0o755); // The runtime reads the mounted fixture as its non-root user.
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const seen=[],document={id:'shared_doc',name:'Shared document',mimeType:'text/plain',version:'1',modifiedTime:'2026-11-12T00:00:00Z',text:'Full body including the distant suffix',extractionStatus:'extracted',access:{policy:'workspace-members-v1',contentHash:'receipt-preserved'}};
  const server=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    const input=JSON.parse(body);seen.push(input);
    if(req.url!=='/api/connector-proxy'||req.headers['x-api-key']!=='fixture-source-capability'||input.endpoint!=='opencrawl://googledrive/workspace-documents') {res.writeHead(403);return res.end('{}');}
    const token=input.parameters?.find(p=>p.name==='pageToken')?.value;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({status:200,data:token==='next-page'?{documents:[document]}:{documents:[],nextPageToken:'next-page'}}));
  });
  await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const manifest=connectorManifest('googledrive'),host=process.platform==='linux'?'127.0.0.1':'host.docker.internal';
  const config={__injected_declarative_manifest:manifest,credential_proxy_base_url:`http://${host}:${server.address().port}`,credential_proxy_api_key:'fixture-source-capability',connected_account_id:'ca_fixture',user_id:'selfhost:org_fixture:user_fixture'};
  const catalog={streams:[{stream:{name:'workspace_documents',json_schema:manifest.streams[0].schema_loader.schema,supported_sync_modes:['full_refresh']},sync_mode:'full_refresh',destination_sync_mode:'append'}]};
  for(const [name,value] of [['config',config],['catalog',catalog]]){const file=join(dir,name+'.json');await writeFile(file,JSON.stringify(value));await chmod(file,0o644);}
  const image=`airbyte/source-declarative-manifest:${pin.version}@${pin.imageSha}`;
  const result=await run('docker',['run','--rm',...(process.platform==='linux'?['--network','host']:[]),'-v',`${dir}:/fixture:ro`,image,'read','--config','/fixture/config.json','--catalog','/fixture/catalog.json'],{maxBuffer:16*1024*1024,timeout:120000});
  const messages=result.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  assert.deepEqual(messages.filter(m=>m.type==='RECORD').map(m=>m.record.data),[document]);
  assert.equal(messages.filter(m=>m.type==='TRACE'&&m.trace?.error).length,0);
  assert.equal(seen.length,2);assert.deepEqual(seen[1].parameters,[{name:'pageToken',value:'next-page',type:'query'}]);
});

// Airbyte validates a manifest only when it builds the streams, so a component the runtime does not know
// surfaces as a failed connection setup. Discovery here reads no provider data and needs no network.
test('real runtime image: every connector manifest passes discovery on the pinned declarative runtime',{skip:!process.env.OPENCRAWL_TEST_CONNECTOR_RUNTIME},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-connector-runtime-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const image=`airbyte/source-declarative-manifest:${pin.version}@${pin.imageSha}`;
  for(const id of ['slack','googledrive','notion','circleback','granola','linear']){
    const manifest=connectorManifest(id),spec=manifest.spec.connection_specification,config={__injected_declarative_manifest:manifest};
    for(const key of spec.required)config[key]=key==='start_date'?'2026-01-01T00:00:00Z':key==='connected_account_id'?'ca_placeholder':spec.properties[key].type==='integer'?1:'placeholder';
    const file=join(dir,id+'.json');await writeFile(file,JSON.stringify(config));await chmod(file,0o644);
    const result=await run('docker',['run','--rm','--network','none','-v',`${file}:/config.json:ro`,image,'discover','--config','/config.json'],{maxBuffer:64*1024*1024}).catch(error=>error);
    const messages=String(result.stdout||'').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const refused=messages.find(message=>message.type==='TRACE'&&message.trace?.error)?.trace.error.message;
    assert.ok(messages.some(message=>message.type==='CATALOG'&&message.catalog.streams.length),`${id} does not load on declarative runtime ${pin.version}: ${refused||String(result.stderr||result.message||'no catalog').slice(0,400)}`);
  }
});
