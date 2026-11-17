import test from 'node:test';
import assert from 'node:assert/strict';
import {createContextCheck,lexicalCheckJudgment,CHECK_LIMITS,tokenPrefix} from '../dist/src/search/check.mjs';
const principal={tenantId:'tenant-a',userId:'alice'},input={eventId:'turn-1',currentSession:{harness:'codex',sessionId:'current'},message:'Diagnose queue timeout regression',timestamp:'2026-11-17T12:00:00Z'};
const hit=(n,overrides={})=>({id:'sessions:'+n,source:'sessions',title:'Queue diagnostic',text:'Queue timeout occurs when retry state is reused. '+n,provenance:{sessionId:'prior-'+n,role:'assistant',timestamp:'2026-11-16T12:00:00Z'},...overrides});
function fixture(overrides={}){
  const docs=Array.from({length:24},(_,i)=>hit(i));let searches=0,fetches=0,authorizations=0;
  const search={async search(p,q){assert.deepEqual(p,principal);assert.deepEqual(q.currentSession,input.currentSession);assert.equal(q.includeToolOutputs,false);searches++;return {results:docs};},async fetch(p,q){assert.deepEqual(p,principal);fetches++;const doc=docs.find(d=>d.id===q.id);return {text:doc.text.slice(q.offset,q.offset+q.length)};}};
  const run=createContextCheck({search,judge:lexicalCheckJudgment,authorize:async p=>{assert.deepEqual(p,principal);authorizations++;},...overrides});
  return {run,docs,search,counts:()=>({searches,fetches,authorizations})};
}
test('portable reference returns bounded exact quotes and checks current scope twice',async()=>{
  const f=fixture(),result=await f.run(principal,input);
  assert.equal(result.results.length,5);assert.equal(result.policyVersion,'lexical-v1');assert.ok(result.outputTokens<=CHECK_LIMITS.outputTokens);
  for(const item of result.results)assert.equal(item.text,f.docs.find(d=>d.id===item.id).text.slice(item.offset,item.offset+item.text.length));
  assert.deepEqual(f.counts(),{searches:1,fetches:5,authorizations:2});
});
test('rejects write-only, forged scope and oversized input before retrieval',async()=>{
  const f=fixture();await assert.rejects(f.run({...principal,captureAccess:'write'},input));
  await assert.rejects(f.run({userId:'alice'},input));await assert.rejects(f.run(principal,{...input,message:'x'.repeat(8001)}));
  assert.equal(f.counts().searches,0);
});
test('current chat, future sources, unclassified roles and duplicate passages are excluded',async()=>{
  const f=fixture();f.docs.splice(0,24,hit(1,{provenance:{sessionId:'current',role:'user',timestamp:'2026-11-16T12:00:00Z'}}),hit(2,{provenance:{sessionId:'future',role:'assistant',timestamp:'2026-11-18T12:00:00Z'}}),hit(3,{provenance:{sessionId:'tool',role:'tool',timestamp:'2026-11-16T12:00:00Z'}}),hit(4),hit(5,{text:hit(4).text}));
  const result=await f.run(principal,input);assert.deepEqual(result.results.map(r=>r.id),['sessions:4']);
});
test('content changed after judgment is dropped and revocation before disclosure fails',async()=>{
  const f=fixture();f.search.fetch=async()=>({text:'edited'});assert.equal((await f.run(principal,input)).results.length,0);
  let checks=0;const revoked=fixture({authorize:async()=>{if(++checks===2)throw Object.assign(Error('revoked'),{status:403});}});
  await assert.rejects(revoked.run(principal,input),/revoked/);
});
test('colliding IDs are resolved with the authenticated tenant on search and final fetch',async()=>{
  const seen=[],search={async search(p){seen.push(p.tenantId);return {results:[hit(1,{text:'Queue solution for '+p.tenantId})]};},async fetch(p){seen.push(p.tenantId);return {text:'Queue solution for '+p.tenantId};}};
  const run=createContextCheck({search,judge:lexicalCheckJudgment,authorize:async()=>{}});
  const b={...principal,tenantId:'tenant-b'};const [aResult,bResult]=await Promise.all([run(principal,input),run(b,input)]);
  assert.match(aResult.results[0].text,/tenant-a/);assert.match(bResult.results[0].text,/tenant-b/);assert.equal(seen.filter(x=>x==='tenant-a').length,2);
});
test('invalid judge fanout and aborted calls stop before further reads',async()=>{
  const f=fixture({judge:()=>({...lexicalCheckJudgment(),async plan(){return Array.from({length:4},()=>({query:'queue',match:'any'}));}})});
  await assert.rejects(f.run(principal,input),/queries/);assert.equal(f.counts().searches,0);
  const g=fixture();await assert.rejects(g.run(principal,input,AbortSignal.abort()));assert.equal(g.counts().searches,0);
});
test('quote windows retain exact Unicode text within token limits',()=>{
  const text='😀中文 Queue '.repeat(300),prefix=tokenPrefix(text,200);assert.ok(text.startsWith(prefix));assert.ok(!/[\uD800-\uDBFF]$/.test(prefix));assert.ok(prefix.length<text.length);
});
