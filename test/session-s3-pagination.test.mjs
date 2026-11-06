import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createObjectStore} from '../src/sessions/s3-store.mjs';

test('S3 pagination omits persisted end-of-list null and preserves opaque tokens',async()=>{
 const requests=[];
 const store=createObjectStore({bucket:'test',credentials:{accessKeyId:'test',secretAccessKey:'test'},fetch:async url=>{
  requests.push(new URL(url));return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
 }});
 const page=await store.listPage('capture/');
 assert.equal(page.nextToken,null);
 await store.listPage('capture/',{continuationToken:page.nextToken});
 await store.listPage('capture/',{continuationToken:'opaque+/=&token'});
 assert.equal(requests[0].searchParams.has('continuation-token'),false);
 assert.equal(requests[1].searchParams.has('continuation-token'),false);
 assert.equal(requests[2].searchParams.get('continuation-token'),'opaque+/=&token');
});

test('complete S3 listings use the same strict pagination contract as listPage',async()=>{
 const requests=[];
 const store=createObjectStore({bucket:'test',credentials:{accessKeyId:'test',secretAccessKey:'test'},fetch:async url=>{
  const request=new URL(url);requests.push(request);
  return new Response(request.searchParams.has('continuation-token')
   ?'<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>capture/b</Key></Contents></ListBucketResult>'
   :'<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>opaque&amp;token</NextContinuationToken><Contents><Key>capture/a</Key></Contents><CommonPrefixes><Prefix>capture/sub/</Prefix></CommonPrefixes></ListBucketResult>');
 }});
 assert.deepEqual(await store.list('capture/',{delimiter:'/'}),{keys:['capture/a','capture/b'],prefixes:['capture/sub/']});
 assert.equal(requests[1].searchParams.get('continuation-token'),'opaque&token');
 assert.ok(requests.every(url=>url.searchParams.get('delimiter')==='/'));
});

test('S3 listings reject missing buckets, missing tokens and cursor cycles rather than return partial data',async()=>{
 for(const method of ['listPage','list'])for(const missing of ['bucket','token']){
  const store=createObjectStore({bucket:'test',credentials:{accessKeyId:'test',secretAccessKey:'test'},fetch:async()=>
   missing==='bucket'?new Response('<Error><Code>NoSuchBucket</Code></Error>',{status:404}):
    new Response('<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>partial</Key></Contents></ListBucketResult>')});
  await assert.rejects(store[method]('capture/'),missing==='bucket'?/404/:/continuation token/);
 }
 for(const tokens of [['a','a'],['a','b','a']]) {
  let calls=0;
  const store=createObjectStore({bucket:'test',credentials:{accessKeyId:'test',secretAccessKey:'test'},fetch:async()=>{
   assert.ok(calls<tokens.length,'pagination must stop at the first cycle');
   return new Response(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>${tokens[calls++]}</NextContinuationToken></ListBucketResult>`);
  }});
  await assert.rejects(store.list('capture/'),/repeated/);
  assert.equal(calls,tokens.length);
 }
});
