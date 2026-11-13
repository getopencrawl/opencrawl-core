import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {writeFile} from 'node:fs/promises';
import {createRealm} from '../src/search/realm.mjs';
import type {DocumentItem} from '../src/search/types.mjs';
const endpoint=process.env.OPENCRAWL_TEST_OPENSEARCH_URL;
if(!endpoint||!['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname))throw new Error('Benchmark requires a disposable loopback OpenSearch service');
const owner={tenantId:'bulk-benchmark-'+randomUUID(),userId:'owner'};
const documents:DocumentItem[]=Array.from({length:4000},(_,n)=>({id:'event-'+n,policy:'session',document:{...owner,harness:'codex',sessionId:'measured',eventId:'event-'+n,receivedAt:'2026-11-12T00:00:00Z',text:('Event '+n+' search indexing 日本語 🙂. ').repeat(30)}}));
const samples:Record<string,unknown>[]=[];
const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
// Interleave targets to avoid assigning startup/warmup entirely to one size.
for(let round=0;round<3;round++)for(const mib of (round%2?[16,8,3,1]:[1,3,8,16])){
 const index='oc-bulk-benchmark-'+randomUUID(),latencies:number[]=[];let wireBytes=0,plainBytes=0,peakRss=process.memoryUsage().rss;
 const transport:typeof fetch=async(url,init)=>{
  const body=init?.body;
  if(String(url).includes('/_bulk')&&body){
   const bytes=typeof body==='string'?Buffer.from(body):Buffer.from(body as Uint8Array);
   wireBytes+=bytes.length;plainBytes+=(new Headers(init?.headers).get('content-encoding')==='gzip'?gunzipSync(bytes):bytes).length;
   const start=performance.now();try{return await fetch(url,init);}finally{latencies.push(performance.now()-start);}
  }
  return fetch(url,init);
 };
 const realm=createRealm({endpoint,index,tenantId:owner.tenantId,bulkTargetBytes:mib*1024*1024,fetch:transport});
 try{
  await realm.ensureIndex();
  const timer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},10),start=performance.now();
  try{await realm.collection('session').bulk(owner,documents);}finally{clearInterval(timer);}
  const elapsedMs=performance.now()-start;await realm.refresh(owner);
  const response=await fetch(endpoint+'/'+index+'/_count'),count=await response.json() as {count:number};
  if(!response.ok||count.count!==documents.length)throw new Error('Benchmark lost documents');
  samples.push({round,targetMiB:mib,documents:documents.length,requests:latencies.length,elapsedMs,docsPerSecond:documents.length*1000/elapsedMs,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),wireBytes,plainBytes,peakRss});
 }finally{const removed=await fetch(endpoint+'/'+index,{method:'DELETE'});if(!removed.ok)throw new Error('Disposable benchmark index cleanup failed');}
}
// Prove the old rejection boundary is gone against the real engine, including
// policy framing and UTF-8, then verify stored content rather than only HTTP 200.
const index='oc-bulk-large-'+randomUUID(),realm=createRealm({endpoint,index,tenantId:owner.tenantId});
try{
 await realm.ensureIndex();const text='large event 日本語 🙂 '.repeat(240000);
 if(Buffer.byteLength(text)<=4*1024*1024)throw new Error('Large document fixture is too small');
 await realm.collection('session').bulk(owner,[{id:'larger-than-four-mib',document:{...owner,text}}]);
 const read=await realm.collection('session').mget(owner,['larger-than-four-mib']);
 if(read.docs?.[0]?._source?.text!==text)throw new Error('Large document was not preserved');
 samples.push({largeDocumentBytes:Buffer.byteLength(text),largeDocumentVerified:true});
}finally{await fetch(endpoint+'/'+index,{method:'DELETE'});}
const result={format:1,node:process.version,platform:process.platform,samples};
await writeFile(process.env.OPENCRAWL_BULK_BENCHMARK_OUTPUT||'bulk-benchmark.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
