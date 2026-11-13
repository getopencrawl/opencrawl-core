// Real HTTP acceptance against this test's disposable capture stack.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const env=Object.fromEntries(readFileSync(new URL('.env',import.meta.url),'utf8').split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>{const at=l.indexOf('=');return [l.slice(0,at),l.slice(at+1)];}));
const [path]=process.argv.slice(2),state=JSON.parse(readFileSync(path,'utf8'));
const api='http://127.0.0.1:'+env.OPENCRAWL_SESSIONS_PORT,headers={authorization:'Bearer '+env.OPENCRAWL_SESSIONS_TOKEN,'content-type':'application/json'};
const send=events=>fetch(api+'/api/sessions/batches',{method:'POST',headers,body:JSON.stringify({schemaVersion:1,owner:state.principal,harness:'codex',origin:'cli',installationId:state.marker,sessionId:state.marker,attachments:[],events})});
const original={id:state.marker,kind:'message',data:{role:'user',content:state.marker}};
assert.equal((await send([original])).status,200,'legacy event retry');
assert.equal((await send([{...original,data:{content:'conflict'}}])).status,409,'legacy content conflict');
const added={id:state.marker+'-postgres',kind:'message',data:{role:'user',content:state.marker+' postgres upgrade accepted'}};
const response=await send([added]);assert.equal(response.status,200);
const receipt=(await response.json()).data;
const stored=await fetch(api+'/api/sessions/batches?'+new URLSearchParams({...state.receipt,batchId:receipt.batchId}),{headers});
assert.equal(stored.status,200);assert.deepEqual((await stored.json()).data.events,[added]);
writeFileSync(path+'.identity-upgrade.json',JSON.stringify({legacyRetry:true,conflictRejected:true,newEventStored:true}),{mode:0o600});
console.log('Legacy retry, conflict protection and new PostgreSQL capture verified.');
