import {document} from '../dist/src/application/presentation.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createCaptureCredentials} from '../dist/src/sessions/credentials.mjs';
import {standaloneCapture} from '../dist/src/sessions/standalone.mjs';
import {cloudSetupScript,captureSetupPrompt,cloudCapturePage} from '../dist/src/sessions/cloud-setup.mjs';
import {memorySessionStore as memory} from './session-store-fixture.mjs';
const owner={tenantId:'fixed',userId:'owner'};
test('capture delegation is hashed, scoped, expiring and revocable',async()=>{
 const store=memory();let now=0;const credentials=createCaptureCredentials({store,now:()=>now});
 const issued=await credentials.issue(owner);
 assert.ok(![...store.data.values()].some(value=>value.toString().includes(issued.token)));
 const delegated=await credentials.authenticate(issued.token);assert.equal(delegated.captureAccess,'write');
 await assert.rejects(credentials.issue(delegated),{status:403});
 await assert.rejects(credentials.revoke({...owner,tenantId:'other'},issued.id),{status:403});
 await assert.rejects(credentials.revoke({...owner,userId:'other'},issued.id),{status:403});
 assert.equal(await credentials.authenticate(issued.token+'x'),null);
 now=Date.parse(issued.expiresAt);assert.equal(await credentials.authenticate(issued.token),null);
 now=0;await credentials.revoke(owner,issued.id);assert.equal(await credentials.authenticate(issued.token),null);
});
test('self-hosted delegation uploads under its fixed owner but cannot read, search, delegate or revoke',async t=>{
 const store=memory(),token='self-hosted-admin-token-01234567890123456789';
 let principal=owner;
 const server=createServer((req,res)=>standaloneCapture({token,principal,store})(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(path,auth=token,method='GET',body)=>fetch(base+'/api/sessions/'+path,{method,headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 const issued=(await (await request('credentials',token,'POST')).json()).data;
 const identity=await (await request('identity',issued.token)).json();assert.equal(identity.data.principal.userId,'owner');
 const batch={schemaVersion:1,owner,installationId:'cloud',sessionId:'session',harness:'claude-code',origin:'cloud',events:[{id:'event',kind:'message',data:{role:'user',content:'cloud fixture'}}],attachments:[]};
 assert.equal((await request('batches',issued.token,'POST',batch)).status,200);
 assert.equal((await request('batches',issued.token,'POST',{...batch,owner:{...owner,tenantId:'forged'}})).status,403);
 for(const [path,method] of [['search','GET'],['batches','GET'],['credentials','POST'],['credentials/'+issued.id,'DELETE']])assert.equal((await request(path,issued.token,method)).status,403);
 assert.equal((await fetch(base+'/api/onboarding',{headers:{authorization:'Bearer '+issued.token}})).status,403);
 assert.equal((await fetch(base+'/api/onboarding',{headers:{authorization:'Bearer '+token}})).status,200);
 principal={...owner,userId:'new-owner'};assert.equal((await request('identity',issued.token)).status,401);principal=owner;
 assert.equal((await request('credentials/'+issued.id,token,'DELETE')).status,200);
 assert.equal((await request('identity',issued.token)).status,401);
});
test('shared setup prompt covers consent, every environment, startup awareness and verified capture',()=>{
 const api='https://capture.example.com',prompt=captureSetupPrompt(api),script=cloudSetupScript(api);
 for(const text of ['all coding agents and environments','human-required steps','fresh session','stored receipt','recording consent',api+'/capture/cloud',api+'/mcp',api+' --no-browser --json','global instructions','opencrawl board instructions','stable session identity','native context-notification','automatic transport receipts','explicit consent to import all available history','Skip only declined sources'])assert.ok(prompt.includes(text),text);
 assert.ok(!prompt.includes('--backfill skip'));
 assert.ok(!prompt.includes('https://app.getopencrawl.com'));
 assert.ok(script.includes('--harness claude-code --defer-auth --backfill skip'));
 for(const text of ['collect backfill --dry-run','--harness <claude-code|codex|all> --yes','keep unanswered choices pending'])assert.ok(prompt.includes(text));
 // One consent question covers everything capture shares, before any import.
 for(const text of ['one consent question','native agent memory files','without automatic secret redaction','codexHooksAwaitingReview','never write hook trust','login --api '+api+' --json so my browser opens'])assert.ok(prompt.includes(text),text);
 assert.ok(prompt.indexOf('collect backfill --dry-run')<prompt.indexOf('one consent question that'),'preview counts precede the consent question');
 assert.ok(!script.includes('login'));assert.ok(!script.includes('systemctl'));
 assert.throws(()=>cloudSetupScript('https://capture.example.com/path'));
 const page=document(cloudCapturePage({api,credential:{token:'<secret>',id:'abc',expiresAt:'2027-11-05'}}));
 assert.ok(page.includes('\\u003csecret\\u003e'));assert.ok(!page.includes('<secret>'));assert.doesNotMatch(page, /<textarea|<form/);
});

test('owner revocation permanently invalidates old delegations without affecting another user or workspace',async()=>{
 const store=memory(),credentials=createCaptureCredentials({store});
 const first=await credentials.issue(owner),second=await credentials.issue(owner);
 const otherUser=await credentials.issue({...owner,userId:'other'}),otherTeam=await credentials.issue({...owner,tenantId:'other'});
 // Legacy records without a generation are valid until the first owner revocation.
 const key=[...store.data.keys()].find(key=>key.endsWith(first.id+'.json'));
 const record=JSON.parse(store.data.get(key));delete record.generation;await store.put(key,JSON.stringify(record));
 assert.ok(await credentials.authenticate(first.token));
 await credentials.revokeAll(owner);
 assert.equal(await credentials.authenticate(first.token),null);assert.equal(await credentials.authenticate(second.token),null);
 assert.ok(await credentials.authenticate(otherUser.token));assert.ok(await credentials.authenticate(otherTeam.token));
 const fresh=await credentials.issue(owner);assert.ok(await credentials.authenticate(fresh.token));
 await assert.rejects(credentials.revokeAll(await credentials.authenticate(fresh.token)),{status:403});
 await credentials.revokeAll(owner);assert.equal(await credentials.authenticate(fresh.token),null);
});
