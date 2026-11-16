import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../dist/src/connectors/scope.mjs';
import {createPostgresSlackCapture,normalizeSlackCaptureProjection} from '../dist/src/state/slack-capture.mjs';
import {decodeOnlineSlackCapture} from '../dist/src/state/slack-online-projection.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const binding={tenantId:'org_fixture',connectionId:'int_fixture',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=int_fixture/'};
const scope=digest(binding),bucket='fixture-bucket',record={tenantId:binding.tenantId,integrationId:binding.connectionId,workspace:binding.workspaceId,provider:'slack',s3Prefix:binding.rawPrefix.slice(0,-1),s3Bucket:bucket};
const path=(kind,run)=>binding.rawPrefix+'capture/'+kind+'/'+(run?run+'/state.json':'catalog.json');
const bytes=value=>Buffer.from(JSON.stringify(value));
const decode=(key,value,options={})=>decodeOnlineSlackCapture({key,bytes:bytes(value),bucket,registryRecords:[record],tenantIds:[binding.tenantId],...options});
const message=()=>({version:1,scope,runId:'pending',cutoff:1234,channels:{C1:{id:'C1',cursor:'next-channel',paginationProgress:{version:1,anchor:'old-channel',window:'2',distance:'1'},done:false}},threads:{'C1:1.000001':{channel:'C1',ts:'1.000001',cursor:'next-thread',done:false}},priorChannels:['COLD','C1'],cursor:'next-list',paginationProgress:{version:1,anchor:'old-list',window:'2',distance:'1'},listed:false,nextDue:{'conversations.history':65000},pages:3,emitted:2,errors:[{method:'conversations.history',channel:'CERROR',code:'not_in_channel'}]});
const file=()=>({version:1,scope,runId:'pending',cutoff:1234,channels:{C1:{id:'C1',page:2,done:false}},files:{F1:{id:'F1',channels:['C1','COLD'],comments:{a:'Retained comment',b:'Another comment'},cursor:'next-file',paginationProgress:{version:1,anchor:'old-file',window:'2',distance:'1'},done:false}},priorChannels:['COLD','C1'],cursor:'',listed:true,nextDue:70000,pages:4,emitted:1,errors:[]});
const reference=()=>({version:1,scope,runId:'pending',inputHash:digest('input'),position:1,nextDue:{'conversations.replies':120000},pages:2,emitted:1,errors:[{position:0,method:'conversations.info',code:'channel_not_found'}]});
const values=()=>[[path('messages-v1'),{scope,channels:['COLD','C1']}],[path('files-v1'),{scope,channels:['COLD','C1'],files:{F1:['C1','COLD'],FEMPTY:[]}}],[path('messages-v1','pending'),message()],[path('files-v1','pending'),file()],[path('message-references-v1','pending'),reference()]];
const live=(name,run)=>test(name,{skip:!postgresUrl},run);

test('Slack online decoder retains exact catalogs and all pending checkpoint children',()=>{
 for(const [key,value] of values()){
  const result=decode(key,value);assert.equal(result.kind,'slack');assert.equal(result.domain,'slack-capture');assert.deepEqual(result.binding,binding);assert.deepEqual(result.value,normalizeSlackCaptureProjection(key,value));
  assert.equal(result.identity[0],binding.rawPrefix);assert.equal(result.identity[1],scope);
 }
 const source=file(),result=decode(path('files-v1','pending'),source);source.files.F1.comments.a='caller-mutated';assert.equal(result.value.files.F1.comments.a,'Retained comment');
});

test('Slack online decoder rejects deletion, foreign or ambiguous registry bindings and malformed children',()=>{
 const key=path('messages-v1','pending'),value=message();
 for(const options of [{bytes:null},{registryRecords:[]},{registryRecords:[record,record]},{registryRecords:[{...record,s3Bucket:'other-bucket'}]},{registryRecords:[{...record,tenantId:'org_other'}]},{registryRecords:[{...record,workspace:'T999'}]},{tenantIds:['org_other']},{tenantIds:[binding.tenantId,binding.tenantId]}])assert.throws(()=>decode(key,value,options));
 assert.throws(()=>decode(key,{...value,scope:'f'.repeat(64)}));assert.throws(()=>decode(key,{...value,runId:'another'}));
 assert.throws(()=>decode(key,{...value,channels:{C1:{id:'C2',cursor:'',done:false}}}));
 assert.throws(()=>decode(key,{...value,paginationProgress:{version:1,anchor:'prior',window:'0',distance:'1'}}));
 assert.throws(()=>decode(path('messages-v1'),{scope,channels:['C1','C1']}));
 assert.throws(()=>decode(path('files-v1'),{scope,channels:[],files:{F1:['C1','C1']}}));
 assert.throws(()=>decode(path('message-references-v1'),reference()));
});

test('Slack client-bound export reconstructs file children without pool access or transaction commands',async()=>{
 const value=file(),metadata={...value,hasPriorChannels:true};for(const key of ['channels','files','priorChannels','errors'])delete metadata[key];
 const items=[{kind:'channels',key:'C1',ordinal:0,value:value.channels.C1},{kind:'files',key:'F1',ordinal:0,value:(({channels,comments,...rest})=>rest)(value.files.F1)},...value.priorChannels.map((v,i)=>({kind:'prior-channel',key:String(i),ordinal:i,value:v})),...value.files.F1.channels.map((v,i)=>({kind:'file-channel',key:JSON.stringify(['F1',v]),ordinal:i,value:{file:'F1',channel:v}})),...Object.entries(value.files.F1.comments).map(([id,text])=>({kind:'file-comment',key:JSON.stringify(['F1',id]),ordinal:0,value:{file:'F1',id,text}}))];
 const queries=[],client={query:async sql=>{queries.push(sql);if(sql.includes('opencrawl_slack_scopes'))return {rows:[{scope_hash:scope}]};if(sql.includes('opencrawl_slack_run_items'))return {rows:items};if(sql.includes('opencrawl_slack_runs'))return {rows:[{metadata,revision:'7'}]};assert.fail(sql);}};
 const database={namespace:'fixture',pool:{query:()=>assert.fail('pool escape')},transaction:()=>assert.fail('nested transaction'),ready:()=>assert.fail('runtime/schema admission')};
 const repository=createPostgresSlackCapture(database);assert.deepEqual(await repository.exportLegacyIn(client,path('files-v1','pending'),scope),value);
 assert.ok(queries.every(sql=>sql.startsWith('SELECT')));
 items.find(row=>row.kind==='file-comment').value.file='FMISSING';await assert.rejects(repository.exportLegacyIn(client,path('files-v1','pending'),scope),/child has no file/);
});

test('Slack normalized catalog readback rejects hidden invalid child kinds and metadata',async()=>{
 const rows=[{item_kind:'file',item_key:'F1',ordinal:0,value:null}],client={query:async sql=>sql.includes('opencrawl_slack_catalog_items')?{rows}:sql.includes('opencrawl_slack_catalogs')?{rows:[{}],rowCount:1}:{rows:[{scope_hash:scope}]}};
 const repository=createPostgresSlackCapture({namespace:'fixture'});
 await assert.rejects(repository.exportLegacyIn(client,path('messages-v1'),scope),/Invalid normalized/);
 rows[0]={item_kind:'channel',item_key:'C1',ordinal:0,value:{ignored:'must fail'}};await assert.rejects(repository.exportLegacyIn(client,path('messages-v1'),scope),/Invalid normalized/);
});

async function fixture(t){const database=await applicationDatabaseFixture(t),repository=createPostgresSlackCapture(database);await repository.ready();const inTransaction=createPostgresSlackCapture({...database,pool:{query:()=>assert.fail('projection escaped its replay client')},transaction:()=>assert.fail('projection opened a nested transaction'),ready:()=>assert.fail('projection created runtime admission')});return {database,repository,inTransaction};}
live('Slack typed projection commits all normalized pending children on the supplied transaction and is retry-safe',async t=>{
 const {database,repository,inTransaction}=await fixture(t);
 for(const [key,value] of values())await database.transaction(async client=>{await inTransaction.projectLegacyIn(client,key,value,binding);assert.deepEqual(await inTransaction.readProjectedLegacyIn(client,key,scope),normalizeSlackCaptureProjection(key,value));});
 await database.transaction(client=>inTransaction.projectLegacyIn(client,path('files-v1','pending'),file(),binding));
 assert.equal((await repository.readCheckpoint(binding,'files-v1','pending')).revision,'1');
 const updated={...file(),pages:5,files:{F1:{...file().files.F1,cursor:'after-file',paginationProgress:{version:1,anchor:'old-file',window:'4',distance:'2'},comments:{a:'Retained comment',b:'Another comment',c:'New comment'}}}};
 await database.transaction(client=>inTransaction.projectLegacyIn(client,path('files-v1','pending'),updated,binding));
 assert.deepEqual(await repository.exportLegacy(path('files-v1','pending'),scope),updated);
 const rows=(await database.pool.query('SELECT metadata FROM opencrawl_slack_runs WHERE namespace=$1',[database.namespace])).rows;
 assert.ok(rows.every(({metadata})=>!['channels','threads','files','comments','priorChannels','errors'].some(field=>Object.hasOwn(metadata,field))));
 assert.equal((await database.pool.query("SELECT count(*)::int n FROM opencrawl_slack_run_items WHERE namespace=$1 AND item_kind='file-comment'",[database.namespace])).rows[0].n,3);
});

live('Slack projection rolls back children and pacing with the caller replay transaction',async t=>{
 const {database,repository,inTransaction}=await fixture(t);
 await assert.rejects(database.transaction(async client=>{await inTransaction.projectLegacyIn(client,path('files-v1','pending'),file(),binding);throw Error('lost replay checkpoint');}),/lost replay checkpoint/);
 assert.equal(await repository.exportLegacy(path('files-v1','pending'),scope),null);
 assert.equal((await database.pool.query('SELECT count(*)::int n FROM opencrawl_slack_pacing WHERE namespace=$1',[database.namespace])).rows[0].n,0);
});

live('Slack catalogs accept benign append and refuse lost file/share/channel revocation history',async t=>{
 const {database,repository,inTransaction}=await fixture(t),key=path('files-v1'),first={scope,channels:['C1'],files:{F1:['C1'],FEMPTY:[]}},next={scope,channels:['C1','C2'],files:{F1:['C1','C2'],FEMPTY:[],F2:['C2']}};
 for(const value of [first,next])await database.transaction(client=>inTransaction.projectLegacyIn(client,key,value,binding));
 assert.deepEqual(await repository.exportLegacy(key,scope),next);
 await database.transaction(client=>inTransaction.projectLegacyIn(client,key,{...next,channels:['C2','C1'],files:{...next.files,F1:['C2','C1']}},binding));
 assert.deepEqual(await database.transaction(client=>inTransaction.readProjectedLegacyIn(client,key,scope)),next,'Benign source ordering cannot lose revocation identities');
 for(const value of [{...next,channels:['C2']},{...next,files:{F1:['C1'],FEMPTY:[],F2:['C2']}},{...next,files:{F1:['C1','C2'],F2:['C2']}}])await assert.rejects(database.transaction(client=>inTransaction.projectLegacyIn(client,key,value,binding)),/cannot erase/);
 assert.deepEqual(await repository.exportLegacy(key,scope),next);
});

live('Slack replay retains maximum method pacing across run updates and rejects foreign scope',async t=>{
 const {database,repository,inTransaction}=await fixture(t);
 await repository.defer(binding,'files.info',200000);
 await database.transaction(client=>inTransaction.projectLegacyIn(client,path('files-v1','pending'),file(),binding));
 const lower={...file(),pages:5,nextDue:1};await database.transaction(client=>inTransaction.projectLegacyIn(client,path('files-v1','pending'),lower,binding));
 const pacing=(await database.pool.query('SELECT method,next_due::text FROM opencrawl_slack_pacing WHERE namespace=$1 ORDER BY method',[database.namespace])).rows;
 assert.deepEqual(pacing,[{method:'conversations.list',next_due:'70000'},{method:'files.info',next_due:'200000'},{method:'files.list',next_due:'70000'}]);
 await assert.rejects(database.transaction(client=>inTransaction.projectLegacyIn(client,path('files-v1','pending'),file(),{...binding,tenantId:'org_other'})),{status:403});
 assert.deepEqual(await repository.exportLegacy(path('files-v1','pending'),scope),lower);
});

test('runtime Slack checkpoint wrapper freezes caller state before acquiring its transaction',async()=>{
 const gate=Promise.withResolvers(),queries=[],stop=Error('stop after frozen SQL input'),client={query:async(sql,args)=>{
  queries.push({sql,args});if(sql.startsWith('SELECT scope_hash'))return {rows:[{scope_hash:scope}]};
  if(sql.startsWith('INSERT INTO opencrawl_slack_runs'))throw stop;return {rows:[],rowCount:0};
 }};
 const repository=createPostgresSlackCapture({namespace:'fixture',transaction:async run=>{await gate.promise;return run(client);}});
 const value=file(),pending=repository.saveCheckpoint(binding,'files-v1','pending',value,null);value.nextDue=999999;value.files.F1.comments.a='changed after call';gate.resolve();
 await assert.rejects(pending,error=>error===stop);const insert=queries.find(({sql})=>sql.startsWith('INSERT INTO opencrawl_slack_runs'));
 assert.equal(JSON.parse(insert.args[5]).nextDue,70000);
});


test('online Slack catalog parity normalizes benign set order without changing pending checkpoint order',()=>{
 const key=path('files-v1'),first={scope,channels:['C2','C1'],files:{F1:['C2','C1'],FEMPTY:[]}},next={scope,channels:['C1','C2'],files:{FEMPTY:[],F1:['C1','C2']}};
 assert.deepEqual(decode(key,first).value,decode(key,next).value);
 assert.deepEqual(decode(path('files-v1','pending'),file()).value,file(),'Run cursor/child order remains the owning checkpoint format');
});
