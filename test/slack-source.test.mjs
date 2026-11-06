import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createSlackFileCapture} from '../src/connectors/slack-source-files.mjs';
import {createSlackHttpSource,slackDownloadUrl} from '../src/connectors/slack-source-http.mjs';
import {createConnectorPipeline} from '../src/connectors/pipeline.mjs';
const binding={tenantId:'tenant-a',connectionId:'conn',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=conn/'};
const input={runId:'run-1',cutoff:1000};
function setup(handler) {
 const objects=new Map(),calls=[];let clock=1000,active=true;
 const store={bucket:'customer-owned',get:async k=>objects.get(k),put:async(k,v)=>objects.set(k,Buffer.from(v))};
 const capture=createSlackFileCapture({binding,store,now:()=>clock,checkActive:async()=>{if(!active)throw Error('revoked');},request:async(method,query)=>{calls.push({method,query});return handler(method,query);},download:async()=>({bytes:Buffer.from('Complete document body far beyond preview'),mediaType:'text/markdown'})});
 return {capture,objects,calls,store,advance:()=>{clock+=70000;},revoke:()=>{active=false;}};
}
const ok=data=>({status:200,data:{ok:true,...data}});
test('customer-operated capture exhausts channels, files and comments; lands originals before searchable envelopes',async()=>{
 const h=setup((method,q)=>{
  if(method==='conversations.list')return ok({channels:q.cursor?[{id:'C2',is_private:false}]:[{id:'C1',is_private:false}],response_metadata:{next_cursor:q.cursor?'':'next'}});
  if(method==='files.list')return ok({files:[{id:'F1'}],paging:{page:q.page,pages:q.channel==='C1'?2:1}});
  return ok({file:{id:'F1',title:'Title',mimetype:'text/markdown',channels:['C1','C2']},comments:[{id:q.cursor?'Fc2':'Fc1',comment:q.cursor?'Final comment beyond first page':'First comment'}],response_metadata:{next_cursor:q.cursor?'':'last'}});
 });
 let result;for(let i=0;i<20;i++){result=await h.capture.step(input);if(result.done)break;h.advance();}
 assert.equal(result.done,true);assert.equal(result.failed,0);assert.equal(h.calls.filter(x=>x.method==='files.list').length,3);assert.equal(h.calls.filter(x=>x.method==='files.info').length,2);
 const sourceKeys=[...h.objects.keys()].filter(k=>k.includes('stream=file_documents/'));
 const records=sourceKeys.flatMap(k=>gunzipSync(h.objects.get(k)).toString().trim().split('\n').map(JSON.parse));
 assert.equal(records.length,2);assert.deepEqual(records.map(r=>r._airbyte_data.channel_id),['C1','C2']);
 assert.ok(records.every(r=>r._airbyte_data.api_text.some(p=>p.text==='Final comment beyond first page')));
 const writes=[];const search={identity:'selfhost',putDocuments:async(_,__,docs)=>writes.push(...docs)};
 const pipeline=createConnectorPipeline({binding,store:h.store,search});for(const key of sourceKeys)await pipeline.processObject({key});
 assert.ok(writes.some(d=>d.document.text.includes('Complete document body far beyond preview')));
 assert.ok(writes.some(d=>d.document.text.includes('Final comment beyond first page')));
});
test('rate limits persist retry timing and retries do not advance a failed page',async()=>{
 let attempted=0;const h=setup(()=>++attempted===1?{status:429,headers:{'Retry-After':'90'},data:{ok:false,error:'ratelimited'}}:ok({channels:[]}));
 assert.equal((await h.capture.step(input)).waitMs,90000);await h.capture.step(input);assert.equal(h.calls.length,1);h.advance();await h.capture.step(input);assert.equal(h.calls.length,1);h.advance();await h.capture.step(input);assert.equal(h.calls.length,2);
});
test('private enumeration, checkpoint scope mismatch and revocation fail closed',async()=>{
 const h=setup(()=>ok({channels:[{id:'C1',is_private:true}]}));await assert.rejects(h.capture.step(input),/public channel/);
 const b=setup(()=>ok({channels:[]}));await b.capture.step(input);const key=[...b.objects.keys()].find(k=>k.endsWith('state.json'));const state=JSON.parse(b.objects.get(key));state.scope='other';b.objects.set(key,Buffer.from(JSON.stringify(state)));await assert.rejects(b.capture.step(input),/scope/);
 b.revoke();await assert.rejects(b.capture.step(input),/revoked/);
});
test('provider errors remain failures and an explicit lost public share emits unavailable metadata',async()=>{
 const h=setup((method)=>method==='conversations.list'?ok({channels:[{id:'C1',is_private:false}]}):method==='files.list'?ok({files:[{id:'F1'},{id:'F2'}],paging:{page:1,pages:1}}):h.calls.at(-1).query.file==='F1'?ok({file:{id:'F1',channels:[]}}):{status:200,data:{ok:false,error:'access_denied'}});
 let result;for(let i=0;i<10;i++){result=await h.capture.step(input);if(result.done)break;h.advance();}
 assert.equal(result.failed,1);const key=[...h.objects.keys()].find(k=>k.includes('stream=file_documents/'));assert.equal(JSON.parse(gunzipSync(h.objects.get(key)))._airbyte_data.available,false);
});
test('reference HTTP adapter never sends source tokens to arbitrary download destinations',async()=>{
 let calls=0;const api=createSlackHttpSource({token:'test',fetch:async()=>{calls++;throw Error('should not request');}});
 for(const url of ['https://attacker.example/file','http://files.slack.com/file','https://user:pass@files.slack.com/file','https://files.slack.com:8443/file'])await assert.rejects(api.download({url_private:url}));
 assert.equal(calls,0);assert.throws(()=>slackDownloadUrl({is_external:true,url_private:'https://files.slack.com/file'}));
});
