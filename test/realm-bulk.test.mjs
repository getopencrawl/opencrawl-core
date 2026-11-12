import {gunzipSync} from 'node:zlib';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRealm} from '../dist/src/search/realm.mjs';
import {createSessionSearch} from '../dist/src/sessions/search.mjs';
import {memorySessionStore} from './session-store-fixture.mjs';

const principal={tenantId:'bulk-tenant',userId:'owner'};
const documents=Array.from({length:1800},(_,i)=>({id:'item-'+i,document:{...principal,harness:'codex',sessionId:'large',eventId:'event-'+i,receivedAt:'2026-11-12T00:00:00Z',text:'界🙂'.repeat(200)}}));
function fixture(){
 const calls=[];let rejectAt=0;
 const fetch=async(_url,init)=>{
  const body=init.headers['content-encoding']==='gzip'?gunzipSync(init.body).toString():init.body;
  const bytes=Buffer.byteLength(body),lines=body.trimEnd().split('\n');
  assert.ok(bytes<=4*1024*1024);assert.equal(lines.length%2,0);
  const ids=[];for(let i=0;i<lines.length;i+=2)ids.push(JSON.parse(lines[i]).update?._id??JSON.parse(lines[i]).index?._id);
  calls.push({bytes,ids});const rejected=calls.length===rejectAt;
  return Response.json({errors:rejected,items:ids.map(()=>({update:{status:rejected?429:200}}))});
 };
 return {calls,fetch,set rejectAt(n){rejectAt=n;}};
}
test('session passage batches fit the search limit including scripts and UTF-8 framing',async()=>{
 const f=fixture(),search=createSessionSearch({store:memorySessionStore(),prefix:'capture-v1',endpoint:'http://localhost:9200',fetch:f.fetch});
 assert.ok(Buffer.byteLength(JSON.stringify(documents))<3*1024*1024);
 await search.putDocuments(documents,principal);
 assert.ok(f.calls.length>1);
 assert.deepEqual(f.calls.flatMap(c=>c.ids),documents.map(d=>'session:'+d.id));
});
test('bulk preflight rejects a late foreign scope or oversized item before sending any chunk',async()=>{
 const f=fixture(),collection=createRealm({tenantId:principal.tenantId,endpoint:'http://localhost:9200',fetch:f.fetch}).collection('session');
 const items=documents.map(d=>({...d,policy:'session'}));
 await assert.rejects(collection.bulk(principal,[...items,{id:'foreign',document:{tenantId:'other'}}]),{status:403,writeOutcome:'not-applied'});
 assert.equal(f.calls.length,0);
 await assert.rejects(collection.bulk(principal,[...items,{id:'oversized',document:{...principal,text:'界'.repeat(2*1024*1024)}}]),{status:400,writeOutcome:'not-applied'});
 assert.equal(f.calls.length,0);
});
test('a later chunk failure retains partial-write uncertainty and retry repeats stable identities',async()=>{
 const f=fixture(),search=createSessionSearch({store:memorySessionStore(),prefix:'capture-v1',endpoint:'http://localhost:9200',fetch:f.fetch});
 const items=documents;f.rejectAt=2;
 await assert.rejects(search.putDocuments(items,principal),error=>{assert.equal(error.writeOutcome,undefined);return /failed or missing/.test(error.message);});
 assert.equal(f.calls.length,2);const original=f.calls.map(c=>c.ids);f.rejectAt=0;f.calls.length=0;
 await search.putDocuments(items,principal);assert.deepEqual(f.calls.map(c=>c.ids),original);
});

test('a definite rejection after an earlier session chunk cannot erase partial-write uncertainty',async()=>{
 let calls=0;
 const search=createSessionSearch({store:memorySessionStore(),prefix:'capture-v1',endpoint:'http://localhost:9200',fetch:async(_url,init)=>{
  if(++calls===2)return Response.json({error:{type:'security_exception'}},{status:403});
  const body=init.headers['content-encoding']==='gzip'?gunzipSync(init.body).toString():init.body;
  const count=body.trimEnd().split('\n').length/2;
  return Response.json({errors:false,items:Array.from({length:count},()=>({update:{status:200}}))});
 }});
 await assert.rejects(search.putDocuments(documents,principal),error=>{assert.equal(error.httpStatus,403);assert.equal(error.writeOutcome,undefined);return true;});
 assert.equal(calls,2);
});
