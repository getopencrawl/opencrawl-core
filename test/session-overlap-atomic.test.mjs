import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sessionOverlap} from '../dist/src/sessions/overlap.mjs';

const now=Date.parse('2026-11-14T12:00:00Z'),principal={tenantId:'org_atomic',userId:'alice'};
const bucket=(userId,sessionId,subagents=0)=>({key:[userId,'codex',sessionId],doc_count:2,first:{value:now-3600000},last:{value:now},subagents:{value:subagents}});
const page=(buckets,otherDocs=0)=>({timed_out:false,_shards:{failed:0},hits:{total:{relation:'eq',value:buckets.reduce((sum,b)=>sum+b.doc_count,0)+otherDocs}},aggregations:{sessions:{buckets,sum_other_doc_count:otherDocs,doc_count_error_upper_bound:0}}});
const digest=value=>createHash('sha256').update(value).digest('hex');

test('more than one old page of intervals comes from one read, with current privacy/deletion controls',async()=>{
 const buckets=Array.from({length:2001},(_,i)=>bucket('alice','s'+i));
 buckets.push(bucket('bob','private'),bucket('bob','team'),bucket('alice','child',1),bucket('alice','deleted'));
 let calls=0;const owners=[];
 const collection={field:f=>'session.'+f,async search(scope,body){
  assert.deepEqual(scope,principal);assert.equal(++calls,1,'a later index refresh cannot introduce a second read view');
  assert.equal(body.aggs.sessions.multi_terms.size,50000);
  assert.deepEqual(body.aggs.sessions.aggs.subagents,{term_count:{field:'session.origin',value:'subagent'}});
  assert.ok(body.query.bool.filter.some(f=>f.term?.tenantId===principal.tenantId));
  return page(buckets);
 }};
 const controls={async list(scope){owners.push(scope.userId);assert.equal(scope.tenantId,principal.tenantId);
  return new Map(scope.userId==='bob'?[[digest('private'),{visibility:'private',deletedAt:null}]]:[[digest('deleted'),{visibility:'team',deletedAt:'2026-11-14T11:00:00Z'}]]);
 }};
 const result=await sessionOverlap(collection,controls,principal,{days:1,now});
 assert.equal(result.sessions,2002);assert.equal(result.daily[0].peak,2002);assert.deepEqual(owners.sort(),['alice','bob']);
});

test('oversized reports and permission failures fail closed; timeouts have only one retry',async()=>{
 let calls=0;const controls={async list(){assert.fail('incomplete results must not reach resource reads');}};
 const collection={field:f=>'session.'+f,async search(){calls++;return page([bucket('alice','a')],2);}};
 await assert.rejects(sessionOverlap(collection,controls,principal,{days:1,now}),/scan limit exceeded/);assert.equal(calls,1);
 collection.search=async()=>{calls++;return {...page([]),timed_out:true};};calls=0;
 await assert.rejects(sessionOverlap(collection,controls,principal,{days:1,now}),/Incomplete/);assert.equal(calls,2);
 const denied=Object.assign(new Error('denied'),{status:403});calls=0;collection.search=async()=>{calls++;throw denied;};
 await assert.rejects(sessionOverlap(collection,controls,principal,{days:1,now}),error=>error===denied);assert.equal(calls,1);
});

test('a transient failed read is discarded before a complete atomic retry',async()=>{
 for(const failure of ['timeout','shard','transport']){
  let calls=0;const requests=[];
  const collection={field:f=>'session.'+f,async search(scope,body){
   requests.push(structuredClone(body));calls++;
   if(calls===1){
    if(failure==='transport')throw Object.assign(new Error('Busy'),{status:503});
    return {...page([bucket('alice','partial')]),timed_out:failure==='timeout',_shards:{failed:failure==='shard'?1:0}};
   }
   return page([bucket('alice','complete')]);
  }};
  let checks=0;const controls={async list(){checks++;return new Map();}};
  const result=await sessionOverlap(collection,controls,principal,{days:1,now});
  assert.equal(calls,2);assert.equal(checks,1);assert.deepEqual(requests[0],requests[1]);
  assert.equal(result.sessions,1);assert.equal(result.daily[0].peak,1);
 }
});

test('the complete single read still rejects duplicate keys, malformed metrics and missing coverage',async()=>{
 const controls={async list(){assert.fail('invalid results must not produce readable intervals');}};
 for(const result of [page([bucket('alice','a'),bucket('alice','a')]),page([bucket('alice','a',3)]),
  {...page([bucket('alice','a')]),hits:{total:{relation:'eq',value:3}}}]){
  const collection={field:f=>'session.'+f,async search(){return result;}};
  await assert.rejects(sessionOverlap(collection,controls,principal,{days:1,now}),/Duplicate|Invalid|Incomplete/);
 }
});
