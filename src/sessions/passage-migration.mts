import type {TenantPrincipal,JsonValue,ObjectStore,SessionBatch} from './types.mjs';
import type {DocumentItem,IndexHit,SearchDocument} from '../search/types.mjs';
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

/** Rebuild bounded groups from immutable captures. Each backup contains only
 * one session, so the runtime can keep it inside that session's deletion root.
 * Checkpoint after complete pages; replay uses the preserved first backup.
 * Raw captures, event ledgers and ingest receipts are never rewritten. */
export async function migrateSessionPassages({realm,principal,store,prefix,backup,onPage=async()=>{},dryRun=true,pageSize=100,after=null,maxEvents=Infinity,eventIdRange}: {
  realm:Realm;principal:TenantPrincipal;store:ObjectStore;prefix:string;backup(step:PassageMigrationStep):Promise<unknown>;
  onPage?(report:PassageMigrationReport):Promise<unknown>;dryRun?:boolean;pageSize?:number;after?:JsonValue[]|null;maxEvents?:number;eventIdRange?:{gte?:string;lt?:string};
}):Promise<PassageMigrationReport>{
  if(!principal?.tenantId||principal.tenantId!==realm.tenantId||principal.captureAccess!==undefined)throw Object.assign(new Error('Realm scope denied'),{status:403});
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!(maxEvents>0))throw new Error('Invalid migration bounds');
  if(eventIdRange&&(!Object.keys(eventIdRange).length||Object.entries(eventIdRange).some(([k,v])=>!['gte','lt'].includes(k)||typeof v!=='string'||!v.length||v.length>200)||eventIdRange.gte&&eventIdRange.lt&&eventIdRange.gte>=eventIdRange.lt))throw new Error('Invalid event ID partition');
  if(!dryRun)await realm.ensureIndex();
  const collection=realm.collection('session'),f=collection.field,controls=createControls({store,prefix});
  const report:PassageMigrationReport={events:0,passages:0,skippedDeleted:0,after,complete:false};
  const sessionKey=(d:SearchDocument)=>JSON.stringify([d.userId,d.harness,d.sessionId]);
  const eventKey=(d:SearchDocument)=>JSON.stringify([d.userId,d.harness,d.sessionId,d.eventId]);
  let lastCompletedEvent='';
  for(;;){
    const page=await collection.search(principal,{size:Math.min(pageSize,maxEvents-report.events),track_total_hits:false,
      query:{bool:{...(eventIdRange?{filter:[{range:{[f('eventId')]:eventIdRange}}]}:{}),must_not:[{range:{[f('passageVersion')]:{gte:PASSAGE_VERSION}}}]}},
      sort:[...['userId','harness','sessionId','eventId'].map(k=>({[f(k)]:'asc'})),{id:'asc'}],...(report.after?{search_after:report.after}:{})});
    if(page.timed_out||page._shards?.failed!==0)throw new Error('Incomplete passage migration scan');
    if(!page.hits.hits.length){report.complete=true;report.after=null;await onPage({...report});return report;}
    const cursor=page.hits.hits.at(-1)!.sort;
    if(!cursor||JSON.stringify(cursor)===JSON.stringify(report.after))throw new Error('Non-advancing migration cursor');
    const groups=new Map<string,Map<string,IndexHit>>();
    for(const hit of page.hits.hits){
      const d=hit._source,key=d.sourceKey;
      if(d.tenantId!==principal.tenantId||typeof d.userId!=='string'||typeof d.harness!=='string'||typeof d.sessionId!=='string'||typeof d.eventId!=='string'||typeof key!=='string')throw new Error('Invalid indexed event identity');
      const identity=sourceBatchIdentity(prefix,key);
      if(!identity||identity.tenantHash!==digest(principal.tenantId)||identity.userHash!==digest(d.userId)||identity.harness!==d.harness||identity.sessionHash!==digest(d.sessionId))throw new Error('Migration source scope denied');
      if(eventKey(d)===lastCompletedEvent)continue;
      const group=groups.get(sessionKey(d))??new Map();group.set(d.eventId,hit);groups.set(sessionKey(d),group);
    }
    for(const events of groups.values()){
      const sample=events.values().next().value!._source,owner={tenantId:principal.tenantId,userId:sample.userId!};
      const control=await controls.read(owner,'sessions',sample.harness!,sample.sessionId!);
      if(control?.deletedAt){report.skippedDeleted+=events.size;continue;}
      const eventFilter={bool:{filter:[...['userId','harness','sessionId'].map(k=>({term:{[f(k)]:sample[k]}})),{terms:{[f('eventId')]:[...events.keys()]}}]}};
      const previous:DocumentItem[]=[];let eventAfter:JsonValue[]|undefined,inventoryBytes=0;
      for(;;){
        const existing=await collection.search(principal,{size:1000,track_total_hits:true,query:eventFilter,sort:[{[f('eventId')]:'asc'},{[f('chunk')]:'asc'},{id:'asc'}],...(eventAfter?{search_after:eventAfter}:{})});
        if(existing.timed_out||existing._shards?.failed!==0||existing.hits.total.relation!=='eq'||existing.hits.total.value>100000)throw new Error('Incomplete event inventory');
        inventoryBytes+=Buffer.byteLength(JSON.stringify(existing.hits.hits));
        if(inventoryBytes>64*1024*1024)throw new Error('Event inventory exceeds bounded memory; reduce pageSize');
        previous.push(...existing.hits.hits.map(h=>({id:h._id,document:h._source})));
        if(previous.length>existing.hits.total.value)throw new Error('Event inventory changed during migration');
        if(previous.length>=existing.hits.total.value)break;
        const next=existing.hits.hits.at(-1)?.sort;if(!next||JSON.stringify(next)===JSON.stringify(eventAfter))throw new Error('Non-advancing event inventory');eventAfter=next;
      }
      const needed=new Set([...events.keys()].filter(id=>previous.some(x=>x.document.eventId===id&&Number(x.document.passageVersion??0)<PASSAGE_VERSION)));
      if(!needed.size)continue;
      // Read at most four bounded source buffers concurrently, reuse one parsed
      // batch for all selected events, and release it before the next group.
      const sourceEvents=new Map<string,string[]>();
      for(const id of needed){const key=events.get(id)!._source.sourceKey!;sourceEvents.set(key,[...(sourceEvents.get(key)??[]),id]);}
      const sources=[...sourceEvents],replacements:DocumentItem[]=[];
      for(let start=0;start<sources.length;start+=4){
        const group=sources.slice(start,start+4),reads=await Promise.allSettled(group.map(([key])=>store.get(key,{maxBytes:MAX_BATCH_BYTES+1024*1024})));
        for(let i=0;i<reads.length;i++){
          const read=reads[i]!;if(read.status==='rejected')throw read.reason;if(!read.value)throw new Error('Missing immutable source; projection preserved');
          const [key,ids]=group[i]!,batch=JSON.parse(gunzipSync(read.value,{maxOutputLength:MAX_BATCH_BYTES+1024*1024}).toString('utf8')) as SessionBatch;
          const docs=batchDocuments({prefix,key,batch,principal:owner});
          if(batch.sessionId!==sample.sessionId||batch.harness!==sample.harness||ids.some(id=>!batch.events.some(e=>e.id===id&&e.kind===events.get(id)!._source.kind)))throw new Error('Capture does not contain indexed event');
          replacements.push(...docs.filter(x=>ids.includes(x.document.eventId!)));
        }
      }
      const changed=previous.filter(x=>needed.has(x.document.eventId!)),replacementIds=replacements.map(x=>x.id),replacementSet=new Set(replacementIds),retired=changed.map(x=>x.id).filter(id=>!replacementSet.has(id));
      if(!dryRun)await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:changed},async()=>{
        const current=await controls.read(owner,'sessions',sample.harness!,sample.sessionId!);
        if(current?.deletedAt)throw Object.assign(new Error('Deleted session cannot be reindexed'),{status:403,writeOutcome:'not-applied'});
        await backup({previous:changed,replacementIds});
        let batch:DocumentItem[]=[],bytes=0;const written:DocumentItem[]=[];
        for(const item of replacements){
          const document={...item.document,private:current?.visibility==='private'},size=Buffer.byteLength(JSON.stringify(document));
          if(bytes+size>2*1024*1024){await collection.bulk(owner,batch);batch=[];bytes=0;}
          batch.push({id:item.id,document});written.push({id:item.id,document});bytes+=size;
        }
        if(batch.length)await collection.bulk(owner,batch);
        if(retired.length)await collection.delete(owner,retired);
        for(let start=0;start<written.length;start+=100){
          // Visibility can change concurrently; compare source projection here,
          // then reconcile the authoritative control below.
          const expected=written.slice(start,start+100),readback=await collection.mget(owner,expected.map(x=>x.id)),actual=new Map(readback.docs.map(h=>[h._id,h]));
          if(expected.some(x=>!actual.get(x.id)?.found||documentDigest({...actual.get(x.id)!._source,private:undefined})!==documentDigest({...x.document,private:undefined})))throw new Error('Passage migration readback mismatch');
        }
        const afterControl=await controls.read(owner,'sessions',sample.harness!,sample.sessionId!);
        if(afterControl?.deletedAt||(afterControl?.visibility??'team')!==(current?.visibility??'team'))await applySessionControl(collection,owner,{userId:owner.userId,harness:sample.harness!,sessionId:sample.sessionId!},afterControl!);
      });
      report.events+=needed.size;report.passages+=replacements.length;
    }
    lastCompletedEvent=eventKey(page.hits.hits.at(-1)!._source);
    report.after=cursor;await onPage({...report});if(report.events>=maxEvents)return report;
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
