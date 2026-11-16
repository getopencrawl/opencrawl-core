import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createPostgresSlackCapture} from '../dist/src/state/slack-capture.mjs';
import {createSlackMessageCapture} from '../dist/src/connectors/slack-source-messages.mjs';
import {digest} from '../dist/src/connectors/scope.mjs';

const binding={tenantId:'org_fixture',connectionId:'int_fixture',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=int_fixture/'};
const key=(kind,run)=>binding.rawPrefix+'capture/'+kind+'/'+(run?run+'/state.json':'catalog.json');
const checkpoint=()=>({version:1,scope:digest(binding),runId:'pending',cutoff:123456,channels:{C1:{id:'C1',cursor:'next-channel',done:false,paginationProgress:{version:1,anchor:'old-channel',window:'2',distance:'1'}}},threads:{'C1:1.000001':{channel:'C1',ts:'1.000001',cursor:'next-thread',done:false}},priorChannels:['CRETAINED','C1'],cursor:'',listed:true,nextDue:{'conversations.history':65000},pages:3,emitted:2,errors:[{method:'conversations.history',channel:'CERROR',code:'not_in_channel'}]});
const bytes=value=>Buffer.from(JSON.stringify(value));
async function fixture(t){const database=await applicationDatabaseFixture(t),repository=createPostgresSlackCapture(database);await repository.ready();return {database,repository};}

test('PostgreSQL Slack import reconstructs every catalog and checkpoint without dropping nested state',{skip:!postgresUrl},async t=>{
 const {database,repository}=await fixture(t),scope=digest(binding),message=checkpoint();
 const file={version:1,scope,runId:'pending',cutoff:123456,channels:{C1:{id:'C1',page:3,done:false}},files:{F1:{id:'F1',channels:['C1','CRETAINED'],comments:{comment1:'Retained comment text',comment2:'Second comment'},cursor:'next-file',done:false,paginationProgress:{version:1,anchor:'old-file',window:'4',distance:'2'}}},priorChannels:['CRETAINED','C1'],cursor:'',listed:true,nextDue:70000,pages:4,emitted:1,errors:[]};
 const references={version:1,scope,runId:'pending',inputHash:digest('reference-input'),position:1,nextDue:{'conversations.replies':120000},pages:2,emitted:1,errors:[{position:0,method:'conversations.info',code:'channel_not_found'}]};
 const sources=[[key('messages-v1'),{scope,channels:['CRETAINED','C1']}],[key('files-v1'),{scope,channels:['CRETAINED','C1'],files:{F1:['C1','CRETAINED'],FEMPTY:[]}}],[key('messages-v1','pending'),message],[key('files-v1','pending'),file],[key('message-references-v1','pending'),references]];
 for(const [path,value]of sources){await repository.importLegacy(path,bytes(value));await repository.importLegacy(path,bytes(value));assert.deepEqual(await repository.exportLegacy(path),value);}
 const {rows}=await database.pool.query('SELECT metadata FROM opencrawl_slack_runs WHERE namespace=$1',[database.namespace]);
 assert.ok(rows.every(({metadata})=>['channels','threads','files','comments','errors','priorChannels'].every(field=>!Object.hasOwn(metadata,field))));
 const counts=await database.pool.query('SELECT item_kind,count(*)::int AS count FROM opencrawl_slack_run_items WHERE namespace=$1 GROUP BY item_kind',[database.namespace]);
 assert.equal(counts.rows.find(row=>row.item_kind==='file-comment').count,2);
 assert.equal((await database.pool.query("SELECT count(*)::int AS count FROM opencrawl_slack_catalog_items WHERE namespace=$1 AND item_kind='file-share'",[database.namespace])).rows[0].count,2);
 await assert.rejects(repository.importLegacy(key('messages-v1','pending'),bytes({...message,pages:99})),/differs/);
 await assert.rejects(repository.readCheckpoint({...binding,tenantId:'org_foreign'},'messages-v1','pending'),/scope mismatch/);
 await assert.rejects(repository.importLegacy(key('messages-v1','unknown'),bytes({...message,runId:'unknown',forgottenField:true})));
 assert.equal(await repository.readCheckpoint(binding,'messages-v1','unknown'),null);
});

test('PostgreSQL Slack revisions reject overlapping stale activities and preserve catalog unions',{skip:!postgresUrl},async t=>{
 const {repository}=await fixture(t),value=checkpoint();
 const revision=await repository.saveCheckpoint(binding,'messages-v1','pending',value,null);
 const results=await Promise.allSettled([repository.saveCheckpoint(binding,'messages-v1','pending',{...value,pages:4},revision),repository.saveCheckpoint(binding,'messages-v1','pending',{...value,pages:5},revision)]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
 assert.ok([4,5].includes((await repository.readCheckpoint(binding,'messages-v1','pending')).value.pages));
 await Promise.all([repository.mergeCatalog(binding,'files-v1',{scope:digest(binding),channels:['C1'],files:{F1:['C1']}}),repository.mergeCatalog(binding,'files-v1',{scope:digest(binding),channels:['C2'],files:{F1:['C2'],F2:[]}})]);
 const catalog=await repository.readCatalog(binding,'files-v1');assert.deepEqual(catalog.channels.sort(),['C1','C2']);assert.deepEqual(catalog.files.F1.sort(),['C1','C2']);assert.deepEqual(catalog.files.F2,[]);
});

test('PostgreSQL Slack pacing survives retries, new runs and imported checkpoints',{skip:!postgresUrl},async t=>{
 const {database,repository}=await fixture(t);
 const results=await Promise.all([repository.reserve(binding,'conversations.history',1000,65000),repository.reserve(binding,'conversations.history',1000,65000)]);
 assert.equal(results.filter(value=>value.reserved).length,1);assert.equal(results.find(value=>!value.reserved).waitMs,65000);
 const restarted=createPostgresSlackCapture(database);await restarted.ready();
 await restarted.defer(binding,'conversations.history',200000);await restarted.defer(binding,'conversations.history',1);
 assert.deepEqual(await restarted.reserve(binding,'conversations.history',199999,65000),{reserved:false,waitMs:1});
 assert.deepEqual(await restarted.reserve(binding,'conversations.history',200000,65000),{reserved:true,waitMs:0});
 await repository.importLegacy(key('messages-v1','pending'),bytes(checkpoint()));
 // Simulate interruption between importing the checkpoint and pacing. Repeating
 // the import must repair pacing before the installation can become ready.
 await database.pool.query('DELETE FROM opencrawl_slack_pacing WHERE namespace=$1',[database.namespace]);
 await repository.importLegacy(key('messages-v1','pending'),bytes(checkpoint()));
 assert.deepEqual(await repository.reserve(binding,'conversations.history',64000,65000),{reserved:false,waitMs:1000});
});

test('real Slack adapter stores only immutable source pages in object storage and keeps new-run pacing',{skip:!postgresUrl},async t=>{
 const {repository}=await fixture(t),objects=new Map();let calls=0;
 const store={get:async key=>objects.get(key),put:async(key,value)=>objects.set(key,Buffer.from(value))};
 const capture=createSlackMessageCapture({binding,store,state:{slackCapture:repository},now:()=>1000,request:async()=>{calls++;throw new Error('Synthetic transport failure');}});
 await assert.rejects(capture.step({runId:'first',cutoff:1000}),/transport/);
 assert.deepEqual(await capture.step({runId:'second',cutoff:1000}),{done:false,waitMs:3500});assert.equal(calls,1);
 assert.equal(objects.size,0);assert.ok(await repository.readCheckpoint(binding,'messages-v1','first'));
});
