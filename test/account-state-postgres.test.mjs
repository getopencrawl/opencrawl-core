import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createAccountState} from '../dist/src/state/account-state.mjs';
import {createConnectorSecrets} from '../dist/src/state/connector-secrets.mjs';
import {createReplicasState} from '../dist/src/state/replicas.mjs';
import {createValueReports} from '../dist/src/state/value-reports.mjs';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {createReplicasConnections} from '../dist/src/identity/replicas-connections.mjs';
import {sealedEnvelope} from '../dist/src/integrations/credential-vault.mjs';
import {sessionScope} from '../dist/src/sessions/event-identity.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const owner={tenantId:'org_team',userId:'user_owner'},peer={...owner,userId:'user_peer'},org='11111111-1111-4111-8111-111111111111';
const hash=value=>createHash('sha256').update(value).digest('hex');

test('PostgreSQL capture credentials preserve revocation generations, expiry and tenant isolation across restart',{skip:!postgresUrl},async t=>{
 const database=await applicationDatabaseFixture(t),accounts=createAccountState(database);await accounts.ready();let now=0;
 let credentials=createCaptureCredentials({state:{accounts},now:()=>now});const a=await credentials.issue(owner),b=await credentials.issue(peer);
 assert.ok(await credentials.authenticate(a.token));await credentials.revokeAll(owner);
 credentials=createCaptureCredentials({state:{accounts:createAccountState(database)},now:()=>now});assert.equal(await credentials.authenticate(a.token),null);assert.ok(await credentials.authenticate(b.token));
 const fresh=await credentials.issue(owner);assert.ok(await credentials.authenticate(fresh.token));await assert.rejects(credentials.revoke(peer,fresh.id),{status:403});
 now=Date.parse(fresh.expiresAt);assert.equal(await credentials.authenticate(fresh.token),null);now=0;await credentials.revoke(owner,fresh.id);assert.equal(await credentials.authenticate(fresh.token),null);
 const legacyToken='occ1_'+'a'.repeat(64),legacy={schemaVersion:1,id:hash(legacyToken),principal:{...owner,userId:'user_legacy'},expiresAt:'2030-01-01T00:00:00Z',revoked:true};
 assert.deepEqual(await accounts.importCredential(legacy),legacy);assert.equal(await credentials.authenticate(legacyToken),null);
 await assert.rejects(accounts.importCredential({...legacy,revoked:false}),{status:409});
 await accounts.importGeneration(sessionScope(legacy.principal),{generation:'b'.repeat(64)});assert.equal(await accounts.credentials.authenticate(legacy.id),null);
 const {rows}=await database.pool.query('SELECT record::text FROM opencrawl_capture_credentials WHERE namespace=$1',[database.namespace]);assert.ok(rows.every(row=>!row.record.includes(a.token)&&!row.record.includes(b.token)));
});

test('role-write holds survive migration and restart; stale release never opens a newer operation',{skip:!postgresUrl},async t=>{
 const database=await applicationDatabaseFixture(t),accounts=createAccountState(database);await accounts.ready();
 const held={schemaVersion:1,state:'held',operationId:randomUUID(),organizationId:owner.tenantId,actorId:owner.userId,userId:peer.userId,role:'member',startedAt:'2000-01-01T00:00:00Z'};
 await accounts.importRole(owner.tenantId,held);await assert.rejects(createAccountState(database).roles.acquire(owner.tenantId,owner.userId,peer.userId,'remove'),{status:409});
 const another='org_other',first=await accounts.roles.acquire(another,owner.userId,peer.userId,'member');await first.release();const second=await accounts.roles.acquire(another,owner.userId,peer.userId,'admin');
 await assert.rejects(first.release(),{status:503});await assert.rejects(accounts.roles.acquire(another,owner.userId,peer.userId,'remove'),{status:409});await second.release();
 const receipt={observedAt:'2026-01-01T00:00:00.000Z',client:'Codex'};await accounts.importReceipt(sessionScope(owner),'mcp',receipt);assert.deepEqual(await createAccountState(database).onboarding.read(sessionScope(owner),'mcp'),receipt);assert.equal(await accounts.onboarding.read(sessionScope(peer),'mcp'),null);
});

test('sealed connector import preserves ciphertext and AAD bytes, with stale-write and wrong-key denial',{skip:!postgresUrl},async t=>{
 const database=await applicationDatabaseFixture(t),secrets=createConnectorSecrets(database);await secrets.ready();const key=Buffer.alloc(32,7),id='grant_'+'a'.repeat(48),scope={kind:'grant',organizationId:'org_team',id},aad=`connector-credentials/v1/org_team/${id}.enc`;
 const bytes=sealedEnvelope(key).seal(aad,Buffer.from('PRIVATE_PROVIDER_TOKEN'));assert.deepEqual(await secrets.importSecret(scope,aad,bytes),bytes);
 const current=await createConnectorSecrets(database).read(scope,aad);assert.deepEqual(current.data,bytes);assert.equal(sealedEnvelope(key).open(aad,current.data).toString(),'PRIVATE_PROVIDER_TOKEN');
 assert.throws(()=>sealedEnvelope(Buffer.alloc(32,8)).open(aad,current.data));await assert.rejects(secrets.read(scope,`other/org_team/${id}.enc`),/binding/);
 assert.equal(await secrets.compareAndSet(scope,aad,null,bytes),false);assert.equal(await secrets.compareAndSet(scope,aad,current.version,bytes),true);assert.equal(await secrets.compareAndSet(scope,aad,current.version,bytes),false);
 await assert.rejects(secrets.importSecret(scope,aad,sealedEnvelope(key).seal(aad,Buffer.from('different'))),/conflicts/);
});

test('Replicas PostgreSQL ownership and installation lists commit atomically and imported revocation survives',{skip:!postgresUrl},async t=>{
 const database=await applicationDatabaseFixture(t),replicas=createReplicasState(database);await replicas.ready();
 const installation={id:'replicas',tenantId:owner.tenantId,userId:'workload_replicas_'+'a'.repeat(64),name:'Replicas'},record={schemaVersion:1,organizationId:org,tenantId:owner.tenantId,approvedBy:owner.userId,approvedAt:'2026-01-01T00:00:00.000Z',revokedAt:null,installations:[installation]};
 await assert.rejects(replicas.saveConnection(org,null,{...record,installations:[installation,installation]}));assert.equal((await replicas.readConnection(org)).record,null);assert.deepEqual(await replicas.listConnections(owner.tenantId),[]);
 assert.equal(await replicas.saveConnection(org,null,record),true);const first=await replicas.readConnection(org);assert.deepEqual((await replicas.listConnections(owner.tenantId))[0],record);
 assert.equal(await replicas.saveConnection(org,first.version,{...record,tenantId:'org_other',installations:[]}),false);assert.deepEqual(await replicas.listConnections('org_other'),[]);
 const revoked={...record,revokedAt:'2026-02-01T00:00:00.000Z'};assert.equal(await replicas.saveConnection(org,first.version,revoked),true);assert.equal(await replicas.saveConnection(org,first.version,record),false);assert.deepEqual(await replicas.importConnection(revoked),revoked);await assert.rejects(replicas.importConnection(record),/conflicts/);
 const restarted=createReplicasState(database);assert.equal((await restarted.readConnection(org)).record.revokedAt,revoked.revokedAt);
});

test('Replicas setup claims persist and expiration cannot consume or move an organization',{skip:!postgresUrl},async t=>{
 const database=await applicationDatabaseFixture(t),replicas=createReplicasState(database);await replicas.ready();let now=Date.parse('2026-01-01T00:00:00Z');
 const workload={organizationId:org,environmentId:'22222222-2222-4222-8222-222222222222',workspaceId:'33333333-3333-4333-8333-333333333333'};
 const options={state:{replicas},verify:async()=>({status:200,workload}),isAdmin:async()=>true,now:()=>now};const service=createReplicasConnections(options),member={userId:owner.userId,organizationId:owner.tenantId,status:'active',role:{slug:'admin'}};
 const setup=await service.issue(owner,member);await service.claim(setup.code,'verified');assert.equal(await createReplicasConnections({...options,state:{replicas:createReplicasState(database)}}).resolveOrganization(org),owner.tenantId);
 const claim=(await replicas.readSetup(hash(setup.code))).record;assert.deepEqual(claim.claim,workload);assert.deepEqual(await replicas.importSetup(hash(setup.code),claim),claim);
 const expired=await service.issue(owner,member);now+=30*60000;await assert.rejects(service.claim(expired.code,'verified'),{status:403});assert.equal((await replicas.readSetup(hash(expired.code))).record.claim,null);
});

test('value report imports keep unknown historical schemas without presenting invented measurements',{skip:!postgresUrl},async t=>{
 const database=await applicationDatabaseFixture(t),reports=createValueReports(database);await reports.ready();const historical={schema:3,recorded:'legacy evidence'};
 assert.deepEqual(await reports.importReport(hash(owner.tenantId),historical),historical);assert.equal(await reports.read(owner.tenantId),null);await assert.rejects(reports.importReport(hash(owner.tenantId),{schema:3,recorded:'different'}),/conflicts/);
});
test('agent credentials cannot authenticate capture secrets and keep independent historical revocation generations',{skip:!postgresUrl},async t=>{
 const database=await applicationDatabaseFixture(t),accounts=createAccountState(database);await accounts.ready();
 const capture=createCaptureCredentials({state:{accounts}}),agent=createCaptureCredentials({state:{accounts},purpose:'agent'});
 const captureKey=await capture.issue(owner),agentKey=await agent.issue(owner);
 assert.equal(await capture.authenticate(agentKey.token),null);assert.equal(await agent.authenticate(captureKey.token),null);
 await capture.revokeAll(owner);assert.equal(await capture.authenticate(captureKey.token),null);assert.ok(await agent.authenticate(agentKey.token));
 const fresh=await capture.issue(owner);await agent.revokeAll(owner);assert.ok(await capture.authenticate(fresh.token));assert.equal(await agent.authenticate(agentKey.token),null);
 const token='occ1_'+'e'.repeat(64),legacy={schemaVersion:1,id:hash(token),principal:{...owner,userId:'user_imported'},expiresAt:'2030-01-01T00:00:00Z',revoked:false,generation:'a'.repeat(64)};
 await accounts.importCredential(legacy,'agent');await accounts.importGeneration(sessionScope(legacy.principal),{generation:legacy.generation},'agent');
 assert.deepEqual(await accounts.exportCredential(legacy.id,'agent'),legacy);assert.equal(await accounts.exportCredential(legacy.id),null);
 const restarted=createCaptureCredentials({state:{accounts:createAccountState(database)},purpose:'agent'});assert.ok(await restarted.authenticate(token));assert.equal(await capture.authenticate(token),null);
 await accounts.importGeneration(sessionScope(legacy.principal),{generation:'b'.repeat(64)});assert.ok(await restarted.authenticate(token));
 await restarted.revoke(legacy.principal,legacy.id);assert.equal(await restarted.authenticate(token),null);
 assert.deepEqual(await accounts.exportGeneration(sessionScope(legacy.principal),'agent'),{generation:legacy.generation});
});
