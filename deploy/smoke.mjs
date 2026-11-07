// Synthetic data only. Run against a disposable stack owned by this test.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const env=Object.fromEntries(readFileSync(new URL('.env',import.meta.url),'utf8').split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>{const at=l.indexOf('=');return [l.slice(0,at),l.slice(at+1)];}));
const receiver=`http://127.0.0.1:${env.OPENCRAWL_SESSIONS_PORT}`,mcp=`http://127.0.0.1:${env.OPENCRAWL_MCP_PORT}`;
const [action,path]=process.argv.slice(2);
assert.ok(['seed','verify'].includes(action)&&path,'Usage: node deploy/smoke.mjs seed|verify receipt.json');
const headers={authorization:'Bearer '+env.OPENCRAWL_SESSIONS_TOKEN,'content-type':'application/json'};
async function request(url,options={}){const r=await fetch(url,options);assert.equal(r.status,200,`${new URL(url).pathname}: ${r.status}`);return (await r.json()).data;}
let state;
if(action==='seed') {
  assert.equal((await fetch(receiver+'/api/sessions/identity')).status,401);
  const {principal}=await request(receiver+'/api/sessions/identity',{headers});
  const marker='oss-smoke-'+randomUUID(),attachment=Buffer.from('synthetic attachment '+marker),sha256=createHash('sha256').update(attachment).digest('hex');
  await request(receiver+'/api/sessions/attachments/'+sha256,{method:'PUT',headers:{...headers,'content-type':'application/octet-stream'},body:attachment});
  const batch={schemaVersion:1,owner:principal,harness:'codex',origin:'cli',installationId:marker,sessionId:marker,
    events:[{id:marker,kind:'message',data:{role:'user',content:marker}}],attachments:[{status:'captured',sha256,size:attachment.length}]};
  assert.equal((await fetch(receiver+'/api/sessions/batches',{method:'POST',headers,body:JSON.stringify({...batch,owner:{...principal,tenantId:'forged'}})})).status,403);
  const receipt=await request(receiver+'/api/sessions/batches',{method:'POST',headers,body:JSON.stringify(batch)});
  assert.equal(receipt.stored,true);
  assert.deepEqual(await request(receiver+'/api/sessions/batches',{method:'POST',headers,body:JSON.stringify(batch)}),receipt);
  state={marker,principal,sha256,receipt:{harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId,batchId:receipt.batchId}};
  writeFileSync(path,JSON.stringify(state),{mode:0o600});
} else {
  state=JSON.parse(readFileSync(path,'utf8'));
  const batch=await request(receiver+'/api/sessions/batches?'+new URLSearchParams(state.receipt),{headers});
  assert.equal(batch.events[0].data.content,state.marker);assert.equal(batch.attachments[0].sha256,state.sha256);
}
assert.equal((await fetch(mcp+'/api/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:state.marker})})).status,401);
const client=new Client({name:'self-host-smoke',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(mcp+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+env.MCP_TOKEN}}}));
try {
  const names=(await client.listTools()).tools.map(t=>t.name);
  for(const name of ['search','fetch','board_topics','board_sync','board_search'])assert.ok(names.includes(name),name);
  if(action==='seed') {
    const posted=await client.callTool({name:'board_sync',arguments:{workspace:state.principal.tenantId,agent:'smoke',topics:['smoke'],posts:[{id:state.marker,topic:'smoke',text:state.marker}]}});
    assert.ok(!posted.isError);
  } else {
    let hit;
    for(let attempt=0;attempt<60;attempt++) {
      const result=await client.callTool({name:'search',arguments:{query:state.marker,source:'sessions',match:'phrase'}});
      assert.ok(!result.isError,JSON.stringify(result));
      hit=result.structuredContent.results.find(r=>r.text.includes(state.marker));
      if(hit)break;
      await new Promise(r=>setTimeout(r,1000));
    }
    assert.ok(hit,'Synthetic capture did not become searchable');
    const fetched=await client.callTool({name:'fetch',arguments:{id:hit.id}});
    assert.ok(!fetched.isError);assert.ok(fetched.structuredContent.text.includes(state.marker));
    const board=await client.callTool({name:'board_search',arguments:{workspace:state.principal.tenantId,query:state.marker}});
    assert.ok(!board.isError);assert.ok(board.structuredContent.messages.some(message=>message.text===state.marker));
  }
}finally{await client.close();}
console.log('Self-host '+action+' verified with synthetic data.');
