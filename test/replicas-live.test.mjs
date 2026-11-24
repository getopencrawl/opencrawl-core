import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {createReplicasImport} from '../dist/src/integrations/replicas-import.mjs';
import {replicasEvents,replicasSession} from '../dist/src/integrations/replicas-events.mjs';

const org=randomUUID(),otherOrg=randomUUID(),workspace=randomUUID(),chatId=randomUUID();
const owner={tenantId:'internal',userId:'admin'};
const time=new Date().toISOString();
const chat={workspace_id:workspace,chat_id:chatId,created_at:time,updated_at:time,provider:'claude',title:'Test chat',workspace_name:'Internal',workspace_status:'active'};
const source=(id,content)=>({timestamp:time,type:'claude-assistant',payload:{uuid:id,message:{role:'assistant',content:[{type:'text',text:content}]}}});
const live=source(randomUUID(),'live output'),missed=source(randomUUID(),'during disconnect');
const packet=(id,type,payload)=>`id: ${id}\r\ndata: ${JSON.stringify({id,type,payload,ts:time})}\r\n\r\n`;
async function until(predicate){
  const timeout=Date.now()+12000;
  while(!await predicate()){if(Date.now()>timeout)throw Error('timed out waiting for capture');await delay(30);}
}
test('Replicas streams share the history identity, resume after storage, repair gaps, and require the exact authorized scope',async t=>{
  const database=await applicationDatabaseFixture(t),records=[],requests=[],streams=[];
  let failFirst=true,reportedOrg=org;
  const encoder=new TextEncoder();
  const request=async(input,opts)=>{
    const u=new URL(input),h=new Headers(opts.headers);
    requests.push({path:u.pathname,org:h.get('replicas-org-id')});
    assert.equal(u.origin,'https://api.replicas.dev');assert.equal(opts.redirect,'error');
    if(u.pathname.endsWith('/whoami'))return Response.json({caller:'organization_api_key',organization:{id:reportedOrg,name:'Internal'}});
    if(u.pathname.endsWith('/conversations'))return Response.json({conversations:[chat],next_cursor:null,total:1});
    assert.equal(h.get('replicas-org-id'),org);
    if(u.pathname==='/v1/replica')return Response.json({page:1,total_pages:1,replicas:[{id:workspace,status:'active'}]});
    if(u.pathname.endsWith('/history'))return Response.json({events:[live,missed],before_cursor:null});
    assert.equal(u.pathname,'/v1/replica/'+workspace+'/events');
    const response=new ReadableStream({start(ctrl){
      const stop=()=>{try{ctrl.close();}catch{}};
      opts.signal.addEventListener('abort',stop,{once:true});
      const send=(p)=>ctrl.enqueue(encoder.encode(p));
      streams.push({send,stop,last:h.get('last-event-id')});
    }});
    return new Response(response,{headers:{'content-type':'text/event-stream'}});
  };
  const service=createReplicasImport({database,key:randomBytes(32),schedule:async()=>{},request,
    ingest:async(p,b)=>{
      if(failFirst&&b.captureMode==='live'){failFirst=false;throw Error('transient store failure');}
      assert.equal(p.tenantId,owner.tenantId);records.push(b);
    }});
  await service.action(owner,{action:'connect',apiKey:'fixture-org-key'});
  const baseline=requests.length;
  for(const scope of [{tenantId:'other',organizationId:org},{tenantId:owner.tenantId,organizationId:otherOrg}]){
    const stop=new AbortController();const done=service.runLiveCapture(scope,stop.signal);
    await delay(100);stop.abort();await done;
  }
  assert.equal(requests.length,baseline);
  reportedOrg=otherOrg;
  const denied=new AbortController(),rejecting=service.runLiveCapture({tenantId:owner.tenantId,organizationId:org},denied.signal);
  await until(()=>requests.length>baseline);denied.abort();await rejecting;
  assert.deepEqual(requests.slice(baseline).map(r=>r.path),['/v1/whoami']);
  reportedOrg=org;
  const stop=new AbortController(),running=service.runLiveCapture({tenantId:owner.tenantId,organizationId:org},stop.signal);
  t.after(async()=>{stop.abort();await running;});
  await until(()=>streams.length===1);
  streams[0].send(packet('engine:10','engine.stream.opened',{resumed:true}));
  streams[0].send(packet('engine:11','chat.turn.delta',{chatId,event:live}));
  await until(()=>streams.length===2);
  assert.equal(streams[1].last,null,'failed write must leave cursor untouched');
  streams[1].send(packet('engine:11','chat.turn.delta',{chatId,event:live}));
  await until(()=>records.length===1);
  const before=records[0],expected=replicasEvents(chat,{events:[live]})[1];
  assert.deepEqual(before.events,[expected]);
  assert.equal(before.installationId,replicasSession(owner.tenantId,org,workspace,chatId).installationId);
  streams[1].stop();await until(()=>streams.length===3);
  assert.equal(streams[2].last,'engine:11');
  streams[2].send(packet('new:10','engine.stream.opened',{resumed:false}));
  await until(()=>records.some(b=>b.captureMode==='history'&&b.events.some(e=>e.id===replicasEvents(chat,{events:[missed]})[1].id)));
  const repaired=records.find(b=>b.captureMode==='history');
  assert.equal(repaired.events[0].id,before.events[0].id);
  assert.deepEqual(repaired.owner,before.owner);
  await until(async()=>!(await database.pool.query('SELECT gap_since FROM opencrawl_replicas_live_workspaces WHERE namespace=$1',[database.namespace])).rows[0].gap_since);
  const current=await service.status(owner);
  await service.action(owner,{action:'stop',id:current.id});
  const count=records.length;
  streams[2].send(packet('new:11','chat.turn.delta',{chatId,event:source(randomUUID(),'after revoke')}));
  await delay(120);assert.equal(records.length,count);
  stop.abort();await running;
});

test('slow durable storage batches the next network chunks without delaying an isolated frame',async()=>{
  const {replicasLiveApi}=await import('../dist/src/integrations/replicas-live-api.mjs');
  const encoder=new TextEncoder(),stop=new AbortController();
  const firstStarted=Promise.withResolvers(),release=Promise.withResolvers(),readAhead=Promise.withResolvers();
  let packetNo=0;
  const body=new ReadableStream({pull(controller){
    packetNo++;
    if(packetNo>12){controller.close();return;}
    controller.enqueue(encoder.encode(packet('e:'+packetNo,'chat.turn.delta',{chatId,event:live})));
    if(packetNo===10)readAhead.resolve();
  }});
  const api=replicasLiveApi('fixture',org,stop.signal,async()=>new Response(body,{headers:{'content-type':'text/event-stream'}}));
  const writes=[];
  const running=api.stream(workspace,null,stop.signal,async frames=>{
    writes.push(frames.map(f=>f.cursor));
    if(writes.length===1){firstStarted.resolve();await release.promise;}
  });
  try{
    await firstStarted.promise;
    await Promise.race([readAhead.promise,delay(1000).then(()=>{throw Error('stream did not read during storage')})]);
    assert.deepEqual(writes,[['e:1']]);
  }finally{release.resolve();await running;}
  assert.deepEqual(writes.flat(),Array.from({length:12},(_,i)=>'e:'+(i+1)));
  assert.ok(writes.length<=3,'the burst must share durable writes');
});
