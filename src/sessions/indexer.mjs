import {gunzipSync} from 'node:zlib';
import {digest,sessionScope,MAX_BATCH_BYTES} from './ingest.mjs';

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

/** Activities call these bounded operations; Temporal owns cursors and retries.
 * The runtime supplies fixed self-host identity or resolves server-authenticated
 * stored owners. Workflow arguments never select a bucket, index, or principal.
 */
export function createSessionPipeline({store,prefix,search,principal,resolvePrincipal,jobId='sessions-v1',checkActive=async()=>{}}) {
  if(Boolean(principal)===Boolean(resolvePrincipal))throw new Error('Supply one fixed single-tenant principal or a trusted scope resolver');
  if(principal)sessionScope(principal);
  if(!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid session prefix');
  const sourcePrefix=prefix+'/'+(principal?sessionScope(principal)+'/':'tenants/');
  // Reuse successful receipts from the previous worker. Its pending/retry/cursor
  // objects are ignored; no ingest-side work item is needed for discovery.
  const statePrefix=prefix+'/_index/'+digest(search.identity)+'/'+digest(jobId+':'+(principal?sessionScope(principal):'runtime-resolved'));
  function authorizedKey(key) {
    if(typeof key!=='string'||!key.startsWith(sourcePrefix)||!sourceBatchIdentity(prefix,key))throw Object.assign(new Error('Session object outside authorized source'),{permanent:true});
  }
  return {
    async listPage({cursor=null}={}) {
      if(cursor!==null&&(typeof cursor!=='string'||cursor.length>8192))throw Object.assign(new Error('Invalid session cursor'),{permanent:true});
      await checkActive();
      const page=await store.listPage(sourcePrefix,{continuationToken:cursor,maxKeys:50});
      return {keys:page.keys.filter(key=>sourceBatchIdentity(prefix,key)),cursor:page.nextToken||null};
    },
    async processObject({key}) {
      authorizedKey(key);await checkActive();
      const stateKey=statePrefix+'/batches/'+digest(key)+'.json';
      const receipt=await store.get(stateKey);
      if(receipt&&JSON.parse(receipt).status==='indexed')return {records:0,skipped:true};
      const bytes=await store.get(key);
      if(!bytes)throw new Error('Session source object unavailable');
      const batch=JSON.parse(gunzipSync(bytes,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}));
      const scope=principal||await resolvePrincipal({key,batch});sessionScope(scope);
      const docs=batchDocuments({prefix,key,batch,principal:scope});
      await checkActive();await search.ensureIndex();await search.putDocuments(docs);
      await checkActive();
      await store.put(stateKey,Buffer.from(JSON.stringify({status:'indexed',sourceKey:key,documents:docs.length,indexedAt:new Date().toISOString()})),'application/json');
      return {records:docs.length,skipped:false};
    },
  };
}
