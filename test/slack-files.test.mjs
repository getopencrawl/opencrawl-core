import {realmResponse} from './realm-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {normalizeSlackFile,textChunks} from '../src/connectors/slack-files.mjs';
import {createConnectorPipeline} from '../src/connectors/pipeline.mjs';
import {createConnectorSearch} from '../src/connectors/search.mjs';
import {normalizeSlack} from '../src/connectors/slack.mjs';
import {receiptKey} from '../src/connectors/scope.mjs';
const binding={tenantId:'tenant-a',connectionId:'conn',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=conn/'};
const key=binding.rawPrefix+'stream=file_documents/date=2026-11-05/sync=1/files.jsonl.gz';
function fixture(text='full body '.repeat(20000)+'FINAL DOCUMENT TEXT') {
 const bytes=Buffer.from(text),sha=createHash('sha256').update(bytes).digest('hex');
 const envelope={_airbyte_extracted_at:1000,_airbyte_data:{format_version:1,id:'F123',channel_id:'C123',available:true,media_type:'text/markdown',title:'Document',content_sha256:sha,content_bytes:bytes.length,content_key:binding.rawPrefix+'files/sha256/'+sha+'.bin'}};
 const objects=new Map([[envelope._airbyte_data.content_key,bytes],[key,gzipSync(JSON.stringify(envelope)+'\n')]]);
 const store={get:async k=>objects.get(k),put:async(k,v)=>objects.set(k,v)};
 return {envelope,objects,store};
}
test('full Unicode file coverage reconstructs exactly across bounded, overlapping chunks',async()=>{
 const text='🦉é全 '.repeat(80000)+'END';const parts=textChunks(text);
 assert.equal(parts.map(p=>p.text.slice(p.overlap)).join(''),text);
 for(const p of parts){assert.equal(p.text.slice(p.overlap),text.slice(p.start,p.end));assert.ok(p.text.isWellFormed());assert.ok(Buffer.byteLength(p.text)<132*1024);}
 const f=fixture(text),n=await normalizeSlackFile(binding,f.envelope,key,{store:f.store});
 assert.equal(n.chunks.map(c=>c.document.text.slice(c.document.partOverlap)).join(''),text);
 assert.equal(n.manifest.document.chunkCount,n.chunks.length);
 assert.ok(n.chunks.every(c=>c.document.parentId==='C123:F123'&&c.document.resourceVersion===n.manifest.document.resourceVersion));
});
test('file content references reject foreign scope, corruption, lossy records, and unsupported bytes',async()=>{
 const f=fixture();for(const changes of [{content_key:'other/secret'},{content_sha256:'0'.repeat(64)},{content_bytes:1}]){
  await assert.rejects(normalizeSlackFile(binding,{...f.envelope,_airbyte_data:{...f.envelope._airbyte_data,...changes}},key,{store:f.store}));
 }
 await assert.rejects(normalizeSlackFile(binding,{...f.envelope,_airbyte_meta:{changes:[{}]}},key,{store:f.store}));
 await assert.rejects(normalizeSlackFile(binding,f.envelope,key,{store:{get:async()=>Buffer.alloc(f.envelope._airbyte_data.content_bytes)}}),/checksum/);
 const unsupported=fixture('binary\x00control');unsupported.envelope._airbyte_data.media_type='application/octet-stream';
 await assert.rejects(normalizeSlackFile(binding,unsupported.envelope,key,{store:unsupported.store}),/extraction failed/);
});
test('failed chunk writes never publish a manifest or receipt; retry publishes all chunks first',async()=>{
 const f=fixture();let fail=true;const writes=[];
 const search={identity:'test',putDocuments:async(_,__,docs)=>{writes.push(...docs);if(fail)throw Error('bulk failure');}};
 const pipeline=createConnectorPipeline({binding,store:f.store,search});
 await assert.rejects(pipeline.processObject({key}),/bulk failure/);
 assert.ok(writes.every(d=>d.document.kind==='file_chunk'));assert.equal(f.objects.has(receiptKey(binding,'test',key)),false);
 fail=false;writes.length=0;assert.equal((await pipeline.processObject({key})).records,1);
 assert.equal(writes.at(-1).document.kind,'file');assert.ok(writes.slice(0,-1).every(d=>d.document.kind==='file_chunk'));
 const receipt=JSON.parse(f.objects.get(receiptKey(binding,'test',key)));assert.equal(receipt.sourceRecords,1);assert.equal(receipt.records,1);
 const n=await normalizeSlackFile(binding,{...f.envelope,_airbyte_data:{...f.envelope._airbyte_data,available:false}},key,{store:f.store});
 assert.equal(n.manifest.document.available,false);assert.equal(n.chunks.length,0);
});
test('file chunks require a current available unsuppressed manifest AND a public channel',async()=>{
 const f=fixture(),n=await normalizeSlackFile(binding,f.envelope,key,{store:f.store});
 const channel=normalizeSlack(binding,'channels',{_airbyte_extracted_at:1000,_airbyte_data:{id:'C123',is_private:false}},key);
 let manifest={...n.manifest.document},publicChannel=true,found=true;
 const hit=n.chunks[0];
 const search=createConnectorSearch({endpoint:'http://localhost:9200',index:'test',tenantId:binding.tenantId,fetch:async(url,options)=>{
  if(url.pathname.endsWith('/_search'))return realmResponse('connector',{hits:{hits:[{_id:hit.id,_source:hit.document,_score:1}]}});
  const ids=JSON.parse(options.body).ids;
  return realmResponse('connector',{docs:ids.includes('connector:'+channel.id)?[{_id:channel.id,found:true,_source:{...channel.document,publicChannel}}]:[{_id:n.manifest.id,found,_source:manifest}]});
 }});
 const run=()=>search.search({tenantId:binding.tenantId},[binding],{query:'full body'});
 assert.equal((await run()).hits.length,1);
 for(const changes of [{available:false},{deleted:true},{resourceVersion:'new'},{resourceVersion:undefined}]){
  manifest={...n.manifest.document,...changes};assert.equal((await run()).hits.length,0);
 }
 manifest={...n.manifest.document};publicChannel=false;assert.equal((await run()).hits.length,0);
 publicChannel=true;found=false;assert.equal((await run()).hits.length,0);
 found=true;manifest.tenantId='other';await assert.rejects(run(),/scope/);
});
test('new file revisions have different immutable chunk IDs, so late old writes cannot replace current text',async()=>{
 const a=fixture('old'),b=fixture('new');const old=await normalizeSlackFile(binding,a.envelope,key,{store:a.store}),fresh=await normalizeSlackFile(binding,b.envelope,key,{store:b.store});
 assert.equal(old.manifest.id,fresh.manifest.id);assert.notEqual(old.chunks[0].id,fresh.chunks[0].id);
});
