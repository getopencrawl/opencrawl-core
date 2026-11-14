import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sessionOverlap} from '../dist/src/sessions/overlap.mjs';

const now=Date.parse('2026-11-14T12:00:00Z'),principal={tenantId:'org_retry',userId:'alice'};
const bucket=(userId,sessionId)=>({key:[userId,'codex',sessionId],doc_count:2,first:{value:now-3600000},last:{value:now},subagents:{doc_count:0}});
const page=(buckets,otherDocs=0)=>({timed_out:false,_shards:{failed:0},hits:{total:{relation:'eq',value:buckets.reduce((sum,b)=>sum+b.doc_count,0)+otherDocs}},aggregations:{sessions:{buckets,sum_other_doc_count:otherDocs,doc_count_error_upper_bound:0}}});
const digest=value=>createHash('sha256').update(value).digest('hex');

test('a changed page restarts the whole overlap scan and rechecks final resource visibility',async()=>{
  const responses=[page([bucket('alice','obsolete')],2),page([bucket('bob','private')],1),
    page([bucket('alice','fresh')],4),page([bucket('bob','private'),bucket('alice','second')])];
  const bodies=[],owners=[];
  const collection={field:f=>'session.'+f,async search(scope,body){assert.deepEqual(scope,principal);bodies.push(body);return responses[bodies.length-1];}};
  const controls={async list(scope){assert.equal(scope.tenantId,principal.tenantId);owners.push(scope.userId);
    return new Map(scope.userId==='bob'?[[digest('private'),{visibility:'private',deletedAt:null}]]:[]);}};
  const result=await sessionOverlap(collection,controls,principal,{days:1,now});
  assert.equal(bodies.length,4);assert.deepEqual(bodies[2],bodies[0],'restart discards the failed continuation cursor');
  assert.equal(result.sessions,2,'neither the obsolete first attempt nor another member\'s private session is returned');
  assert.equal(result.daily[0].peak,2);assert.deepEqual(owners.sort(),['alice','bob']);
});

test('persistent incomplete reports fail after one restart and authorization errors are never retried',async()=>{
  let calls=0;
  const controls={async list(){assert.fail('incomplete or unauthorized results must not reach resource reads');}};
  const collection={field:f=>'session.'+f,async search(){calls++;return {...page([]),timed_out:true};}};
  await assert.rejects(sessionOverlap(collection,controls,principal,{days:1,now}),/Incomplete session overlap response/);
  assert.equal(calls,2);
  calls=0;const denied=Object.assign(new Error('denied'),{status:403});
  collection.search=async()=>{calls++;throw denied;};
  await assert.rejects(sessionOverlap(collection,controls,principal,{days:1,now}),error=>error===denied);
  assert.equal(calls,1);
});

test('a restart shares the original total page budget instead of doubling backend load',async()=>{
  let calls=0;
  const collection={field:f=>'session.'+f,async search(){calls++;
    const b={...bucket('alice','s'+String(calls).padStart(2,'0')),doc_count:1};
    return calls===25?page([b],2):page([b],26-calls);
  }};
  const controls={async list(){assert.fail('an exhausted scan must not produce readable intervals');}};
  await assert.rejects(sessionOverlap(collection,controls,principal,{days:1,now}),/scan limit exceeded/);
  assert.equal(calls,25);
});
