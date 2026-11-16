import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';

test('worker startup failures drain created workers and close every opened connection',()=>{
  for(const scenario of ['binding','schedule','second-worker']){
    const child=spawnSync(process.execPath,['--experimental-vm-modules',new URL('./fixtures/selfhost-worker-cleanup.mjs',import.meta.url).pathname,scenario],{encoding:'utf8',timeout:5000});
    assert.equal(child.status,0,child.stderr||child.error?.message);
    const result=JSON.parse(child.stdout);
    assert.match(result.error,/migration incomplete|schedule denied|second worker unavailable/);
    assert.equal(result.closed.filter(name=>name==='database').length,1);
    if(scenario==='binding'){assert.deepEqual(result.closed,['database']);assert.equal(result.created,0);}
    else{
      for(const resource of ['identity','services','events','scheduling'])assert.equal(result.closed.filter(name=>name===resource).length,1,resource);
      if(scenario==='schedule')assert.equal(result.created,0,'validate schedules before creating native workers');
      else{assert.deepEqual(result.calls,['schedule','run','shutdown']);assert.ok(result.closed.indexOf('native')<result.closed.indexOf('database'));}
    }
  }
});

test('API startup rejects an unready migration and releases its real PostgreSQL pool',{skip:!postgresUrl},async t=>{
  const database=await applicationDatabaseFixture(t);
  const code=`import {startSelfhost} from ${JSON.stringify(new URL('../dist/src/selfhost/server.mjs',import.meta.url).href)};
    try {await startSelfhost();process.exitCode=2;} catch(error) {if(!/migration is incomplete/.test(error.message))throw error;console.log('rejected');}`;
  const child=spawn(process.execPath,['--input-type=module','--eval',code],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,
    OPENCRAWL_DATABASE_URL:postgresUrl,OPENCRAWL_APP_STATE_NAMESPACE:database.namespace,
    OPENCRAWL_URL:'http://localhost:8092',OPENCRAWL_ORGANIZATION_ID:'org_cleanup',OPENCRAWL_AUTH_SECRET:'disposable-cleanup-secret-at-least-32-chars',OPENCRAWL_SETUP_TOKEN:'disposable-cleanup-setup-at-least-32-chars',
    OPENCRAWL_OPENSEARCH_URL:'http://127.0.0.1:1',OPENCRAWL_LANDING_S3_BUCKET:'cleanup-fixture',OPENCRAWL_LANDING_S3_ACCESS_KEY_ID:'test',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'test'}});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGKILL');await end;}});
  const result=await new Promise((resolve,reject)=>{
    let output='',errors='',exitTimer;
    const startupTimer=setTimeout(()=>reject(new Error('API startup fixture timed out')),30000);
    child.stdout.on('data',chunk=>{
      output+=chunk;
      // Measure cleanup after admission actually rejects, independent of CPU
      // contention while the full suite imports modules and prepares schemas.
      if(output.includes('rejected')&&!exitTimer)exitTimer=setTimeout(()=>reject(new Error('Rejected startup left its database pool alive')),2000);
    });
    child.stderr.on('data',chunk=>{errors+=chunk;});
    child.once('error',error=>{clearTimeout(startupTimer);clearTimeout(exitTimer);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(startupTimer);clearTimeout(exitTimer);resolve({code,signal,output,errors});});
  });
  assert.equal(result.code,0,result.errors);assert.equal(result.signal,null);
  assert.equal(result.output.trim(),'rejected','natural process exit proves no pool was left holding the failed startup open');
});
