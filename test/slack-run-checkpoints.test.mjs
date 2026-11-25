import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applicationDatabaseFixture, postgresUrl} from './fixtures/application-database.mjs';
import {digest} from '../dist/src/connectors/scope.mjs';
import {createSlackMessageCapture} from '../dist/src/connectors/slack-source-messages.mjs';
import {createSlackRunCheckpoints} from '../dist/src/state/slack-run-checkpoints.mjs';
import {createPostgresIntegrationRegistry} from '../dist/src/integrations/local-registry.mjs';

const environment='production', tenantId='org_Slack', userId='user_Slack', connectionId='int_'+'a'.repeat(26);
const binding={tenantId,connectionId,workspaceId:'T123',provider:'slack',access:'team-public',
  rawPrefix:'raw/v1/source=slack/workspace=T123/connection='+connectionId+'/'};
const owner={userId,connectedAccountId:'account-A'};
async function setup(t) {
  const database=await applicationDatabaseFixture(t);
  const registry=createPostgresIntegrationRegistry({database,environment,bindingId:'slack-test',authorizeTenant:v=>v===tenantId});
  const record={tenantId,userId,integrationId:connectionId,environment,status:'active',provider:'slack',scope:'team',workspace:'T123',
    connectedAccountId:owner.connectedAccountId,s3Bucket:'example',s3Prefix:binding.rawPrefix.slice(0,-1),createdAt:'2026-01-01',startDate:'2026-01-01'};
  await registry.create(record);
  const repo=createSlackRunCheckpoints(database), scope={binding,environment,bucket:'example',owner};
  const source=repo.source(scope),objects=new Map(),reads=[];
  const store={bucket:'example',async get(key){reads.push(key);return objects.get(key)??null;},async put(key,bytes){objects.set(key,Buffer.from(bytes));},
    async listPage(prefix,{continuationToken}){const keys=[...objects.keys()].filter(k=>k.startsWith(prefix)&&(!continuationToken||k>continuationToken)).sort();return {keys:keys.slice(0,1),nextToken:keys.length>1?keys[0]:null};}};
  return {database,registry,record,repo,scope,source,objects,reads,store};
}
function location(kind,runId) {return binding.rawPrefix+'capture/'+kind+'/'+runId+'/state.json';}
function bytes(runId,extra) {return Buffer.from(JSON.stringify({version:1,runId,scope:digest(binding),...extra}));}

test('quiesced adoption verifies all three checkpoint families, resumes pacing, rejects stale saves and erases on disconnect',{skip:!postgresUrl},async t=>{
  const {registry,record,repo,scope,source,objects,reads,store}=await setup(t);
  const runId='inflight',cutoff=10000;
  const message=bytes(runId,{cutoff,channels:{},threads:{},cursor:'more',listed:false,nextDue:{'conversations.list':65000},pages:1,emitted:0,errors:[]});
  const legacy=location('messages-v1',runId);
  objects.set(legacy,message);
  objects.set(legacy.replace('state.json','pages/raw.json'),Buffer.from('raw page'));
  objects.set(location('files-v1','file'),bytes('file',{cutoff}));
  objects.set(location('message-references-v1','refs'),bytes('refs',{inputHash:digest(['T123'])}));
  assert.equal(await source.current(),null);
  const imported=await source.adopt(store);
  assert.equal(imported.count,3);
  assert.equal(reads.length,3);
  assert.deepEqual(await repo.source(scope).current(),imported);
  assert.deepEqual(await source.adopt({...store,listPage(){throw Error('relisted');}}),imported);
  assert.deepEqual((await source.checkpoints.open('messages-v1',runId)).bytes,message);
  let now=64000,calls=0;
  const capture=()=>createSlackMessageCapture({binding,store,checkpoints:repo.source(scope).checkpoints,now:()=>now,
    async request(method,query){calls++;assert.equal(method,'conversations.list');assert.equal(query.cursor,'more');return {status:429,headers:{'Retry-After':'120'},data:{error:'ratelimited'}};}});
  assert.equal((await capture().step({runId,cutoff})).waitMs,1000);assert.equal(calls,0);
  now+=1000;await capture().step({runId,cutoff});assert.equal(calls,1);
  assert.equal((await capture().step({runId,cutoff})).waitMs,120000);
  assert.equal(objects.get(legacy),message);
  const a=await source.checkpoints.open('messages-v1',runId),b=await source.checkpoints.open('messages-v1',runId);
  await a.save(a.bytes);await assert.rejects(b.save(b.bytes),/latest revision/);
  await assert.rejects(repo.source({...scope,objectPrefix:'other-path'}).current(),/binding changed/);
  await assert.rejects(repo.source({...scope,owner:{...owner,connectedAccountId:'other'}}).current(),/binding changed/);
  await registry.update(record,{status:'disconnecting'});
  await assert.rejects(a.save(a.bytes),/binding changed/);
  await registry.update(record,{status:'active'});
  assert.equal(await source.current(),null);
  assert.equal((await source.adopt({...store,listPage:async()=>({keys:[]})})).count,0);
  assert.equal((await source.checkpoints.open('messages-v1',runId)).bytes,null);
});

test('incomplete or wrong-scope inventory rolls back ownership and every staged run',{skip:!postgresUrl},async t=>{
  const {source,objects,store}=await setup(t);
  objects.set(location('files-v1','one'),bytes('one',{cutoff:10}));
  objects.set(location('messages-v1','two'),bytes('two',{cutoff:10,scope:'wrong'}));
  await assert.rejects(source.adopt(store),/scope mismatch/);
  assert.equal(await source.current(),null);
  await assert.rejects(source.checkpoints.open('files-v1','one'),/not been imported/);
  objects.delete(location('messages-v1','two'));
  assert.equal((await source.adopt(store)).count,1);
});

test('directory inventory skips raw pages, orphan directories and advancing empty filtered pages',{skip:!postgresUrl},async t=>{
  const {source,store,objects,reads}=await setup(t);
  const kind='messages-v1',name=location(kind,'saved');
  objects.set(name,bytes('saved',{cutoff:1}));
  const listPage=async(prefix,{delimiter,continuationToken})=>{
    assert.equal(delimiter,'/');
    if(!prefix.endsWith('/'+kind+'/'))return {keys:[],prefixes:[]};
    if (!continuationToken)return {keys:[],prefixes:[],nextToken:'next-page'};
    return {keys:[prefix+'catalog.json'],prefixes:[prefix+'old-page-only/',prefix+'saved/']};
  };
  assert.equal((await source.adopt({...store,listPage})).count,1);
  assert.deepEqual(reads.sort(),[location(kind,'old-page-only'),name].sort());
});
