import {createObjectStore} from '../../dist/src/sessions/s3-store.mjs';
import assert from 'node:assert/strict';

let pages=0;const retained=new Set();
const store=createObjectStore({endpoint:'http://storage.invalid',bucket:'test',credentials:{accessKeyId:'test',secretAccessKey:'test'},fetch:async()=>{
 const page=pages++,keys=Array.from({length:1000},(_,n)=>'<Contents><Key>root/'+page+'/'+n+'-'+'x'.repeat(400)+'</Key></Contents>').join('');
 return new Response('<ListBucketResult>'+keys+'<IsTruncated>true</IsTruncated><NextContinuationToken>'+('token-'+page+'-').padEnd(128,'y')+'</NextContinuationToken></ListBucketResult>');
}});
let cursor;global.gc();const baseline=process.memoryUsage().heapUsed;
for(let n=0;n<160;n++){
 const page=await store.listPage('root/',{continuationToken:cursor});
 assert.equal(page.keys.length,1000);cursor=page.nextToken;
 assert.ok(!retained.has(cursor));retained.add(cursor);
 if(n%10===0)global.gc();
}
global.gc();console.log(JSON.stringify({pages,retained:retained.size,baseline,heapUsed:process.memoryUsage().heapUsed,maxRssKiB:process.resourceUsage().maxRSS}));
