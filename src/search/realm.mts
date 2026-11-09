import type {TenantPrincipal} from '../sessions/types.mjs';
import {serviceError} from '../sessions/types.mjs';
import type {Corpus, SearchDocument, DocumentItem, IndexHit, OpenSearchResponse, QueryBody, RealmOptions, IndexTransportOptions, Mapping} from './types.mjs';
import {createHash} from 'node:crypto';
import {signRequest} from '../sessions/s3-store.mjs';
import {realmMapping} from './mapping.mjs';
export {realmMapping};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string,status=503) => Object.assign(new Error(message),{status,permanent:status===403});
const corpora = new Set(['connector','session','board','memory']);
export function realmIndex(environment: string,tenantId: string,generation='v1') {
  if (!/^[a-z][a-z0-9-]{0,24}$/.test(environment) || !/^v[1-9][0-9]*$/.test(generation) || typeof tenantId!=='string' || !tenantId) throw fail('Invalid realm scope',403);
  return `opencrawl-${environment}-realm-${hash(tenantId)}-${generation}`;
}
export function realmField(corpus: string,field: string) {
  if(!corpora.has(corpus)) throw fail('Invalid corpus',400);
  return ['tenantId','text','title','sourceKey'].includes(field)?field:corpus+'.'+field;
}
export function realmDocument(corpus: string,id: string,document: SearchDocument) {
  if(!corpora.has(corpus)||typeof id!=='string'||!/^[A-Za-z0-9_:-]{1,256}$/.test(id)||typeof document?.tenantId!=='string'||!document.tenantId) throw fail('Document realm scope required',403);
  const {tenantId,text,title,sourceKey,...metadata}=document;
  const raw=document.timestamp;
  let timestamp= typeof raw==='number'?raw:typeof raw==='string'&&/^\d{10}(\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(String(raw));
  if(!Number.isFinite(timestamp)) timestamp=Date.parse(document.receivedAt ?? '')||(document.extractedAt ?? NaN);
  const author=document.author??document.authorId??document.userId;
  const source=corpus==='connector'?document.provider:['session','memory'].includes(corpus)?document.harness:'board';
  return {schema:1,tenantId,corpus,id,source,kind:document.kind||'message',
    ...(Number.isFinite(timestamp)?{timestamp:new Date(timestamp).toISOString()}:{}),
    ...(author?{author}:{}),
    ...(text!==undefined?{text}:{}),...(title!==undefined?{title}:{}),...(sourceKey!==undefined?{sourceKey}:{}),[corpus]:metadata};
}
function compatible(actual: Mapping | undefined,expected: Mapping): boolean {
  if(expected.type && (actual?.type||(actual?.properties?'object':undefined))!==expected.type) return false;
  if(expected.dynamic && actual?.dynamic!==expected.dynamic) return false;
  for(const option of ['index','doc_values','ignore_malformed','analyzer','enabled','ignore_above']) if(expected[option]!==undefined && actual?.[option]!==expected[option]) return false;
  for(const key of ['properties','fields']) for(const [name,value] of Object.entries((expected[key] as Record<string, Mapping>)||{})) if(!compatible((actual?.[key] as Record<string, Mapping> | undefined)?.[name],value))return false;
  return true;
}
/** One tenant-bound index, mapping and transport for every searchable corpus. */
export function createRealm({endpoint,index,tenantId,environment='selfhost',generation='v1',username,password,credentials,region='us-east-1',replicas=0,fetch:send=globalThis.fetch}: RealmOptions) {
  if(typeof tenantId!=='string'||!tenantId)throw fail('Realm tenant required',403);
  index ||= realmIndex(environment,tenantId,generation);
  const base=new URL(endpoint);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!/^[a-z][a-z0-9_-]{0,150}$/.test(index))throw fail('Invalid realm endpoint or index',400);
  if(Boolean(username)!==Boolean(password)||!Number.isInteger(replicas)||replicas<0||replicas>2)throw fail('Invalid realm configuration',400);
  const scope=(principal: TenantPrincipal)=>{if(principal?.tenantId!==tenantId || principal.captureAccess!==undefined)throw fail('Realm scope denied',403);};
  const request=createIndexTransport({endpoint,index,username,password,credentials,region,fetch:send});
  let ready: Promise<void> | undefined;
  async function ensureIndex(){
    ready ||= (async()=>{
      try{await request('',{settings:{number_of_shards:1,number_of_replicas:replicas},mappings:{...realmMapping,_meta:{schema:1,tenantId}}},'PUT');}
      catch(caught){const e=serviceError(caught);if(e.status!==400||e.type!=='resource_already_exists_exception')throw e;}
      let mapping=(await request<Record<string, {mappings: Mapping}>>('/_mapping',undefined,'GET'))?.[index!]?.mappings;
      // The only in-place schema upgrade is an additive normalization revision.
      // Validate ownership and every existing field before making any change.
      // Revisions apply in order; each earlier check ignores fields added by later revisions.
      const withoutStemming=(value: Mapping)=>{delete value.properties!.text.fields;return value;};
      const withoutVisibility=(value: Mapping)=>{withoutStemming(value);delete value.properties!.session.properties!.private;if(value.properties!.memory)delete value.properties!.memory.properties!.private;return value;};
      const previous: Mapping=withoutVisibility(structuredClone(realmMapping));
      delete previous.properties!.connector.properties!.normalizerVersion;
      if(!mapping?.properties?.memory)delete previous.properties!.memory;
      if(mapping?._meta?.tenantId===tenantId && mapping?._meta?.schema===1 &&
        !mapping.properties?.connector?.properties?.normalizerVersion && compatible(mapping,previous)) {
        await request('/_mapping',{properties:{connector:{properties:{normalizerVersion:{type:'integer'}}}}},'PUT');
        mapping=(await request<Record<string, {mappings: Mapping}>>('/_mapping',undefined,'GET'))?.[index!]?.mappings;
      }
      const withoutMemory: Mapping=withoutVisibility(structuredClone(realmMapping));delete withoutMemory.properties!.memory;
      if(mapping?._meta?.tenantId===tenantId&&mapping?._meta?.schema===1&&!mapping.properties?.memory&&compatible(mapping,withoutMemory)) {
        await request('/_mapping',{properties:{memory:withoutVisibility(structuredClone(realmMapping)).properties!.memory}},'PUT');
        mapping=(await request<Record<string, {mappings: Mapping}>>('/_mapping',undefined,'GET'))?.[index!]?.mappings;
      }
      // Owner visibility is the second additive revision: two boolean fields.
      if(mapping?._meta?.tenantId===tenantId&&mapping?._meta?.schema===1&&(!mapping.properties?.session?.properties?.private||!mapping.properties?.memory?.properties?.private)&&
        compatible(mapping,withoutVisibility(structuredClone(realmMapping)))) {
        await request('/_mapping',{properties:{session:{properties:{private:{type:'boolean'}}},memory:{properties:{private:{type:'boolean'}}}}},'PUT');
        mapping=(await request<Record<string, {mappings: Mapping}>>('/_mapping',undefined,'GET'))?.[index!]?.mappings;
      }
      // Stemmed text is the third additive revision: a `text.english` subfield. Existing
      // documents are re-indexed in place by a background update-by-query; until it finishes
      // they still match through `text`. Concurrent newer writes win (conflicts=proceed).
      if(mapping?._meta?.tenantId===tenantId&&mapping?._meta?.schema===1&&!mapping.properties?.text?.fields?.english&&
        compatible(mapping,withoutStemming(structuredClone(realmMapping)))) {
        await request('/_mapping',{properties:{text:realmMapping.properties.text}},'PUT');
        await request('/_update_by_query?conflicts=proceed&wait_for_completion=false&slices=auto',{query:{match_all:{}}},'POST');
        mapping=(await request<Record<string, {mappings: Mapping}>>('/_mapping',undefined,'GET'))?.[index!]?.mappings;
      }
      if(mapping?._meta?.tenantId!==tenantId||mapping?._meta?.schema!==1||!compatible(mapping,realmMapping))throw fail('Realm mapping or tenant mismatch; migrate to a new generation');
    })().catch(e=>{ready=undefined;throw e;});
    return ready;
  }
  const checkSearch=(result: OpenSearchResponse)=>{
    if(result?.timed_out!==false||result?._shards?.failed!==0||!Array.isArray(result?.hits?.hits))throw fail('Realm search incomplete');
    return result;
  };
  return {index,tenantId,identity:base.origin+base.pathname+'/'+index,ensureIndex,scope,
    collection(corpus: Corpus){
      if(!corpora.has(corpus))throw fail('Invalid corpus',400);
      const encodedId=(id: string)=>corpus+':'+id;
      const encode=(id: string,document: SearchDocument)=>{if(document.tenantId!==tenantId)throw fail('Document realm scope mismatch',403);return realmDocument(corpus,id,document);};
      function decode(hit: IndexHit){
        if(hit.found===false){if(!hit._id?.startsWith(corpus+':'))throw fail('Realm identity mismatch');return {...hit,_id:hit._id.slice(corpus.length+1)};}
        const d=hit._source as SearchDocument & {schema: number; corpus: string; id: string};
        if(d?.schema!==1||d.tenantId!==tenantId||d.corpus!==corpus||typeof d.id!=='string'||hit._id!==encodedId(d.id)||!d[corpus])throw fail('Realm response ownership scope mismatch');
        return {...hit,_id:d.id,_source:{...(d[corpus] as Record<string, unknown>),tenantId,...Object.fromEntries(['text','title','sourceKey'].filter(k=>d[k]!==undefined).map(k=>[k,d[k]]))}};
      }
      return {field:(field: string)=>realmField(corpus,field),encode,id:encodedId,
        async search(principal: TenantPrincipal,body: QueryBody){
          scope(principal);
          const query={bool:{filter:[{term:{tenantId}},{term:{corpus}}],must:[body.query||{match_all:{}}]}};
          // Scope/identity fields are always fetched, including for ID-only board snapshots.
          const source=Array.isArray(body._source)?[...new Set(['schema','tenantId','corpus','id',...body._source.map(f=>realmField(corpus,f))])]:body._source;
          const scopedBody={...body,query,...(source?{_source:source}:{})};
          let result;
          try{result=checkSearch(await request('/_search',scopedBody));}
          catch(caught){const e=serviceError(caught);if(e.status!==404)throw e;ready=undefined;await ensureIndex();result=checkSearch(await request('/_search',scopedBody));}
          result.hits.hits=result.hits.hits.map(decode);return result;
        },
        async mget(principal: TenantPrincipal,ids: string[]){scope(principal);const result=await request('/_mget',{ids:ids.map(encodedId)});if(!Array.isArray(result.docs)||result.docs.length!==ids.length)throw fail('Incomplete realm lookup');const docs=result.docs.map(decode);if(docs.some(d=>!ids.includes(d._id))||new Set(docs.map(d=>d._id)).size!==ids.length)throw fail('Realm lookup identity mismatch');return {...result,docs};},
        async bulk(principal: TenantPrincipal,items: DocumentItem[],{refresh=false}={}){
          let body;
          try {
            scope(principal);if(!items.length)return {items:[]};
            body=items.map(({id,document,script})=>{
              const doc=encode(id,document);
              return JSON.stringify({[script?'update':'index']:{_id:encodedId(id),...(script?{retry_on_conflict:5}:{})}})+'\n'+JSON.stringify(script?{scripted_upsert:true,script:{lang:'painless',source:script,params:{doc}},upsert:{}}:doc)+'\n';
            }).join('');
            if(Buffer.byteLength(body)>4*1024*1024)throw fail('Realm bulk exceeds limit',400);
          } catch(caught){const error=serviceError(caught);throw Object.assign(serviceError(error),{writeOutcome:'not-applied'});}
          const result=await request('/_bulk'+(refresh?'?refresh=wait_for':''),body,'POST','application/x-ndjson');
          if(result.errors||!Array.isArray(result.items)||result.items.length!==items.length||result.items.some(item=>{const op=item.index||item.update;return !op||op.status<200||op.status>=300;}))throw fail('Realm bulk contained failed or missing items');
          return result;
        },
        /** Removes documents of this corpus by ID. Missing IDs are already removed. */
        async delete(principal: TenantPrincipal,ids: string[]){
          let body;
          try {scope(principal);if(!ids.length)return {items:[]};if(ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_:-]{1,256}$/.test(id)))throw fail('Invalid document ID',400);body=ids.map(id=>JSON.stringify({delete:{_id:encodedId(id)}})+'\n').join('');}
          catch(caught){const error=serviceError(caught);throw Object.assign(serviceError(error),{writeOutcome:'not-applied'});}
          const result=await request('/_bulk',body,'POST','application/x-ndjson');
          if(!Array.isArray(result.items)||result.items.length!==ids.length||result.items.some(item=>{const op=item.delete;return !op||(op.status<200||op.status>=300)&&op.status!==404;}))throw fail('Realm delete contained failed or missing items');
          return result;
        },
        /** Owner operations over a whole resource (a session or memory file). The
         * tenant and corpus filters are always applied; conflicts are retried until
         * no matching document was skipped. */
        async byQuery(principal: TenantPrincipal,operation: 'update' | 'delete',query: unknown,script?: unknown){
          scope(principal);
          if(operation==='update'&&!script)throw fail('Update script required',400);
          const body={query:{bool:{filter:[{term:{tenantId}},{term:{corpus}}],must:[query]}},...(operation==='update'?{script}:{})};
          let changed=0;
          for(let attempt=0;attempt<5;attempt++) {
            type ByQuery={updated?: number; deleted?: number; version_conflicts?: number; failures?: unknown[]; timed_out?: boolean};
            let result: ByQuery;
            try{result=await request<ByQuery>('/_'+operation+'_by_query?refresh=true&conflicts=proceed',body);}
            catch(caught){const e=serviceError(caught);if(e.status===404)return {changed};throw e;}
            if(result?.timed_out||!Array.isArray(result?.failures)||result.failures.length)throw fail('Realm '+operation+' by query incomplete');
            changed+=(operation==='update'?result.updated:result.deleted)??0;
            if(!result.version_conflicts)return {changed};
          }
          throw fail('Realm '+operation+' by query kept conflicting; retry');
        },
        async update(principal: TenantPrincipal,id: string,{script,upsert}: {script: unknown; upsert: SearchDocument}){
          let body;
          try {scope(principal);body={script,upsert:encode(id,upsert)};}
          catch(caught){const error=serviceError(caught);throw Object.assign(serviceError(error),{writeOutcome:'not-applied'});}
          return request('/_update/'+encodedId(id),body);
        },
      };
    },
    async refresh(principal: TenantPrincipal){scope(principal);return request('/_refresh');},
  };
}

/** Runtime routing uses a trusted principal; requests never supply an index name. */
export function createRealmResolver(options: RealmOptions) {
  const realms=new Map<string, ReturnType<typeof createRealm>>();
  function resolve(principal: TenantPrincipal){
    const tenantId=principal?.tenantId;
    if(typeof tenantId!=='string'||!tenantId||principal.captureAccess!==undefined||(options.tenantId&&options.tenantId!==tenantId))throw fail('Realm scope denied',403);
    let realm=realms.get(tenantId);
    if(!realm){realm=createRealm({...options,tenantId});if(realms.size>=128)realms.delete(realms.keys().next().value!);realms.set(tenantId,realm);}
    return realm;
  }
  resolve.identity=JSON.stringify([options.endpoint,options.environment||'selfhost',options.generation||'v1',options.index||'organization-realms']);
  return resolve;
}

export function createIndexTransport({endpoint,index,username,password,credentials,region='us-east-1',fetch:send=globalThis.fetch,allowIndexPattern=false}: IndexTransportOptions) {
  const base=new URL(endpoint);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!(allowIndexPattern?/^[a-z][a-z0-9_*-]{0,150}$/:/^[a-z][a-z0-9_-]{0,150}$/).test(index))throw fail('Invalid index transport',400);
  return async function request<T = OpenSearchResponse>(path: string,body?: unknown,method='POST',contentType='application/json'): Promise<T> {
    if(allowIndexPattern && !(method==='POST'&&path==='/_search'))throw fail('Index patterns are read-only migration inventory',403);
    let url: URL,headers: Record<string, string>;
    let serialized: string | undefined;
    try {
      url=new URL(base.href.replace(/\/$/,'')+'/'+index.replaceAll('*','%2A')+path);
      serialized=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
      headers={'content-type':contentType};
      if(username)headers.authorization='Basic '+Buffer.from(username+':'+password).toString('base64');
      if(credentials){const c=await credentials();if(c.sessionToken)headers['x-amz-security-token']=c.sessionToken;headers=signRequest({method,url,body:serialized,headers,region,service:'es',...c});}
    } catch(caught){const error=serviceError(caught);throw Object.assign(serviceError(error),{writeOutcome:'not-applied'});}
    const response=await send(url,{method,body:serialized,headers,signal:AbortSignal.timeout(30000),redirect:'error'});
    let data: OpenSearchResponse;try{data=await response.json() as OpenSearchResponse;}catch{throw fail('Invalid realm response');}
    if(!response.ok)throw Object.assign(fail('Realm request failed ('+response.status+')',response.status),{httpStatus:response.status,type:data?.error?.type,
      ...([401,403].includes(response.status)&&['security_exception','authentication_exception','authorization_exception'].includes(data?.error?.type ?? '')?{writeOutcome:'not-applied'}:{})});
    return data as T;
  };
}
