import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {applicationDatabaseFixture} from './fixtures/application-database.mjs';
import {createReplicasImport} from '../dist/src/integrations/replicas-import.mjs';
import {replicasEvents,replicasSession} from '../dist/src/integrations/replicas-events.mjs';

const org=randomUUID(),otherOrg=randomUUID(),workspace=randomUUID(),chatId=randomUUID();
const owner={tenantId:'internal',userId:'admin'};
const time=new Date().toISOString(),claudeThread=randomUUID(),codexThread=randomUUID(),codexChat=randomUUID();
const chat={workspace_id:workspace,chat_id:chatId,created_at:time,updated_at:time,provider:'claude',title:'Test chat',workspace_name:'Internal',workspace_status:'active'};
const source=(id,content)=>({timestamp:time,type:'claude-assistant',payload:{session_id:claudeThread,uuid:id,message:{role:'assistant',content:[{type:'text',text:content}]}}});
const live=source(randomUUID(),'live output'),missed=source(randomUUID(),'during disconnect');
const packet=(id,type,payload)=>`id: ${id}\r\ndata: ${JSON.stringify({id,type,payload,ts:time})}\r\n\r\n`;
async function until(predicate){
  const timeout=Date.now()+12000;
  while(!await predicate()){if(Date.now()>timeout)throw Error('timed out waiting for capture');await delay(30);}
}
test('Replicas streams share the history identity, resume after storage, repair gaps, and require the exact authorized scope',async t=>{
  const database=await applicationDatabaseFixture(t),records=[],requests=[],streams=[];
  let failFirst=true,reportedOrg=org,codexOpeningReads=0;
  const encoder=new TextEncoder();
  const request=async(input,opts)=>{
    const u=new URL(input),h=new Headers(opts.headers);
    requests.push({path:u.pathname,org:h.get('replicas-org-id')});
    assert.equal(u.origin,'https://api.replicas.dev');assert.equal(opts.redirect,'error');
    if(u.pathname.endsWith('/whoami'))return Response.json({caller:'organization_api_key',organization:{id:reportedOrg,name:'Internal'}});
    if(u.pathname.endsWith('/conversations'))return Response.json({conversations:[chat],next_cursor:null,total:1});
    assert.equal(h.get('replicas-org-id'),org);
    if(u.pathname==='/v1/replica')return Response.json({page:1,total_pages:1,replicas:[{id:workspace,status:'active'}]});
    if(u.pathname.endsWith('/history')){
      if(u.searchParams.get('chat_id')===codexChat){
        assert.equal(u.searchParams.get('limit'),'1');
        codexOpeningReads++;
        return Response.json({coding_agent:'codex',thread_id:codexThread,events:[],before_cursor:null});
      }
      return Response.json({events:[live,missed],before_cursor:null});
    }
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
  const agent={tenantId:owner.tenantId,userId:'workspace-agent',owner:{kind:'shared',provider:'replicas',organizationId:org,workspaceId:workspace,environmentId:randomUUID()}};
  const own=async(harness,sessionId)=>(await service.currentCapture(agent,{harness,sessionId}))?.sessionId;
  assert.equal(await own('claude-code',claudeThread),'replicas-chat:'+chatId);
  const codexEvent=(message)=>({type:'event_msg',timestamp:time,payload:{type:'user_message',message}});
  streams[2].send(packet('new:11','chat.turn.started',{chatId:codexChat,event:codexEvent('first')}));
  await until(async()=>await own('codex',codexThread)==='replicas-chat:'+codexChat);
  streams[2].send(packet('new:12','chat.turn.started',{chatId:codexChat,event:codexEvent('second')}));
  await until(async()=>(await database.pool.query('SELECT cursor FROM opencrawl_replicas_live_workspaces WHERE namespace=$1',[database.namespace])).rows[0].cursor==='new:12');
  assert.equal(codexOpeningReads,1,'one bounded metadata read per identified chat');
  const current=await service.status(owner);
  await service.action(owner,{action:'stop',id:current.id});
  const count=records.length;
  streams[2].send(packet('new:13','chat.turn.delta',{chatId,event:source(randomUUID(),'after revoke')}));
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

test('retained history storage cannot hold a new live message behind its thread mapping',async t=>{
  const database=await applicationDatabaseFixture(t);
  const historyEntered=Promise.withResolvers(),releaseHistory=Promise.withResolvers(),liveEntered=Promise.withResolvers();
  const connected=Promise.withResolvers(),historyFinished=Promise.withResolvers();
  const request=async(input,options)=>{
    const url=new URL(input);
    if(url.pathname.endsWith('/whoami'))return Response.json({caller:'organization_api_key',organization:{id:org,name:'Internal'}});
    if(url.pathname.endsWith('/conversations'))return Response.json({conversations:[chat],next_cursor:null,total:1});
    if(url.pathname==='/v1/replica')return Response.json({page:1,total_pages:1,replicas:[{id:workspace,status:'active'}]});
    if(url.pathname.endsWith('/history'))return Response.json({coding_agent:'claude',thread_id:claudeThread,events:[missed],before_cursor:null});
    assert.equal(url.pathname,'/v1/replica/'+workspace+'/events');
    const stream=new ReadableStream({start(controller){
      connected.resolve((id,type,payload)=>controller.enqueue(new TextEncoder().encode(packet(id,type,payload))));
      options.signal.addEventListener('abort',()=>controller.close(),{once:true});
    }});
    return new Response(stream,{headers:{'content-type':'text/event-stream'}});
  };
  const service=createReplicasImport({database,key:randomBytes(32),request,schedule:async()=>{},ingest:async(p,b)=>{
    assert.equal(p.tenantId,owner.tenantId);
    if(b.captureMode==='history'){
      assert.equal(b.events[0].id,replicasEvents(chat,{events:[missed]})[1].id);
      historyEntered.resolve();await releaseHistory.promise;historyFinished.resolve();
    }else{
      assert.equal(b.events[0].id,replicasEvents(chat,{events:[live]})[1].id);
      liveEntered.resolve();
    }
  }});
  await service.action(owner,{action:'connect',apiKey:'fixture-org-key'});
  const stop=new AbortController(),running=service.runLiveCapture({tenantId:owner.tenantId,organizationId:org},stop.signal);
  try{
    const send=await connected.promise;
    send('engine:1','engine.stream.opened',{resumed:false});
    await historyEntered.promise;
    send('engine:2','chat.turn.delta',{chatId,event:live});
    await Promise.race([liveEntered.promise,delay(1200).then(()=>{throw Error('live capture blocked behind retained history storage')})]);
    await until(async()=>(await database.pool.query('SELECT cursor FROM opencrawl_replicas_live_workspaces WHERE namespace=$1',[database.namespace])).rows[0]?.cursor==='engine:2');
    releaseHistory.resolve();await historyFinished.promise;
    await until(async()=>(await database.pool.query('SELECT gap_since FROM opencrawl_replicas_live_workspaces WHERE namespace=$1',[database.namespace])).rows[0]?.gap_since===null);
  }finally{releaseHistory.resolve();stop.abort();await running;}
});

test('a native message flushes preceding ancillary frames without waiting for a separate durable write',async()=>{
  const {replicasLiveApi}=await import('../dist/src/integrations/replicas-live-api.mjs');
  for(const type of ['claude-system','codex-item-partial']){
    const first=Promise.withResolvers(),release=Promise.withResolvers();
    let controller;
    const body=new ReadableStream({start(c){controller=c;}});
    const stop=new AbortController();
    const api=replicasLiveApi('fixture',org,stop.signal,async()=>new Response(body,{headers:{'content-type':'text/event-stream'}}));
    const writes=[];
    const running=api.stream(workspace,null,stop.signal,async frames=>{
      const ids=frames.map(f=>f.cursor);writes.push(ids);first.resolve(ids);await release.promise;
    });
    const send=(id,eventType,payload)=>controller.enqueue(new TextEncoder().encode(packet(id,eventType,payload)));
    try{
      send('e:1','chat.turn.delta',{chatId,event:{type}});
      await delay(40);
      send('e:2','chat.updated',{chat:{id:chatId}});
      const message=type==='claude-system'?{type:'claude-user',payload:{message:{role:'user',content:'first prompt'}}}
        :{type:'codex-item',payload:{item:{type:'userMessage',content:[{type:'text',text:'first prompt'}]}}};
      send('e:3','chat.turn.delta',{chatId,event:message});
      assert.deepEqual(await Promise.race([first.promise,delay(400,[],{ref:false})]),['e:1','e:2','e:3']);
    }finally{release.resolve();controller.close();await running;}
    assert.equal(writes.length,1);
  }
});

test('ancillary-only reads flush at the deadline, at the buffer limit and at EOF',async()=>{
  const {replicasLiveApi}=await import('../dist/src/integrations/replicas-live-api.mjs');
  for(const end of ['deadline','limit','EOF']){
    let controller;
    const source=new ReadableStream({start(c){controller=c;}});
    const receive=Promise.withResolvers(),writes=[];
    const api=replicasLiveApi('fixture',org,new AbortController().signal,async()=>new Response(source,{headers:{'content-type':'text/event-stream'}}));
    const run=api.stream(workspace,null,new AbortController().signal,async frames=>{writes.push(frames.map(f=>f.cursor));receive.resolve();});
    const count=end==='limit'?64:1;
    for(let i=0;i<count;i++)controller.enqueue(new TextEncoder().encode(packet('e:'+i,'chat.turn.delta',{chatId,event:{type:'claude-system'}})));
    if(end==='EOF')controller.close();
    try{
      await Promise.race([receive.promise,delay(end==='deadline'?1800:350,undefined,{ref:false}).then(()=>{throw Error('ancillary frames did not flush at '+end)})]);
      assert.deepEqual(writes,[Array.from({length:count},(_,i)=>'e:'+i)]);
    }finally{if(end!=='EOF')controller.close();await run;}
  }
});
