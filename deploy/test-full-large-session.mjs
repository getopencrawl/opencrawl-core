// Synthetic acceptance fixture, run only inside the disposable full-app CI stack.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,chownSync,statSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {connectorClient} from '../dist/src/connectors/temporal/client.mjs';
const phase=process.env.UPGRADE_LARGE_PHASE;
assert.ok(['before','after','verify','restored'].includes(phase));
const input=JSON.parse(readFileSync('/dev-state/seed-input.json','utf8'));
const path='/dev-state/upgrade-fixture.json',saved=JSON.parse(readFileSync(path,'utf8'));
const origin=input.connectOrigin,host=new URL(input.origin).host;
const token=await fetch(origin+'/api/cli/token',{method:'POST',headers:{host,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'opencrawl-cli',grant_type:'refresh_token',refresh_token:saved.refreshToken})});
assert.equal(token.status,200);const grant=await token.json();assert.ok(grant.access_token&&grant.refresh_token);
saved.refreshToken=grant.refresh_token;writeFileSync(path,JSON.stringify(saved),{mode:0o600});const {uid,gid}=statSync('/dev-state');chownSync(path,uid,gid);
const headers={host,authorization:'Bearer '+grant.access_token,'content-type':'application/json'};
const batch={...saved.batch,sessionId:input.project+'-large-session',events:[]};
const events=start=>Array.from({length:1000},(_,i)=>({id:'retained-hook-'+(start+i),kind:'hook',data:{sequence:start+i}}));
const upload=async events=>{
 const response=await fetch(origin+'/api/sessions/batches',{method:'POST',headers,body:JSON.stringify({...batch,events}),signal:AbortSignal.timeout(120000)});
 const body=await response.text();return {status:response.status,body};
};
const started=Date.now();
if(phase==='before')for(let start=0;start<125000;start+=1000){assert.equal((await upload(events(start))).status,200);}
const overflow=await upload(events(125000));
const old=phase==='before'||phase==='restored';
assert.equal(overflow.status,old?413:200,overflow.body.slice(0,300));
if(old)assert.match(overflow.body,/identity capacity exceeded/);
assert.equal((await upload(events(0))).status,200,'Original event retry failed');
const conflict=events(0);conflict[0].data.sequence=-1;assert.equal((await upload(conflict)).status,409);
const marker='oversizedtailproof';
if(phase==='after'){
 const content='Synthetic retained session evidence. '.repeat(180000)+marker;
 assert.ok(Buffer.byteLength(content)>6*1024*1024);
 assert.equal((await upload([{id:'oversized-message',kind:'message',data:{role:'user',content}}])).status,200);
 const client=await connectorClient({address:process.env.TEMPORAL_ADDRESS,namespace:process.env.TEMPORAL_NAMESPACE});
 try{await client.client.workflow.execute('indexSessionsV1',{workflowId:'large-upgrade-'+Date.now(),taskQueue:process.env.TEMPORAL_SESSION_TASK_QUEUE,args:[{sourceId:'sessions-'+input.organization+'-v1'}],workflowExecutionTimeout:'5 minutes'});}finally{await client.connection.close();}
}
if(!old){
 let id=0,session;
 const rpc=async(method,params)=>{
  const response=await fetch(origin+'/mcp',{method:'POST',headers:{...headers,accept:'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(120000)});
  assert.equal(response.status,200);session=response.headers.get('mcp-session-id')||session;
  const raw=await response.text();const payload=JSON.parse(raw.startsWith('data:')||raw.startsWith('event:')?raw.split('\n').find(line=>line.startsWith('data:')).slice(5):raw);
  assert.ok(!payload.error);assert.ok(!payload.result.isError);return payload.result;
 };
 await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Full application upgrade acceptance',version:'1'}});
 let found=false;
 for(let attempt=0;attempt<30;attempt++){const result=await rpc('tools/call',{name:'search',arguments:{query:marker,source:'sessions'}});if(JSON.stringify(result).includes(marker)){found=true;break;}await delay(2000);}
 assert.ok(found,'Tail of the large message was not searchable through authenticated MCP');
}
console.log(JSON.stringify({largeSession:phase,existingEvents:125000,additionalEvents:1000,status:overflow.status,largeMessageSearch:!old,elapsedMs:Date.now()-started}));
