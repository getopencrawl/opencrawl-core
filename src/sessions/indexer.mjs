import {gunzipSync} from 'node:zlib';
import {digest,sessionScope,MAX_BATCH_BYTES,batchIndexQueueKey} from './ingest.mjs';

const HEX='[a-f0-9]{64}';
export function sourceBatchIdentity(prefix,key) {
  if(!key.startsWith(prefix+'/'))return null;
  const match=new RegExp(`^tenants/(${HEX})/users/(${HEX})/(claude-code|codex)/(${HEX})/(${HEX})/(${HEX})\\.json\\.gz$`).exec(key.slice(prefix.length+1));
  return match?{tenantHash:match[1],userHash:match[2],harness:match[3],installationHash:match[4],sessionHash:match[5],batchId:match[6]}:null;
}
function collect(value,text,attachments,names) {
  if(typeof value==='string'){if(!value.startsWith('data:'))text.push(value);return;}
  if(!value||typeof value!=='object')return;
  if(value.type==='opencrawl_attachment'){attachments.push(value);return;}
  if(['tool_use','function_call','custom_tool_call'].includes(value.type)&&typeof value.name==='string')names.add(value.name);
  if(Array.isArray(value)){for(const child of value)collect(child,text,attachments,names);return;}
  for(const [key,child] of Object.entries(value)) {
    if(['id','type','role','call_id','tool_use_id','encrypted_content','image_url'].includes(key))continue;
    collect(child,text,attachments,names);
  }
}
export function batchDocuments({prefix,key,batch,principal}) {
  const scope=sessionScope(principal),identity=sourceBatchIdentity(prefix,key);
  if(!identity||identity.tenantHash!==digest(principal.tenantId)||identity.userHash!==digest(principal.userId)||
    batch?.owner?.tenantId!==principal.tenantId||batch?.owner?.userId!==principal.userId||batch.schemaVersion!==1||
    batch.harness!==identity.harness||digest(batch.installationId??'')!==identity.installationHash||digest(batch.sessionId??'')!==identity.sessionHash||
    !Array.isArray(batch.events)||batch.events.length>1000)throw new Error('Stored batch does not match its authorized scope and source key');
  const documents=[];
  for(const event of batch.events){
    if(typeof event.id!=='string'||!event.id||typeof event.kind!=='string')throw new Error('Malformed stored event');
    const texts=[],attachments=[],names=new Set();collect(event.data,texts,attachments,names);
    const text=texts.join('\n');
    const chunks=text.match(/[\s\S]{1,16000}/gu)||[''];
    for(let chunk=0;chunk<chunks.length;chunk++){
      const document={tenantId:principal.tenantId,userId:principal.userId,installationId:batch.installationId,sessionId:batch.sessionId,
        harness:batch.harness,origin:batch.origin,eventId:event.id,kind:event.kind,role:event.data?.role??null,
        timestamp:typeof event.timestamp==='string'?event.timestamp:null,receivedAt:batch.receivedAt,
        sequence:Number.isSafeInteger(event.sequence)?event.sequence:0,chunk,text:chunks[chunk],sourceKey:key,
        nativeId:typeof event.nativeId==='string'?event.nativeId:null,parentId:event.parentId??null,turnId:event.turnId??null,
        toolCallId:event.data?.call_id??event.data?.tool_use_id??null,toolNames:[...names],host:batch.host??null,
        attachments:attachments.map(a=>({sha256:a.sha256,size:a.size,mimeType:a.mimeType,path:a.path,
          objectKey:/^[a-f0-9]{64}$/.test(a.sha256??'')?`${prefix}/${scope}/attachments/${a.sha256}`:null}))};
      documents.push({id:digest(JSON.stringify([scope,batch.harness,batch.installationId,batch.sessionId,event.id,chunk])),document});
    }
  }
  return documents;
}

/** Scope is supplied by a trusted runtime adapter, never by an ordinary API caller. */
export function createSessionIndexer({store,prefix,search,principal,resolvePrincipal,jobId='sessions-v1',now=()=>Date.now()}) {
  if(Boolean(principal)===Boolean(resolvePrincipal))throw new Error('Supply one fixed single-tenant principal or a trusted scope resolver');
  if(principal)sessionScope(principal);
  if(typeof store.listPage!=='function'||typeof store.delete!=='function')throw new Error('Paged S3 listing and deletion are required');
  const sourcePrefix=prefix+'/'+(principal?sessionScope(principal)+'/':'tenants/');
  const listingPrefix=prefix+'/index-pending/'+(principal?sessionScope(principal)+'/':'');
  const statePrefix=prefix+'/_index/'+digest(search.identity)+'/'+digest(jobId+':'+(principal?sessionScope(principal):'runtime-resolved'));
  const read=async key=>{const bytes=await store.get(key);return bytes?JSON.parse(bytes):null;};
  const save=(key,value)=>store.put(key,Buffer.from(JSON.stringify(value)),'application/json');
  let busy=false;
  return {
    async runOnce({pages=1}={}) {
      if(busy)return {busy:true};busy=true;
      const result={indexed:0,documents:0,skipped:0,failed:0,pages:0};
      try {
        await search.ensureIndex();
        // Bounded reconciliation backfills older releases and repairs a missing work
        // item. Fresh uploads use the pending queue and never wait for a full scan.
        const prior=await read(statePrefix+'/reconcile.json');
        const sources=await store.listPage(sourcePrefix,{continuationToken:prior?.nextToken,maxKeys:50});
        for(const key of sources.keys)if(sourceBatchIdentity(prefix,key)){
          const state=await read(statePrefix+'/batches/'+digest(key)+'.json');
          if(state?.status!=='indexed')await save(batchIndexQueueKey(prefix,key),{sourceKey:key});
        }
        await save(statePrefix+'/reconcile.json',{nextToken:sources.nextToken||null});
        let cursor=await read(statePrefix+'/cursor.json');
        for(let page=0;page<pages;page++){
          const listing=await store.listPage(listingPrefix,{continuationToken:cursor?.nextToken,maxKeys:50});
          for(const queueKey of listing.keys){
            const item=await read(queueKey);if(!item)continue;
            const key=item.sourceKey;
            if(typeof key!=='string'||!sourceBatchIdentity(prefix,key)||batchIndexQueueKey(prefix,key)!==queueKey){result.failed++;continue;}

            const stateKey=statePrefix+'/batches/'+digest(key)+'.json';
            const state=await read(stateKey);
            if(state?.status==='indexed'){await store.delete(queueKey);result.skipped++;continue;}
            if(state?.nextAttempt>now()){result.skipped++;continue;}
            try {
              const bytes=await store.get(key);if(!bytes)throw new Error('Source batch disappeared');
              const batch=JSON.parse(gunzipSync(bytes,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}));
              const scope=principal||await resolvePrincipal({key,batch});sessionScope(scope);
              const docs=batchDocuments({prefix,key,batch,principal:scope});
              await search.putDocuments(docs);
              await save(stateKey,{status:'indexed',sourceKey:key,documents:docs.length,indexedAt:new Date(now()).toISOString()});
              await store.delete(queueKey);
              result.indexed++;result.documents+=docs.length;
            } catch(error) {
              const attempts=(state?.attempts||0)+1;
              // Do not persist provider response bodies or transcript contents in diagnostics.
              await save(stateKey,{status:'failed',sourceKey:key,attempts,lastAttempt:new Date(now()).toISOString(),nextAttempt:now()+Math.min(3600000,1000*2**Math.min(attempts,12)),error:'INDEXING_FAILED'});
              result.failed++;
            }
          }
          cursor={nextToken:listing.nextToken||null,updatedAt:new Date(now()).toISOString()};
          await save(statePrefix+'/cursor.json',cursor);result.pages++;
          result.more=Boolean(cursor.nextToken);
          if(!cursor.nextToken)break;
        }
        return result;
      } finally {busy=false;}
    },
  };
}
export function startIndexLoop(indexer,{intervalMs=15000,log=console.log}={}) {
  let stopped=false,timer;
  async function tick(){
    let more=false;
    try{const result=await indexer.runOnce();more=result.more;log(JSON.stringify({event:'session_index_pass',...result}));}
    catch{log(JSON.stringify({event:'session_index_unavailable'}));}
    if(!stopped)timer=setTimeout(tick,more?0:intervalMs);
  }
  void tick();
  return ()=>{stopped=true;clearTimeout(timer);};
}
