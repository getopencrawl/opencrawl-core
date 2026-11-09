import type {TenantPrincipal, JsonValue, ObjectStore, SessionBatch} from './types.mjs';
import type {DocumentItem, SearchDocument} from '../search/types.mjs';
import type {createRealm} from '../search/realm.mjs';
import {gunzipSync} from 'node:zlib';
import {MAX_BATCH_BYTES,digest} from './ingest.mjs';
import {batchDocuments,sourceBatchIdentity} from './indexer.mjs';

type Realm = Pick<ReturnType<typeof createRealm>, 'tenantId' | 'collection'>;
export interface SessionProjectionReport {scanned: number; rewritten: number; removed: number; unchanged: number; after: JsonValue[] | null; complete: boolean}
export interface SessionProjectionBackup {previous: DocumentItem[]}

/** Repair only the derived projection; raw captures, event IDs, ledgers and
 * receipts stay intact. Deploy the fixed worker before running this migration.
 * Back up each page before mutation. A crash repeats the page idempotently. */
export async function migrateSessionProjection({realm, principal, store, prefix, backup, dryRun=false, pageSize=100, after=null, onPage=async()=>{}}: {
  realm: Realm; principal: TenantPrincipal; store: Pick<ObjectStore,'get'>; prefix: string;
  backup(step: SessionProjectionBackup): Promise<unknown>; dryRun?: boolean; pageSize?: number; after?: JsonValue[] | null;
  onPage?(report: SessionProjectionReport): Promise<unknown>;
}): Promise<SessionProjectionReport> {
  if(!principal?.tenantId||principal.tenantId!==realm.tenantId||principal.captureAccess!==undefined)throw Object.assign(new Error('Realm scope denied'),{status:403});
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('Invalid page size');
  const sessions=realm.collection('session'),field=sessions.field;
  const report: SessionProjectionReport={scanned:0,rewritten:0,removed:0,unchanged:0,after,complete:false};
  let cachedKey: string|undefined,cached: DocumentItem[]=[],stored: SessionBatch|undefined;
  for(;;) {
    const result=await sessions.search(principal,{size:pageSize,track_total_hits:false,
      query:{bool:{should:[{terms:{[field('kind')]:['compaction','hook']}},{bool:{filter:[{term:{[field('harness')]:'codex'}},{term:{[field('kind')]:'user_message'}}]}}],minimum_should_match:1}},
      sort:[...['userId','harness','sessionId','eventId','chunk'].map(key=>({[field(key)]:'asc'})),{id:'asc'}],...(report.after?{search_after:report.after}:{})});
    if(result.timed_out||result._shards?.failed!==0)throw new Error('Incomplete session projection scan');
    const hits=result.hits.hits;
    if(!hits.length){report.complete=true;report.after=null;await onPage({...report});return report;}
    const writes: DocumentItem[]=[],removals: string[]=[],previous: DocumentItem[]=[];
    // Bound source memory to one capture batch per page, even for large sessions.
    for(const hit of hits) {
      const doc=hit._source;
      if(doc.tenantId!==principal.tenantId||typeof doc.userId!=='string'||typeof doc.sourceKey!=='string'||typeof doc.eventId!=='string'||!Number.isSafeInteger(doc.chunk))throw new Error('Invalid session projection source');
      const identity=sourceBatchIdentity(prefix,doc.sourceKey);
      if(!identity||identity.tenantHash!==digest(principal.tenantId)||identity.userHash!==digest(doc.userId))throw new Error('Session source scope denied');
      if(cachedKey!==doc.sourceKey) {
        const bytes=await store.get(doc.sourceKey,{maxBytes:MAX_BATCH_BYTES+1024*1024});
        if(!bytes)throw new Error('Session source unavailable; projection preserved');
        const batch=JSON.parse(gunzipSync(bytes,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}).toString('utf8')) as SessionBatch;
        cached=batchDocuments({prefix,key:doc.sourceKey,batch,principal:{tenantId:principal.tenantId,userId:doc.userId}});
        cachedKey=doc.sourceKey;stored=batch;
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
    const cursor=hits.at(-1)?.sort;
    if(!cursor||JSON.stringify(cursor)===JSON.stringify(report.after))throw new Error('Session projection scan returned no advancing cursor');
    if(!dryRun&&previous.length) {
      await backup({previous});
      // Each replacement is at most one 16k text chunk; cap bulk size separately.
      for(const item of writes)await sessions.bulk(principal,[{...item,script:"if (ctx._source.session == null) { ctx.op = 'none'; } else { ctx._source.text = params.doc.text; ctx._source.session.attachments = params.doc.session.attachments; ctx._source.session.toolNames = params.doc.session.toolNames; }"}]);
      if(removals.length)await sessions.delete(principal,removals);
    }
    report.after=cursor;await onPage({...report});
  }
}

/** Restore saved pages in reverse, using only the tenant they were saved for. */
export async function restoreSessionProjection({realm,principal,steps}: {realm: Realm; principal: TenantPrincipal; steps: SessionProjectionBackup[]}) {
  if(!principal?.tenantId||principal.tenantId!==realm.tenantId||principal.captureAccess!==undefined)throw Object.assign(new Error('Realm scope denied'),{status:403});
  let restored=0;
  for(const step of [...steps].reverse())for(const item of step.previous) {
    if(item.document.tenantId!==principal.tenantId)throw new Error('Backup scope denied');
    await realm.collection('session').bulk(principal,[item]);restored++;
  }
  return {restored};
}
