import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer,Agent,request} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

test('the self-host entrypoint outlives proxy idle timeouts without widening request deadlines',{skip:!process.env.OPENCRAWL_TEST_POSTGRES_URL},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-transport-'));
  const storage=createServer((req,res)=>{res.writeHead(req.method==='HEAD'?200:404);res.end();});
  const agent=new Agent({keepAlive:true,maxSockets:1});
  let child;
  t.after(async()=>{
    agent.destroy();
    if(child&&child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGKILL');await end;}
    storage.closeAllConnections();await new Promise(resolve=>storage.close(resolve));
    await rm(dir,{recursive:true,force:true});
  });
  await new Promise(resolve=>storage.listen(0,'127.0.0.1',resolve));
  const code=`
    import {startSelfhost} from ${JSON.stringify(new URL('../dist/src/selfhost/server.mjs',import.meta.url).href)};
    const {server}=await startSelfhost();
    process.send({port:server.address().port,keepAliveTimeout:server.keepAliveTimeout,
      buffer:server.keepAliveTimeoutBuffer,headersTimeout:server.headersTimeout,requestTimeout:server.requestTimeout});
  `;
  child=spawn(process.execPath,['--input-type=module','--eval',code],{
    env:{OPENCRAWL_DATABASE_URL:process.env.OPENCRAWL_TEST_POSTGRES_URL,PATH:process.env.PATH,HOST:'127.0.0.1',PORT:'0',OPENCRAWL_URL:'http://localhost:8092',
      OPENCRAWL_ORGANIZATION_ID:'org_transporttest',OPENCRAWL_AUTH_SECRET:randomBytes(32).toString('hex'),
      OPENCRAWL_SETUP_TOKEN:randomBytes(32).toString('hex'),OPENCRAWL_IDENTITY_PATH:join(dir,'identity.sqlite'),
      OPENCRAWL_REGISTRY_PATH:join(dir,'registry.sqlite'),OPENCRAWL_AIRBYTE_ENABLED:'false',
      OPENCRAWL_OPENSEARCH_URL:'http://127.0.0.1:1',OPENCRAWL_LANDING_S3_BUCKET:'transport-test',
      OPENCRAWL_LANDING_S3_ENDPOINT:'http://127.0.0.1:'+storage.address().port,
      OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test-key',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test-secret'},
    stdio:['ignore','ignore','pipe','ipc'],
  });
  let errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Startup timed out: '+errors)),15000);
    child.once('message',message=>{clearTimeout(timer);resolve(message);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Startup failed '+code+': '+errors));});
  });
  assert.equal(ready.keepAliveTimeout,125000,'upstream exceeds default Caddy 120s');
  assert.equal(ready.buffer,1000);
  assert.equal(ready.headersTimeout,10000);
  assert.equal(ready.requestTimeout,60000);
  const probe=()=>new Promise((resolve,reject)=>{
    let socket;
    const req=request({host:'127.0.0.1',port:ready.port,path:'/health',agent},res=>{
      res.resume();res.once('end',()=>resolve({socket,status:res.statusCode,keepalive:res.headers['keep-alive']}));
    });
    req.once('socket',value=>{socket=value;});req.once('error',reject);req.end();
  });
  const first=await probe();assert.equal(first.status,200);assert.match(first.keepalive,/timeout=125/);
  await delay(6500);
  const second=await probe();assert.equal(second.status,200);
  assert.equal(second.socket,first.socket,'requests after the previous 5s idle timeout reuse a live connection');
  agent.destroy();
  const stopped=once(child,'exit');child.kill('SIGTERM');assert.deepEqual(await stopped,[0,null]);
});
