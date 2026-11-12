import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createIndexTransport} from '../dist/src/search/realm.mjs';
const body=Array.from({length:200},(_,i)=>JSON.stringify({index:{_id:String(i)}})+'\n'+JSON.stringify({text:'界🙂'.repeat(200)})+'\n').join('');
const options={endpoint:'https://search.example.test',index:'test-index'};

test('large bulk requests preserve UTF-8 NDJSON and sign the compressed wire bytes',async()=>{
 let calls=0;
 const request=createIndexTransport({...options,region:'us-west-2',credentials:async()=>({accessKeyId:'fixture-key',secretAccessKey:'fixture-secret',sessionToken:'fixture-session'}),fetch:async(url,init)=>{
  calls++;assert.equal(String(url),'https://search.example.test/test-index/_bulk');
  assert.equal(init.headers['content-type'],'application/x-ndjson');assert.equal(init.headers['content-encoding'],'gzip');
  assert.ok(init.body instanceof Uint8Array);assert.ok(init.body.length<Buffer.byteLength(body)*0.5);
  assert.equal(gunzipSync(init.body).toString(),body);
  assert.equal(init.headers['x-amz-content-sha256'],createHash('sha256').update(init.body).digest('hex'));
  assert.match(init.headers.authorization,/SignedHeaders=[^,]*content-encoding/);assert.equal(init.headers['x-amz-security-token'],'fixture-session');
  return Response.json({acknowledged:true});
 }});
 assert.deepEqual(await request('/_bulk',body,'POST','application/x-ndjson'),{acknowledged:true});assert.equal(calls,1);
});

test('small bulk and ordinary JSON requests retain their original uncompressed bodies',async()=>{
 const seen=[];const request=createIndexTransport({...options,fetch:async(_url,init)=>{seen.push(init);return Response.json({ok:true});}});
 await request('/_bulk','{}\n','POST','application/x-ndjson');await request('/_search',{query:'x'.repeat(40000)});
 assert.deepEqual(seen.map(x=>x.body),['{}\n',JSON.stringify({query:'x'.repeat(40000)})]);assert.ok(seen.every(x=>!x.headers['content-encoding']));
});

for(const status of [400,415])test('explicit unsupported compression retries identical plaintext once and remembers the rejection '+status,async()=>{
 const seen=[];const request=createIndexTransport({...options,fetch:async(_url,init)=>{
  seen.push(init);
  if(seen.length===1)return status===415?new Response('Unsupported encoding',{status}):Response.json({Message:'Content-Encoding header is not supported'},{status});
  assert.equal(init.body,body);assert.equal(init.headers['content-encoding'],undefined);return Response.json({ok:true});
 }});
 await request('/_bulk',body,'POST','application/x-ndjson');await request('/_bulk',body,'POST','application/x-ndjson');
 assert.equal(seen.length,3);assert.equal(gunzipSync(seen[0].body).toString(),seen[1].body);
});

for(const status of [400,403,503])test('document, authorization and ambiguous failures never trigger plaintext replay '+status,async()=>{
 let calls=0;const request=createIndexTransport({...options,fetch:async()=>{calls++;return Response.json({error:{type:status===403?'security_exception':'validation_exception',reason:'Request rejected'}},{status});}});
 await assert.rejects(request('/_bulk',body,'POST','application/x-ndjson'),error=>{assert.equal(error.httpStatus,status);assert.equal(error.writeOutcome,status===403?'not-applied':undefined);return true;});assert.equal(calls,1);
});

test('failed signing is a definite pre-application failure for compressed requests',async()=>{
 let sent=false;const request=createIndexTransport({...options,credentials:async()=>{throw new Error('fixture signing unavailable');},fetch:async()=>{sent=true;return Response.json({});}});
 await assert.rejects(request('/_bulk',body,'POST','application/x-ndjson'),{writeOutcome:'not-applied'});assert.equal(sent,false);
});
