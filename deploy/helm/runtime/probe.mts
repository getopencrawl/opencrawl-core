// Mounted into the released runtime by verify.mts; never prints credentials.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {sessionStorage} from '../../../dist/src/sessions/storage.mjs';
import {connectorClient} from '../../../dist/src/connectors/temporal/client.mjs';
import {selfhostTemporalSettings} from '../../../dist/src/selfhost/temporal-settings.mjs';
import {realmIndex} from '../../../dist/src/search/realm-format.mjs';

const env=process.env,results:object[]=[],exercise=env.CONFORMANCE_EXERCISE==='true',existing=env.CONFORMANCE_EXISTING==='true';
const required=(key:string)=>{const value=env[key];assert.ok(value,`${key} required`);return value;};
async function check(name:string,hint:string,run:()=>Promise<unknown>){
  const started=Date.now();
  try{await run();const result={name,status:'passed',elapsedMs:Date.now()-started};results.push(result);console.log(JSON.stringify(result));}
  catch{console.error(JSON.stringify({schemaVersion:1,status:'failed',check:name,hint,results}));process.exit(1);}
}
const origin=required('OPENCRAWL_URL'),url=required('CONFORMANCE_APP_URL');
const request=(path:string,init:RequestInit={})=>fetch(url+path,{...init,redirect:'manual',headers:{host:new URL(origin).host,...init.headers},signal:AbortSignal.timeout(30000)});
await check('postgresql','Check OPENCRAWL_DATABASE_URL, TLS trust, DB ownership and migration Job.',async()=>{
  const db=new pg.Client({connectionString:required('OPENCRAWL_DATABASE_URL'),connectionTimeoutMillis:15000});
  await db.connect();try{const r=await db.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');assert.equal(r.rows[0].rolsuper,false,'App must use a restricted role');}finally{await db.end();}
});
const {store:storage}=sessionStorage();
await check('object-storage','Check bucket existence, credentials, endpoint and network policies.',()=>storage.checkAccess());
const temporal=selfhostTemporalSettings();
await check('temporal-namespace','Check Temporal address, namespace, TLS and credentials.',async()=>{
  const c=await connectorClient(temporal);try{await c.connection.workflowService.describeNamespace({namespace:temporal.namespace});}finally{await c.connection.close();}
});
await check('worker-poller','Check the worker readiness probe and session task-queue configuration.',async()=>{
  const c=await connectorClient(temporal);try{const response=await c.connection.workflowService.describeTaskQueue({namespace:temporal.namespace,taskQueue:{name:env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1'},taskQueueType:1});assert.ok(response.pollers?.length);}finally{await c.connection.close();}
});
await check('opensearch-index','Grant access to the configured index and check app/worker readiness.',async()=>{
  const index=env.OPENCRAWL_OPENSEARCH_INDEX||realmIndex('selfhost',required('OPENCRAWL_ORGANIZATION_ID'));
  const authorization:Record<string,string>=env.OPENCRAWL_OPENSEARCH_USERNAME?{authorization:'Basic '+Buffer.from(env.OPENCRAWL_OPENSEARCH_USERNAME+':'+required('OPENCRAWL_OPENSEARCH_PASSWORD')).toString('base64')}:{};
  const r=await fetch(required('OPENCRAWL_OPENSEARCH_URL')+'/'+index+'/_mapping',{headers:authorization,redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);
  const mapping=await r.json();assert.equal(mapping[index].mappings._meta.tenantId,env.OPENCRAWL_ORGANIZATION_ID);
});
await check('application-health','Inspect application readiness and migration logs.',async()=>assert.equal((await request('/health')).status,200));
await check('anonymous-denied','The application must reject unauthenticated CLI identity requests.',async()=>assert.equal((await request('/api/cli/me')).status,401));
if(env.OPENCRAWL_AIRBYTE_ENABLED!=='false')await check('airbyte-workspace','Check the Airbyte API client credentials and configured workspace.',async()=>{
  const r=await fetch(required('AIRBYTE_URL')+'/api/public/v1/applications/token',{redirect:'error',method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:required('AIRBYTE_CLIENT_ID'),client_secret:required('AIRBYTE_CLIENT_SECRET'),'grant-type':'client_credentials'}),signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);
  const {access_token}=await r.json();const workspace=await fetch(required('AIRBYTE_URL')+'/api/public/v1/workspaces/'+required('AIRBYTE_WORKSPACE_ID'),{redirect:'error',headers:{authorization:'Bearer '+access_token},signal:AbortSignal.timeout(30000)});assert.equal(workspace.status,200);
});
if(exercise){
  const cookies=new Map<string,string>();
  const cookie=()=>[...cookies].map(([k,v])=>`${k}=${v}`).join('; ');
  async function form(path:string,fields:Record<string,string>){const r=await request(path,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',cookie:cookie()},body:new URLSearchParams(fields)});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}return r;}
  let bearer:Record<string,string>={},principal:{tenantId:string;userId:string},grant:{access_token:string;refresh_token:string};
  await check('login-and-device-grant','Exercise mode creates a synthetic first admin on fresh installations; use its saved Secret for repeat runs.',async()=>{
    const account={email:required('CONFORMANCE_EMAIL'),password:required('CONFORMANCE_PASSWORD')};
    let login=await form('/auth/login',account);
    if(login.status===401&&!existing){assert.equal((await form('/auth/signup',{...account,setup:required('OPENCRAWL_SETUP_TOKEN'),name:'Conformance',workspace:'Helm validation'})).status,303);login=await form('/auth/login',account);}
    assert.equal(login.status,303);
    const r=await request('/api/cli/device',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'opencrawl-cli'})});assert.equal(r.status,200);
    const device=await r.json();assert.equal((await form('/device',{user_code:device.user_code,decision:'approve'})).status,200);await delay((device.interval||5)*1000);
    const token=await request('/api/cli/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'opencrawl-cli',grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code})});assert.equal(token.status,200);grant=await token.json();assert.ok(grant.access_token&&grant.refresh_token);bearer={authorization:'Bearer '+grant.access_token};
    const identity=await request('/api/sessions/identity',{headers:bearer});assert.equal(identity.status,200);principal=(await identity.json()).data.principal;assert.equal(principal.tenantId,env.OPENCRAWL_ORGANIZATION_ID);
  });
  const marker=required('CONFORMANCE_MARKER'),text=`Synthetic Helm conformance fixture ${marker}.`;
  if(!existing)await check('capture-idempotency-and-conflict','Inspect app-state/event-identity storage and capture validation.',async()=>{
    const batch={schemaVersion:1,owner:principal,harness:'codex',origin:'cli',installationId:marker,sessionId:marker,events:[{id:marker+'-message',kind:'message',data:{role:'user',content:text}}],attachments:[]};
    const capture=(value:unknown)=>request('/api/sessions/batches',{method:'POST',headers:{...bearer,'content-type':'application/json'},body:JSON.stringify(value)});
    assert.equal((await capture(batch)).status,200);assert.equal((await capture(batch)).status,200);batch.events[0].data.content+=' conflicting';assert.equal((await capture(batch)).status,409);
  });
  if(!existing)await check('temporal-indexing','Check worker pollers, task queues, S3 access and index write permissions.',async()=>{
    const c=await connectorClient(temporal);try{await c.client.workflow.execute('indexSessionsV1',{workflowId:'helm-'+marker+'-'+Date.now(),taskQueue:env.TEMPORAL_SESSION_TASK_QUEUE||'session-indexing-v1',args:[{sourceId:'sessions-'+env.OPENCRAWL_ORGANIZATION_ID+'-v1'}],workflowExecutionTimeout:'5 minutes'});}finally{await c.connection.close();}
  });
  await check('mcp-search','Indexing completed but authenticated MCP retrieval did not find the fixture.',async()=>{
    let id=0,session:string|undefined;
    async function rpc(method:string,params:unknown){const r=await request('/mcp',{method:'POST',headers:{...bearer,'content-type':'application/json',accept:'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});assert.equal(r.status,200);session=r.headers.get('mcp-session-id')||session;const raw=await r.text(),payload=JSON.parse(raw.startsWith('data:')||raw.startsWith('event:')?raw.split('\n').find(l=>l.startsWith('data:'))!.slice(5):raw);assert.ok(!payload.error&&!payload.result?.isError);return payload.result;}
    await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'OpenCrawl Helm conformance',version:'1'}});
    await rpc('tools/call',{name:'test_connection',arguments:{}});
    if(env.CONFORMANCE_DENY_MARKER){const denied=await rpc('tools/call',{name:'search',arguments:{query:env.CONFORMANCE_DENY_MARKER,source:'sessions'}});assert.ok(!JSON.stringify(denied).includes('Synthetic Helm conformance fixture '+env.CONFORMANCE_DENY_MARKER+'.'));}
    for(let attempt=0;attempt<30;attempt++){const r=await rpc('tools/call',{name:'search',arguments:{query:marker,source:'sessions'}});if(JSON.stringify(r).includes(text))return;await delay(2000);}throw Error('Fixture absent');
  });
  await check('browser-scope-and-origin','Authenticated browser operations must reject caller-supplied scope and a foreign Origin.',async()=>{
    const query=(extra:object,requestOrigin=origin)=>request('/api/debug/search',{method:'POST',headers:{cookie:cookie(),origin:requestOrigin,'content-type':'application/json'},body:JSON.stringify({query:marker,...extra})});
    assert.equal((await query({tenantId:'org_forged'})).status,400);assert.equal((await query({},'https://invalid.example')).status,403);
  });
  await check('refresh-grant','OAuth refresh grants must remain usable with persisted identity state.',async()=>{
    const r=await request('/api/cli/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'opencrawl-cli',grant_type:'refresh_token',refresh_token:grant.refresh_token})});assert.equal(r.status,200);assert.ok((await r.json()).access_token);
  });
}
console.log(JSON.stringify({schemaVersion:1,status:'passed',exercise,existing,revision:env.REVISION,organization:env.OPENCRAWL_ORGANIZATION_ID,checkedAt:new Date().toISOString(),results}));
