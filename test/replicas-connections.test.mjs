import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, SignJWT} from 'jose';
import {createReplicasConnections} from '../dist/src/identity/replicas-connections.mjs';
import {createReplicasVerifier, createReplicasWorkloads, replicasOwnerId, REPLICAS_ISSUER} from '../dist/src/identity/replicas.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const org='11111111-1111-4111-8111-111111111111', env='22222222-2222-4222-8222-222222222222', workspace='33333333-3333-4333-8333-333333333333', other='44444444-4444-4444-8444-444444444444';
const audience='https://operator.example', keys=await generateKeyPair('RS256'), badKeys=await generateKeyPair('RS256');
const second=Math.floor(Date.now()/1000), admin={tenantId:'org_a',userId:'user_admin'}, member={id:'membership',userId:admin.userId,organizationId:admin.tenantId,status:'active',role:{slug:'admin'}};
async function token({organizationId=org,environmentId=env,workspaceId=workspace,...claims}={},key=keys.privateKey){return new SignJWT({iss:REPLICAS_ISSUER,aud:audience,sub:`org:${organizationId}:env:${environmentId}:workspace:${workspaceId}`,organization_id:organizationId,environment_id:environmentId,workspace_id:workspaceId,iat:second,exp:second+900,...claims}).setProtectedHeader({alg:'RS256'}).sign(key);}
function fixture(options={}) {
 const store=memorySessionStore();let clock=second*1000,adminActive=true;
 const verify=createReplicasVerifier({audience,key:async()=>keys.publicKey,now:()=>clock});
 const isAdmin=async p=>adminActive&&p.userId==='user_admin';
 const make=()=>createReplicasConnections({store,verify,isAdmin,now:()=>clock,...options});
 const connections=make();
 const auth=createReplicasWorkloads({audience,key:async()=>keys.publicKey,resolveOrganization:connections.resolveOrganization,now:()=>clock});
 return {store,connections,auth,make,revokeAdmin(){adminActive=false;},advance(ms){clock+=ms;},async enroll(){const {code}=await connections.issue(admin,member);return connections.claim(code,await token());}};
}
const status=expected=>error=>error.status===expected;

test('admin enrolls once; restart, fresh workspaces and personal forks keep native identity and tenant',async()=>{
 const f=fixture();assert.equal((await f.auth.identify(await token())).status,403);
 await f.enroll();assert.equal(await f.make().resolveOrganization(org),'org_a');
 for(const input of [{},{environmentId:other},{workspaceId:other},{environmentId:other,workspaceId:other}]) {
  const result=await f.auth.identify(await token(input));assert.equal(result.status,200);assert.equal(result.principal.tenantId,'org_a');
  assert.equal(result.principal.userId,replicasOwnerId(org,input.environmentId??env,input.workspaceId??workspace));
  assert.equal(result.principal.owner.kind,'shared');assert.equal(result.user.email,null);
  await assert.rejects(f.auth.revalidate(result.principal,'org_b'),status(403));
 }
 assert.equal((await f.auth.identify(await token({organizationId:other}))).status,403);
 assert.deepEqual(await f.connections.list({tenantId:'org_b',userId:'user_admin'}),[]);
});

test('setup requires an active admin bound to the caller and workspace',async()=>{
 const f=fixture();
 for(const changes of [{userId:'user_other'},{organizationId:'org_b'},{status:'inactive'},{role:{slug:'member'}}])await assert.rejects(f.connections.issue(admin,{...member,...changes}),status(403));
 await assert.rejects(f.connections.issue({...admin,captureAccess:'write'},member),status(403));
 f.revokeAdmin();await assert.rejects(f.connections.issue(admin,member),status(403));
 assert.equal(f.store.data.size,0);
});

test('invalid, forged, wrong-audience and expired workspace credentials cannot consume a setup code',async()=>{
 const f=fixture(),{code}=await f.connections.issue(admin,member);
 for(const value of ['bad',await token({aud:'https://elsewhere.example'}),await token({},badKeys.privateKey),await token({exp:second-1})])await assert.rejects(f.connections.claim(code,value),status(401));
 assert.equal(await f.connections.resolveOrganization(org),null);
 await f.connections.claim(code,await token());
 assert.equal(await f.connections.resolveOrganization(org),'org_a');
});

test('setup code is hashed at rest, scoped, single-workspace and retryable after a lost response',async()=>{
 const f=fixture(),{code}=await f.connections.issue(admin,member);
 assert.equal([...f.store.data.keys(),...[...f.store.data.values()].map(v=>v.toString())].some(v=>v.includes(code)),false);
 const first=await f.connections.claim(code,await token());assert.deepEqual(await f.connections.claim(code,await token()),first);
 await assert.rejects(f.connections.claim(code,await token({workspaceId:other})),status(409));
 await assert.rejects(f.connections.claim(code,await token({organizationId:other})),status(409));
 assert.equal((await f.connections.list(admin))[0].installations.length,0,'enrollment alone cannot fabricate readiness');
});

test('expired approval and removed administrator cannot enroll a workspace',async()=>{
 const f=fixture(),{code}=await f.connections.issue(admin,member);f.revokeAdmin();
 await assert.rejects(f.connections.claim(code,await token()),status(403));
 assert.equal(await f.connections.resolveOrganization(org),null);
 const g=fixture(),setup=await g.connections.issue(admin,member);g.advance(30*60*1000);
 await assert.rejects(g.connections.claim(setup.code,await token({iat:second+1800,exp:second+2700})),status(403));
});

test('concurrent tenant claims have exactly one winner and cannot move the organization',async()=>{
 const f=fixture(),b={...admin,tenantId:'org_b'},mb={...member,organizationId:'org_b'};
 const [aCode,bCode]=await Promise.all([f.connections.issue(admin,member),f.connections.issue(b,mb)]);
 const results=await Promise.allSettled([f.connections.claim(aCode.code,await token()),f.connections.claim(bCode.code,await token())]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
 const owner=await f.connections.resolveOrganization(org);assert.ok(['org_a','org_b'].includes(owner));
 const loser=owner==='org_a'?b:admin;assert.deepEqual(await f.connections.list(loser),[]);
});

test('migration preserves existing owners and real shared receipts alongside personal onboarding',async()=>{
 const f=fixture(),rows=[{organizationId:org,environmentId:env,tenantId:admin.tenantId,onboardingWorkspaceId:workspace},{organizationId:org,environmentId:other,tenantId:admin.tenantId}];
 const oldOwner={tenantId:admin.tenantId,userId:replicasOwnerId(org,env,workspace)};
 const onboarding=createOnboardingStatus({store:f.store,sharedInstallations:p=>f.connections.sharedInstallations(p)});
 await onboarding.cli(oldOwner);await onboarding.mcpTest(oldOwner);
 await f.connections.migrateLegacy(rows);
 assert.equal((await onboarding.read(admin)).shared,undefined,'migration does not invent a capture receipt');
 await onboarding.session(oldOwner,{harness:'codex',captureMode:'live',events:[{kind:'message'}]});
 const before=await onboarding.read(admin);assert.ok(before.shared);assert.equal(before.cli,null);
 await f.connections.migrateLegacy(rows);assert.deepEqual((await onboarding.read(admin)).shared,before.shared);
 await onboarding.cli(admin);await onboarding.mcpTest(admin);await onboarding.session(admin,{harness:'claude-code',captureMode:'live',events:[{kind:'message'}]});
 const personal=await onboarding.read(admin);assert.ok(personal.cli&&personal.mcpTest&&personal.session&&personal.shared);
 assert.equal((await f.auth.identify(await token())).principal.userId,oldOwner.userId);
});

test('migration rejects conflicting tenants before any write and never revives revoked access',async()=>{
 const f=fixture(),row={organizationId:org,environmentId:env,tenantId:'org_a'};
 await assert.rejects(f.connections.migrateLegacy([row,{...row,environmentId:other,tenantId:'org_b'}]),status(409));
 assert.equal(f.store.data.size,0);
 await f.connections.migrateLegacy([row]);const active=await f.auth.identify(await token());
 await f.connections.revoke(admin,org);await assert.rejects(f.auth.revalidate(active.principal),status(403));
 assert.equal((await f.auth.identify(await token())).status,403);
 await assert.rejects(f.connections.migrateLegacy([row]),status(409));
 assert.equal(await f.connections.resolveOrganization(org),null);
});

test('authoritative registry denial never falls back to legacy admission',async()=>{
 const auth=createReplicasWorkloads({audience,key:async()=>keys.publicKey,bindings:()=>[{organizationId:org,environmentId:env,tenantId:'org_a'}],resolveOrganization:async()=>null});
 assert.equal((await auth.identify(await token())).status,403);
 const unavailable=createReplicasWorkloads({audience,key:async()=>keys.publicKey,resolveOrganization:async()=>{throw new Error('store offline');}});
 assert.equal((await unavailable.identify(await token())).status,503);
});

test('self-host registry pins its organization without hosted credentials',async()=>{
 const f=fixture({tenantId:'org_a'});await f.enroll();
 await assert.rejects(f.connections.issue({...admin,tenantId:'org_b'},{...member,organizationId:'org_b'}),status(403));
 await assert.rejects(f.connections.list({...admin,tenantId:'org_b'}),status(403));
 await assert.rejects(f.connections.migrateLegacy([{organizationId:other,environmentId:env,tenantId:'org_b'}]));
 assert.equal(await f.connections.resolveOrganization(org),'org_a');
});


test('a fresh workspace completes organization readiness automatically from its own three real receipts',async()=>{
 const f=fixture();await f.enroll();
 const principal=(await f.auth.identify(await token({environmentId:other,workspaceId:other}))).principal;
 const onboarding=createOnboardingStatus({store:f.store,sharedInstallations:p=>f.connections.sharedInstallations(p),onSharedReady:p=>f.connections.confirmInstallation(p)});
 await onboarding.cli(principal);await onboarding.mcpTest(principal);
 assert.equal((await onboarding.read(admin)).shared,undefined);
 await onboarding.session(principal,{harness:'codex',captureMode:'live',events:[{kind:'message'}]});
 assert.ok((await onboarding.read(admin)).shared);
 assert.equal((await f.connections.list(admin))[0].installations[0].userId,principal.userId);
 await f.connections.revoke(admin,org);
 const legacy=[{organizationId:org,environmentId:other,tenantId:admin.tenantId,onboardingWorkspaceId:other}];
 assert.deepEqual(await f.connections.sharedInstallations(admin,legacy),[],'revocation cannot revive readiness through old settings');
});


test('an already used setup prompt cannot restore a revoked connection; a fresh admin approval can',async()=>{
 const f=fixture(),setup=await f.connections.issue(admin,member);
 await f.connections.claim(setup.code,await token());f.advance(1000);await f.connections.revoke(admin,org);
 await assert.rejects(f.connections.claim(setup.code,await token()),status(409));
 assert.equal(await f.connections.resolveOrganization(org),null);
 f.advance(1000);const fresh=await f.connections.issue(admin,member);
 await f.connections.claim(fresh.code,await token());assert.equal(await f.connections.resolveOrganization(org),'org_a');
});

test('enrollment recovers after the authoritative connection succeeds but its tenant index write fails',async()=>{
 const f=fixture(),setup=await f.connections.issue(admin,member),put=f.store.put;let failOnce=true;
 f.store.put=async(key,...args)=>{if(key.includes('/tenants/')&&failOnce){failOnce=false;throw new Error('index write unavailable');}return put(key,...args);};
 await assert.rejects(f.connections.claim(setup.code,await token()),/index write unavailable/);
 assert.equal(await f.connections.resolveOrganization(org),'org_a');
 assert.deepEqual(await f.connections.list(admin),[]);
 await f.make().claim(setup.code,await token());
 assert.equal((await f.connections.list(admin)).length,1);
});

test('a forged tenant index never grants another tenant a connection or shared receipt',async()=>{
 const {createHash}=await import('node:crypto');
 const f=fixture();await f.enroll();
 const hash=createHash('sha256').update('org_b').digest('hex');
 await f.store.put(`capture-v1/identity/replicas-v1/tenants/${hash}/${org}.json`,Buffer.from(JSON.stringify({organizationId:org})));
 const outsider={tenantId:'org_b',userId:'user_admin'};
 assert.deepEqual(await f.connections.list(outsider),[]);
 assert.deepEqual(await f.connections.sharedInstallations(outsider),[]);
 await assert.rejects(f.connections.revoke(outsider,org),status(404));
 assert.equal(await f.connections.resolveOrganization(org),'org_a');
});
