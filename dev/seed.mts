import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {chownSync,existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createAirbyte,createAirbyteTransport} from '../dist/src/integrations/airbyte.mjs';
import {createProvisioning,provisioningLabel} from '../dist/src/integrations/provisioning.mjs';
import {createSingleOrganizationRegistry} from '../dist/src/integrations/local-registry.mjs';
import {singleOrganizationDestination} from '../dist/src/integrations/single-organization-storage.mjs';
import {connectorClient,ensureConnectorSchedule} from '../dist/src/connectors/temporal/client.mjs';
import type {ConnectorManifest} from '../dist/src/integrations/types.mjs';

interface Input {format:number;project:string;origin:string;connectOrigin:string;organization:string;email:string;password:string;setupToken:string;airbyteEnabled:boolean;fixtureUrl?:string}
interface SeedState {project:string;integrationId:string;definitionId?:string;definitionIntent?:boolean;jobId?:string|number;userId?:string}
const input=JSON.parse(readFileSync('/dev-state/seed-input.json','utf8')) as Input;
const verifyOnly=process.env.OPENCRAWL_DEV_VERIFY_ONLY==='true';
if(input.format!==1||!/^ocdev-[a-f0-9]{12}$/.test(input.project)||input.organization!==process.env.OPENCRAWL_ORGANIZATION_ID)throw new Error('Development seed scope mismatch');
if(input.airbyteEnabled!==(process.env.OPENCRAWL_AIRBYTE_ENABLED!=='false'))throw new Error('Development seed mode mismatch');
if(input.airbyteEnabled&&!/^http:\/\/\d+\.\d+\.\d+\.\d+:8080$/.test(input.fixtureUrl||'')||input.connectOrigin!=='http://app:8092')throw new Error('Unexpected development fixture address');
const stateFile='/dev-state/seed.json';
const seed:SeedState=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{project:input.project,integrationId:'int_'+randomBytes(13).toString('hex')};
if(seed.project!==input.project||!/^int_[a-f0-9]{26}$/.test(seed.integrationId))throw new Error('Sample data belongs to another development installation');
// The container needs root for the shared app volume. Return private output
// files to the bind directory's owner so a non-root installer can read them.
function writeState(path:string,value:unknown){
  writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  const {uid,gid}=statSync('/dev-state');chownSync(path,uid,gid);
}
const save=()=>writeState(stateFile,seed);save();
const cookies=new Map<string,string>();
async function request(path:string,init:RequestInit={}){
  const response=await fetch(input.connectOrigin+path,{...init,redirect:'manual',headers:{host:new URL(input.origin).host,cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...init.headers},signal:AbortSignal.timeout(30000)});
  for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';'),i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
  return response;
}
async function form(path:string,fields:Record<string,string>){
  const deadline=Date.now()+60000;
  for(;;){
    const response=await request(path,{method:'POST',headers:{origin:input.origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
    if(response.status!==429||Date.now()>=deadline)return response;
    await response.arrayBuffer();
    console.log('Waiting for the authentication retry window...');
    await delay(Math.max(1,Number(response.headers.get('retry-after'))||10)*1000);
  }
}
async function json<T>(path:string,body?:unknown):Promise<T>{
  const r=await request(path,body===undefined?{}:{method:'POST',headers:{origin:input.origin,'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok)throw new Error(`Authenticated ${path} returned ${r.status}`);return await r.json() as T;
}
let login=await form('/auth/login',{email:input.email,password:input.password});
if(login.status===401){
  if(seed.userId)throw new Error('The generated dev account password changed; automatic startup will not reset it');
  const signup=await form('/auth/signup',{setup:input.setupToken,email:input.email,password:input.password,name:'Developer',workspace:'OpenCrawl development'});
  assert.equal(signup.status,303,'First local admin setup did not succeed');
  login=await form('/auth/login',{email:input.email,password:input.password});
}
assert.equal(login.status,303,'Generated local login failed');
const protocol=async(path:string,init:RequestInit={})=>fetch(input.connectOrigin+path,{...init,redirect:'manual',headers:{host:new URL(input.origin).host,...init.headers},signal:AbortSignal.timeout(30000)});
const tokenForm=async(fields:Record<string,string>)=>{
  const r=await protocol('/api/cli/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'opencrawl-cli',...fields})});
  const body=await r.json() as {access_token?:string;refresh_token?:string;error?:string};if(!r.ok)throw new Error(`Dev OAuth token failed: ${body.error||r.status}`);return body;
};
const deviceResponse=await protocol('/api/cli/device',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'opencrawl-cli'})});
assert.equal(deviceResponse.status,200);
const device=await deviceResponse.json() as {device_code:string;user_code:string;interval?:number};
assert.equal((await form('/device',{user_code:device.user_code,decision:'approve'})).status,200);
await delay((device.interval||5)*1000);
let grant=await tokenForm({grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code});
assert.ok(grant.access_token&&grant.refresh_token);
const bearer=()=>({authorization:'Bearer '+grant.access_token});
const me=await protocol('/api/cli/me',{headers:bearer()});assert.equal(me.status,200);
const identityResponse=await protocol('/api/sessions/identity',{headers:bearer()});assert.equal(identityResponse.status,200);
const {data:{principal}}=await identityResponse.json() as {data:{principal:{tenantId:string;userId:string}}};
assert.equal(principal.tenantId,input.organization);if(seed.userId)assert.equal(principal.userId,seed.userId);seed.userId=principal.userId;save();
let rpcId=0,mcpSession:string|undefined;
async function rpc(method:string,params:unknown):Promise<{isError?:boolean;structuredContent?:unknown}>{
  const r=await protocol('/mcp',{method:'POST',headers:{...bearer(),'content-type':'application/json',accept:'application/json, text/event-stream',...(mcpSession?{'Mcp-Session-Id':mcpSession}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});
  assert.equal(r.status,200,`MCP ${method}`);mcpSession=r.headers.get('mcp-session-id')||mcpSession;
  const raw=await r.text(),payload=JSON.parse(raw.startsWith('data:')||raw.startsWith('event:')?raw.split('\n').find(l=>l.startsWith('data:'))!.slice(5):raw) as {error?:unknown;result:{isError?:boolean;structuredContent?:unknown}};
  assert.ok(!payload.error);assert.ok(!payload.result.isError);return payload.result;
}
await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'OpenCrawl development installer',version:'1'}});
await rpc('tools/call',{name:'test_connection',arguments:{}});
const sessionText='The lunar otter checks agent capture. Synthetic OpenCrawl development setup verification. No personal agent history was imported.';
const batch={schemaVersion:1,owner:principal,harness:'codex',origin:'cli',installationId:input.project,sessionId:input.project+'-sample',events:[{id:input.project+'-sample-message',kind:'message',data:{role:'user',content:sessionText}}],attachments:[]};
if(!verifyOnly){const captured=await protocol('/api/sessions/batches',{method:'POST',headers:{...bearer(),'content-type':'application/json'},body:JSON.stringify(batch)});assert.equal(captured.status,200);}
assert.ok((await json<{data:{cli?:{observedAt:string};mcpTest?:{observedAt:string};session?:{observedAt:string}}}>('/api/onboarding')).data.session?.observedAt);
// Full-application upgrade acceptance stores only synthetic fixture credentials.
// These private files are never included in uploaded verification artifacts.
if(process.env.OPENCRAWL_UPGRADE_FIXTURE==='true') {
  const path='/dev-state/upgrade-fixture.json';
  if(existsSync(path)) {
    const saved=JSON.parse(readFileSync(path,'utf8')) as {refreshToken:string;batch:typeof batch};
    const oldGrant=await tokenForm({grant_type:'refresh_token',refresh_token:saved.refreshToken});
    assert.ok(oldGrant.access_token&&oldGrant.refresh_token,'Pre-upgrade OAuth grant was lost');
    const headers={authorization:'Bearer '+oldGrant.access_token,'content-type':'application/json'};
    const retry=await protocol('/api/sessions/batches',{method:'POST',headers,body:JSON.stringify(saved.batch)});
    assert.equal(retry.status,200,'Pre-upgrade event retry failed');
    const conflict=structuredClone(saved.batch);conflict.events[0]!.data.content+=' changed';
    assert.equal((await protocol('/api/sessions/batches',{method:'POST',headers,body:JSON.stringify(conflict)})).status,409,'Pre-upgrade event identity changed');
    const next=structuredClone(saved.batch);next.events[0]!.id+='-after-upgrade';next.events[0]!.data.content+=' after upgrade';
    assert.equal((await protocol('/api/sessions/batches',{method:'POST',headers,body:JSON.stringify(next)})).status,200,'New event write failed');
    saved.refreshToken=oldGrant.refresh_token!;writeState(path,saved);
  }
}
const denied=await fetch(input.connectOrigin+'/api/console/team',{redirect:'manual',headers:{host:new URL(input.origin).host}});
assert.ok([401,302,303].includes(denied.status),'Anonymous team access was accepted');

const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;};
let ingestion:Record<string,unknown>,expected:string;
if(input.airbyteEnabled){
if(verifyOnly)throw new Error('Read-only demo verification currently supports --no-airbyte');
const workspaceId=required('AIRBYTE_WORKSPACE_ID'),organizationId=input.organization;
const airbyte=createAirbyte({url:required('AIRBYTE_URL'),clientId:required('AIRBYTE_CLIENT_ID'),clientSecret:required('AIRBYTE_CLIENT_SECRET')});
const registry=createSingleOrganizationRegistry({path:required('OPENCRAWL_REGISTRY_PATH'),organizationId});
const destination=singleOrganizationDestination({organizationId,bucket:required('OPENCRAWL_LANDING_S3_BUCKET'),region:required('OPENCRAWL_LANDING_S3_REGION'),endpoint:required('OPENCRAWL_AIRBYTE_S3_ENDPOINT'),accessKeyId:required('OPENCRAWL_LANDING_S3_ACCESS_KEY_ID'),secretAccessKey:required('OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY')});
const specification={type:'Spec',connection_specification:{$schema:'http://json-schema.org/draft-07/schema#',type:'object',required:['base_url'],properties:{base_url:{type:'string',title:'Development fixture URL'}}}};
const manifest:ConnectorManifest={version:'7.28.2',type:'DeclarativeSource',check:{type:'CheckStream',stream_names:['notes']},
  streams:[{type:'DeclarativeStream',name:'notes',primary_key:['id'],retriever:{type:'SimpleRetriever',requester:{type:'HttpRequester',url_base:"{{ config['base_url'] }}",path:'/notes',http_method:'GET'},record_selector:{type:'RecordSelector',extractor:{type:'DpathExtractor',field_path:['notes']}}},
    schema_loader:{type:'InlineSchemaLoader',schema:{$schema:'http://json-schema.org/draft-07/schema#',type:'object',additionalProperties:true,properties:{id:{type:'string'},title:{type:'string'},summary_markdown:{type:'string'},created_at:{type:'string'},updated_at:{type:'string'},url:{type:'string'}}}}}],
  spec:specification};

try{
  const definitionName=input.project+' synthetic meeting source';
  if(!seed.definitionId){
    const matches=(await airbyte.declarativeSources(workspaceId)).filter(x=>x.name===definitionName);
    if(matches.length>1)throw new Error('Ambiguous sample source definition');
    if(matches.length)seed.definitionId=matches[0].id;
    else{
      if(seed.definitionIntent)throw new Error('An earlier sample source definition request has an uncertain outcome; inspect Airbyte before retrying');
      seed.definitionIntent=true;save();
      seed.definitionId=(await airbyte.createDeclarativeSource(workspaceId,definitionName,manifest)).id;
    }
    seed.definitionIntent=false;save();
  }
  let record=await registry.get(organizationId,seed.userId!,seed.integrationId);
  if(!record){
    const createdAt=new Date().toISOString();
    record=await registry.create({tenantId:organizationId,userId:seed.userId!,integrationId:seed.integrationId,provider:'granola',environment:'selfhost',scope:'team',status:'provisioning',createdAt,startDate:'2026-01-01T00:00:00Z',
      ownerEmail:input.email,account:'Synthetic development sample — not a Granola account',workspace:organizationId,s3Bucket:required('OPENCRAWL_LANDING_S3_BUCKET'),s3Prefix:`raw/v1/source=granola/workspace=${organizationId}/connection=${seed.integrationId}`,
      airbyteWorkspaceId:workspaceId,airbyteLandingMode:'operator-owned',provisionProtocol:1,provisionRun:randomBytes(16).toString('hex'),provisionVersion:randomBytes(16).toString('hex')});
  }
  if(record.status!=='active'){
    if(record.status!=='provisioning')throw new Error('Sample connection was changed; automatic startup will not restore a disconnected source');
    const durable=createProvisioning({environment:'selfhost',registry,airbyte}),name=provisioningLabel(record);
    record=await durable.ensure(record,'destinationId',workspaceId,async()=>airbyte.createDestination({workspaceId,name,...await destination.settings(record!)}));
    record=await durable.ensure(record,'sourceId',workspaceId,()=>airbyte.createSource({workspaceId,name,definitionId:seed.definitionId,configuration:{base_url:input.fixtureUrl}}));
    record=await durable.ensure(record,'connectionId',workspaceId,()=>airbyte.createConnection({name,sourceId:record!.airbyte!.sourceId,destinationId:record!.airbyte!.destinationId,
      namespaceDefinition:'destination',schedule:{scheduleType:'manual'},status:'active',configurations:{streams:[{name:'notes',syncMode:'full_refresh_append'}]}}));
    record=await registry.update(record,{status:'active'},{whenStatus:['provisioning'],whenFields:{provisionVersion:record.provisionVersion}});
  }
  const connectionId=record.airbyte?.connectionId;if(!connectionId)throw new Error('Sample Airbyte connection is incomplete');
  if(process.env.OPENCRAWL_UPGRADE_FIXTURE==='true'&&process.env.OPENCRAWL_UPGRADE_FRESH_SYNC==='true'){
    const transport=createAirbyteTransport({url:required('AIRBYTE_URL'),clientId:required('AIRBYTE_CLIENT_ID'),clientSecret:required('AIRBYTE_CLIENT_SECRET')});
    const destination=await transport.request<{configuration:{s3_endpoint?:string}}>('GET','/destinations/'+record.airbyte!.destinationId);
    const source=await transport.request<{configuration:{base_url?:string}}>('GET','/sources/'+record.airbyte!.sourceId);
    console.log(JSON.stringify({upgradeRoutes:{storedS3:destination.configuration.s3_endpoint,currentS3:process.env.OPENCRAWL_AIRBYTE_S3_ENDPOINT,storedFixture:source.configuration.base_url,currentFixture:process.env.OPENCRAWL_UPGRADE_FIXTURE_ACTUAL_URL}}));
  }
  const jobs=await airbyte.jobs(connectionId);let job=jobs.find(j=>String(j.jobId)===String(seed.jobId))||jobs[0];
  if(!job||process.env.OPENCRAWL_UPGRADE_FRESH_SYNC==='true'){job=await airbyte.sync(connectionId);seed.jobId=job.jobId;save();}
  const deadline=Date.now()+20*60_000;
  while(job.status!=='succeeded'){
    if(['failed','cancelled'].includes(job.status)){
      if(process.env.OPENCRAWL_UPGRADE_FIXTURE==='true'){
        const transport=createAirbyteTransport({url:required('AIRBYTE_URL'),clientId:required('AIRBYTE_CLIENT_ID'),clientSecret:required('AIRBYTE_CLIENT_SECRET')});
        const details=await transport.config<{attempts?:Array<{attempt?:{failureSummary?:unknown};failureSummary?:unknown}>}>('/jobs/get',{id:Number(job.jobId)});
        let summary=JSON.stringify(details.attempts?.map(a=>a.attempt?.failureSummary??a.failureSummary??null));
        for(const [key,value] of Object.entries(process.env))if(/secret|password|token|key|credential/i.test(key)&&value&&value.length>=8)summary=summary.replaceAll(value,'[redacted]');
        console.log('Synthetic Airbyte failure summary: '+summary.slice(0,6000));
      }
      throw new Error(`Sample Airbyte job ${job.jobId} ${job.status}; inspect its logs in Airbyte`);
    }
    if(Date.now()>deadline)throw new Error('Timed out waiting for the sample Airbyte sync');
    console.log(`Airbyte sample job ${job.jobId}: ${job.status}`);await delay(10000);
    const current=(await airbyte.jobs(connectionId)).find(j=>String(j.jobId)===String(job.jobId));if(current)job=current;
  }
  assert.ok((job.rowsSynced||0)>=2,'Airbyte did not report both sample rows');
  const scheduling=await connectorClient({address:required('TEMPORAL_ADDRESS'),namespace:required('TEMPORAL_NAMESPACE')});
  let workflowId:string;
  try{
    const reference={tenantId:organizationId,userId:seed.userId!,connectionId:seed.integrationId,generation:'v1'};
    await ensureConnectorSchedule(scheduling.client,{reference,taskQueue:required('TEMPORAL_CONNECTOR_TASK_QUEUE')});
    workflowId='dev-verify-'+input.project+'-'+Date.now();
    await scheduling.client.workflow.execute('indexConnectorV1',{workflowId,taskQueue:required('TEMPORAL_CONNECTOR_TASK_QUEUE'),args:[reference],workflowExecutionTimeout:'5 minutes'});
  }finally{await scheduling.connection.close();}
  ingestion={airbyte:{workspaceId,connectionId,jobId:job.jobId,status:job.status,rows:job.rowsSynced},temporal:{workflowId}};
  expected='The lunar otter checks the ingestion pipeline';
}finally{registry.close();}
}else{
  const scheduling=await connectorClient({address:required('TEMPORAL_ADDRESS'),namespace:required('TEMPORAL_NAMESPACE')});
  const workflowId='dev-capture-'+input.project+'-'+Date.now();
  try{
    if(!verifyOnly)await scheduling.client.workflow.execute('indexSessionsV1',{workflowId,taskQueue:required('TEMPORAL_SESSION_TASK_QUEUE'),args:[{sourceId:'sessions-'+input.organization+'-v1'}],workflowExecutionTimeout:'5 minutes'});
  }finally{await scheduling.connection.close();}
  const sources=await json<{items:Array<{state:string;setup?:{requirement?:string}}>}>('/api/onboarding/sources');
  assert.equal(sources.items.length,6);
  assert.ok(sources.items.every(card=>card.state==='setup-required'&&card.setup?.requirement==='Airbyte disabled'));
  ingestion={airbyte:{enabled:false},temporal:verifyOnly?{reindex:false}:{workflowId}};expected=sessionText;
}
  const marker='lunar otter';
  grant=await tokenForm({grant_type:'refresh_token',refresh_token:grant.refresh_token!});
  // A completed indexing workflow can precede OpenSearch's search refresh.
  // Observe the real authenticated read path without changing production refresh policy.
  let searchable=false;
  for(let attempt=0;attempt<30;attempt++){
    const result=await rpc('tools/call',{name:'search',arguments:{query:marker,source:input.airbyteEnabled?'connectors':'sessions',match:'phrase'}});
    if(JSON.stringify(result).includes(expected)){searchable=true;break;}
    console.log('Waiting for the imported sample to become searchable...');await delay(2000);
  }
  assert.ok(searchable,'MCP did not retrieve the imported fixture within 60 seconds');
  const complete=await json<{workspaceUrl:string}>('/api/onboarding/finish',{});assert.equal(complete.workspaceUrl,'/');
  const team=await json<{viewerUserId:string;organization:{id:string};role:string;members:Array<{id:string}>}>('/api/console/team');
  assert.equal(team.organization.id,input.organization);assert.equal(team.viewerUserId,seed.userId);assert.equal(team.role,'admin');
  const result=await json<unknown>('/api/debug/search',{query:marker});
  assert.ok(JSON.stringify(result).includes(expected),'Authenticated product search did not retrieve the imported fixture');
  if(!verifyOnly)await rpc('tools/call',{name:'board_sync',arguments:{workspace:input.organization,agent:'dev:verification',topics:['dev-verification'],posts:[{id:input.project+'-board',topic:'dev-verification',text:'Synthetic development verification: capture and retrieval succeeded.'}]}});
  const board=await rpc('tools/call',{name:'board_sync',arguments:{workspace:input.organization,agent:'dev:reader',topics:['dev-verification'],after:0,leave:true}});
  assert.ok(JSON.stringify(board).includes('Synthetic development verification: capture and retrieval succeeded.'));
  const forged=await request('/api/debug/search',{method:'POST',headers:{origin:input.origin,'content-type':'application/json'},body:JSON.stringify({query:marker,tenantId:'org_forged'})});
  assert.equal(forged.status,400,'Search accepted a caller-supplied tenant');
  const badOrigin=await request('/api/debug/search',{method:'POST',headers:{origin:'https://invalid.example','content-type':'application/json'},body:JSON.stringify({query:marker})});
  assert.equal(badOrigin.status,403,'Search accepted a foreign browser Origin');
  if(process.env.OPENCRAWL_UPGRADE_FIXTURE==='true'&&!existsSync('/dev-state/upgrade-fixture.json'))writeState('/dev-state/upgrade-fixture.json',{refreshToken:grant.refresh_token,batch});
  const report={ok:true,checkedAt:new Date().toISOString(),project:input.project,organization:input.organization,syntheticFixture:true,verifyOnly,identity:'better-auth-local',
    ...ingestion,retrieval:{query:marker,authenticated:true,found:true,mcp:true},board:true,onboardingCompleted:true,deviceGrant:true,refreshGrant:true,anonymousDenied:true,forgedScopeDenied:true,foreignOriginDenied:true};
  writeState('/dev-state/verification.json',report);console.log(JSON.stringify(report));
