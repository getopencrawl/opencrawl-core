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
