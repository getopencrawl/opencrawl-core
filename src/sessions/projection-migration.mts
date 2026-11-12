import type {TenantPrincipal, JsonValue, ObjectStore, SessionBatch} from './types.mjs';
import type {DocumentItem, SearchDocument} from '../search/types.mjs';
import type {createRealm} from '../search/realm.mjs';
import {gunzipSync} from 'node:zlib';
import {MAX_BATCH_BYTES,digest} from './ingest.mjs';
import {batchDocuments,sourceBatchIdentity} from './indexer.mjs';
import {withSessionDocumentWrites} from './write-barrier.mjs';

type Realm = Pick<ReturnType<typeof createRealm>, 'tenantId' | 'collection'>;
export interface SessionProjectionReport {scanned: number; rewritten: number; removed: number; unchanged: number; after: JsonValue[] | null; complete: boolean}
export interface SessionProjectionBackup {previous: DocumentItem[]}

/** Repair only the derived projection; raw captures, event IDs, ledgers and
 * receipts stay intact. Deploy the fixed worker before running this migration.
 * Back up each page before mutation. A crash repeats the page idempotently. */
export async function migrateSessionProjection({realm, principal, store, prefix, backup, dryRun=false, pageSize=100, after=null, onPage=async()=>{}}: {
  realm: Realm; principal: TenantPrincipal; store: ObjectStore; prefix: string;
  backup(step: SessionProjectionBackup): Promise<unknown>; dryRun?: boolean; pageSize?: number; after?: JsonValue[] | null;
  onPage?(report: SessionProjectionReport): Promise<unknown>;
}): Promise<SessionProjectionReport> {
  if(!principal?.tenantId||principal.tenantId!==realm.tenantId||principal.captureAccess!==undefined)throw Object.assign(new Error('Realm scope denied'),{status:403});
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('Invalid page size');
  const sessions=realm.collection('session'),field=sessions.field;
  const report: SessionProjectionReport={scanned:0,rewritten:0,removed:0,unchanged:0,after,complete:false};
  let cachedKey: string|undefined,cached: DocumentItem[]=[],stored: SessionBatch|undefined;
  function authorizedSource(doc: SearchDocument): asserts doc is SearchDocument & {userId: string; sourceKey: string; eventId: string; chunk: number} {
    if(doc.tenantId!==principal.tenantId||typeof doc.userId!=='string'||typeof doc.sourceKey!=='string'||typeof doc.eventId!=='string'||!Number.isSafeInteger(doc.chunk))throw new Error('Invalid session projection source');
    const identity=sourceBatchIdentity(prefix,doc.sourceKey);
    if(!identity||identity.tenantHash!==digest(principal.tenantId)||identity.userHash!==digest(doc.userId))throw new Error('Session source scope denied');
  }
  for(;;) {
    const result=await sessions.search(principal,{size:pageSize,track_total_hits:false,
      query:{bool:{should:[{terms:{[field('kind')]:['compaction','hook']}},{bool:{filter:[{term:{[field('harness')]:'codex'}},{term:{[field('kind')]:'user_message'}}]}}],minimum_should_match:1}},
      sort:[...['userId','harness','sessionId','eventId','chunk'].map(key=>({[field(key)]:'asc'})),{id:'asc'}],...(report.after?{search_after:report.after}:{})});
    if(result.timed_out||result._shards?.failed!==0)throw new Error('Incomplete session projection scan');
    const hits=result.hits.hits;
    if(!hits.length){report.complete=true;report.after=null;await onPage({...report});return report;}
    const writes: DocumentItem[]=[],removals: string[]=[],previous: DocumentItem[]=[];
    // Overlap network reads, bounded to eight source buffers (at most 136 MiB).
    // Validate every key before reading and settle every read before any write.
    for(let start=0;start<hits.length;start+=8) {
      const group=hits.slice(start,start+8);
      const prior={key:cachedKey,documents:cached,batch:stored};
      const keys=[...new Set(group.map(hit=>{authorizedSource(hit._source);return hit._source.sourceKey;}))].filter(key=>key!==cachedKey);
      const reads=await Promise.allSettled(keys.map(key=>store.get(key,{maxBytes:MAX_BATCH_BYTES+1024*1024})));
      const sources=new Map<string,Buffer>();
      for(let i=0;i<reads.length;i++) {
        const read=reads[i]!;
        if(read.status==='rejected')throw read.reason;
        if(!read.value)throw new Error('Session source unavailable; projection preserved');
        sources.set(keys[i]!,read.value);
      }
      for(const hit of group) {
        const doc=hit._source;
        authorizedSource(doc);
        if(cachedKey!==doc.sourceKey) {
          if(doc.sourceKey===prior.key) {
            cachedKey=doc.sourceKey;cached=prior.documents;stored=prior.batch;
          } else {
            const bytes=sources.get(doc.sourceKey);
            if(!bytes)throw new Error('Session source unavailable; projection preserved');
            const batch=JSON.parse(gunzipSync(bytes,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}).toString('utf8')) as SessionBatch;
            cached=batchDocuments({prefix,key:doc.sourceKey,batch,principal:{tenantId:principal.tenantId,userId:doc.userId}});
            cachedKey=doc.sourceKey;stored=batch;
          }
        }
        if(!stored||stored.sessionId!==doc.sessionId||stored.harness!==doc.harness||stored.installationId!==doc.installationId||!stored.events.some(event=>event.id===doc.eventId&&event.kind===doc.kind))throw new Error('Indexed event does not match its capture');
        const projected=cached.find(item=>item.document.eventId===doc.eventId&&item.document.chunk===doc.chunk)?.document;
        report.scanned++;
        if(projected) {
          // Preserve index identity and current privacy, including legacy IDs.
          const document: SearchDocument={...doc,text:projected.text,attachments:projected.attachments,toolNames:projected.toolNames};
          if(JSON.stringify([doc.text,doc.attachments,doc.toolNames])===JSON.stringify([document.text,document.attachments,document.toolNames])){report.unchanged++;continue;}
          writes.push({id:hit._id,document});report.rewritten++;
        } else {removals.push(hit._id);report.removed++;}
        previous.push({id:hit._id,document:doc});
      }
    }
    const cursor=hits.at(-1)?.sort;
    if(!cursor||JSON.stringify(cursor)===JSON.stringify(report.after))throw new Error('Session projection scan returned no advancing cursor');
    if(!dryRun&&previous.length) {
      await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:previous},async()=>{
      await backup({previous});
      // Each replacement is at most one 16k text chunk; cap bulk size separately.
      for(const item of writes)await sessions.bulk(principal,[{...item,policy:'session-projection'}]);
      if(removals.length)await sessions.delete(principal,removals);
      });
    }
    report.after=cursor;await onPage({...report});
  }
}

/** Restore saved pages in reverse, using only the tenant they were saved for. */
export async function restoreSessionProjection({realm,principal,store,prefix,steps}: {realm: Realm; principal: TenantPrincipal; store:ObjectStore; prefix:string; steps: SessionProjectionBackup[]}) {
  if(!principal?.tenantId||principal.tenantId!==realm.tenantId||principal.captureAccess!==undefined)throw Object.assign(new Error('Realm scope denied'),{status:403});
  let restored=0;
  for(const step of [...steps].reverse())for(const item of step.previous) {
    if(item.document.tenantId!==principal.tenantId)throw new Error('Backup scope denied');
    await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:[item]},()=>realm.collection('session').bulk(principal,[item]));restored++;
  }
  return {restored};
}
