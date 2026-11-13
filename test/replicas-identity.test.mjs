import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, SignJWT} from 'jose';
import {createReplicasWorkloads, replicasBindings, isReplicasToken, REPLICAS_ISSUER} from '../dist/src/identity/replicas.mjs';

const org='11111111-1111-4111-8111-111111111111',env='22222222-2222-4222-8222-222222222222',workspace='33333333-3333-4333-8333-333333333333';
const audience='https://operator.example';
const keys=await generateKeyPair('RS256'),otherKeys=await generateKeyPair('RS256');
const second=Math.floor(Date.now()/1000);
async function token(changes={},privateKey=keys.privateKey){return new SignJWT({iss:REPLICAS_ISSUER,aud:audience,sub:`org:${org}:env:${env}:workspace:${workspace}`,organization_id:org,environment_id:env,workspace_id:workspace,iat:second,exp:second+900,...changes}).setProtectedHeader({alg:'RS256'}).sign(privateKey);}
function fixture(){let allowed=[{organizationId:org,environmentId:env,tenantId:'org_local'}],clock=second*1000;const auth=createReplicasWorkloads({audience,key:async()=>keys.publicKey,bindings:()=>allowed,now:()=>clock});return {auth,revoke(){allowed=[];},expire(){clock+=901000;}};}

test('operator binding creates a distinct workspace identity, never a human identity',async()=>{
 const {auth}=fixture();const result=await auth.identify(await token({creator_id:org,creator_email:'admin@operator.example'}));
 assert.equal(result.status,200);assert.equal(result.principal.tenantId,'org_local');assert.match(result.principal.userId,/^workload_replicas_/);assert.equal(result.user.email,null);
 assert.equal(await auth.revalidate(result.principal,'org_local'),result.principal);
 await assert.rejects(auth.revalidate({...result.principal}),/denied/);
 await assert.rejects(auth.revalidate(result.principal,'org_other'),/denied/);
});
test('forged signatures, issuer/audience/scope mismatch and stale credentials fail closed',async()=>{
 const {auth}=fixture();
 for(const changes of [{iss:'https://attacker.example'},{aud:'https://other.example'},{aud:[audience,'https://other.example']},{sub:'forged'},{exp:second-1},{iat:second+1},{exp:second+901},{workspace_id:'not-a-uuid'}])assert.equal((await auth.identify(await token(changes))).status,401,JSON.stringify(changes));
 assert.equal((await auth.identify(await token({},otherKeys.privateKey))).status,401);
 assert.equal((await auth.identify('not-a-token')).status,401);
 const outsider='44444444-4444-4444-8444-444444444444';
 assert.equal((await auth.identify(await token({environment_id:outsider,sub:`org:${org}:env:${outsider}:workspace:${workspace}`}))).status,403);
});
test('revocation and expiration recheck before releasing results',async()=>{
 const f=fixture(),r=await f.auth.identify(await token());assert.equal(r.status,200);f.revoke();await assert.rejects(f.auth.revalidate(r.principal),/revoked/);assert.equal((await f.auth.identify(await token())).status,403);
 const g=fixture(),s=await g.auth.identify(await token());g.expire();await assert.rejects(g.auth.revalidate(s.principal),/denied/);
});
test('bindings reject collisions and cannot override a self-hosted tenant',()=>{
 const value=JSON.stringify([{organizationId:org,environmentId:env}]);assert.equal(replicasBindings(value,'org_local')[0].tenantId,'org_local');
 assert.throws(()=>replicasBindings(JSON.stringify([{organizationId:org,environmentId:env,tenantId:'org_other'}]),'org_local'));
 assert.throws(()=>replicasBindings(JSON.stringify([{organizationId:org,environmentId:env,tenantId:'org_a'},{organizationId:org,environmentId:env,tenantId:'org_b'}])));
 assert.equal(isReplicasToken('bad'),false);
});
test('key discovery outages fail closed and remain retryable',async()=>{
 const auth=createReplicasWorkloads({audience,key:async()=>{throw new Error('network unavailable');},bindings:()=>[{organizationId:org,environmentId:env,tenantId:'org_local'}]});
 assert.equal((await auth.identify(await token())).status,503);
});
