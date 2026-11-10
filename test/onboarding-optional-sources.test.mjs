import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGuidedOnboarding} from '../dist/src/application/onboarding.mjs';
import {integrationRequest} from '../dist/src/application/integration-http.mjs';
import {createOnboardingStatus} from '../dist/src/onboarding-status.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const principal={tenantId:'org_team',userId:'user_owner'};
async function guidedFixture({agentSetup=true,cards=[]}={}) {
  const store=memorySessionStore(),onboarding=createOnboardingStatus({store,prefix:'sessions/test/v1'}),events=[];
  if(agentSetup){await onboarding.cli(principal);await onboarding.mcpTest(principal);await onboarding.session(principal,{harness:'codex',events:[{kind:'message'}]});}
  let outage=false;
  const guided=createGuidedOnboarding({onboarding,integrations:{list:async who=>{assert.deepEqual(who,principal);if(outage)throw new Error('private upstream');return cards;}},
    organizations:{},track:(name,who,properties)=>{events.push({name,who,properties});},smallJson:async()=>({})});
  const finish=async()=>{let response;await guided.handle({method:'POST'},{route:{name:'/api/onboarding/finish'},principal,identity:{user:{}},member:{},respond:(status,body)=>{response={status,body:JSON.parse(body)};}});return response;};
  return {guided,onboarding,events,finish,failSources:()=>{outage=true;}};
}
const card=state=>({provider:'slack',name:'Slack',auth:'oauth',state});

test('finishing onboarding needs agent setup only and records how many sources were connected',async()=>{
  const skipped=await guidedFixture({cards:[card('disconnected'),card('connecting')]});
  assert.equal(await skipped.guided.next(principal),'/onboarding/sources','an unfinished setup with nothing connected resumes at Sources');
  assert.deepEqual(await skipped.finish(),{status:200,body:{workspaceUrl:'/'}});
  assert.ok((await skipped.onboarding.read(principal)).completed.observedAt);
  assert.deepEqual(skipped.events,[{name:'onboarding_completed',who:principal,properties:{sources_connected:0}}],'a skipped Sources step is recorded as zero connected sources');
  assert.deepEqual(await skipped.finish(),{status:200,body:{workspaceUrl:'/'}});
  assert.equal(skipped.events.length,1,'a repeated finish records no second completion');

  const connected=await guidedFixture({cards:[card('syncing'),card('synced'),card('error')]});
  assert.equal(await connected.guided.next(principal),'/onboarding/invite');
  assert.equal((await connected.finish()).status,200);
  assert.deepEqual(connected.events.map(event=>event.properties),[{sources_connected:2}]);

  const outage=await guidedFixture();outage.failSources();
  assert.equal((await outage.finish()).status,200,'a source outage never blocks finishing');
  assert.deepEqual(outage.events.map(event=>event.properties),[{sources_connected:null}]);
});

test('skipping sources never skips agent setup',async()=>{
  const f=await guidedFixture({agentSetup:false,cards:[card('synced')]});
  assert.deepEqual(await f.finish(),{status:409,body:{error:'Complete agent setup first.',onboardingUrl:'/onboarding'}});
  assert.equal((await f.onboarding.read(principal)).completed,null);assert.deepEqual(f.events,[]);
  assert.equal(await f.guided.next(principal),'/onboarding');
});

test('a connect refused for our own stated reason keeps that reason; only a live connection is already connected',async()=>{
  const act=async(action,error)=>{
    let response;
    await integrationRequest({},new URL(`https://self.example/api/integrations/slack/${action}`),{name:'integration-action',provider:'slack',action},{
      integrations:{[action]:async()=>{throw error;}},providers:{slack:{id:'slack',name:'Slack',auth:'oauth'}},principal,onboarding:null,guided:{},
      respond:(status,body)=>{response={status,body:JSON.parse(body)};},message:()=>assert.fail(),document:()=>assert.fail(),
    });
    return response;
  };
  const storage='Your team’s storage isn’t ready yet. Reload this page, then connect again.';
  assert.deepEqual(await act('connect',Object.assign(new Error(storage),{status:409,expose:true})),{status:409,body:{error:{code:'NOT_READY',message:storage}}});
  const pending='Connection setup is waiting for an earlier request to finish.';
  assert.deepEqual(await act('retry',Object.assign(new Error(pending),{status:409,expose:true})),{status:409,body:{error:{code:'NOT_READY',message:pending}}});
  // An unexposed conflict is the live-connection case; its internal text never reaches the browser.
  assert.deepEqual(await act('connect',Object.assign(new Error('Already connected'),{status:409})),{status:409,body:{error:{code:'ALREADY_CONNECTED',message:'Slack is already connected.'}}});
});
