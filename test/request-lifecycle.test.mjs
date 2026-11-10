import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {Agent, request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createDrainableServer} from '../dist/src/application/request-lifecycle.mjs';

async function childServer(t, drainTimeoutMs) {
  const code = `
    import {writeSync} from 'node:fs';
    import {createDrainableServer} from ${JSON.stringify(new URL('../dist/src/application/request-lifecycle.mjs', import.meta.url).href)};
    let release, written=false;
    const pending=new Promise(resolve=>{release=resolve;});
    process.on('message',message=>{if(message==='release')release();});
    const {server,shutdown}=createDrainableServer(async(req,res)=>{
      res.on('close',()=>process.send({event:'client_closed'}));
      process.send({event:'accepted'});
      await pending;
      written=true;process.send({event:'write_completed'});
      res.end('stored');
    },{drainTimeoutMs:${drainTimeoutMs},analytics:{close:async()=>{
      writeSync(1,JSON.stringify({event:'analytics_closed',written})+'\\n');
    }},log:(event,detail)=>writeSync(1,JSON.stringify({event,...detail})+'\\n')});
    process.on('SIGTERM',()=>{process.send({event:'signal'});void shutdown();});
    server.listen(0,'127.0.0.1',()=>process.send({event:'listening',port:server.address().port}));
  `;
  const child=spawn(process.execPath,['--input-type=module','--eval',code],{stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const messages=[];let stdout='',stderr='',closed=false;
  child.on('message',message=>messages.push(message));
  child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
  const exited=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});}));
  const waitFor=predicate=>new Promise((resolve,reject)=>{
    const existing=messages.find(predicate);if(existing)return resolve(existing);
    const timer=setTimeout(()=>{child.off('message',check);reject(new Error('Child event missing: '+stderr));},3000);
    function check(message){if(predicate(message)){clearTimeout(timer);child.off('message',check);resolve(message);}}
    child.on('message',check);
  });
  const {port}=await waitFor(message=>message.event==='listening');
  const req=request({host:'127.0.0.1',port,path:'/capture',method:'POST'});
  req.on('error',()=>{});req.end('capture');
  await waitFor(message=>message.event==='accepted');
  req.destroy();await waitFor(message=>message.event==='client_closed');
  return {child,messages,waitFor,exited,isClosed:()=>closed,logs:()=>stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}

test('SIGTERM drains application writes after client abort before analytics and clean exit',async t=>{
  const process=await childServer(t,1500);
  process.child.kill('SIGTERM');await process.waitFor(message=>message.event==='signal');
  process.child.kill('SIGTERM');
  await delay(50);
  assert.equal(process.isClosed(),false,'aborted socket must not hide the unfinished write');
  process.child.send('release');
  assert.deepEqual(await process.exited,{code:0,signal:null});
  const logs=process.logs();
  assert.deepEqual(logs[0],{event:'analytics_closed',written:true});
  assert.equal(logs.filter(log=>log.event==='http.shutdown').length,1);
  assert.deepEqual({...logs[1],elapsedMs:0},{event:'http.shutdown',status:'drained',reason:'complete',protocol:1,phase:'analytics',activeHandlers:0,acceptedHandlers:1,completedHandlers:1,rejectedHandlers:0,elapsedMs:0});
  assert.equal(process.messages.filter(message=>message.event==='signal').length,2);
});

test('an unfinished write reaches a distinct failed-drain exit without claiming clean completion',async t=>{
  const process=await childServer(t,100);
  process.child.kill('SIGTERM');
  assert.deepEqual(await process.exited,{code:75,signal:null});
  const logs=process.logs();assert.equal(logs.length,1);
  assert.equal(logs[0].status,'failed');assert.equal(logs[0].reason,'deadline');
  assert.equal(logs[0].phase,'handlers');assert.equal(logs[0].activeHandlers,1);
  assert.equal(logs[0].completedHandlers,0);assert.equal(logs[0].protocol,1);
});

test('analytics failure is nonzero and repeated shutdown calls share one result',async()=>{
  const codes=[],reports=[];
  const {server,shutdown}=createDrainableServer((_req,res)=>res.end(),{
    analytics:{close:async()=>{throw new Error('private database detail');}},
    exit:code=>codes.push(code),log:(_event,report)=>reports.push(report),
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const first=shutdown();assert.equal(shutdown(),first);
  const result=await first;
  assert.deepEqual(codes,[75]);assert.equal(result.reason,'analytics_failed');assert.equal(result.activeHandlers,0);
  assert.equal(reports.length,1);assert.equal(JSON.stringify(reports).includes('private'),false);
});

test('the runtime supplies transport deadlines without changing the drain protocol',()=>{
  const {server}=createDrainableServer((_req,res)=>res.end(),{httpOptions:{keepAliveTimeout:190000,requestTimeout:15000,headersTimeout:10000}});
  assert.equal(server.keepAliveTimeout,190000);assert.equal(server.requestTimeout,15000);assert.equal(server.headersTimeout,10000);
});
