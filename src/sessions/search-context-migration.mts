import type {TenantPrincipal,ObjectStore,JsonValue} from './types.mjs';
import type {SearchRealm,DocumentItem,IndexHit} from '../search/types.mjs';
import {createSessionIngest,digest} from './ingest.mjs';
import {sourceBatchIdentity} from './event-identity.mjs';
import {createControls} from './controls.mjs';
import {withSessionDocumentWrites} from './write-barrier.mjs';
import {containsToolOutput} from './tool-output.mjs';

type EventClassifications=Map<string,{kind:string;containsToolOutput:boolean}>;
const MAX_CACHED_BATCHES=128,MAX_CACHED_EVENTS=100_000;

export interface SearchContextMigrationReport {passages:number;skippedDeleted:number;after:JsonValue[]|null;complete:boolean}
/** Add classification only. Capture, text, IDs, privacy and existing fields are
 * unchanged. Bounded, resumable writes cannot recreate deleted passages.
 * Older readers ignore this additive field, so rolling back code needs no data
 * rewrite. Counts include only previously unclassified passages; after is the
 * last fully checked page, and complete requires a scan with no remaining page. */
export async function migrateSessionSearchContext({realm,principal,store,prefix,dryRun=true,pageSize=500,maxPassages=1000,sourceConcurrency=4,after=null,onPage=async()=>{}}:{
  realm:SearchRealm;principal:TenantPrincipal;store:ObjectStore;prefix:string;
  dryRun?:boolean;pageSize?:number;maxPassages?:number;sourceConcurrency?:number;after?:JsonValue[]|null;
  onPage?(report:SearchContextMigrationReport):Promise<unknown>;
}):Promise<SearchContextMigrationReport>{
  if(!principal?.tenantId||principal.tenantId!==realm.tenantId||principal.captureAccess!==undefined)throw Object.assign(new Error('Realm scope denied'),{status:403});
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>500||!Number.isSafeInteger(maxPassages)||maxPassages<1||maxPassages>1_000_000||
    !Number.isInteger(sourceConcurrency)||sourceConcurrency<1||sourceConcurrency>16)throw new Error('Invalid search context migration bounds');
  if(!dryRun)await realm.ensureIndex();
  const collection=realm.collection('session'),f=collection.field,ingest=createSessionIngest({store,prefix}),controls=createControls({store,prefix});
  const report:SearchContextMigrationReport={passages:0,skippedDeleted:0,after,complete:false};
  // Invocation-local LRU retains classifications, never raw capture bodies. All
  // source/owner and current deletion checks still run before a cache lookup.
  const cache=new Map<string,EventClassifications>();let cachedEvents=0;
  function remember(key:string,events:EventClassifications){
    if(events.size>MAX_CACHED_EVENTS)return;
    while(cache.size>=MAX_CACHED_BATCHES||cachedEvents+events.size>MAX_CACHED_EVENTS){
      const oldest=cache.keys().next().value!;
      cachedEvents-=cache.get(oldest)!.size;cache.delete(oldest);
    }
    cache.set(key,events);cachedEvents+=events.size;
  }
  for(;;){
    const page=await collection.search(principal,{size:Math.min(pageSize,maxPassages-report.passages-report.skippedDeleted),
      query:{bool:{must_not:[{exists:{field:f('containsToolOutput')}}]}},
      _source:['userId','harness','sessionId','installationId','eventId','kind','sourceKey','chunk'],
      sort:[...['userId','harness','sessionId','eventId','chunk'].map(key=>({[f(key)]:'asc'})),{id:'asc'}],...(report.after?{search_after:report.after}:{}),
    },{createIfMissing:false});
    if(page.timed_out||page._shards?.failed!==0)throw new Error('Incomplete search context migration scan');
    if(!page.hits.hits.length){report.complete=true;report.after=null;await onPage({...report});return report;}
    const cursor=page.hits.hits.at(-1)?.sort;
    if(!cursor||JSON.stringify(cursor)===JSON.stringify(report.after))throw new Error('Non-advancing search context migration cursor');
    const groups=new Map<string,IndexHit[]>();
    for(const hit of page.hits.hits){
      const d=hit._source,source=typeof d.sourceKey==='string'?sourceBatchIdentity(prefix,d.sourceKey):null;
      if(d.tenantId!==principal.tenantId||typeof d.userId!=='string'||typeof d.harness!=='string'||typeof d.sessionId!=='string'||
        typeof d.installationId!=='string'||typeof d.eventId!=='string'||typeof d.kind!=='string'||!Number.isSafeInteger(d.chunk)||d.chunk!<0||!source||
        source.tenantHash!==digest(principal.tenantId)||source.userHash!==digest(d.userId)||source.harness!==d.harness||
        source.installationHash!==digest(d.installationId)||source.sessionHash!==digest(d.sessionId))throw new Error('Search context source scope denied');
      const group=groups.get(d.sourceKey!)??[];group.push(hit);groups.set(d.sourceKey!,group);
    }
    const sources=[...groups],updates:DocumentItem[]=[];
    async function prepare([key,hits]:[string,IndexHit[]]){
      const sample=hits[0]!._source,owner={tenantId:principal.tenantId,userId:sample.userId!};
      const deleted=async()=>Boolean((await controls.read(owner,'sessions',sample.harness!,sample.sessionId!))?.deletedAt);
      if(await deleted()){report.skippedDeleted+=hits.length;return;}
      let events=cache.get(key);
      if(events){cache.delete(key);cache.set(key,events);}
      else{
        const batch=await ingest.getBatch(owner,{harness:sample.harness!,installationId:sample.installationId!,sessionId:sample.sessionId!,batchId:sourceBatchIdentity(prefix,key)!.batchId});
        if(!batch){if(await deleted()){report.skippedDeleted+=hits.length;return;}throw new Error('Missing immutable search context source');}
        events=new Map(batch.events.map(event=>[event.id,{kind:event.kind,containsToolOutput:containsToolOutput(event)}]));
        remember(key,events);
      }
      for(const hit of hits){
        const event=events.get(hit._source.eventId!);
        if(!event||event.kind!==hit._source.kind)throw new Error('Search context source does not contain indexed event');
        updates.push({id:hit._id,document:{...hit._source,containsToolOutput:event.containsToolOutput},policy:'session-search-context'});
      }
    }
    for(let offset=0;offset<sources.length;offset+=sourceConcurrency){
      const results=await Promise.allSettled(sources.slice(offset,offset+sourceConcurrency).map(prepare));
      for(const result of results)if(result.status==='rejected')throw result.reason;
    }
    if(!dryRun&&updates.length)await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:updates},async()=>{
      // Make the missing-field query observe this page before checkpoint/retry.
      await collection.bulk(principal,updates,{refresh:true});
      const actual=await collection.mget(principal,updates.map(item=>item.id)),byId=new Map(actual.docs.map(hit=>[hit._id,hit]));
      for(const item of updates)if(!byId.get(item.id)?.found||byId.get(item.id)!._source.containsToolOutput!==item.document.containsToolOutput){
        const d=item.document;
        if(!(await controls.read({tenantId:principal.tenantId,userId:d.userId!},'sessions',d.harness!,d.sessionId!))?.deletedAt)throw new Error('Search context migration readback mismatch');
      }
    });
    report.passages+=updates.length;report.after=cursor;await onPage({...report});
    if(report.passages+report.skippedDeleted>=maxPassages)return report;
  }
}
