import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createObjectStore} from '../dist/src/sessions/s3-store.mjs';

test('retained pagination cursors do not retain complete XML pages',()=>{
 const child=spawnSync(process.execPath,['--expose-gc','--max-old-space-size=64',fileURLToPath(new URL('./fixtures/s3-pagination-memory.mjs',import.meta.url))],{encoding:'utf8',timeout:15000});
 assert.equal(child.status,0,child.stderr);
 const result=JSON.parse(child.stdout);
 assert.equal(result.pages,160);assert.equal(result.retained,160);
});

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

test('migration listings require a complete page, its exact count and an unambiguous cursor',async()=>{
 const prefix='capture/',entry='<Contents><Key>capture/key</Key></Contents>';
 const body=(contents,metadata,count='1')=>'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Prefix>capture/</Prefix><KeyCount>'+count+'</KeyCount>'+contents+metadata+'</ListBucketResult>';
 const more='<IsTruncated>true</IsTruncated>',done='<IsTruncated>false</IsTruncated>',next='<NextContinuationToken>opaque&amp;next</NextContinuationToken>';
 const page=(xml,continuationToken=null)=>createObjectStore({bucket:'test',credentials:{accessKeyId:'test',secretAccessKey:'test'},fetch:async()=>new Response(xml)}).listPage(prefix,{requireComplete:true,continuationToken});
 assert.deepEqual(await page(body(entry+'<CommonPrefixes><Prefix>capture/sub/</Prefix></CommonPrefixes>',more+next,'2')),{keys:['capture/key'],prefixes:['capture/sub/'],nextToken:'opaque&next'});
 assert.deepEqual(await page(body('',done+'<ContinuationToken>opaque&amp;next</ContinuationToken>','0'),'opaque&next'),{keys:[],prefixes:[],nextToken:null});
 for(const xml of [
   body(entry,''),body(entry,more),body(entry,done+next),body(entry,more+next+next),body(entry,done+more),
   body(entry,done).replace('<KeyCount>1</KeyCount>',''), body(entry,done,'0'),body(entry,done).slice(0,-1),
   body('<Contents></Contents><Contents><Key>capture/key</Key></Contents>',done),body(entry.replace('</Key>','</Owner>'),done),
   body(entry.replace('capture/key','elsewhere/key'),done),body(entry,done).replace('<Prefix>capture/</Prefix>',''),
   body(entry,done).replace('</IsTruncated>','</IsTruncated><Broken>'),'<Error><Code>InternalError</Code></Error>',
 ]){
   await assert.rejects(page(xml),{message:'Invalid or incomplete S3 listing'});
 }
 await assert.rejects(page(body(entry,more+next),'opaque&next'),{message:'Invalid or incomplete S3 listing'});
});
