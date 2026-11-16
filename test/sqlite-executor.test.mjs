import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {createRealm} from '../dist/src/search/realm.mjs';
import {createSqliteExecutor,sqliteExecutor} from '../dist/src/search/sqlite-executor.mjs';
const principal={tenantId:'org_sqlite',userId:'user_fixture'};
after(()=>sqliteExecutor().close());
async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'opencrawl-sqlite-executor-')),path=join(directory,'search.sqlite'),endpoint=pathToFileURL(path).href.replace('file:','sqlite:');
 const realm={endpoint,tenantId:principal.tenantId},pool=createSqliteExecutor(options);
 t.after(async()=>{await pool.close();await rm(directory,{recursive:true,force:true});});
 await pool.run({realm,operation:'ensureIndex',args:[]});
 return {path,endpoint,realm,pool};
}
const write=realm=>({realm,corpus:'session',operation:'bulk',args:[principal,[{id:'one',document:{...principal,text:'durable result'}}]]});
function gone(pid){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
async function until(predicate){const end=performance.now()+2000;while(!predicate()){if(performance.now()>end)assert.fail('Worker did not retire');await delay(10);}}

test('public SQLite search does not block the event loop and actually terminates a native locked read at its deadline',async t=>{
 const f=await fixture(t),realm=createRealm({endpoint:f.endpoint,tenantId:principal.tenantId});await realm.ensureIndex();
 const before=sqliteExecutor().inspect().pids,db=new DatabaseSync(f.path);let ticks=0;
 db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');const heartbeat=setInterval(()=>ticks++,10),started=performance.now();
 try{
  await assert.rejects(realm.collection('session').search(principal,{timeout:'200ms'}),{code:'SQLITE_DEADLINE'});
  assert.ok(performance.now()-started<1500);assert.ok(ticks>=5,'API timers must progress during the native lock');for(const pid of before)gone(pid);
 }finally{clearInterval(heartbeat);db.exec('ROLLBACK');db.close();}
 assert.equal((await realm.collection('session').search(principal,{})).hits.total.value,0);
});

test('a timed-out dispatched SQLite write stays uncertain and its child is reaped before the slot is reusable',async t=>{
 const f=await fixture(t,{maxWorkers:1}),db=new DatabaseSync(f.path);db.exec('BEGIN IMMEDIATE');const pid=f.pool.inspect().pids[0];
 try{await assert.rejects(f.pool.run(write(f.realm),150),error=>error.code==='SQLITE_DEADLINE'&&error.writeOutcome===undefined);gone(pid);assert.equal(f.pool.inspect().workers,0);}
 finally{db.exec('ROLLBACK');db.close();}
 assert.equal((await f.pool.run({realm:f.realm,corpus:'session',operation:'mget',args:[principal,['one']]})).docs[0].found,false);
});

test('bounded SQLite admission rejects saturation and expires queued writes as unapplied',async t=>{
 const f=await fixture(t,{maxWorkers:1,maxQueue:1}),db=new DatabaseSync(f.path);db.exec('BEGIN IMMEDIATE');
 try{
  const active=assert.rejects(f.pool.run(write(f.realm),350),error=>error.code==='SQLITE_DEADLINE'&&error.writeOutcome===undefined);
  const queued=assert.rejects(f.pool.run(write(f.realm),70),{code:'SQLITE_DEADLINE',writeOutcome:'not-applied'});
  assert.deepEqual({...f.pool.inspect(),pids:[]},{workers:1,busy:1,queued:1,pids:[]});
  await assert.rejects(f.pool.run(write(f.realm)),{code:'SQLITE_QUEUE_FULL',writeOutcome:'not-applied'});
  await queued;assert.equal(f.pool.inspect().queued,0);await active;
 }finally{db.exec('ROLLBACK');db.close();}
});

test('process death after a committed SQLite write never invents rollback evidence or inherits credentials',async t=>{
 const f=await fixture(t,{workerUrl:new URL('./fixtures/sqlite-worker-lost-reply.mjs',import.meta.url),maxWorkers:1});
 const environment=await f.pool.run({realm:f.realm,operation:'ensureIndex',args:[]});assert.deepEqual(environment.flags,[]);assert.ok(environment.environment.every(key=>key==='__CF_USER_TEXT_ENCODING'),'Only OS-injected locale metadata is allowed');
 await assert.rejects(f.pool.run(write(f.realm),200),error=>error.code==='SQLITE_DEADLINE'&&error.writeOutcome===undefined);
 const read=await createRealm({endpoint:f.endpoint,tenantId:principal.tenantId}).collection('session').mget(principal,['one']);assert.equal(read.docs[0]._source.text,'durable result');
});

test('SQLite child lifetime and shutdown are bounded and scope violations never dispatch',async t=>{
 const f=await fixture(t,{maxWorkers:1,maxTasks:1,idleTimeoutMs:30});await until(()=>f.pool.inspect().workers===0);
 await f.pool.run({realm:f.realm,operation:'ensureIndex',args:[]});const pids=f.pool.inspect().pids;await until(()=>f.pool.inspect().workers===0);for(const pid of pids)gone(pid);
 const realm=createRealm({endpoint:f.endpoint,tenantId:principal.tenantId});
 const before=sqliteExecutor().inspect();await assert.rejects(realm.collection('session').bulk({...principal,tenantId:'org_foreign'},[{id:'bad',document:principal}]),{status:403,writeOutcome:'not-applied'});assert.deepEqual(sqliteExecutor().inspect(),before);
 await f.pool.close();await assert.rejects(f.pool.run(write(f.realm)),{code:'SQLITE_EXECUTOR_CLOSED',writeOutcome:'not-applied'});
});

test('SQLite shutdown reaps a busy child and rejects queued writes without erasing uncertainty',async t=>{
 const f=await fixture(t,{maxWorkers:1,maxQueue:2}),db=new DatabaseSync(f.path);db.exec('BEGIN IMMEDIATE');
 try{
  const active=assert.rejects(f.pool.run(write(f.realm)),error=>error.code==='SQLITE_WORKER_LOST'&&error.writeOutcome===undefined);
  const queued=assert.rejects(f.pool.run(write(f.realm)),{code:'SQLITE_EXECUTOR_CLOSED',writeOutcome:'not-applied'});
  const pids=f.pool.inspect().pids;await f.pool.close();await Promise.all([active,queued]);for(const pid of pids)gone(pid);
 }finally{db.exec('ROLLBACK');db.close();}
});


test('a deadline interrupts an executing CPU-bound SQLite statement while API timers keep progressing',async t=>{
 const f=await fixture(t,{maxWorkers:1}),db=new DatabaseSync(f.path);
 db.exec(`CREATE TRIGGER expensive_test BEFORE INSERT ON documents BEGIN
  SELECT sum(n) FROM (WITH RECURSIVE work(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM work WHERE n<1000000000) SELECT n FROM work);
 END`);db.close();let ticks=0;const heartbeat=setInterval(()=>ticks++,10),pid=f.pool.inspect().pids[0],started=performance.now();
 try{await assert.rejects(f.pool.run(write(f.realm),200),error=>error.code==='SQLITE_DEADLINE'&&error.writeOutcome===undefined);assert.ok(ticks>=5);assert.ok(performance.now()-started<1500);gone(pid);}
 finally{clearInterval(heartbeat);}
 const read=new DatabaseSync(f.path);try{assert.equal(read.prepare('SELECT count(*) n FROM documents').get().n,0);}finally{read.close();}
});

test('unused SQLite children retire without retaining resolver handles',async t=>{
 const f=await fixture(t,{idleTimeoutMs:30}),pids=f.pool.inspect().pids;await until(()=>f.pool.inspect().workers===0);for(const pid of pids)gone(pid);
});
