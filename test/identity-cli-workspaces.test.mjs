import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPairSync, sign} from 'node:crypto';
import {cliIdentity} from '../dist/src/identity/cli.mjs';

const member = (organizationId, changes = {}) => ({id:'om_'+organizationId, userId:'user_test', organizationId, status:'active', ...changes});
async function fixture(t, settings = {}) {
  const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength:2048});
  const jwk = {...publicKey.export({format:'jwk'}),kid:'cli-workspaces',alg:'RS256'};
  const server = createServer((_req,res) => {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({keys:[jwk]}));});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const state = {members:[],verified:true,userId:'user_test',sessionUserId:'user_test',sessionStatus:'active',membershipFailure:false,paginationFailure:false};
  const membershipReads = [], organizationReads = [];
  const sdk = {userManagement:{
    getJwksUrl:()=>'http://127.0.0.1:'+server.address().port,
    getUser:async()=>({id:state.userId,email:'test@example.test',emailVerified:state.verified}),
    listSessions:async()=>({data:[{id:'session_test',userId:state.sessionUserId,status:state.sessionStatus,endedAt:null,expiresAt:new Date(Date.now()+60_000)}],listMetadata:{after:null}}),
    listOrganizationMemberships:async input=>{
      membershipReads.push(input);
      if(state.membershipFailure)throw new Error('Private membership failure');
      return {data:state.members.slice(0,1),autoPagination:async()=>{if(state.paginationFailure)throw new Error('Private pagination failure');return state.members;}};
    },
  },organizations:{getOrganization:async id=>{organizationReads.push(id);return {id,name:'Team '+id};}}};
  const identify = cliIdentity({clientId:'client_test',...settings},sdk);
  const token = (claims = {}) => {
    const now = Math.floor(Date.now()/1000);
    const body = [{alg:'RS256',kid:'cli-workspaces'},{iss:'https://api.workos.com/user_management/client_test',sub:'user_test',sid:'session_test',auth_time:now,iat:now,exp:now+300,...claims}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return 'Bearer '+body+'.'+sign('RSA-SHA256',Buffer.from(body),privateKey).toString('base64url');
  };
  return {state,sdk,identify,token,membershipReads,organizationReads};
}

test('CLI organization choices come only from the current user active memberships across all pages',async t=>{
  const f=await fixture(t);
  f.state.members=[member('org_a'),member('org_a'),member('org_b'),member('org_other',{userId:'user_other'}),member('org_inactive',{status:'inactive'}),member('org_pending',{status:'pending'}),member('../../org_invalid')];
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:403,code:'ORGANIZATION_REQUIRED',workspaces:[{id:'org_a',name:'Team org_a'},{id:'org_b',name:'Team org_b'}]});
  assert.deepEqual(f.membershipReads,[{userId:'user_test',statuses:['active'],limit:100}]);
  assert.deepEqual(f.organizationReads,['org_a','org_b']);
});

test('CLI no-membership and single-membership admission do not enumerate organization names',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:403,code:'ORGANIZATION_REQUIRED',workspaces:[]});
  f.state.members=[member('org_a')];
  const admitted=await f.identify(f.token(),{capture:true});
  assert.equal(admitted.status,200);assert.equal(admitted.principal.tenantId,'org_a');
  assert.equal(f.membershipReads.length,2);assert.deepEqual(f.organizationReads,[]);
  const reads=f.membershipReads.length;
  assert.equal((await f.identify(f.token())).status,200);
  assert.equal(f.membershipReads.length,reads,'non-capture identity does not enumerate memberships');
});

test('CLI malformed and stale explicit organization claims cannot disclose other choices',async t=>{
  const f=await fixture(t);f.state.members=[member('org_a'),member('org_b')];
  for(const org_id of ['../../org_a','org_a/path',{},['org_a'],7]) {
    assert.deepEqual(await f.identify(f.token({org_id}),{capture:true}),{status:403,code:'ORGANIZATION_REQUIRED',workspaces:[]});
  }
  assert.deepEqual(f.membershipReads,[]);assert.deepEqual(f.organizationReads,[]);
  assert.deepEqual(await f.identify(f.token({org_id:'org_removed'}),{capture:true}),{status:403,code:'ORGANIZATION_REQUIRED',workspaces:[]});
  assert.deepEqual(f.membershipReads,[{userId:'user_test',organizationId:'org_removed',statuses:['active'],limit:100}]);
  assert.deepEqual(f.organizationReads,[]);
  const selected=await f.identify(f.token({org_id:'org_b'}),{capture:true});
  assert.equal(selected.status,200);assert.equal(selected.principal.tenantId,'org_b');
});

test('CLI fixed-organization identity never lists another organization or accepts a mismatched claim',async t=>{
  const f=await fixture(t,{organizationId:'org_fixed'});
  f.state.members=[member('org_fixed'),member('org_other')];
  assert.equal((await f.identify(f.token(),{capture:true})).principal.tenantId,'org_fixed');
  f.state.members=[member('org_other')];
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:403,code:'ORGANIZATION_REQUIRED',workspaces:[]});
  const reads=f.membershipReads.length;
  for(const org_id of ['org_other','../../org_fixed',{},7]) assert.deepEqual(await f.identify(f.token({org_id}),{capture:true}),{status:403,code:'ORGANIZATION_REQUIRED',workspaces:[]});
  assert.equal(f.membershipReads.length,reads);
  assert.ok(f.membershipReads.every(input=>input.organizationId==='org_fixed'));
  assert.deepEqual(f.organizationReads,[]);
  assert.throws(()=>cliIdentity({clientId:'client_test',organizationId:'../invalid'},f.sdk),/Configure one organization/);
});

test('CLI organization names are best effort and only accepted for the exact verified ID',async t=>{
  const f=await fixture(t);f.state.members=[member('org_a'),member('org_b'),member('org_c')];
  f.sdk.organizations.getOrganization=async id=>{
    f.organizationReads.push(id);
    if(id==='org_a')throw new Error('Private organization failure');
    if(id==='org_b')return {id:'org_foreign',name:'Private foreign workspace'};
    return {id,name:123};
  };
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:403,code:'ORGANIZATION_REQUIRED',workspaces:[{id:'org_a',name:null},{id:'org_b',name:null},{id:'org_c',name:null}]});
  assert.deepEqual(f.organizationReads,['org_a','org_b','org_c']);
});

test('CLI membership lookup or pagination failures return unavailable without workspace choices',async t=>{
  const f=await fixture(t);f.state.members=[member('org_a'),member('org_b')];
  f.state.membershipFailure=true;
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:503});
  f.state.membershipFailure=false;f.state.paginationFailure=true;
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:503});
  assert.deepEqual(f.organizationReads,[]);
});

test('CLI workspace choices require a verified current account and an active owned session',async t=>{
  const f=await fixture(t);f.state.members=[member('org_a'),member('org_b')];
  f.state.verified=false;
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:403});
  f.state.verified=true;f.state.userId='user_other';
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:401});
  f.state.userId='user_test';f.state.sessionStatus='revoked';
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:401});
  f.state.sessionStatus='active';f.state.sessionUserId='user_other';
  assert.deepEqual(await f.identify(f.token(),{capture:true}),{status:401});
  assert.equal(f.membershipReads.length,4);
  assert.ok(f.membershipReads.every(input=>input.userId==='user_test'));
  assert.deepEqual(f.organizationReads,[],'parallel membership reads never disclose choices for a rejected account/session');
});

test('CLI live account, session and membership reads overlap without caching the next request',async t=>{
  const f=await fixture(t);f.state.members=[member('org_a')];
  let started=0,release,timedOut=false;
  const barrier=new Promise(resolve=>{release=resolve;});
  for(const key of ['getUser','listSessions','listOrganizationMemberships']){
    const original=f.sdk.userManagement[key];
    f.sdk.userManagement[key]=async(...args)=>{if(++started===3)release();await barrier;return original(...args);};
  }
  const timeout=setTimeout(()=>{timedOut=true;release();},1000);t.after(()=>clearTimeout(timeout));
  assert.equal((await f.identify(f.token(),{capture:true})).status,200);
  assert.equal(started,3);
  assert.equal(timedOut,false,'independent checks must all start before any finishes');
  f.state.sessionStatus='revoked';
  assert.equal((await f.identify(f.token(),{capture:true})).status,401);
  assert.equal(started,6,'no completed authorization is cached across requests');
});
