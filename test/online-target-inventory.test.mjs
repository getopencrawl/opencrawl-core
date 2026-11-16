import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';
import {createOnlineJournal} from '../dist/src/state/online-journal.mjs';
import {createOnlineProjection} from '../dist/src/state/online-projection.mjs';
import {createOnlineTargetInventory,ONLINE_TYPED_TARGET_TABLES,ONLINE_TYPED_TARGET_OWNED_RELATIONS} from '../dist/src/state/online-target-inventory.mjs';
import {scanTargetInventoryIn} from '../dist/src/state/online-target-inventory-support.mjs';
import {sealedEnvelope} from '../dist/src/integrations/credential-vault.mjs';
import {digest as bindingHash} from '../dist/src/connectors/scope.mjs';
import {legacySetupState} from './fixtures/setup-state.mjs';
const url=process.env.OPENCRAWL_TEST_POSTGRES_URL,live=(name,run)=>test(name,{skip:!url},run),hash=value=>createHash('sha256').update(value).digest('hex'),encode=value=>Buffer.from(JSON.stringify(value));
const owner={tenantId:'org_inventory',userId:'user_inventory'},date='2026-11-16T00:00:00.000Z',prefix='sessions',scope=`tenants/${hash(owner.tenantId)}/users/${hash(owner.userId)}`;

test('global inventory names all thirty owning runtime tables without native ledgers',()=>{assert.equal(ONLINE_TYPED_TARGET_TABLES.length,30);assert.equal(new Set(ONLINE_TYPED_TARGET_TABLES).size,30);assert.ok(!ONLINE_TYPED_TARGET_OWNED_RELATIONS.some(name=>/event_identit|session_events/.test(name)));});
test('owner cursor fetches bounded pages and closes after early return or body failure',async()=>{const queries=[],client={query:async sql=>{queries.push(sql);return {rows:sql.startsWith('FETCH')?[{key:'owner'}]:[]};}};for await(const row of scanTargetInventoryIn(client,'SELECT owner FROM owning_table',[])){assert.equal(row.key,'owner');break;}assert.match(queries.at(-1),/^CLOSE /);assert.ok(queries.some(q=>q.startsWith('FETCH FORWARD 64 ')));});
test('global reader refuses source roster mismatch and nonrepeatable transaction before owner scans',async()=>{
 const epoch=randomUUID(),binding={namespace:'n',epoch,sourceId:'source',bindingHash:'a'.repeat(64)},projection={binding,inspectOwnedTargetIn:async()=>assert.fail('must not inspect')},inventory=createOnlineTargetInventory({database:{namespace:'n'},epoch,projections:[projection]});
 await assert.rejects(inventory.beginSnapshotIn({query:async()=>({rows:[{pid:1,stamp:'t',snapshot:'1:1:',isolation:'read committed',read_only:'on'}]})}),/repeatable/);
 const queries=[],client={query:async sql=>{queries.push(sql);if(sql.includes('pg_backend_pid'))return {rows:[{pid:1,stamp:'t',snapshot:'1:1:',isolation:'repeatable read',read_only:'on'}]};if(sql.includes('SELECT epoch'))return {rows:[{epoch}]};if(sql.startsWith('FETCH'))return {rows:[{source_id:'unknown',binding_hash:'b'.repeat(64)}]};return {rows:[]};}};
 await assert.rejects(inventory.beginSnapshotIn(client),/roster differs/);assert.match(queries.at(-1),/^CLOSE /);assert.throws(()=>createOnlineTargetInventory({database:{namespace:'n'},epoch,projections:[projection,projection]}),/duplicate/);
});
async function fixture(t){
 const admin=new Pool({connectionString:url,max:1}),schema='oc_inventory_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
 const database=createApplicationDatabase({connectionString:url,namespace:'inventory-'+randomUUID(),max:4,options:'-c search_path='+schema}),epoch=randomUUID(),sourceId='one',connectorKey=Buffer.alloc(32,17),slack={tenantId:owner.tenantId,connectionId:'int_inventory',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=int_inventory/'};
 t.after(async()=>{await database.close();const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");await c.query('DROP SCHEMA '+schema+' CASCADE');await c.query('COMMIT');}finally{c.release();await admin.end();}});
 const journal=createOnlineJournal({database,epoch,sourceId});await journal.ready();
 const options={database,epoch,sourceId,journalBinding:journal.binding,prefix,agentPrefix:prefix+'/_agent-access',tenantIds:[owner.tenantId],store:{bucket:'inventory-bucket',get:async()=>assert.fail('no source reads')},registryRecords:[{tenantId:owner.tenantId,integrationId:slack.connectionId,workspace:slack.workspaceId,provider:'slack',s3Prefix:slack.rawPrefix.slice(0,-1),s3Bucket:'inventory-bucket'}],eventIdentities:{},connectorKey,enrollment:{verifierId:'inventory-tests',initialReceiptHash:hash('inventory'),verify:async()=>assert.fail('no enrollment')}};
 const projection=createOnlineProjection(options);await projection.ready();
 const otherJournal=createOnlineJournal({database,epoch,sourceId:'two'});await otherJournal.ready();const other=createOnlineProjection({...options,sourceId:'two',prefix:'other',agentPrefix:undefined,journalBinding:otherJournal.binding});await other.ready();
 const inventory=createOnlineTargetInventory({database,epoch,projections:[projection,other]});
 const baseline=(key,value,p=projection)=>database.transaction(c=>p.backfill(c,{key,bytes:Buffer.isBuffer(value)?value:encode(value),version:'legacy-'+hash(key)}));
 const inspect=async({client,limit=64}={})=>{const c=client??await database.pool.connect();try{if(!client)await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const reader=await inventory.beginSnapshotIn(c);let page;do{page=await reader.next({limit});}while(!page.exhausted);await reader.close();return page;}finally{if(!client){await c.query('ROLLBACK');c.release();}}};
 return {database,epoch,journal,projection,other,options,inventory,baseline,inspect,slack,connectorKey};
}
async function seed(f){
 const entries=[],put=async(key,value,p)=>{await f.baseline(key,value,p);entries.push(key);};
 const cred={schemaVersion:1,id:hash('credential'),principal:owner,expiresAt:'2099-01-01T00:00:00Z',revoked:false,generation:hash('generation')};
 await put(prefix+'/_credentials/'+cred.id+'.json',cred);await put(prefix+'/_agent-access/_credentials/'+cred.id+'.json',cred);
 await put(prefix+'/_credential-generations/'+scope+'.json',{generation:cred.generation});await put(prefix+'/_agent-access/_credential-generations/'+scope+'.json',{generation:cred.generation});
 await put(prefix+'/'+scope+'/onboarding/mcp.json',{observedAt:date});await put(prefix+'/organization-role-writes/'+owner.tenantId+'.json',{schemaVersion:1,state:'idle',operationId:randomUUID(),completedAt:date});
 await put(prefix+'/'+scope+'/setup/status-v1.json',legacySetupState(owner));
 await put(prefix+'/'+scope+'/controls/sessions/codex/'+hash('session')+'.json',{schemaVersion:1,visibility:'private',deletedAt:null,updatedAt:date});
 const sf={version:1,namespace:'sessions',tenantId:hash(owner.tenantId),connectionId:hash('resource'),closedAt:null,writers:[{id:'w',operation:'object-put',phase:'writing',startedAt:1,instance:'test',target:'synthetic'}]};
 await put(prefix+'/'+scope+'/controls/write-barriers/'+hash(JSON.stringify([sf.namespace,sf.tenantId,sf.connectionId]))+'.json',sf);
 const cf={...sf,namespace:'production',tenantId:owner.tenantId,connectionId:'int_inventory'};await put('control/connectors/write-barriers/v1/'+hash(JSON.stringify([cf.namespace,cf.tenantId,cf.connectionId]))+'.json',cf);
 await put(prefix+'/_deletions/v1/'+hash(JSON.stringify([prefix,owner.tenantId,owner.userId,'codex','session']))+'.json',{schemaVersion:1,owner,harness:'codex',sessionId:'session'});
 const envelope=sealedEnvelope(f.connectorKey),grantId='grant_'+'a'.repeat(48),grantKey='connector-credentials/v1/'+owner.tenantId+'/'+grantId+'.enc',settingsKey='connector-settings/v1/'+owner.tenantId+'/settings.enc';
 await put(grantKey,envelope.seal(grantKey,encode({version:1,id:grantId,organizationId:owner.tenantId,userId:owner.userId,integrationId:'int_'+'a'.repeat(26),provider:'slack',status:'INITIATED',state:'synthetic',callbackUrl:'https://example.invalid/callback',flowExpiresAt:1,proxyToken:'synthetic'})));
 await put(settingsKey,envelope.seal(settingsKey,encode({version:1,organizationId:owner.tenantId,broker:null})));
 const org=randomUUID(),connection={schemaVersion:1,organizationId:org,tenantId:owner.tenantId,approvedBy:owner.userId,approvedAt:date,revokedAt:null,installations:[{id:'i',tenantId:owner.tenantId,userId:'workload_replicas_'+hash('user'),name:'Replicas'}]};
 await put(prefix+'/identity/replicas-v1/organizations/'+org+'.json',connection);await put(prefix+'/identity/replicas-v1/tenants/'+hash(owner.tenantId)+'/'+org+'.json',{organizationId:org});
 await put(prefix+'/identity/replicas-v1/setup/'+hash('challenge')+'.json',{schemaVersion:1,tenantId:owner.tenantId,userId:owner.userId,issuedAt:1,expiresAt:9999999999999,claim:null});
 await put('other/value/tenants/'+hash(owner.tenantId)+'.json',{historical:true},f.other);
 const message={id:1,timestamp:1,agent:'agent',author:owner.userId,name:'Agent',topic:'topic',text:'retained message',requestId:'request'}, {requestId,...visible}=message;
 const participant={name:'Agent',task:'task',harness:'codex',registeredAt:1,seen:1,topics:['topic'],ackCursor:0,lastPoll:1,lastAckAt:null,nextHomeAt:2,pending:{receipt:hash('receipt'),createdAt:1,through:1,more:false,messages:[{...visible,reasons:['topic']}]},batches:1,acknowledgedBatches:0};
 await put(prefix+'/board/tenants/'+hash(owner.tenantId)+'.json',{schema:1,messages:[message],agents:{agent:{name:'Agent',topics:['topic'],seen:1}},usage:{calls:1,inputBytes:2,outputBytes:3},participants:{agent:participant}});
 const slackScope=bindingHash(f.slack),catalogKey=f.slack.rawPrefix+'capture/files-v1/catalog.json';await put(catalogKey,{scope:slackScope,channels:['C1'],files:{F1:['C1']}});
 const slackKey=f.slack.rawPrefix+'capture/files-v1/pending/state.json',checkpoint={version:1,scope:slackScope,runId:'pending',cutoff:1,cursor:'',listed:true,channels:{C1:{id:'C1',page:1,done:false}},files:{F1:{id:'F1',cursor:'',done:false,channels:['C1'],comments:{a:'retained'}}},priorChannels:['C1'],nextDue:100,pages:1,emitted:1,errors:[]};await put(slackKey,checkpoint);
 return {entries,cred,slackKey,checkpoint};
}
live('global inventory covers seventeen retained domains across sources and rejects every unheaded owner',async t=>{
 const f=await fixture(t);await seed(f);const result=await f.inspect({limit:1});assert.equal(result.complete,true);assert.equal(result.runtimeAdmission,false);assert.equal(Object.keys(result.counts).filter(k=>k!=='slack-pacing').length,17);assert.equal(result.counts['capture-credentials'],'2');assert.equal(result.counts['credential-generations'],'2');assert.equal(result.unprovedTotal,'0');
 const heads=(await f.database.pool.query('SELECT target_key,domain FROM opencrawl_online_projection_heads ORDER BY target_key')).rows;
 for(const head of heads){await f.database.transaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.query('DELETE FROM opencrawl_online_projection_heads WHERE target_key=$1',[head.target_key]);await assert.rejects(f.inspect({client:c,limit:2}),/unheaded|canonical|publisher|alias|target|connection/i);throw Object.assign(Error('rollback-case'),{expected:true});}).catch(e=>{if(!e.expected)throw e;});}
 const partial=createOnlineTargetInventory({database:f.database,epoch:f.epoch,projections:[f.projection]});await f.database.transaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await assert.rejects(partial.beginSnapshotIn(c),/roster/);});
 assert.equal((await f.inspect()).complete,true);
});
live('global owner inventory catches normalized columns, auxiliary drift and unexplained pacing',async t=>{
 const f=await fixture(t);await seed(f);
 for(const sql of ["UPDATE opencrawl_capture_credentials SET owner_scope='tenants/"+'a'.repeat(64)+"/users/"+'b'.repeat(64)+"'", "UPDATE opencrawl_board_topics SET posts=posts+1", "UPDATE opencrawl_board_heads SET head=head+1", "UPDATE opencrawl_board_deliveries SET receipt=repeat('f',64)", "UPDATE opencrawl_board_participants SET seen=seen+1", "UPDATE opencrawl_board_search_chunks SET words=to_tsvector('simple','wrong')", "UPDATE opencrawl_board_messages SET author='user_other'", "UPDATE opencrawl_slack_run_items SET ordinal=ordinal+1 WHERE item_kind='file-channel'", "UPDATE opencrawl_replicas_installations SET user_id='workload_replicas_other'", "INSERT INTO opencrawl_slack_runs(namespace,raw_prefix,scope_hash,kind,run_id,metadata) SELECT namespace,raw_prefix,scope_hash,kind,'catalog',jsonb_set(metadata,'{runId}','\"catalog\"') FROM opencrawl_slack_runs WHERE run_id='pending'"]){await f.database.transaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.query(sql);await assert.rejects(f.inspect({client:c}),/differs|invalid|mismatch/i);throw Object.assign(Error('rollback-case'),{expected:true});}).catch(e=>{if(!e.expected)throw e;});}
 await f.database.pool.query('DELETE FROM opencrawl_online_slack_pacing_proofs');const incomplete=await f.inspect();assert.equal(incomplete.exhausted,true);assert.equal(incomplete.complete,false);assert.equal(incomplete.unprovedTotal,'3');
});
live('reader binds one transaction and closes cursors on refusal and early abandonment',async t=>{
 const f=await fixture(t);await seed(f);const c=await f.database.pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const reader=await f.inventory.beginSnapshotIn(c);await reader.next({limit:1});await reader.close();assert.equal((await c.query("SELECT count(*)::int n FROM pg_cursors WHERE name LIKE 'oc_target_%'")).rows[0].n,0);await assert.rejects(reader.next(),/closed/);const invalidBudget=await f.inventory.beginSnapshotIn(c);await invalidBudget.next({limit:1});await assert.rejects(invalidBudget.next({limit:65}),/invalid page budget/);assert.equal((await c.query("SELECT count(*)::int n FROM pg_cursors WHERE name LIKE 'oc_target_%'")).rows[0].n,0);await assert.rejects(invalidBudget.next(),/closed/);await c.query('ROLLBACK');
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const changed=await f.inventory.beginSnapshotIn(c);await c.query('COMMIT');await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await assert.rejects(changed.next(),/snapshot changed/);await c.query('ROLLBACK');}finally{c.release();}
});
live('pacing maximum contribution rolls back with target and survives lower later journal checkpoints',async t=>{
 const f=await fixture(t),seeded=await seed(f),values=new Map([[seeded.slackKey,{version:'legacy-'+hash(seeded.slackKey),operationId:null,revision:null,deleted:false,bytes:encode(seeded.checkpoint),contentType:'application/json'}]]),store={read:async key=>values.get(key),putIfVersion:async(key,version,m)=>{if(values.get(key).version!==version)return false;values.set(key,{version:m.operationId,operationId:m.operationId,revision:m.revision,deleted:false,bytes:m.bytes,contentType:m.contentType});return true;}};
 const mutate=async due=>f.journal.mutate({operationId:randomUUID(),key:seeded.slackKey,mutation:{kind:'put',bytes:encode({...seeded.checkpoint,nextDue:due}),contentType:'application/json'}},store);
 const high=await mutate(200);await assert.rejects(f.database.transaction(async c=>{await f.projection.apply(c,high);throw Error('lost response before commit');}),/lost response/);assert.equal((await f.database.pool.query('SELECT max(next_due)::text n FROM opencrawl_online_slack_pacing_proofs')).rows[0].n,'100');
 await f.database.transaction(c=>f.projection.apply(c,high));const low=await mutate(1);await f.database.transaction(c=>f.projection.apply(c,low));assert.equal((await f.inspect()).complete,true);assert.equal((await f.database.pool.query('SELECT min(next_due)::text n FROM opencrawl_online_slack_pacing_proofs')).rows[0].n,'200');
 await f.database.pool.query("UPDATE opencrawl_online_slack_pacing_proofs SET source_hash=repeat('f',64)");await assert.rejects(f.inspect(),/proof changed/);
});

live('child-only rows, oversized targets and unrelated namespaces have explicit inventory outcomes',async t=>{
 const f=await fixture(t);await seed(f);
 for(const [child,parent,where] of [['opencrawl_resource_writers','opencrawl_write_fences',''],['opencrawl_board_search_chunks','opencrawl_board_messages',''],['opencrawl_slack_run_items','opencrawl_slack_runs','']]){
  await f.database.transaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');const constraints=(await c.query("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f'",[child])).rows;assert.ok(constraints.length);for(const {conname} of constraints){assert.match(conname,/^[a-z_]+$/);await c.query(`ALTER TABLE ${child} DROP CONSTRAINT ${conname}`);}await c.query(`DELETE FROM ${parent} ${where}`);await assert.rejects(f.inspect({client:c}),/child|parent|differs|head/i);throw Object.assign(Error('rollback-case'),{expected:true});}).catch(e=>{if(!e.expected)throw e;});
 }
 await f.database.transaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.query("UPDATE opencrawl_value_reports SET report=jsonb_build_object('oversized',repeat('x',70000))");await assert.rejects(f.inspect({client:c}),/value report|bound|oversized/i);throw Object.assign(Error('rollback-case'),{expected:true});}).catch(e=>{if(!e.expected)throw e;});
 await f.database.pool.query("INSERT INTO opencrawl_value_reports VALUES($1,$2,'{}')",['other-namespace',hash('other')]);assert.equal((await f.inspect()).complete,true);
});
live('owner scan visits multiple bounded cursor pages and binds Unicode source metadata once',async t=>{
 const f=await fixture(t);for(let i=0;i<130;i++){const id=hash('credential-'+i);await f.baseline(prefix+'/_credentials/'+id+'.json',{schemaVersion:1,id,principal:{...owner,name:'東京 café '+i},expiresAt:'2099-01-01T00:00:00Z',revoked:false});}
 const c=await f.database.pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const reader=await f.inventory.beginSnapshotIn(c);let pages=0,result;do{result=await reader.next({limit:13});assert.ok(Number(result.processed)<=13);pages++;}while(!result.exhausted);assert.ok(pages>=10);assert.equal(result.counts['capture-credentials'],'130');assert.equal(result.complete,true);assert.equal((await c.query("SELECT count(*)::int n FROM pg_cursors WHERE name LIKE 'oc_target_%'")).rows[0].n,0);await c.query('ROLLBACK');}finally{c.release();}
});
