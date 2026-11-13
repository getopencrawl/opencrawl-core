import type {TenantPrincipal, JsonValue, ObjectStore} from '../sessions/types.mjs';
import type {Corpus, DocumentItem, IndexTransportOptions} from './types.mjs';
import type {createRealm} from './realm.mjs';
interface MigrationState {identity: string; version: string; after: JsonValue[] | null; copied: number; total: number | null; complete: boolean}
interface SourceStats {indices: Record<string, {uuid: string; shards: Record<string, Array<{routing?: {primary?: boolean}; seq_no?: {max_seq_no?: number}}>>}>}
export interface MigrationSource {identity: string; version(): Promise<string>; read(after: JsonValue[] | null): Promise<{total: number; documents: DocumentItem[]; next: JsonValue[] | null}>}
import {createHash} from 'node:crypto';
import {INITIAL_BULK_TARGET_BYTES} from './bulk.mjs';
import {createIndexTransport,realmDocument} from './realm.mjs';
import {withSessionDocumentWrites} from '../sessions/write-barrier.mjs';
const sorts={connector:['connectionId','workspaceId','provider','kind','sourceId'],session:['tenantId','userId','harness','installationId','sessionId','eventId','chunk']};
const stable=(value: unknown): unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable((value as Record<string,unknown>)[k])])):value;
export const documentDigest=(value: unknown)=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
/** Legacy source is read only after an explicit write barrier. No implicit live-data copy. */
export function legacyRealmSource({corpus,tenantId,...options}: IndexTransportOptions & {corpus: keyof typeof sorts; tenantId: string}): MigrationSource {
  if(!sorts[corpus]||!tenantId)throw new Error('Invalid migration scope');
  const request=createIndexTransport(options),filter=[{term:{tenantId}}];
  async function assertFrozen(){
    const settings=await request<Record<string, {settings: {index: {blocks: {write: string}}}}>>('/_settings/index.blocks.write',undefined,'GET');
    if(String(settings?.[options.index]?.settings?.index?.blocks?.write)!=='true')throw new Error('Legacy index must be write-blocked before migration');
  }
  return {identity:options.index+':'+tenantId+':'+corpus,
    async version(){
      await assertFrozen();
      const result=await request<SourceStats>('/_stats?level=shards',undefined,'GET');
      const index=result.indices?.[options.index];
      if(!index?.uuid||!index.shards)throw new Error('Missing migration source version');
      const shards=Object.entries(index.shards).sort(([a],[b])=>a.localeCompare(b)).map(([id,copies])=>{
        const primary=copies.find(s=>s.routing?.primary===true);
        if(!Number.isSafeInteger(primary?.seq_no?.max_seq_no))throw new Error('Missing source sequence barrier');
        return [id,primary!.seq_no!.max_seq_no];
      });
      return documentDigest([index.uuid,shards]);
    },
    async read(after: JsonValue[] | null){
      await assertFrozen();
      const result=await request('/_search',{size:500,track_total_hits:true,query:{bool:{filter}},sort:sorts[corpus].map(field=>({[field]:'asc'})),...(after?{search_after:after}:{})});
      if(result.timed_out||result._shards?.failed!==0||result.hits?.total?.relation!=='eq'||!Array.isArray(result.hits?.hits))throw new Error('Incomplete migration source page');
      const hits=result.hits.hits;
      if(hits.some(h=>h._source?.tenantId!==tenantId||!h._id||!Array.isArray(h.sort))||new Set(hits.map(h=>h._id)).size!==hits.length)throw new Error('Invalid migration source scope or identity');
      const cursor=hits.at(-1)?.sort;
      if(cursor&&JSON.stringify(cursor)===JSON.stringify(after))throw new Error('Migration cursor did not advance');
      return {total:result.hits.total.value,documents:hits.map(h=>({id:h._id,document:h._source})),next:cursor||null};
    },
  };
}
/** Checkpoint only after write+readback; interrupted pages are safe to replay while target writers are stopped. */
export async function migrateRealmCorpus({principal,corpus,source,realm,store,prefix,load,save,onPage=async()=>{}}: {principal: TenantPrincipal; corpus: Corpus; source: MigrationSource; realm: ReturnType<typeof createRealm>; store?:ObjectStore;prefix?:string;load(): Promise<MigrationState | null>; save(state: MigrationState): Promise<unknown>; onPage?(progress: {copied: number; total: number | null}): Promise<unknown>}){
  realm.scope(principal);const collection=realm.collection(corpus);
  let state=await load();const identity=JSON.stringify([source.identity,realm.identity,corpus]);
  if(state&&state.identity!==identity)throw new Error('Migration checkpoint scope mismatch');
  const version=await source.version();
  if(state&&state.version!==version)throw new Error('Migration source version changed; checkpoint requires explicit restart');
  if(state?.complete)return state;
  await realm.ensureIndex();state ||= {identity,version,after:null,copied:0,total:null,complete:false};
  for(;;){
    const page=await source.read(state.after);
    if(!Number.isSafeInteger(page.total)||page.total<0||(state.total!==null&&state.total!==page.total))throw new Error('Migration source changed while frozen');
    if(!page.documents.length){
      if(state.copied!==page.total)throw new Error('Migration source coverage mismatch');
      await realm.refresh(principal);
      const result=await collection.search(principal,{size:0,track_total_hits:true});
      if(result.hits.total.relation!=='eq'||result.hits.total.value!==page.total)throw new Error('Migration destination coverage mismatch');
      if(await source.version()!==version)throw new Error('Migration source changed during copy');
      state={...state,total:page.total,complete:true};await save(state);return state;
    }
    // Schedule small batches; a larger individual document is sent alone.
    const copy=async()=>{
    let batch: DocumentItem[]=[],bytes=0;
    for(const item of page.documents){
      const size=Buffer.byteLength(JSON.stringify(realmDocument(corpus,item.id,item.document)));
      if(batch.length&&bytes+size>INITIAL_BULK_TARGET_BYTES){await collection.bulk(principal,batch);batch=[];bytes=0;}
      batch.push(item);bytes+=size;
    }
    await collection.bulk(principal,batch);
    const verified=await collection.mget(principal,page.documents.map(d=>d.id));
    const actual=new Map(verified.docs.map(h=>[h._id,h]));
    if(page.documents.some(d=>!actual.get(d.id)?.found||documentDigest(actual.get(d.id)!._source)!==documentDigest(d.document)))throw new Error('Migration document verification failed');
    };
    if(corpus==='session'){
      if(!store||!prefix)throw new Error('Session migration requires authoritative deletion controls');
      await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:page.documents},copy);
    }else await copy();
    state={...state,total:page.total,after:page.next,copied:state.copied+page.documents.length};
    if(state.copied>page.total)throw new Error('Migration duplicated source records');
    await save(state);await onPage({copied:state.copied,total:state.total});
  }
}

export function legacyConnectorIndex(environment: string, tenantId: string, generation = 'v1') {
  if (!/^[a-z][a-z0-9-]{0,24}$/.test(environment) || !/^v[1-9][0-9]*$/.test(generation) || typeof tenantId !== 'string' || !tenantId) throw new Error('Invalid index scope');
  return `opencrawl-${environment}-connectors-${createHash('sha256').update(tenantId).digest('hex').slice(0, 32)}-${generation}`;
}


