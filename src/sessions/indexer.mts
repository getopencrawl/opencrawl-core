import type {Principal, SourceOptions, SessionBatch, Attachment, SessionEvent} from './types.mjs';
import {parseJson} from './types.mjs';
import type {DocumentItem} from '../search/types.mjs';
import type {StoredMemorySnapshot} from '../memories/types.mjs';
import type {createSessionSearch} from './search.mjs';
export interface SessionPipelineOptions extends SourceOptions {search: ReturnType<typeof createSessionSearch>; jobId?: string; checkActive?: () => Promise<void>}
import {gunzipSync} from 'node:zlib';
import {digest,sessionScope,MAX_BATCH_BYTES} from './ingest.mjs';
import {sourceBatchIdentity,reserveSessionEvents} from './event-identity.mjs';
import {memorySourceIdentity,verifyStoredMemory,MAX_MEMORY_BYTES} from '../memories/snapshot.mjs';
import {createControls} from './controls.mjs';
import {sessionWriteBarrier, sessionWriteStore} from './write-barrier.mjs';
import {memoryControls} from '../memories/library.mjs';
export {sourceBatchIdentity} from './event-identity.mjs';
export {memorySourceIdentity} from '../memories/snapshot.mjs';

function collect(value: unknown,text: string[],attachments: Attachment[],names: Set<string>,depth=0): void {
  if(depth>128)throw Object.assign(new Error('Event structure exceeds supported depth'),{status:400,permanent:true});
  if(typeof value==='string'){if(!value.startsWith('data:'))text.push(value);return;}
  if(!value||typeof value!=='object')return;
  const fields=value as Record<string, unknown>;
  if(fields.type==='opencrawl_attachment'){attachments.push(fields as Attachment);return;}
  if(typeof fields.type==='string'&&['tool_use','function_call','custom_tool_call'].includes(fields.type)&&typeof fields.name==='string')names.add(fields.name);
  if(Array.isArray(value)){for(const child of value)collect(child,text,attachments,names,depth+1);return;}
  // JSON object property order is not event identity. Keep chunk boundaries
  // stable when an equivalent event arrives with reordered object properties.
  for(const key of Object.keys(value).sort()) {
    if(['id','type','role','call_id','tool_use_id','encrypted_content','image_url'].includes(key))continue;
    collect(fields[key],text,attachments,names,depth+1);
  }
}
/** One document per captured event chunk, whichever installation uploaded it.
 * Event IDs are content-derived, so the same native record re-uploaded from a
 * cloned machine or a second install overwrites rather than duplicates. */
export function sessionDocumentId({scope,harness,sessionId,eventId,chunk}: {scope: string; harness: string; sessionId: string; eventId: string; chunk: number}) {
  return digest(JSON.stringify([scope,harness,sessionId,eventId,chunk]));
}
/** Shared searchable/meterable content; null denotes a transcript echo. */
export function sessionEventData(harness: string,event: {kind?: string; data?: unknown}): unknown {
  if(event.kind==='hook'||harness==='codex'&&event.kind==='user_message')return null;
  if(event.kind!=='compaction')return event.data;
  const data=event.data&&typeof event.data==='object'?event.data as Record<string,unknown>:{};
  return Object.fromEntries((harness==='codex'?['message']:['summary','content']).flatMap(key=>typeof data[key]==='string'?[[key,data[key]]]:[]));
}
export function batchDocuments({prefix,key,batch,principal,visibility='team'}: {prefix: string; key: string; batch: SessionBatch; principal: Principal; visibility?: 'team' | 'private'}): DocumentItem[] {
  const scope=sessionScope(principal),identity=sourceBatchIdentity(prefix,key);
  if(!identity||identity.tenantHash!==digest(principal.tenantId)||identity.userHash!==digest(principal.userId)||
    batch?.owner?.tenantId!==principal.tenantId||batch?.owner?.userId!==principal.userId||batch.schemaVersion!==1||
    batch.harness!==identity.harness||digest(batch.installationId??'')!==identity.installationHash||digest(batch.sessionId??'')!==identity.sessionHash||
    !Array.isArray(batch.events)||batch.events.length>1000)throw new Error('Stored batch does not match its authorized scope and source key');
  const documents=[];
  for(const event of batch.events){
    if(!event||typeof event.id!=='string'||!event.id||typeof event.kind!=='string')throw Object.assign(new Error('Malformed stored event'),{permanent:true});
    // Hooks and Codex user_message notifications echo the native transcript.
    // Keep their immutable capture evidence, without indexing a second copy.
    const data=sessionEventData(batch.harness,event);
    if(data===null)continue;
    // Compaction is a context snapshot, not a new transcript. In particular,
    // replacement_history/retained_context also contain repeated system and
    // developer prompts. Only the explicit human-readable summary is evidence.
    const texts: string[]=[],attachments: Attachment[]=[],names=new Set<string>();collect(data,texts,attachments,names);
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
          objectKey:/^[a-f0-9]{64}$/.test(a.sha256??'')?(batch.attachments?.find(item=>item.sha256===a.sha256)?.objectKey===`${prefix}/${scope}/${batch.harness}/${digest(batch.installationId)}/${digest(batch.sessionId)}/attachments/${a.sha256}`
            ? `${prefix}/${scope}/${batch.harness}/${digest(batch.installationId)}/${digest(batch.sessionId)}/attachments/${a.sha256}` : `${prefix}/${scope}/attachments/${a.sha256}`):null})),private:visibility==='private'};
      documents.push({id:sessionDocumentId({scope,harness:batch.harness,sessionId:batch.sessionId,eventId:event.id,chunk}),document});
    }
  }
  return documents;
}

/** Activities call these bounded operations; Temporal owns cursors and retries.
 * The runtime supplies fixed self-host identity or resolves server-authenticated
 * stored owners. Workflow arguments never select a bucket, index, or principal.
 */
export function createSessionPipeline({store,prefix,search,principal,resolvePrincipal,jobId='sessions-v1',checkActive=async()=>{}}: SessionPipelineOptions) {
  if(Boolean(principal)===Boolean(resolvePrincipal))throw new Error('Supply one fixed single-tenant principal or a trusted scope resolver');
  if(principal)sessionScope(principal);
  if(!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid session prefix');
  const sourcePrefix=prefix+'/'+(principal?sessionScope(principal)+'/':'tenants/');
  // Reuse successful receipts from the previous worker. Its pending/retry/cursor
  // objects are ignored; no ingest-side work item is needed for discovery.
  const statePrefix=prefix+'/_index/'+digest(search.identity)+'/'+digest(jobId+':'+(principal?sessionScope(principal):'runtime-resolved'));
  function authorizedKey(key: string) {
    if(typeof key!=='string'||!key.startsWith(sourcePrefix)||!(sourceBatchIdentity(prefix,key)||memorySourceIdentity(prefix,key)))throw Object.assign(new Error('Session object outside authorized source'),{permanent:true});
  }
  const receiptKey=(key: string)=>statePrefix+'/batches/'+digest(key)+'.json';
  const controls=createControls({store,prefix});
  async function indexed(key: string) {
    const receipt=await store.get(receiptKey(key));
    return Boolean(receipt&&parseJson<{status: string}>(receipt).status==='indexed');
  }
  return {
    async listPage({cursor=null}: {cursor?: string | null}={}) {
      if(cursor!==null&&(typeof cursor!=='string'||cursor.length>8192))throw Object.assign(new Error('Invalid session cursor'),{permanent:true});
      await checkActive();
      const page=await store.listPage(sourcePrefix,{continuationToken:cursor,maxKeys:50});
      const keys=page.keys.filter(key=>sourceBatchIdentity(prefix,key)||memorySourceIdentity(prefix,key));
      // Every run rereads the whole prefix. Drop already-indexed objects here with
      // concurrent receipt reads rather than one serialized activity per object,
      // so new uploads are not queued behind a full replay of history.
      const pending=await Promise.all(keys.map(async key=>await indexed(key)?null:key));
      return {keys:pending.filter((key): key is string=>key!==null),cursor:page.nextToken||null};
    },
    async processObject({key}: {key: string}) {
      authorizedKey(key);await checkActive();
      const stateKey=receiptKey(key);
      if(await indexed(key))return {records:0,skipped:true};
      const bytes=await store.get(key);
      if(!bytes){
        const source=sourceBatchIdentity(prefix,key);
        if(source&&(await controls.readSource(source))?.deletedAt)return {records:0,skipped:true};
        throw new Error('Session source unavailable without a deletion tombstone');
      }
      const memory=Boolean(memorySourceIdentity(prefix,key));
      const batch=parseJson<SessionBatch>(gunzipSync(bytes,{maxOutputLength:(memory?MAX_MEMORY_BYTES:MAX_BATCH_BYTES)+1024*1024}));
      const scope=principal||await resolvePrincipal!({key,batch});sessionScope(scope);
      if(memory) {
        verifyStoredMemory({prefix,key,snapshot:batch as unknown as StoredMemorySnapshot,principal:scope});
        await checkActive();
        if(!search.memories)throw new Error('Memory indexing is not configured');
        const snapshot=batch as unknown as StoredMemorySnapshot;
        const count=await search.memories.putSnapshot(snapshot,scope,key,{controls:await memoryControls(controls,scope,snapshot)});
        await checkActive();
        await store.put(stateKey,Buffer.from(JSON.stringify({status:'indexed',sourceKey:key,documents:count,indexedAt:new Date().toISOString()})),'application/json');
        return {records:count,skipped:false};
      }
      // Owner controls apply before any write: deleted sessions are never indexed
      // again, and private sessions are written private.
      const control=await controls.read(scope,'sessions',batch.harness,batch.sessionId);
      const barrier=sessionWriteBarrier(store,prefix,scope,batch.harness,batch.sessionId);
      if(control?.deletedAt || (await barrier.inspect()).closed) {
        await store.put(stateKey,Buffer.from(JSON.stringify({status:'indexed',sourceKey:key,documents:0,deleted:true,indexedAt:new Date().toISOString()})),'application/json');
        return {records:0,skipped:true};
      }
      const docs=batchDocuments({prefix,key,batch,principal:scope,visibility:control?.visibility});
      // Check the whole event before any chunk write. Receipt order, shorter
      // payloads and concurrent activities must never assemble mixed revisions.
      try {
      await checkActive();await reserveSessionEvents({store:sessionWriteStore(store,prefix,scope,batch.harness,batch.sessionId),prefix,principal:scope,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId,events:batch.events});
      await checkActive();await search.ensureIndex(scope);
      await barrier.run('search-write',()=>search.putDocuments(docs,scope),{target:digest(key)});
      } catch(error) {if((await barrier.inspect()).closed)return {records:0,skipped:true};throw error;}
      // A visibility change or delete that landed while this batch was indexing
      // must still apply to the documents just written.
      const after=await controls.read(scope,'sessions',batch.harness,batch.sessionId);
      if(after?.deletedAt||(after?.visibility??'team')!==(control?.visibility??'team'))await search.applySessionControl(scope,{harness:batch.harness,sessionId:batch.sessionId},after!);
      await checkActive();
      await store.put(stateKey,Buffer.from(JSON.stringify({status:'indexed',sourceKey:key,documents:docs.length,indexedAt:new Date().toISOString()})),'application/json');
      return {records:docs.length,skipped:false};
    },
  };
}
