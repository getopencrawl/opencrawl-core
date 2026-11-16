import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, SignJWT} from 'jose';
import {createDevinConnections} from '../dist/src/identity/devin-connections.mjs';
import {createDevinVerifier, createDevinWorkloads, DEVIN_ISSUER} from '../dist/src/identity/devin.mjs';
import {createReplicasConnections} from '../dist/src/identity/replicas-connections.mjs';
import {createReplicasVerifier, REPLICAS_ISSUER} from '../dist/src/identity/replicas.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
import {memoryApplicationState} from './fixtures/memory-application-state.mjs';

const org='org-11111111111141118111111111111111', other='org-22222222222242228222222222222222';
const keys=await generateKeyPair('RS256'), audience='https://operator.example', second=Math.floor(Date.now()/1000);
const admin={tenantId:'org_a',userId:'user_admin'}, member={...admin,organizationId:admin.tenantId,status:'active',role:{slug:'admin'}};
const status=expected=>error=>error.status===expected;
async function token(changes={}) {return new SignJWT({iss:DEVIN_ISSUER,aud:audience,sub:`org_id:${org}`,org_id:org,devin_id:'session-one',iat:second,exp:second+900,...changes}).setProtectedHeader({alg:'RS256'}).sign(keys.privateKey);}
function fixture(options={}) {
  const state=memoryApplicationState();let clock=second*1000,active=true;
  const verify=createDevinVerifier({audience,key:async()=>keys.publicKey,now:()=>clock});
  const make=()=>createDevinConnections({state,verify,isAdmin:async p=>active&&p.userId==='user_admin',now:()=>clock,...options});
  const connections=make();
  const auth=createDevinWorkloads({audience,key:async()=>keys.publicKey,resolveOrganization:connections.resolveOrganization,now:()=>clock});
  return {state,make,connections,auth,advance(ms){clock+=ms;},removeAdmin(){active=false;},async enroll(){const setup=await connections.issue(admin,member);await connections.claim(setup.code,await token());return setup;}};
}

test('one Devin organization approval survives restart and admits fresh sessions with distinct owners',async()=>{
  const f=fixture();assert.equal((await f.auth.identify(await token())).status,403);
  await f.enroll();assert.equal(await f.make().resolveOrganization(org),'org_a');
  const first=await f.auth.identify(await token()),fresh=await f.auth.identify(await token({devin_id:'fresh-session'}));
  assert.equal(first.status,200);assert.equal(fresh.status,200);
  assert.notEqual(first.principal.userId,fresh.principal.userId);assert.equal(fresh.principal.tenantId,'org_a');
  assert.equal((await f.auth.identify(await token({org_id:other,sub:`org_id:${other}`}))).status,403);
  assert.equal(f.connections.migrateApprovedConnections,undefined);
});

test('Devin setup binds current admin approval to one signed session, never a requester email or caller tenant',async()=>{
  const f=fixture(),setup=await f.connections.issue(admin,member);
  for(const changes of [{userId:'someone-else'},{organizationId:'org_b'},{status:'inactive'},{role:{slug:'member'}}])await assert.rejects(f.connections.issue(admin,{...member,...changes}),status(403));
  await assert.rejects(f.connections.claim(setup.code,await token({aud:'https://elsewhere.example'})),status(401));
  assert.equal([...f.state.devin.setups.keys(),...Array.from(f.state.devin.setups.values(),v=>JSON.stringify(v))].some(v=>v.includes(setup.code)),false);
  const claimed=await f.connections.claim(setup.code,await token({requesting_user_email:'admin@operator.example'}));
  assert.deepEqual(await f.make().claim(setup.code,await token()),claimed);
  await assert.rejects(f.connections.claim(setup.code,await token({devin_id:'different-session'})),status(409));
  await assert.rejects(f.connections.claim(setup.code,await token({org_id:other,sub:`org_id:${other}`})),status(409));
  const abandoned=await f.connections.issue(admin,member);f.removeAdmin();
  await assert.rejects(f.connections.claim(abandoned.code,await token()),status(403));
});

test('Devin concurrent tenant claims cannot move an organization and a mis-scoped repository result cannot expose it',async()=>{
  const f=fixture(),b={...admin,tenantId:'org_b'},mb={...member,organizationId:'org_b'};
  const [aCode,bCode]=await Promise.all([f.connections.issue(admin,member),f.connections.issue(b,mb)]);
  const results=await Promise.allSettled([f.connections.claim(aCode.code,await token()),f.connections.claim(bCode.code,await token())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
  const tenant=await f.connections.resolveOrganization(org),outsider=tenant==='org_a'?b:admin;
  const record=(await f.state.devin.readConnection(org)).record;
  f.state.devin.listConnections=async()=>[record];
  assert.deepEqual(await f.connections.list(outsider),[]);
  await assert.rejects(f.connections.revoke(outsider,org),status(404));
});

test('Devin revocation blocks prior sessions and old setup prompts; fresh approval is required',async()=>{
  const f=fixture(),setup=await f.enroll(),identity=await f.auth.identify(await token());
  f.advance(1000);await f.connections.revoke(admin,org);
  await assert.rejects(f.auth.revalidate(identity.principal),status(403));
  await assert.rejects(f.connections.claim(setup.code,await token()),status(409));
  f.advance(1000);await f.enroll();assert.equal((await f.auth.identify(await token())).status,200);
  const expired=fixture(),pending=await expired.connections.issue(admin,member);expired.advance(30*60*1000);
  await assert.rejects(expired.connections.claim(pending.code,await token({iat:second+1800,exp:second+2700})),status(403));
});

test('Devin enrollment cannot fabricate readiness and self-host cannot bind another tenant',async()=>{
  const f=fixture({tenantId:'org_a'});await f.enroll();
  await assert.rejects(f.connections.issue({...admin,tenantId:'org_b'},{...member,organizationId:'org_b'}),status(403));
  const identity=await f.auth.identify(await token());
  const onboarding=createOnboardingStatus({state:f.state,sharedInstallations:p=>f.connections.sharedInstallations(p),onSharedReady:p=>f.connections.confirmInstallation(p)});
  assert.equal((await onboarding.read(admin)).shared,undefined);
  await onboarding.cli(identity.principal);await onboarding.mcpTest(identity.principal);
  assert.equal((await onboarding.read(admin)).shared,undefined);
  await onboarding.session(identity.principal,{harness:'devin',captureMode:'live',events:[{kind:'message'}]});
  assert.ok((await onboarding.read(admin)).shared);
  assert.equal((await f.connections.list(admin))[0].installations[0].name,'Devin Cloud');
  await assert.rejects(f.connections.revoke(identity.principal,org),status(403));
});

test('Devin and Replicas keep approvals, colliding organization IDs and revocation separate',async()=>{
  const org='11111111-1111-4111-8111-111111111111';
  const f=fixture(),replicasAdmin={...admin,tenantId:'org_b'},replicasMember={...member,organizationId:'org_b'};
  const replicas=createReplicasConnections({state:f.state,
    verify:createReplicasVerifier({audience,key:async()=>keys.publicKey,now:()=>second*1000}),
    isAdmin:async p=>p.userId===admin.userId,now:()=>second*1000});
  const env='33333333-3333-4333-8333-333333333333',workspace='44444444-4444-4444-8444-444444444444';
  // Even a shared test signing key cannot erase the pinned issuer boundary.
  const replicasToken=await new SignJWT({iss:REPLICAS_ISSUER,aud:audience,
    sub:`org:${org}:env:${env}:workspace:${workspace}`,organization_id:org,environment_id:env,workspace_id:workspace,
    iat:second,exp:second+900}).setProtectedHeader({alg:'RS256'}).sign(keys.privateKey);
  const devinToken=await token({org_id:org,sub:`org_id:${org}`}),devinSetup=await f.connections.issue(admin,member),replicasSetup=await replicas.issue(replicasAdmin,replicasMember);
  await assert.rejects(f.connections.claim(devinSetup.code,replicasToken),status(401));
  await assert.rejects(replicas.claim(replicasSetup.code,devinToken),status(401));
  await assert.rejects(f.connections.claim(replicasSetup.code,devinToken),status(403));
  await assert.rejects(replicas.claim(devinSetup.code,replicasToken),status(403));
  await f.connections.claim(devinSetup.code,devinToken);
  await replicas.claim(replicasSetup.code,replicasToken);
  assert.equal(await f.connections.resolveOrganization(org),'org_a');
  assert.equal(await replicas.resolveOrganization(org),'org_b');
  assert.deepEqual(await f.connections.list(replicasAdmin),[]);
  assert.deepEqual(await replicas.list(admin),[]);
  await f.connections.revoke(admin,org);
  assert.equal(await f.connections.resolveOrganization(org),null);
  assert.equal(await replicas.resolveOrganization(org),'org_b');
});
