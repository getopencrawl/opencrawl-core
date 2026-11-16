import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSetupState} from '../dist/src/state/setup.mjs';
import {validateSetupState} from '../dist/src/setup/state.mjs';
import {createSetupStatus} from '../dist/src/setup/status.mjs';
import {memorySetupState} from './fixtures/memory-setup-state.mjs';
import {legacySetupState} from './fixtures/setup-state.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const owner={tenantId:'org_setup',userId:'user_fixture'};
const input={installationId:'new-installation',machine:{id:'new-machine',label:'Machine'},clients:[{client:'codex',installed:false,pluginState:'prepared',forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'pending'}]};
const search={search:async()=>({results:[]}),fetch:async()=>null};

test('Setup domain retains exactly eight CAS retries without writing mutable objects',async()=>{
 const backing=memorySetupState();let saves=0,reads=0;
 const setup=createSetupStatus({state:{setup:{read:async scope=>{reads++;return backing.read(scope);},save:async()=>{saves++;return false;}}},search});
 await assert.rejects(setup.installation(owner,input),{status:409,message:'Setup changed concurrently. Retry this operation.'});
 assert.equal(saves,8);assert.equal(reads,8);assert.equal((await backing.read(owner)).record,null);
 const eventually=createSetupStatus({state:{setup:{read:backing.read,save:async(...args)=>++saves<16?false:backing.save(...args)}},search});
 await eventually.installation(owner,input);assert.equal(saves,16);assert.equal((await backing.read(owner)).record.installations.length,1);
});

test('Setup persisted records reject owner substitution, malformed private evidence and oversize state',()=>{
 const record=legacySetupState(owner);assert.deepEqual(validateSetupState(record,owner),record);
 assert.throws(()=>validateSetupState(record,{...owner,userId:'other'}),/storage scope/);
 assert.throws(()=>validateSetupState({...record,scope:{tenantId:'',userId:'user'}}));
 assert.throws(()=>validateSetupState({...record,installations:[record.installations[0],record.installations[0]]}));
 const malformed=structuredClone(record);malformed.installations[0].clients[0].evidence.nativeCalls[0].sessionId=42;assert.throws(()=>validateSetupState(malformed));
 const oversized=structuredClone(record);oversized.installations[0].clients[0].evidence.proof.marker='x'.repeat(256*1024);assert.throws(()=>validateSetupState(oversized),{status:409});
});

test('Setup repository rejects invalid scope/revision before SQL and storage failure has no fallback',async()=>{
 let queries=0;const setup=createSetupState({namespace:'fixture',pool:{query:async()=>{queries++;throw new Error('postgres unavailable');}}});
 await assert.rejects(setup.read({userId:'user'}),/Authentication/);
 await assert.rejects(setup.save(owner,'not-a-uuid',legacySetupState(owner)),/revision/);
 await assert.rejects(setup.save({...owner,userId:'other'},null,legacySetupState(owner)),/scope/);assert.equal(queries,0);
 await assert.rejects(createSetupStatus({state:{setup},search}).read(owner),/postgres unavailable/);assert.equal(queries,1);
});

const live=(name,run)=>test(name,{skip:!postgresUrl},run);
async function fixture(t){const database=await applicationDatabaseFixture(t),repository=createSetupState(database);await repository.ready();return {database,repository};}
live('PostgreSQL Setup CAS isolates namespaces and owners, survives restart and refuses stale revisions',async t=>{
 const a=await fixture(t),b=await fixture(t),value=legacySetupState(owner);
 const races=await Promise.all([a.repository.save(owner,null,value),a.repository.save(owner,null,value)]);assert.deepEqual([...races].sort(),[false,true]);
 for(const scope of [{...owner,userId:'other'},{...owner,tenantId:'org_other'}])assert.deepEqual(await a.repository.read(scope),{record:null,version:null});
 assert.deepEqual(await b.repository.read(owner),{record:null,version:null});
 const initial=await a.repository.read(owner);assert.deepEqual(initial.record,value);
 const changed=structuredClone(value);changed.installations[0].clients[0].installed=true;
 assert.equal(await a.repository.save(owner,initial.version,changed),true);assert.equal(await a.repository.save(owner,initial.version,value),false);
 const restarted=createSetupState(a.database);assert.deepEqual((await restarted.read(owner)).record,changed);
 await assert.rejects(restarted.save({...owner,userId:'other'},null,changed),/storage scope/);
 await assert.rejects(a.database.pool.query('INSERT INTO opencrawl_setup_status(namespace,tenant_id,user_id,record,revision) VALUES($1,$2,$3,$4::jsonb,$5)',[a.database.namespace,'org_wrong',owner.userId,JSON.stringify(value),initial.version]),error=>error.code==='23514');
 await assert.rejects(restarted.importStatus(value),/differs from legacy state/);assert.deepEqual((await restarted.read(owner)).record,changed);
});

live('PostgreSQL Setup concurrent CLI and native observations retain evidence without extending imported expiry',async t=>{
 const {database,repository}=await fixture(t),record=legacySetupState(owner);await repository.importStatus(record);
 const at='2026-11-14T12:00:01.000Z',setup=createSetupStatus({state:{setup:repository},search,now:()=>new Date(at)});
 const existing=record.installations[0],client=existing.clients[0],observation={client:client.client,installed:true,pluginState:'installed',forward:true,history:'import',historyProgress:{state:'complete',completed:4,total:4},hookTrust:'trusted'};
 await Promise.all([
  setup.installation(owner,{installationId:existing.installationId,machine:existing.machine,clients:[observation]}),
  setup.session(owner,{schemaVersion:1,owner,installationId:existing.installationId,sessionId:'second-native-session',harness:'codex',origin:'cli',captureMode:'live',events:[{id:'call2',kind:'tool_call',timestamp:at,data:{id:'call2',name:'opencrawl.verify_installation',input:{installationId:existing.installationId,client:'codex',proofId:client.evidence.proof.id}}}],attachments:[]})
 ]);
 const stored=(await createSetupState(database).read(owner)).record.installations[0].clients[0];
 assert.equal(stored.historyProgress.completed,4);assert.equal(stored.installed,true);assert.ok(stored.evidence.nativeCalls.some(call=>call.callId==='call2'));assert.deepEqual(stored.evidence.mcpCall,client.evidence.mcpCall);
 assert.equal(stored.evidence.proof.expiresAt,client.evidence.proof.expiresAt);
 const expired=createSetupStatus({state:{setup:repository},search,now:()=>new Date('2026-11-15T00:00:00Z')});
 assert.equal((await expired.read(owner)).installations[0].clients[0].proof.state,'expired');
 await assert.rejects(expired.mcp(owner,{installationId:existing.installationId,client:'codex',proofId:client.evidence.proof.id}),{status:409});
 assert.equal((await repository.read(owner)).record.installations[0].clients[0].evidence.proof.expiresAt,client.evidence.proof.expiresAt);
});
