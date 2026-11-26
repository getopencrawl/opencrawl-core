import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {ReplicasProviderError} from '../dist/src/integrations/replicas-api.mjs';
import {MockActivityEnvironment,TestWorkflowEnvironment} from '@temporalio/testing';
import {Worker} from '@temporalio/worker';
import {sessionIndexingScheduler} from '../dist/src/sessions/temporal/client.mjs';
import {replicasActivities} from '../dist/src/sessions/temporal/replicas.mjs';
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

async function liveService(t,options){
  const env=await TestWorkflowEnvironment.createLocal(),taskQueue='replicas-live-'+randomUUID();
  const scheduler=sessionIndexingScheduler({address:env.address,namespace:env.namespace??'default',taskQueue,sourceId:'fixture',generation:'v1'});
  let handle;
  const service=createReplicasImport({...options,schedule:async job=>{
    if(job.kind==='live-repair')handle=env.client.workflow.getHandle(await scheduler.scheduleReplicasImport(job));
  }});
  const worker=await Worker.create({connection:env.nativeConnection,namespace:env.namespace??'default',taskQueue,
    workflowsPath:new URL('../dist/src/sessions/temporal/workflows.cjs',import.meta.url).pathname,activities:replicasActivities(service)});
  const run=worker.run();
  t.after(async()=>{worker.shutdown();await run;await scheduler.close();await env.teardown();});
  return {...service,repairHandle:()=>handle};
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
  const service=await liveService(t,{database,key:randomBytes(32),request,
    ingest:async(p,b)=>{
      if(failFirst&&b.captureMode==='live'){failFirst=false;throw Error('transient store failure');}
      assert.equal(p.tenantId,owner.tenantId);records.push(b);
    }});
  await service.action(owner,{action:'connect',apiKey:'fixture-org-key'});
  const baseline=requests.length;
  assert.equal(await service.repairLiveCapture({kind:'live-repair',tenantId:'unbound',organizationId:org,id:randomUUID()},new AbortController().signal),null);
  assert.equal(requests.length,baseline);
  reportedOrg=otherOrg;
  const denied=new AbortController(),rejecting=service.runConnectedLiveCapture(denied.signal);
  await until(()=>requests.length>baseline);denied.abort();await rejecting;
  assert.deepEqual(requests.slice(baseline).map(r=>r.path),['/v1/whoami']);
  reportedOrg=org;
  const stop=new AbortController(),running=service.runConnectedLiveCapture(stop.signal);
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
  await until(async()=>{const handle=service.repairHandle();return handle&&(await handle.describe()).status.name==='COMPLETED';});
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
  const service=await liveService(t,{database,key:randomBytes(32),request,ingest:async(p,b)=>{
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
  const stop=new AbortController(),running=service.runConnectedLiveCapture(stop.signal);
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

test('repair resumes a committed page and fences newer gap and tail intents',async t=>{
  const database=await applicationDatabaseFixture(t),key=randomBytes(32),scope={tenantId:owner.tenantId,organizationId:org};
  const binding=[database.namespace,owner.tenantId,org,workspace];
  let release,entered,failWake=false,discovered=0;
  const requested=[],written=[];
  const request=async(input,options)=>{
    const url=new URL(input);
    if(url.pathname.endsWith('/whoami'))return Response.json({caller:'organization_api_key',organization:{id:org,name:'Fixture'}});
    if(url.pathname==='/v1/replica'){discovered++;return Response.json({page:1,total_pages:1,replicas:[]});}
    if(url.pathname.endsWith('/conversations'))return Response.json({conversations:[chat],total:1,next_cursor:null});
    assert.equal(new Headers(options.headers).get('replicas-org-id'),org);
    assert.equal(url.pathname,'/v1/replica/'+workspace+'/history');
    const before=url.searchParams.get('before_cursor');requested.push(before);
    if(entered){entered.resolve();await release.promise;}
    return Response.json({events:[missed],before_cursor:before?null:'next',has_more:!before});
  };
  const submitted=[];
  const open=()=>createReplicasImport({database,key,request,schedule:async job=>{
    if(job.kind==='live-repair'){
      submitted.push(job);
      if(failWake){failWake=false;throw Error('transient submit failure');}
    }
  },ingest:async(_p,b)=>{written.push(...b.events.map(e=>e.id));}});
  const connect=async service=>{
    submitted.length=0;
    const before=discovered,stop=new AbortController(),running=service.runConnectedLiveCapture(stop.signal);
    await until(()=>discovered>before);
    return async()=>{stop.abort();await running;};
  };
  let service=open();
  const {id}=await service.action(owner,{action:'connect',apiKey:'test-private-key'});
  let close=await connect(service);
  const job={...scope,id,kind:'live-repair'},signal=new AbortController().signal;
  try{
    assert.equal(await service.repairLiveCapture({...job,id:randomUUID()},signal),null);
    assert.equal(await service.repairLiveCapture({...job,tenantId:'other'},signal),null);
    assert.deepEqual(submitted,[],'an idle collector starts no workflow');
    await database.pool.query(`INSERT INTO opencrawl_replicas_live_workspaces(namespace,tenant,organization,workspace,gap_since,gap_generation)
      VALUES($1,$2,$3,$4,now()-interval '1 hour',1)`,binding);
    // Simulate a crash after the SQL commit and before its Temporal wake.
    await close();service=open();failWake=true;close=await connect(service);
    await until(()=>submitted.length>=2);
    await service.repairLiveCapture(job,signal); // select a catalog page
    await service.repairLiveCapture(job,signal); // commit the first history page
    await close();service=open();close=await connect(service);
    await service.repairLiveCapture(job,signal);
    assert.deepEqual(requested,[null,'next']);
    assert.equal(new Set(written).size,2,'occurrences across the checkpoint retain distinct event IDs');
    assert.equal(await service.repairLiveCapture(job,signal),null,'the workflow can finish as soon as the queue drains');
    const position=async()=>(await database.pool.query('SELECT gap_since,gap_generation FROM opencrawl_replicas_live_workspaces WHERE namespace=$1',[database.namespace])).rows[0];
    assert.equal((await position()).gap_since,null);

    await database.pool.query("UPDATE opencrawl_replicas_live_workspaces SET gap_since=now()-interval '1 hour',gap_generation=2 WHERE namespace=$1",[database.namespace]);
    await service.repairLiveCapture(job,signal);
    entered=Promise.withResolvers();release=Promise.withResolvers();
    const oldPage=service.repairLiveCapture(job,signal);
    await entered.promise;
    await database.pool.query('UPDATE opencrawl_replicas_live_workspaces SET gap_generation=3 WHERE namespace=$1',[database.namespace]);
    release.resolve();await oldPage;entered=undefined;
    assert.ok((await position()).gap_since,'a new gap survives an old page completing');
    await database.pool.query('UPDATE opencrawl_replicas_live_workspaces SET gap_since=NULL WHERE namespace=$1',[database.namespace]);

    const insertTail=()=>database.pool.query('INSERT INTO opencrawl_replicas_live_tails(namespace,tenant,organization,workspace,chat) VALUES($1,$2,$3,$4,$5)',[...binding,chatId]);
    await insertTail();
    entered=Promise.withResolvers();release=Promise.withResolvers();
    const priorTail=service.repairLiveCapture(job,signal);
    await entered.promise;
    await database.pool.query('DELETE FROM opencrawl_replicas_live_tails WHERE namespace=$1',[database.namespace]);
    await insertTail(); // new row, same numeric generation and chat
    release.resolve();await priorTail;entered=undefined;
    assert.equal((await database.pool.query('SELECT 1 FROM opencrawl_replicas_live_tails WHERE namespace=$1',[database.namespace])).rowCount,1);
    await service.action(owner,{action:'stop',id});
    assert.equal(await service.repairLiveCapture(job,signal),null);
  }finally{release?.resolve();await close();}
});

test('provider rate limits tell Temporal when the repair may run again',async()=>{
  const activity=new MockActivityEnvironment();
  const job={kind:'live-repair',tenantId:'fixture',organizationId:org,id:randomUUID()};
  for(const operation of ['identity','history']){
    const activities=replicasActivities({repairLiveCapture:async()=>{
      throw new ReplicasProviderError('private provider response',429,operation,undefined,120000);
    }});
    await assert.rejects(activity.run(activities.repairReplicasLivePage,job),error=>{
      assert.equal(error.type,'ReplicasRateLimited');
      assert.equal(error.nextRetryDelay,120000);
      assert.equal(error.message,'Replicas live repair rate limited');
      return true;
    });
  }
});

test('workers discover existing and new API-key bindings, share locks, and capture for each tenant',async t=>{
  // More organizations than database connections must still be able to ingest.
  const database=await applicationDatabaseFixture(t,{max:4}),key=randomBytes(32);
  const accounts=Array.from({length:6},(_,i)=>({tenantId:'customer-'+i,userId:'admin',organizationId:randomUUID(),workspaceId:randomUUID(),key:'fixture-'+i}));
  const streams=new Map(),writes=[],duplicates=[];
  const request=async(input,options)=>{
    const path=new URL(input).pathname,headers=new Headers(options.headers);
    const account=accounts.find(item=>headers.get('authorization')==='Bearer '+item.key);
    assert.ok(account);
    if(path.endsWith('/whoami'))return Response.json({caller:'organization_api_key',organization:{id:account.organizationId,name:'Customer'}});
    if(path.endsWith('/conversations'))return Response.json({conversations:[],total:0,next_cursor:null});
    assert.equal(headers.get('replicas-org-id'),account.organizationId);
    if(path==='/v1/replica')return Response.json({page:1,total_pages:1,replicas:[{id:account.workspaceId,status:'active'}]});
    assert.equal(path,'/v1/replica/'+account.workspaceId+'/events');
    if(streams.has(account.tenantId))duplicates.push(account.tenantId);
    return new Response(new ReadableStream({start(controller){
      streams.set(account.tenantId,controller);
      options.signal.addEventListener('abort',()=>{streams.delete(account.tenantId);controller.close();},{once:true});
    }}),{headers:{'content-type':'text/event-stream'}});
  };
  const peer=createApplicationDatabase({connectionString:postgresUrl,namespace:database.namespace,max:4,connectionTimeoutMillis:1500});
  const service=(db,tenantId)=>createReplicasImport({database:db,key,request,tenantId,schedule:async()=>{},ingest:async(p,b)=>{
    // Hosted storage checks resource access while the binding transaction is open.
    await db.pool.query('SELECT 1');
    writes.push([p.tenantId,b.owner.userId,b.events[0].id]);
  }});
  const first=service(database),second=service(peer),single=service(database,accounts[0].tenantId);
  const connect=account=>first.action(account,{action:'connect',apiKey:account.key});
  for(const account of accounts.slice(0,-1))await connect(account);
  const one=new AbortController(),two=new AbortController(),local=new AbortController();
  const localRun=single.runConnectedLiveCapture(local.signal);
  let firstRun,secondRun;
  try{
    await until(()=>streams.size>0);
    assert.deepEqual([...streams.keys()],[accounts[0].tenantId]);
    local.abort();await localRun;
    firstRun=first.runConnectedLiveCapture(one.signal);
    await until(()=>streams.size===accounts.length-1);
    secondRun=second.runConnectedLiveCapture(two.signal);
    await connect(accounts.at(-1));
    await until(()=>streams.size===accounts.length);
    for(const account of accounts){
      streams.get(account.tenantId).enqueue(new TextEncoder().encode(packet('engine:1','chat.turn.delta',{chatId,event:live})));
    }
    await until(()=>writes.length===accounts.length);
    assert.deepEqual(writes.sort(),accounts.map(account=>[account.tenantId,
      replicasSession(account.tenantId,account.organizationId,account.workspaceId,chatId).owner.userId,
      replicasEvents(chat,{events:[live]})[1].id]).sort());
    const retiring=accounts[0],status=await first.status(retiring);
    await first.action(retiring,{action:'stop',id:status.id});
    await until(()=>!streams.has(retiring.tenantId));
    one.abort();await firstRun;
    await until(()=>streams.size===accounts.length-1);
    assert.deepEqual(duplicates,[]);
    assert.equal(streams.has(retiring.tenantId),false);
  }finally{
    one.abort();two.abort();local.abort();
    await Promise.all([firstRun,secondRun,localRun]);
    await peer.close();
  }
});
