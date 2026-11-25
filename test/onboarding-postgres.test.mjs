import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {sessionScope} from '../dist/src/sessions/ingest.mjs';
import {createOnboardingRepository} from '../dist/src/state/onboarding.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';

const prefix='sessions/test/v1',bucket='test-bucket',skip=!postgresUrl;
const person={tenantId:'org_one',userId:'user_one'}, owner=sessionScope(person);
const observedAt='2026-11-07T23:24:07.773Z',recent='2026-11-24T23:00:00.000Z';
const human={cli:{observedAt},mcp:{observedAt,client:'Codex'},mcpTest:{observedAt},history:{observedAt,state:'received',harness:'codex'},session:{observedAt,harness:'codex'},completed:{observedAt}};
const base=scope=>prefix+'/'+scope+'/onboarding/';
async function fixture(t,organizationId=null){
 const database=await applicationDatabaseFixture(t,{sourceIdentity:{version:1,bucket,prefix,organizationId}});
 const entries=new Map(),calls=[];
 const store={bucket,
   async get(k){calls.push(k);return entries.get(k)??null;},
   async put(k,v){calls.push(k);entries.set(k,v);},
   async listPage(p,{delimiter}){assert.equal(delimiter,'/');const paths=[...entries.keys()].filter(k=>k.startsWith(p)).map(k=>k.slice(p.length).split('/')[0]+'/');return {prefixes:[...new Set(paths)].map(k=>p+k),keys:[],nextToken:null};}
 };
 function seed(scope,snapshot){for(const [kind,value] of Object.entries(snapshot))entries.set(base(scope)+kind+'.json',Buffer.from(JSON.stringify(value)));}
 const open=()=>createOnboardingRepository(database,store,prefix);
 return {database,store,entries,calls,open,seed};
}

test('retained onboarding preserves all six milestones and scoped shared readiness; PostgreSQL traffic avoids the source',{skip},async t=>{
 const f=await fixture(t);
 const installation={tenantId:person.tenantId,userId:'workload_replicas_1',id:'id',name:'Team agent'};
 const other={tenantId:'org_other',userId:person.userId};
 f.seed(owner,human);f.seed(sessionScope(installation),{cli:human.cli,mcpTest:human.mcpTest,session:human.session});
 f.seed(sessionScope(other),{session:{observedAt,harness:'claude'}});
 const control=f.open();assert.equal(await control.status(),'object');
 const status=createOnboardingStatus({repository:control.repository,sharedInstallations:()=>[installation],now:()=>new Date(recent)});
 const previous=await status.read(person);
 assert.deepEqual(await control.migrate(),{phase:'postgres',owners:3,receipts:10});
 assert.deepEqual(await f.open().verify(),{phase:'postgres',owners:3,receipts:10});
 f.calls.length=0;
 assert.deepEqual(await status.read(person),previous);
 assert.equal((await status.read(other)).shared,undefined);
 assert.equal((await status.read(other)).cli,null);
 await assert.rejects(status.read({...person,captureAccess:'write'}),e=>e.status===403);
 await status.cli({...person,captureAccess:'write'});
 await Promise.all([status.mcp(person),status.mcpTest(person),status.session(person,{harness:'cursor',events:[{kind:'message'}]})]);
 assert.deepEqual(await control.repository.write(owner,'completed',{observedAt:recent}),human.completed);
 const updated=await status.read(person);
 assert.equal(updated.cli.observedAt,recent);assert.equal(updated.mcp.client,'Codex');assert.equal(updated.mcpTest.observedAt,recent);
 assert.equal(updated.session.harness,'cursor');assert.deepEqual(updated.completed,human.completed);assert.deepEqual(f.calls,[]);
 // A verified, durable PostgreSQL receipt wins on subsequent migrations.
 assert.deepEqual(await f.open().migrate(),{phase:'postgres',owners:3,receipts:10});
 assert.equal((await status.read(person)).session.harness,'cursor');
 f.entries.delete(base(owner)+'mcp.json');
 await assert.rejects(control.verify(),/differ/);f.seed(owner,{mcp:human.mcp});
 assert.deepEqual(await control.restore(),{phase:'object',owners:3,receipts:10});
 assert.deepEqual(await status.read(person),updated);
});

test('an interrupted import adopts live writers once and rescans without replaying the old value',{skip},async t=>{
 const f=await fixture(t,'org_one'),control=f.open(),status=createOnboardingStatus({repository:control.repository,now:()=>new Date(recent)});
 const other={tenantId:'org_other',userId:person.userId};
 f.seed(owner,human);f.seed(sessionScope(other),human);
 const get=f.store.get.bind(f.store);
 f.store.get=async key=>{if(key.endsWith('history.json'))throw Error('injected read failure');return get(key);};
 await assert.rejects(control.migrate(),/injected/);assert.equal(await control.status(),'importing');
 f.store.get=get;
 await Promise.all([status.mcp(person),status.cli(person),status.session(person,{harness:'cursor',events:[{kind:'message'}]})]);
 const report=await control.migrate();assert.deepEqual(report,{phase:'postgres',owners:1,receipts:6});
 assert.equal((await status.read(person)).session.harness,'cursor');
 await assert.rejects(status.read(other),/outside configured/);
 await assert.rejects(control.repository.read('tenants/../users/abc',['cli']),/Invalid onboarding owner/);
 const put=f.store.put.bind(f.store);f.store.put=async()=>{throw Error('injected restore failure');};
 await assert.rejects(control.restore(),/restore failure/);assert.equal(await control.status(),'postgres');
 f.store.put=put;await control.restore();assert.equal((await status.read(person)).mcp.observedAt,recent);
});

test('activation fences source writes until each reported outcome is known',{skip},async t=>{
 const f=await fixture(t),control=f.open();await control.ready();
 const started=Promise.withResolvers(),finish=Promise.withResolvers(),put=f.store.put.bind(f.store);
 f.store.put=async (...args)=>{started.resolve();await finish.promise;await put(...args);};
 const live=control.repository.write(owner,'cli',{observedAt});await started.promise;
 await assert.rejects(control.migrate(),/in flight/);assert.equal(await control.status(),'object');
 finish.resolve();await live;
 f.store.put=async()=>{throw Error('uncertain');};
 await assert.rejects(control.repository.write(owner,'mcpTest',{observedAt}),/uncertain/);
 await assert.rejects(control.migrate(),/uncertain outcome/);
});
