import type {TenantPrincipal,JsonValue,ObjectStore,SessionBatch} from './types.mjs';
import type {DocumentItem} from '../search/types.mjs';
import type {createRealm} from '../search/realm.mjs';
import {gunzipSync} from 'node:zlib';
import {MAX_BATCH_BYTES,digest} from './ingest.mjs';
import {batchDocuments,sourceBatchIdentity} from './indexer.mjs';
import {withSessionDocumentWrites} from './write-barrier.mjs';
import {createControls} from './controls.mjs';
import {PASSAGE_VERSION} from '../search/passages.mjs';
import {applySessionControl} from './library.mjs';
import {documentDigest} from '../search/migration.mjs';

type Realm=Pick<ReturnType<typeof createRealm>,'tenantId'|'collection'|'ensureIndex'>;
export interface PassageMigrationStep {previous:DocumentItem[]; replacementIds:string[]}
export interface PassageMigrationReport {events:number; passages:number; skippedDeleted:number; after:JsonValue[]|null; complete:boolean}

/** Rebuild one event at a time from its immutable captured batch. Back up before
 * writes, checkpoint after the event, and resume from the last completed cursor.
 * Current privacy/deletion controls and durable write fences apply to migration
 * and rollback. Old success receipts are deliberately left intact. */
export async function migrateSessionPassages({realm,principal,store,prefix,backup,onPage=async()=>{},dryRun=true,pageSize=25,after=null,maxEvents=Infinity}: {
  realm:Realm;principal:TenantPrincipal;store:ObjectStore;prefix:string;backup(step:PassageMigrationStep):Promise<unknown>;
  onPage?(report:PassageMigrationReport):Promise<unknown>;dryRun?:boolean;pageSize?:number;after?:JsonValue[]|null;maxEvents?:number;
}):Promise<PassageMigrationReport>{
  if(!principal?.tenantId||principal.tenantId!==realm.tenantId||principal.captureAccess!==undefined)throw Object.assign(new Error('Realm scope denied'),{status:403});
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!(maxEvents>0))throw new Error('Invalid migration bounds');
  if(!dryRun)await realm.ensureIndex();
  const collection=realm.collection('session'),f=collection.field,controls=createControls({store,prefix});
  const report:PassageMigrationReport={events:0,passages:0,skippedDeleted:0,after,complete:false};
  let lastCompletedEvent='';
  let cachedKey='',cachedBatch:SessionBatch|undefined,cachedDocuments:DocumentItem[]=[];
  for(;;){
    const page=await collection.search(principal,{size:pageSize,track_total_hits:false,
      query:{bool:{must_not:[{range:{[f('passageVersion')]:{gte:PASSAGE_VERSION}}}]}},
      sort:[...['userId','harness','sessionId','eventId'].map(k=>({[f(k)]:'asc'})),{id:'asc'}],...(report.after?{search_after:report.after}:{})});
    if(page.timed_out||page._shards?.failed!==0)throw new Error('Incomplete passage migration scan');
    if(!page.hits.hits.length){report.complete=true;report.after=null;await onPage({...report});return report;}
    for(const hit of page.hits.hits){
      const d=hit._source,key=d.sourceKey;
      if(d.tenantId!==principal.tenantId||typeof d.userId!=='string'||typeof d.harness!=='string'||typeof d.sessionId!=='string'||typeof d.eventId!=='string'||typeof key!=='string')throw new Error('Invalid indexed event identity');
      const owner={tenantId:principal.tenantId,userId:d.userId},identity=sourceBatchIdentity(prefix,key);
      if(!identity||identity.tenantHash!==digest(owner.tenantId)||identity.userHash!==digest(owner.userId)||identity.harness!==d.harness||identity.sessionHash!==digest(d.sessionId))throw new Error('Migration source scope denied');
      const cursor=hit.sort;if(!cursor||JSON.stringify(cursor)===JSON.stringify(report.after))throw new Error('Non-advancing migration cursor');
      const eventIdentity=JSON.stringify([d.userId,d.harness,d.sessionId,d.eventId]);
      if(eventIdentity===lastCompletedEvent){report.after=cursor;continue;}
      const control=await controls.read(owner,'sessions',d.harness,d.sessionId);
      if(control?.deletedAt){report.skippedDeleted++;report.after=cursor;await onPage({...report});continue;}
      if(cachedKey!==key){
        const raw=await store.get(key,{maxBytes:MAX_BATCH_BYTES+1024*1024});if(!raw)throw new Error('Missing immutable source; projection preserved');
        cachedBatch=JSON.parse(gunzipSync(raw,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}).toString('utf8')) as SessionBatch;
        cachedDocuments=batchDocuments({prefix,key,batch:cachedBatch,principal:owner});cachedKey=key;
      }
      if(!cachedBatch||cachedBatch.sessionId!==d.sessionId||cachedBatch.harness!==d.harness||!cachedBatch.events.some(e=>e.id===d.eventId&&e.kind===d.kind))throw new Error('Capture does not contain indexed event');
      const eventFilter={bool:{filter:['userId','harness','sessionId','eventId'].map(k=>({term:{[f(k)]:d[k]}}))}};
      const existing=await collection.search(principal,{size:10000,track_total_hits:true,query:eventFilter,sort:[{[f('chunk')]:'asc'},{id:'asc'}]});
      if(existing.timed_out||existing._shards?.failed!==0||existing.hits.total.relation!=='eq'||existing.hits.total.value>10000)throw new Error('Incomplete event inventory');
      const previous=existing.hits.hits.map(h=>({id:h._id,document:h._source}));
      // A preceding copy of this legacy event may already have migrated it.
      if(previous.length&&previous.every(x=>Number(x.document.passageVersion)>=PASSAGE_VERSION)){report.after=cursor;await onPage({...report});continue;}
      const replacements=cachedDocuments.filter(x=>x.document.eventId===d.eventId);
      const replacementIds=replacements.map(x=>x.id),retired=previous.map(x=>x.id).filter(id=>!replacementIds.includes(id));
      if(!dryRun)await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:previous.length?previous:[{id:hit._id,document:d}]},async()=>{
        const current=await controls.read(owner,'sessions',d.harness!,d.sessionId!);
        if(current?.deletedAt)throw Object.assign(new Error('Deleted session cannot be reindexed'),{status:403,writeOutcome:'not-applied'});
        await backup({previous,replacementIds});
        let batch:DocumentItem[]=[],bytes=0;
        const written:DocumentItem[]=[];
        for(const item of replacements){
          const document={...item.document,private:current?.visibility==='private'},size=Buffer.byteLength(JSON.stringify(document));
          if(bytes+size>2*1024*1024){await collection.bulk(owner,batch);batch=[];bytes=0;}
          batch.push({id:item.id,document});written.push({id:item.id,document});bytes+=size;
        }
        if(batch.length)await collection.bulk(owner,batch);
        if(retired.length)await collection.delete(owner,retired);
        for(let start=0;start<written.length;start+=100){
          const expected=written.slice(start,start+100),readback=await collection.mget(owner,expected.map(x=>x.id));
          const actual=new Map(readback.docs.map(h=>[h._id,h]));
          if(expected.some(x=>!actual.get(x.id)?.found||documentDigest(actual.get(x.id)!._source)!==documentDigest(x.document)))throw new Error('Passage migration readback mismatch');
        }
        const afterControl=await controls.read(owner,'sessions',d.harness!,d.sessionId!);
        if(afterControl?.deletedAt||(afterControl?.visibility??'team')!==(current?.visibility??'team'))await applySessionControl(collection,owner,{userId:owner.userId,harness:d.harness!,sessionId:d.sessionId!},afterControl!);
      });
      lastCompletedEvent=eventIdentity;
      report.events++;report.passages+=replacements.length;report.after=cursor;await onPage({...report});
      if(report.events>=maxEvents)return report;
    }
  }
}

/** Drain indexing/visibility writes before rollback. Current privacy wins over
 * the backup; deletion fences prevent restoration of a deleted session. */
export async function restoreSessionPassages({realm,principal,store,prefix,steps}: {
  realm:Realm;principal:TenantPrincipal;store:ObjectStore;prefix:string;steps:PassageMigrationStep[];
}){
  if(principal?.tenantId!==realm.tenantId||principal.captureAccess!==undefined)throw Object.assign(new Error('Realm scope denied'),{status:403});
  const collection=realm.collection('session'),controls=createControls({store,prefix});let restored=0;
  for(const step of [...steps].reverse()){
    if(!step.previous.length)throw new Error('Missing rollback ownership evidence');
    await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:step.previous},async()=>{
      for(const item of step.previous){
        const d=item.document,control=await controls.read({tenantId:principal.tenantId,userId:d.userId!},'sessions',d.harness!,d.sessionId!);
        await collection.bulk(principal,[{id:item.id,document:{...d,private:control?.visibility==='private'}}]);restored++;
      }
      const original=new Set(step.previous.map(x=>x.id));await collection.delete(principal,step.replacementIds.filter(id=>!original.has(id)));
    });
  }
  return {restored};
}
