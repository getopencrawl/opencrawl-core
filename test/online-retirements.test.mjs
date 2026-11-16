import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createOnlineRetirements} from '../dist/src/state/online-retirements.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex'),H='a'.repeat(64),J='b'.repeat(64),prefix='sessions/test/v1',bucket='operator-bucket',sourceId='operator-source',namespace='operator-namespace',epoch='00000000-0000-4000-8000-000000000001';
const countId='int_'+'a'.repeat(26),countRecord={environment:'selfhost',tenantId:'org_local',userId:'user_local',integrationId:countId,s3Bucket:bucket,s3Prefix:'raw/v1/source=slack/workspace=T1/connection='+countId};
const keys={pending:prefix+'/index-pending/tenants/'+H+'/users/'+J+'/'+H+'.json',cursor:prefix+'/_index/'+H+'/'+J+'/cursor.json',reconcile:prefix+'/_index/'+H+'/'+J+'/reconcile.json',session:prefix+'/_index/'+H+'/'+J+'/batches/'+H+'.json',temporal:prefix+'/_index/temporal-cutover/'+H+'.json',connector:'derived/indexing/slack-v4/'+H+'/'+J+'.json',snapshot:'derived/indexing/slack-v4/'+H+'/snapshot-'+J+'.json',counts:'_opencrawl/counts/connection='+countId+'.json.gz'};
const options=database=>({database,epoch,sourceId,journalBinding:{namespace:database.namespace,epoch,sourceId},source:{bucket,prefix},registryRecords:[countRecord],tenantIds:['org_local']});
const observed=(repo,key)=>({key,...repo.classify(key)});
const intent=(key,change={})=>({namespace,epoch,sourceId,key,sequence:'1',revision:'1',operationId:randomUUID(),expectedVersion:null,mutation:{kind:'put',bytes:Buffer.from('malformed historical cache is deliberately not parsed'),contentType:'application/json'},state:'applied',dispatched:true,resultVersion:'unique-version',requestHash:H,...change});
const journalRow=i=>({revision:i.revision,sequence:i.sequence,operation_id:i.operationId,kind:i.mutation.kind,state:i.state,result_version:i.resultVersion,payload_hash:i.mutation.kind==='put'?sha(i.mutation.bytes):null,source_bytes:i.mutation.kind==='put'?i.mutation.bytes.length:null,content_type:i.mutation.kind==='put'?i.mutation.contentType:null,request_hash:i.requestHash});
function fake(){
 const saved=new Map(),journal=new Map(),queries=[],database={namespace,pool:{query:()=>assert.fail('pool escape')},transaction:()=>assert.fail('nested transaction'),ready:()=>assert.fail('runtime admission')};
 const repo=createOnlineRetirements(options(database));let policyHash=repo.binding.policyHash,closed='0',allocated='0',isolation='repeatable read',readonly='on',corrupt=false;
 const client={query:async(sql,args=[])=>{queries.push({sql,args});
  if(sql.includes('current_setting'))return {rows:[{isolation,read_only:readonly}]};
  if(sql.startsWith('SELECT policy_hash'))return {rows:[{policy_hash:policyHash}]};
  if(sql.startsWith('SELECT s.sequence'))return {rows:[{closed,allocated}]};
  if(sql.includes('FROM opencrawl_online_migration_journal')){const rows=(journal.get(args[3])??[]).filter(row=>args.length===5?row.operation_id===args[4]:['pending','applied'].includes(row.state)).sort((a,b)=>BigInt(a.revision)>BigInt(b.revision)?-1:1);return {rows:rows.slice(0,1)};}
  if(sql.startsWith('INSERT INTO opencrawl_online_retirements')){const [,,,source_key,domain,scope_hash,disposition,revision,source_sequence,operation_id,deleted,source_version,source_hash,source_bytes,content_type,request_hash]=args;saved.set(source_key,{source_key,domain,scope_hash,disposition,revision,source_sequence,operation_id,deleted,source_version,source_hash,source_bytes,content_type,request_hash});return {rows:[],rowCount:1};}
  if(sql.startsWith('SELECT source_key FROM opencrawl_online_retirements'))return {rows:[...saved.keys()].filter(key=>Buffer.compare(Buffer.from(key),Buffer.from(args[3]))>0).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).slice(0,args[4]).map(source_key=>({source_key}))};
  if(sql.includes('FROM opencrawl_online_retirements')){const row=saved.get(args[3]);return {rows:row?[corrupt?{...row,disposition:'completed'}:{...row}]:[]};}
  assert.fail('Unexpected SQL '+sql);
 }};
 return {repo,client,saved,journal,queries,setFrontier:(c,a=c)=>{closed=c;allocated=a;},setReadonly:value=>{readonly=value;},setPolicy:value=>{policyHash=value;},setCorrupt:()=>{corrupt=true;}};
}
test('online retirement owns only exact approved derived paths and uniquely enrolled count scope',()=>{
 const f=fake();for(const key of Object.values(keys))assert.ok(f.repo.classify(key));
 assert.equal(f.repo.classify(prefix+'/board/tenants/'+H+'.json'),null);
 assert.throws(()=>f.repo.classify(prefix+'/_index/unknown/'+H+'.json'));
 assert.throws(()=>f.repo.classify('_opencrawl/counts/connection=int_unknown.json.gz'));
 for(const change of [{registryRecords:[]},{registryRecords:[countRecord,countRecord]},{tenantIds:['org_other']},{registryRecords:[{...countRecord,s3Bucket:'another'}]},{registryRecords:[{...countRecord,s3Prefix:'bad/../scope'}]}]){
  const repo=createOnlineRetirements({...options({namespace}),...change});assert.throws(()=>repo.classify(keys.counts));
 }
 const changed=createOnlineRetirements({...options({namespace}),registryRecords:[{...countRecord,userId:'user_changed'}]});assert.notEqual(changed.binding.policyHash,f.repo.binding.policyHash);assert.notEqual(changed.classify(keys.counts).scopeHash,f.repo.classify(keys.counts).scopeHash);
});
test('baseline records listed keys only; malformed cache contents and old completion are never runtime authority',async()=>{
 const f=fake();for(const key of Object.values(keys)){await f.repo.backfillIn(f.client,observed(f.repo,key));assert.equal(await f.repo.inspectIn(f.client,observed(f.repo,key)),true);}
 const marker=await f.repo.readIn(f.client,observed(f.repo,keys.temporal));assert.equal(marker.disposition,'full-current-session-catchup');assert.equal(marker.sourceHash,null);assert.equal(marker.sourceVersion,null);assert.equal(marker.sourceBytes,null);
 const count=await f.repo.readIn(f.client,observed(f.repo,keys.counts));assert.equal(count.disposition,'unavailable-until-count-rebuild');assert.equal(Object.hasOwn(count,'records'),false);
 assert.ok(f.queries.every(({sql})=>!/(opencrawl_application_(?:installations|migrations)|opencrawl_count_|opencrawl_indexing_receipts|BEGIN|COMMIT)/.test(sql)));
});
test('replay retains exact metadata and tombstones without storing bodies or suppressing fresh catch-up',async()=>{
 const f=fake(),key=keys.connector,i=intent(key);f.journal.set(key,[journalRow(i)]);await f.repo.applyIn(f.client,i,f.repo.classify(key));await f.repo.applyIn(f.client,i,f.repo.classify(key));
 const value=await f.repo.readIn(f.client,observed(f.repo,key));assert.equal(value.sourceHash,sha(i.mutation.bytes));assert.equal(Object.hasOwn(value,'payload'),false);assert.equal(await f.repo.inspectIn(f.client,observed(f.repo,key)),true);
 const del=intent(key,{sequence:'2',revision:'2',mutation:{kind:'delete'}});f.journal.get(key).push(journalRow(del));await f.repo.applyIn(f.client,del,f.repo.classify(key));
 const gone=await f.repo.readIn(f.client,observed(f.repo,key));assert.equal(gone.deleted,true);assert.equal(gone.disposition,'full-current-connector-catchup');assert.deepEqual(await f.repo.keysPageIn(f.client,{after:'',limit:64}),[key]);assert.equal(gone.sourceHash,null);
 assert.ok(f.queries.filter(({sql})=>sql.startsWith('INSERT')).every(({args})=>args.every(value=>!Buffer.isBuffer(value))));
});
test('unknown source scope, forged journal evidence, stale/reused revision and policy drift fail closed',async()=>{
 for(const change of [{namespace:'other'},{epoch:randomUUID()},{sourceId:'other'},{state:'pending'},{sequence:'0'},{revision:'0'},{resultVersion:null},{requestHash:'invalid'},{mutation:{kind:'put',bytes:Buffer.alloc(32769),contentType:'application/json'}}]){const f=fake(),i=intent(keys.session,change);await assert.rejects(f.repo.applyIn(f.client,i,f.repo.classify(i.key)));assert.equal(f.saved.size,0);}
 const f=fake(),i=intent(keys.session);f.journal.set(i.key,[journalRow(i)]);await assert.rejects(f.repo.applyIn(f.client,{...i,mutation:{...i.mutation,bytes:Buffer.from('forged')}},f.repo.classify(i.key)),/durable journal/);
 await f.repo.applyIn(f.client,i,f.repo.classify(i.key));const next=intent(i.key,{sequence:'2',revision:'2'});f.journal.get(i.key).push(journalRow(next));await f.repo.applyIn(f.client,next,f.repo.classify(i.key));await assert.rejects(f.repo.applyIn(f.client,i,f.repo.classify(i.key)),/stale/);
 const reused=intent(i.key,{sequence:'3',revision:'2'});f.journal.get(i.key).push(journalRow(reused));await assert.rejects(f.repo.applyIn(f.client,reused,f.repo.classify(i.key)),/reused/);
 f.setPolicy(J);await assert.rejects(f.repo.keysPageIn(f.client,{after:'',limit:1}),/policy/);
});
test('baseline cannot hide accepted mutation history; pending newer intent is not successful parity',async()=>{
 const f=fake(),i=intent(keys.pending);f.journal.set(i.key,[journalRow(i)]);await assert.rejects(f.repo.backfillIn(f.client,observed(f.repo,i.key)),/history/);
 await f.repo.applyIn(f.client,i,f.repo.classify(i.key));f.journal.get(i.key).push(journalRow(intent(i.key,{revision:'2',sequence:'2',state:'pending'})));assert.equal(await f.repo.inspectIn(f.client,observed(f.repo,i.key)),false);
 const clean=fake();clean.journal.set(keys.cursor,[journalRow(intent(keys.cursor,{state:'notApplied'}))]);await clean.repo.backfillIn(clean.client,observed(clean.repo,keys.cursor));assert.equal(await clean.repo.inspectIn(clean.client,observed(clean.repo,keys.cursor)),true);
});
test('independent readback refuses corrupted SQL and supplied classification',async()=>{
 const f=fake();await assert.rejects(f.repo.backfillIn(f.client,{key:keys.session,domain:'temporal-cutover',scopeHash:H}));f.setCorrupt();await assert.rejects(f.repo.backfillIn(f.client,observed(f.repo,keys.session)),/disposition/);
});
test('handoff page binds actual closed frontier and explicit non-completion, never MAX allocated sequence',async()=>{
 const f=fake();await f.repo.backfillIn(f.client,observed(f.repo,keys.counts));f.setFrontier('0','4');
 await assert.rejects(f.repo.requirementsPageIn(f.client,{through:'4'}),/not currently closed/);
 const page=await f.repo.requirementsPageIn(f.client,{through:'0',limit:1});assert.equal(page.pending,true);assert.equal(page.applicationReady,false);assert.equal(page.catchupComplete,false);assert.equal(page.keyCoverageComplete,false);assert.equal(page.records[0].disposition,'unavailable-until-count-rebuild');assert.equal(page.next,keys.counts);
 assert.notEqual((await f.repo.requirementsPageIn(f.client,{through:'0',after:keys.counts})).receiptIdentity,page.receiptIdentity);
 f.setReadonly('off');await assert.rejects(f.repo.requirementsPageIn(f.client,{through:'0'}),/read-only repeatable/);
 for(const limit of [0,65,1.5])await assert.rejects(f.repo.keysPageIn(f.client,{after:'',limit}));
});
test('caller changes during SQL acquisition cannot redirect replay metadata',async()=>{
 const f=fake(),i=intent(keys.session),original=journalRow(i);f.journal.set(i.key,[original]);const gate=Promise.withResolvers(),old=f.client.query;let first=true;
 f.client.query=async(...args)=>{if(first){first=false;await gate.promise;}return old(...args);};
 const promise=f.repo.applyIn(f.client,i,f.repo.classify(i.key));i.key=keys.connector;i.revision='900';i.mutation.bytes.fill(0);gate.resolve();await promise;
 assert.equal(f.saved.get(keys.session).source_hash,original.payload_hash);assert.equal(f.saved.has(keys.connector),false);
});
const live=(name,run)=>test(name,{skip:!postgresUrl},run);
live('actual PG listed-only retirement and journal replay share transaction and retain tombstone requirements',async t=>{
 const database=await applicationDatabaseFixture(t),ep=randomUUID(),journal=createOnlineJournal({database,epoch:ep,sourceId}),repo=createOnlineRetirements({...options(database),epoch:ep,journalBinding:journal.binding});await journal.ready();await repo.ready();
 await journal.backfillIfUnchanged({key:keys.temporal,apply:client=>repo.backfillIn(client,observed(repo,keys.temporal))});
 let external={version:null,operationId:null,revision:null,deleted:true,bytes:null,contentType:null};const store={read:async()=>external,putIfVersion:async(key,version,m)=>{assert.equal(version,external.version);external={version:'etag-'+m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:Buffer.from(m.bytes),contentType:m.contentType};return true;},deleteIfVersion:async(key,version,m)=>{assert.equal(version,external.version);external={version:'etag-'+m.operationId,operationId:m.operationId,revision:m.revision,deleted:true,bytes:null,contentType:null};return true;}};
 await journal.mutate({operationId:randomUUID(),key:keys.connector,mutation:{kind:'put',bytes:Buffer.from('invalid historical JSON deliberately not parsed'),contentType:'application/json'}},store);
 const apply=(client,i)=>repo.applyIn(client,i,repo.classify(i.key));
 await assert.rejects(journal.replayPage({consumer:'retirements',apply:async(client,i)=>{await apply(client,i);throw Error('abort checkpoint');}}),/abort checkpoint/);
 assert.equal(await database.transaction(client=>repo.readIn(client,observed(repo,keys.connector))),null);assert.equal(await journal.replayCheckpoint('retirements'),null);
 await journal.replayPage({consumer:'retirements',apply});await journal.mutate({operationId:randomUUID(),key:keys.connector,mutation:{kind:'delete'}},store);await journal.replayPage({consumer:'retirements',apply});
 assert.equal(await database.transaction(client=>repo.inspectIn(client,observed(repo,keys.connector))),true);
 const client=await database.pool.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const page=await repo.requirementsPageIn(client,{through:'2'});assert.equal(page.records.length,2);assert.equal(page.records.find(row=>row.key===keys.connector).deleted,true);assert.equal(page.records.find(row=>row.key===keys.temporal).disposition,'full-current-session-catchup');await client.query('COMMIT');}finally{client.release();}
});
live('actual PG retirement scope and policy changes cannot borrow another epoch evidence',async t=>{
 const database=await applicationDatabaseFixture(t),ep=randomUUID(),journal=createOnlineJournal({database,epoch:ep,sourceId}),base={...options(database),epoch:ep,journalBinding:journal.binding},repo=createOnlineRetirements(base);await journal.ready();await repo.ready();await journal.backfillIfUnchanged({key:keys.counts,apply:client=>repo.backfillIn(client,observed(repo,keys.counts))});
 await assert.rejects(createOnlineRetirements({...base,registryRecords:[{...countRecord,userId:'user_other'}]}).ready(),/policy changed/);
 const foreignEpoch=randomUUID(),foreign=createOnlineRetirements({...base,epoch:foreignEpoch,journalBinding:{...journal.binding,epoch:foreignEpoch}});await foreign.ready();assert.equal(await database.transaction(client=>foreign.inspectIn(client,observed(foreign,keys.counts))),false);
 const row=(await database.pool.query('SELECT source_hash,source_bytes,disposition FROM opencrawl_online_retirements WHERE namespace=$1 AND epoch=$2',[database.namespace,ep])).rows[0];assert.deepEqual(row,{source_hash:null,source_bytes:null,disposition:'unavailable-until-count-rebuild'});
});
