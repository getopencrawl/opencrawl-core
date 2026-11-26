import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';
import {createControls,controlKey} from '../dist/src/sessions/controls.mjs';
import {sessionScope,digest} from '../dist/src/sessions/event-identity.mjs';
import {createPostgresResourceControls} from '../dist/src/state/postgres-resource-controls.mjs';
import {createResourceControlState} from '../dist/src/state/resource-controls.mjs';

const skip=!postgresUrl,bucket='fixture-visibility',prefix='sessions/test/v1',p={tenantId:'org_a',userId:'one'},other={...p,userId:'two'};
const at='2026-11-07T23:24:07.773Z';
const base={schemaVersion:1,visibility:'private',visibilitySource:'manual',updatedAt:at,deletedAt:null};
const quiet=async()=>{};
async function fixture(t,organizationId=null){
 const database=await applicationDatabaseFixture(t,{sourceIdentity:{version:1,bucket,prefix,organizationId}});
 const raw=memorySessionStore(),store={...raw,bucket,async listPage(path,opts){
   if(!opts.delimiter)return raw.listPage(path,opts);
   assert.equal(opts.requireComplete,true);
   const page=await raw.listPage(path,{}),prefixes=new Set();
   for(const key of page.keys){const first=key.slice(path.length).split('/');if(first.length>1)prefixes.add(path+first[0]+'/');}
   return {keys:[],prefixes:[...prefixes].sort(),nextToken:null};
 }};
 const state=()=>createResourceControlState(database,store,prefix);
 const seed=async(who,kind,harness,name,body)=>{
   const path=controlKey(prefix,who,kind,harness,name),bytes=Buffer.from(JSON.stringify(body,null,2));
   await raw.put(path,bytes);
   const {version}=await raw.readVersion(path);
   return [sessionScope(who),kind,harness,digest(name),version,digest(bytes)];
 };
 return {database,store,raw,state,seed};
}
const manifest=entries=>createHash('sha256').update(entries.sort((a,b)=>Buffer.compare(Buffer.from(a.slice(0,4).join('/')),Buffer.from(b.slice(0,4).join('/')))).map(row=>JSON.stringify(row)+'\n').join('')).digest('hex');
const source=(who,harness,id)=>({tenantHash:digest(who.tenantId),userHash:digest(who.userId),harness,sessionHash:digest(id)});
const failSource=store=>{for(const m of ['readVersion','listPage','compareAndSet','put','get'])store[m]=()=>{throw Error('source fenced');};};
const privateChange=current=>({visibility:'private',visibilitySource:'manual',deletedAt:current?.deletedAt??null});

test('imports both owner/resource families, exact physical version and original bytes; sealed readers need no source',{skip},async t=>{
 const {database,store,raw,seed,state}=await fixture(t,'org_a'),first=state(),ns=database.namespace;
 const deleted={...base,visibility:'team',deletion:{state:'pending',sessionId:'gone'},deletedAt:at};
 const entries=await Promise.all([seed(p,'sessions','codex','same',base),seed(p,'sessions','new-harness','gone',deleted),
   seed(other,'sessions','codex','same',{...base,visibility:'team'}),seed(p,'memories','codex','same',{...base,deletedAt:at})]);
 // AWS physical ETags include the quote marks.
 const oldRead=store.readVersion.bind(store);store.readVersion=async(...args)=>{const row=await oldRead(...args);return {...row,version:row.version===null?null:'"fixture-'+row.version+'"'};};
 for(const row of entries)row[4]='"fixture-'+row[4]+'"';
 const expected={sessions:3,memories:1,sha256:manifest(entries)};
 assert.deepEqual(await first.controls.read(p,'sessions','codex','same'),base);
 await assert.rejects(first.activate(async candidate=>{if(candidate)throw Error('independent census disagrees');}),/census disagrees/);
 assert.equal((await first.status()).backend,'objects');
 assert.equal((await database.pool.query('SELECT count(*)::int n FROM opencrawl_resource_control_records WHERE namespace=$1',[ns])).rows[0].n,0);
 const calls=[];assert.deepEqual(await first.activate(async candidate=>{calls.push(candidate);if(candidate)assert.deepEqual(candidate,expected);}),expected);
 assert.deepEqual(calls,[undefined,expected]);assert.deepEqual(await state().verify(),expected);
 await raw.put(controlKey(prefix,p,'sessions','codex','same'),Buffer.from(JSON.stringify({...base,visibility:'team'})));
 await assert.rejects(first.verify(),/verification differs/);
 failSource(store);
 const next=state(),native=createPostgresResourceControls(database),c=native.controls;
 assert.deepEqual(await next.activate(quiet),expected);await native.ready();
 assert.deepEqual(await c.read(p,'sessions','codex','same'),base);assert.equal((await c.read(other,'sessions','codex','same')).visibility,'team');
 assert.equal((await c.readSource(source(p,'codex','same'))).visibility,'private');
 assert.deepEqual([...await c.list(p,'memories','codex')],[[digest('same'),{...base,deletedAt:at}]]);
 assert.deepEqual(await c.pendingDeletions(p),[{harness:'new-harness',sessionId:'gone'}]);
 await c.update(p,'sessions','new-harness','gone',v=>({...v,deletion:{sessionId:'gone',state:'complete'}}));
 assert.deepEqual(await c.pendingDeletions(p),[]);
 await assert.rejects(c.update(p,'sessions','new-harness','gone',()=>({...base,deletion:undefined})),/cannot be reversed/);
 await assert.rejects(async()=>c.readSource(source({...p,tenantId:'other'},'codex','same')),/scope denied/);
 const wrong=createResourceControlState({...database,sourceIdentity:{...database.sourceIdentity,organizationId:null}},store,prefix);
 await assert.rejects(wrong.controls.read(p,'sessions','codex','same'),/binding differs/);
 // A restored DB which no longer holds the bound seal cannot expose missing controls as public.
 await database.pool.query("UPDATE opencrawl_resource_control_authority SET receipt=NULL,activated_at=NULL WHERE namespace=$1",[ns]);
 await assert.rejects(c.read(p,'sessions','codex','missing'),/authority is unavailable/);
 await assert.rejects(c.list(p,'memories','codex'),/authority is unavailable/);
 await assert.rejects(c.update(p,'sessions','codex','new',privateChange),/authority is unavailable/);
});

test('a new owner and a second privacy change during discovery join the same verified seal',{skip},async t=>{
 const {store,state,seed}=await fixture(t);await seed(p,'sessions','codex','a',base);
 const api=state(),worker=state();await Promise.all([api.ready(),worker.ready()]);
 const path=controlKey(prefix,p,'sessions','codex','a'),read=store.readVersion.bind(store);
 const captured=Promise.withResolvers(),resume=Promise.withResolvers();let once=true;
 store.readVersion=async(k,opts)=>{const v=await read(k,opts);if(k===path&&once){once=false;captured.resolve();await resume.promise;}return v;};
 const migration=api.activate(quiet);await captured.promise;
 const changed=await worker.controls.update(p,'sessions','codex','a',()=>({visibility:'team',visibilitySource:'manual',deletedAt:null}));
 const fresh=await worker.controls.update({tenantId:'new_org',userId:'new_user'},'memories','codex','first',privateChange);
 resume.resolve();const receipt=await migration;assert.equal(receipt.sessions,1);assert.equal(receipt.memories,1);
 assert.deepEqual(await api.verify(),receipt);failSource(store);
 assert.deepEqual(await worker.controls.read(p,'sessions','codex','a'),changed);
 assert.deepEqual(await api.controls.read({tenantId:'new_org',userId:'new_user'},'memories','codex','first'),fresh);
});

test('old read spanning a handoff rechecks SQL privacy and deletion inventory',{skip},async t=>{
 const {store,state,seed}=await fixture(t);await seed(p,'sessions','codex','old',{...base,visibility:'team'});
 const link=state(),another=state();await Promise.all([link.ready(),another.ready()]);
 const old=store.readVersion.bind(store),started=Promise.withResolvers(),go=Promise.withResolvers();let first=true;
 store.readVersion=async(...args)=>{const value=await old(...args);if(first){first=false;started.resolve();await go.promise;}return value;};
 const pending=link.controls.read(p,'sessions','codex','old');await started.promise;
 await another.activate(quiet);await another.controls.update(p,'sessions','codex','old',privateChange);go.resolve();
 assert.equal((await pending).visibility,'private');
});

test('uncertain object CAS fences seal and exact terminal recovery retains the requested restriction',{skip},async t=>{
 const {database,store,state,seed}=await fixture(t);await seed(p,'sessions','codex','old',{...base,visibility:'team'});
 const service=state(),cas=store.compareAndSet.bind(store);
 store.compareAndSet=async()=>{throw Error('ambiguous');};
 await assert.rejects(service.controls.update(p,'sessions','codex','old',privateChange),/ambiguous/);
 assert.equal((await service.status()).pendingSourceWrites,1);
 await assert.rejects(service.activate(quiet),/in flight or uncertain/);
 const {rows:[row]}=await database.pool.query('SELECT operation FROM opencrawl_resource_control_source_writes WHERE namespace=$1 AND NOT settled',[database.namespace]);
 await assert.rejects(service.reconcile(row.operation,async()=>({})),/evidence required/);
 store.compareAndSet=cas;
 assert.equal(await service.reconcile(row.operation,async()=>({writersDrained:true,requestTerminal:true})),true);
 await service.activate(quiet);assert.equal((await service.controls.read(p,'sessions','codex','old')).visibility,'private');
});

test('bad keys, oversized invalid values and mismatched deletion identities abort before activation',{skip},async t=>{
 const {raw,seed,state}=await fixture(t);
 const good=controlKey(prefix,p,'sessions','codex','a'),bad=good.replace(/[^/]+$/,'unknown.json');
 const control=state();await raw.put(bad,Buffer.from('{}'));await assert.rejects(control.activate(quiet),/Unknown resource control/);
 await raw.delete(bad);await raw.put(good,Buffer.alloc(5000));await assert.rejects(control.activate(quiet),/unreadable or invalid/);
 await seed(p,'sessions','codex','a',{...base,deletedAt:at,deletion:{state:'pending',sessionId:'b'}});
 await assert.rejects(control.activate(quiet),/unreadable or invalid/);
 assert.equal((await control.status()).backend,'objects');
});

test('two concurrent native updates preserve a tombstone and manual visibility in either order',{skip},async t=>{
 const {state}=await fixture(t);const api=state();await api.activate(quiet);
 const c=api.controls,k=[p,'sessions','codex','editing'];
 await Promise.all([c.update(...k,privateChange),c.update(...k,v=>({visibility:v?.visibility??'team',deletedAt:at,deletion:{state:'pending',sessionId:'editing'}}))]);
 const v=await c.read(...k);assert.equal(v.deletedAt,at);assert.equal(v.visibility,'private');assert.equal(v.visibilitySource,'manual');
 assert.equal(v.deletion.state,'pending');
});

test('losing the settlement acknowledgement never replays an earlier public write over a later private choice',{skip},async t=>{
 const {state,database,seed}=await fixture(t);await seed(p,'sessions','codex','change',base);
 const slow=state(),live=state();await Promise.all([slow.ready(),live.ready()]);
 const settled=Promise.withResolvers(),finish=Promise.withResolvers(),query=database.pool.query.bind(database.pool);
 let first=true;
 database.pool.query=async(...args)=>{
   const result=await query(...args);
   if(first && String(args[0]).includes('SET settled=true')){first=false;settled.resolve();await finish.promise;throw Error('lost settlement response');}
   return result;
 };
 const publicAttempt=slow.controls.update(p,'sessions','codex','change',()=>({visibility:'team',visibilitySource:'manual',deletedAt:null}));
 await settled.promise;await live.controls.update(p,'sessions','codex','change',privateChange);
 await live.activate(quiet);finish.resolve();
 await assert.rejects(publicAttempt,/lost settlement response/);
 assert.equal((await live.controls.read(p,'sessions','codex','change')).visibility,'private');
});

test('a memory cutoff must cover the deleted version and preserve privacy of future versions',{skip},async t=>{
 const {state,store,raw,seed,database}=await fixture(t),service=state(),k=[p,'memories','codex','memory.md'];
 const later='2026-11-08T12:00:00.000Z';
 await seed(...k,{...base,deletedAt:at});
 const cas=store.compareAndSet.bind(store);store.compareAndSet=async()=>{throw Error('ambiguous');};
 await assert.rejects(service.controls.update(...k,()=>({...base,deletedAt:later})),/ambiguous/);
 const {rows:[row]}=await database.pool.query('SELECT operation FROM opencrawl_resource_control_source_writes WHERE namespace=$1 AND NOT settled',[database.namespace]);
 store.compareAndSet=cas;
 const key=controlKey(prefix,...k);await raw.put(key,Buffer.from(JSON.stringify({...base,visibility:'team',deletedAt:at})));
 const proof=async()=>({writersDrained:true,requestTerminal:true});
 await assert.rejects(service.reconcile(row.operation,proof),/requires reconciliation/);
 await service.controls.update(...k,()=>({...base,visibility:'team',deletedAt:later}));
 await assert.rejects(service.reconcile(row.operation,proof),/requires reconciliation/);
 await service.controls.update(...k,()=>({...base,deletedAt:later}));
 assert.equal(await service.reconcile(row.operation,proof),true);
 await service.activate(quiet);
 await assert.rejects(service.controls.update(...k,()=>({...base,deletedAt:at})),/cannot be reversed/);
});
