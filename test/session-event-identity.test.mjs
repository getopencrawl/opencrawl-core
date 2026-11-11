import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionIngest,digest,sessionScope,auditSessionEventIdentities,auditSessionEventSource} from '../dist/src/sessions/ingest.mjs';
import {MAX_EVENT_LEDGER_BYTES} from '../dist/src/sessions/event-identity.mjs';
import {createSessionPipeline,batchDocuments} from '../dist/src/sessions/indexer.mjs';
import {createLocalSessionStore} from '../dist/src/sessions/local-store.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const owner={tenantId:'tenant-a',userId:'author'},prefix='sessions/identity-test/v1';
const event=(id='event',data={text:'original'},extra={})=>({id,kind:'message',data,...extra});
const batch=(events=[event()],extra={})=>({schemaVersion:1,owner,harness:'codex',origin:'desktop',installationId:'device',sessionId:'session',events,attachments:[],...extra});
const options=store=>({store,prefix,principal:owner,harness:'codex',installationId:'device',sessionId:'session'});
const sourceKeys=store=>[...store.data.keys()].filter(key=>key.endsWith('.json.gz'));
const ledgerKeys=store=>[...store.data.keys()].filter(key=>key.endsWith('/event-identities-v1.json'));
async function legacy(store,value=batch()) {
 const key=`${prefix}/${sessionScope(value.owner)}/${value.harness}/${digest(value.installationId)}/${digest(value.sessionId)}/${digest(JSON.stringify(value))}.json.gz`;
 await store.put(key,gzipSync(JSON.stringify({...value,receivedAt:'2026-11-01T00:00:00.000Z'})));return key;
}
function pipeline(store) {
 const documents=new Map();let writes=0;
 const search={identity:'fixture',ensureIndex:async()=>{},putDocuments:async items=>{writes++;for(const item of items)documents.set(item.id,item.document);}};
 return {documents,get writes(){return writes;},worker:createSessionPipeline({...options(store),search})};
}

test('reusing an event ID cannot publish a shorter revision or leave mixed search chunks',async()=>{
 const store=memorySessionStore(),ingest=createSessionIngest({store,prefix}),p=pipeline(store);
 await ingest.putBatch(owner,batch([event('event',{text:'x'.repeat(17000)+' original-tail'})]));
 const key=sourceKeys(store)[0];await p.worker.processObject({key});assert.equal(p.documents.size,2);
 await assert.rejects(ingest.putBatch(owner,batch([event('event',{text:'short replacement'})])),{status:409,code:'SESSION_EVENT_ID_CONFLICT'});
 assert.equal(sourceKeys(store).length,1);assert.equal(p.writes,1);
 assert.ok([...p.documents.values()].every(doc=>!doc.text.includes('replacement')));
 // Even a bypassed receiver or corrupt legacy raw object cannot reach search.
 const corrupt=await legacy(store,batch([event('event',{text:'short replacement'})]));
 await assert.rejects(p.worker.processObject({key:corrupt}),{status:409});assert.equal(p.writes,1);
 assert.equal([...store.data.keys()].filter(key=>key.includes('/_index/')).length,1);
});

test('canonical retries preserve every event field and deterministic chunk contents',async()=>{
 const store=memorySessionStore(),ingest=createSessionIngest({store,prefix});
 const original=event('event',{z:'z'.repeat(17000),a:'alpha',list:[{right:2,left:1},true,null]}, {sequence:7,timestamp:'2026-11-01',nativeId:'n',parentId:'p',turnId:'t',extra:{b:2,a:1}});
 await ingest.putBatch(owner,batch([original]));
 const reordered={extra:{a:1,b:2},turnId:'t',parentId:'p',nativeId:'n',timestamp:'2026-11-01',sequence:7,data:{list:[{left:1,right:2},true,null],a:'alpha',z:'z'.repeat(17000)},kind:'message',id:'event'};
 await ingest.putBatch(owner,batch([reordered]));assert.equal(sourceKeys(store).length,2);
 const docs=sourceKeys(store).map(key=>batchDocuments({prefix,key,batch:JSON.parse(gunzipSync(store.data.get(key))),principal:owner}).map(({id,document})=>({id,text:document.text})));
 assert.deepEqual(docs[0],docs[1]);
 for(const [field,value] of Object.entries({kind:'tool_result',sequence:8,timestamp:'later',nativeId:'other',parentId:'other',turnId:'other',extra:{a:2},data:{text:'changed'}})) {
  await assert.rejects(ingest.putBatch(owner,batch([{...original,[field]:value}])),{status:409});
 }
 assert.equal(sourceKeys(store).length,2);
});

test('scope includes tenant, author, harness, installation and session',async()=>{
 const store=memorySessionStore(),ingest=createSessionIngest({store,prefix});
 const variants=[batch(),batch([event('event',{text:'tenant'})],{owner:{...owner,tenantId:'tenant-b'}}),batch([event('event',{text:'author'})],{owner:{...owner,userId:'author-b'}}),batch([event('event',{text:'harness'})],{harness:'claude-code'}),batch([event('event',{text:'installation'})],{installationId:'device-b'}),batch([event('event',{text:'session'})],{sessionId:'session-b'})];
 for(const value of variants)await ingest.putBatch(value.owner,value);
 assert.equal(sourceKeys(store).length,6);assert.equal(ledgerKeys(store).length,6);
 await assert.rejects(auditSessionEventIdentities({...options(store),principal:{...owner,captureAccess:'write'}}),{status:403});
 await assert.rejects(auditSessionEventSource({store,prefix,principal:{...owner,captureAccess:'write'}}),{status:403});
 const report=await auditSessionEventSource({store,prefix,principal:owner});assert.equal(report.sessions,4);assert.equal(report.events,4);
});

test('whole-batch reservations reject conflicting duplicates without reserving other events',async()=>{
 const store=memorySessionStore(),ingest=createSessionIngest({store,prefix});
 await assert.rejects(ingest.putBatch(owner,batch([event(),event('event',{text:'different'}),event('new')])),{status:409});
 assert.equal(store.data.size,0);
 await ingest.putBatch(owner,batch());
 await assert.rejects(ingest.putBatch(owner,batch([event('new'),event('event',{text:'different'})])),{status:409});
 await ingest.putBatch(owner,batch([event('new',{text:'allowed because rejected batch reserved nothing'})]));
 assert.equal(sourceKeys(store).length,2);
});

test('concurrent conflicting requests have one winner; concurrent matching and disjoint retries survive CAS races',async()=>{
 const store=memorySessionStore(),ingest=createSessionIngest({store,prefix});
 const results=await Promise.allSettled([ingest.putBatch(owner,batch()),ingest.putBatch(owner,batch([event('event',{text:'other'})]))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const winner=JSON.parse(gunzipSync(store.data.get(sourceKeys(store)[0]))).events[0];
 const retries=await Promise.all([ingest.putBatch(owner,batch([winner])),ingest.putBatch(owner,batch([winner]))]);assert.deepEqual(retries[0],retries[1]);
 await Promise.all([ingest.putBatch(owner,batch([event('new-a')])),ingest.putBatch(owner,batch([event('new-b')]))]);
 const report=await auditSessionEventIdentities(options(store));assert.equal(report.events,3);assert.equal(report.reservedEvents,3);assert.equal(report.conflicts,0);
});

test('failed publication leaves a reservation, not an accepted event, and retries may only publish matching content',async()=>{
 const store=memorySessionStore(),put=store.put;let fail=true;
 store.put=async(key,data)=>{if(fail&&key.endsWith('.json.gz'))throw new Error('source storage unavailable');return put(key,data);};
 const ingest=createSessionIngest({store,prefix});
 await assert.rejects(ingest.putBatch(owner,batch()),/write outcome is uncertain/);assert.equal(sourceKeys(store).length,0);
 const report=await auditSessionEventIdentities(options(store));assert.equal(report.events,0);assert.equal(report.reservedEvents,1);
 await assert.rejects(ingest.putBatch(owner,batch([event('event',{text:'different'})])),{status:409});
 fail=false;await ingest.putBatch(owner,batch());assert.equal(sourceKeys(store).length,1);
});

test('first capture bootstraps every historical batch, with complete paginated inventory',async()=>{
 const store=memorySessionStore();
 for(let i=0;i<105;i++)await legacy(store,batch([event('old-'+i,{text:'accepted '+i})]));
 const ingest=createSessionIngest({store,prefix});
 await assert.rejects(ingest.putBatch(owner,batch([event('old-104',{text:'changed'})])),{status:409});assert.equal(ledgerKeys(store).length,0);
 await ingest.putBatch(owner,batch([event('new')]));
 const report=await auditSessionEventIdentities(options(store));assert.equal(report.batches,106);assert.equal(report.events,106);assert.equal(report.reservedEvents,106);
});

test('historical conflict audits expose hashes only and prevent choosing a winner or indexing any chunks',async()=>{
 const store=memorySessionStore(),first=await legacy(store,batch([event('sensitive-event-id',{text:'private first'})]));
 await legacy(store,batch([event('sensitive-event-id',{text:'private second'}),event('same-batch',{text:'first'}),event('same-batch',{text:'second'})]));
 const report=await auditSessionEventSource({store,prefix,principal:owner,initialize:true});
 assert.equal(report.conflicts,2);assert.equal(report.sessions,1);assert.equal(report.initialized,0);assert.equal(report.events,2);
 assert.equal(ledgerKeys(store).length,0);assert.doesNotMatch(JSON.stringify(report),/private|sensitive-event-id|same-batch|tenant-a|author/);
 assert.deepEqual(new Set(report.conflictIds.map(item=>item.eventIdentity)),new Set([digest('sensitive-event-id'),digest('same-batch')]));
 await assert.rejects(createSessionIngest({store,prefix}).putBatch(owner,batch([event('fresh')])),{status:409});
 const p=pipeline(store);await assert.rejects(p.worker.processObject({key:first}),{status:409});assert.equal(p.writes,0);
 assert.equal([...store.data.keys()].filter(key=>key.includes('/_index/')).length,0);
});

test('portable migration validates stored owners, initializes idempotently and checks existing receipts through raw inventory',async()=>{
 const store=memorySessionStore(),key=await legacy(store);await store.put(prefix+'/_index/old/receipt.json',JSON.stringify({status:'indexed'}));
 const audit=initialize=>auditSessionEventSource({store,prefix,resolvePrincipal:async({batch})=>batch.owner,initialize});
 assert.equal((await audit(false)).initialized,0);assert.equal(ledgerKeys(store).length,0);
 const report=await audit(true);assert.equal(report.initialized,1);assert.equal(report.conflicts,0);assert.deepEqual(await audit(true),report);
 await assert.rejects(auditSessionEventSource({store,prefix,resolvePrincipal:async()=>({...owner,userId:'forged'})}),{status:409});
 const corrupt={...batch(),owner:{...owner,tenantId:'forged'}};await store.put(key,gzipSync(JSON.stringify(corrupt)));
 await assert.rejects(audit(false),{status:409});
});

test('exhausted identity ledger rejects the entire new batch without raw publication',async()=>{
 const store=memorySessionStore(),ingest=createSessionIngest({store,prefix});await ingest.putBatch(owner,batch());
 const key=ledgerKeys(store)[0],ledger=JSON.parse(store.data.get(key));
 let count=Object.keys(ledger.events).length;
 const emptyBytes=Buffer.byteLength(JSON.stringify({...ledger,events:{}})),maximum=Math.floor((MAX_EVENT_LEDGER_BYTES-emptyBytes+1)/134);
 while(count<maximum){ledger.events[digest('reserved-'+count)]=digest('payload-'+count);count++;}
 const bytes=Buffer.from(JSON.stringify(ledger));assert.ok(bytes.length<=MAX_EVENT_LEDGER_BYTES);await store.put(key,bytes);
 await assert.rejects(ingest.putBatch(owner,batch([event('would-exceed')])),{status:413});
 assert.equal(sourceKeys(store).length,1);assert.deepEqual(store.data.get(key),bytes);
});

test('scope and malformed storage fail closed; unsupported adapters cannot publish',async()=>{
 const store=memorySessionStore();await legacy(store);const listPage=store.listPage;
 store.listPage=async()=>({keys:['elsewhere/private.json.gz'],nextToken:null});
 await assert.rejects(auditSessionEventIdentities(options(store)),{status:409});assert.equal(ledgerKeys(store).length,0);
 store.listPage=listPage;await auditSessionEventIdentities({...options(store),initialize:true});
 const key=ledgerKeys(store)[0],ledger=JSON.parse(store.data.get(key));await store.put(key,JSON.stringify({...ledger,identity:'forged'}));
 await assert.rejects(createSessionIngest({store,prefix}).putBatch(owner,batch()),{status:409});
 await store.put(key,'{"private raw content":"');
 await assert.rejects(auditSessionEventIdentities(options(store)),error=>error.status===409&&!error.message.includes('private raw content'));
 const unsupported={get:async()=>null,put:async()=>assert.fail('must not publish')};
 await assert.rejects(createSessionIngest({store:unsupported,prefix}).putBatch(owner,batch()),{status:503});
});

test('accepted JSON snapshots handle non-JSON direct callers and cannot change across asynchronous I/O',async()=>{
 const store=memorySessionStore(),ingest=createSessionIngest({store,prefix});
 for(const invalid of [undefined,1n,{toJSON:()=>({...batch(),owner:{...owner,userId:'forged'}})}])await assert.rejects(ingest.putBatch(owner,invalid),error=>[400,403].includes(error.status));
 const value=batch(),readVersion=store.readVersion;
 store.readVersion=async(...args)=>{value.events[0].data.text='changed after snapshot';return readVersion(...args);};
 await ingest.putBatch(owner,value);assert.equal(JSON.parse(gunzipSync(store.data.get(sourceKeys(store)[0]))).events[0].data.text,'original');
 await assert.rejects(ingest.putBatch(owner,value),{status:409});
});

test('independent filesystem adapters preserve reservations across restart and concurrent requests',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'session-ledger-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const first=createSessionIngest({store:createLocalSessionStore(directory),prefix}),second=createSessionIngest({store:createLocalSessionStore(directory),prefix});
 const results=await Promise.allSettled([first.putBatch(owner,batch()),second.putBatch(owner,batch([event('event',{text:'other'})]))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const report=await auditSessionEventSource({store:createLocalSessionStore(directory),prefix,principal:owner});assert.equal(report.events,1);assert.equal(report.reservedEvents,1);
});

test('ever-advancing empty inventories are bounded, and deeply nested legacy content fails permanently before search',async()=>{
 const store=memorySessionStore();let pages=0;
 store.listPage=async()=>({keys:[],nextToken:'cursor-'+(++pages)});
 await assert.rejects(auditSessionEventIdentities(options(store)),{status:413});assert.equal(pages,1000);
 pages=0;await assert.rejects(auditSessionEventSource({store,prefix,principal:owner}),{status:413});assert.equal(pages,10000);
 const raw=memorySessionStore();let data='private';for(let i=0;i<1000;i++)data={nested:data};
 const key=await legacy(raw,batch([event('deep',data)])),p=pipeline(raw);
 await assert.rejects(p.worker.processObject({key}),{status:400,permanent:true});assert.equal(p.writes,0);assert.equal(ledgerKeys(raw).length,0);
});
