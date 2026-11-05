import {signRequest} from './s3-store.mjs';
import {sessionScope} from './ingest.mjs';
import {fuseRankings,relevanceQuery,textWithStemming,STEMMED_SUBFIELD} from '../search/relevance.mjs';

export const sessionIndexMapping={dynamic:'strict',properties:{
  tenantId:{type:'keyword'},userId:{type:'keyword'},installationId:{type:'keyword'},sessionId:{type:'keyword'},
  harness:{type:'keyword'},origin:{type:'keyword'},eventId:{type:'keyword'},kind:{type:'keyword'},role:{type:'keyword'},
  timestamp:{type:'date',ignore_malformed:true},receivedAt:{type:'date'},sequence:{type:'long'},chunk:{type:'integer'},
  text:textWithStemming,sourceKey:{type:'keyword',index:false,doc_values:false},
  nativeId:{type:'keyword'},parentId:{type:'keyword'},turnId:{type:'keyword'},toolCallId:{type:'keyword'},
  toolNames:{type:'keyword'},attachments:{type:'object',enabled:false},host:{type:'keyword',ignore_above:256},
}};
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export const MAX_SEARCH_LIMIT=500;
/** Index mapping. With `vectors`, documents also carry a passage embedding for hybrid search.
 * `exact` scores every passage in the caller's scope (no ANN graph to build; right for small
 * scopes and high-churn indexes); otherwise an HNSW graph serves filtered approximate search. */
export function sessionMapping(vectors) {
  if(!vectors)return sessionIndexMapping;
  const embedding=vectors.exact?{type:'knn_vector',dimension:vectors.dimensions}
    :{type:'knn_vector',dimension:vectors.dimensions,method:{name:'hnsw',engine:'lucene',space_type:'cosinesimil'}};
  return {...sessionIndexMapping,properties:{...sessionIndexMapping.properties,embedding}};
}
/** `embed(texts) -> Promise<number[][]>` (unit-length vectors) enables hybrid lexical+vector search. */
export function createSessionSearch({endpoint,index,username,password,credentials,replicas=0,region='us-east-1',embed,vectors,fetch:send=globalThis.fetch}) {
  if(Boolean(embed)!==Boolean(vectors)||(vectors&&(!Number.isInteger(vectors.dimensions)||vectors.dimensions<1||vectors.dimensions>4096)))throw new Error('Configure embed together with vectors.dimensions');
  const base=new URL(endpoint);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw new Error('Invalid OpenSearch endpoint');
  if(!Number.isInteger(replicas)||replicas<0||replicas>2)throw new Error('Invalid replica count');
  if(!/^[a-z][a-z0-9_-]{0,100}$/.test(index))throw new Error('Invalid OpenSearch index');
  if(Boolean(username)!==Boolean(password))throw new Error('Configure both OpenSearch username and password');
  async function request(path,{method='GET',body,contentType='application/json'}={}) {
    const url=new URL(base.href.replace(/\/$/,'')+'/'+index+path);
    let headers={'content-type':contentType};
    if(username)headers.authorization='Basic '+Buffer.from(username+':'+password).toString('base64');
    if(credentials){const resolved=await credentials();if(resolved.sessionToken)headers['x-amz-security-token']=resolved.sessionToken;headers=signRequest({method,url,body,headers,region,service:'es',...resolved});}
    const response=await send(url,{method,headers,body,signal:AbortSignal.timeout(30000),redirect:'error'});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
    if(!response.ok)throw Object.assign(new Error('OpenSearch request failed ('+response.status+')'),{status:response.status,type:data?.error?.type});
    return data;
  }
  return {
    identity:base.origin+base.pathname+'/'+index,
    async ensureIndex(){
      const settings={number_of_shards:1,number_of_replicas:replicas,...(vectors&&!vectors.exact?{'index.knn':true}:{})};
      try{await request('',{method:'PUT',body:JSON.stringify({settings,mappings:sessionMapping(vectors)})});}
      catch(error){if(error.status!==400||error.type!=='resource_already_exists_exception')throw error;}
      const mapping=await request('/_mapping');
      const actual=mapping?.[index]?.mappings;
      if(actual?.properties?.tenantId?.type!=='keyword'||actual?.properties?.userId?.type!=='keyword'||actual?.properties?.text?.type!=='text'||
        actual?.properties?.text?.fields?.[STEMMED_SUBFIELD]?.type!=='text'||(vectors&&actual?.properties?.embedding?.dimension!==vectors.dimensions))throw new Error('Unexpected session index mapping; create a new versioned index');
    },
    async putDocuments(documents){
      if(embed&&documents.length){
        const vectors=await embed(documents.map(({document})=>document.text??''));
        if(vectors.length!==documents.length)throw new Error('Embedding count mismatch');
        documents=documents.map(({id,document},i)=>({id,document:{...document,embedding:Array.from(vectors[i])}}));
      }
      let lines=[],bytes=0,count=0;
      async function flush(){
        if(!count)return;
        const result=await request('/_bulk',{method:'POST',body:lines.join('') ,contentType:'application/x-ndjson'});
        if(!Array.isArray(result?.items)||result.items.length!==count||result.items.some(item=>!item.index||item.index.status<200||item.index.status>=300))throw new Error('OpenSearch bulk contained failed or missing items');
        lines=[];bytes=0;count=0;
      }
      for(const {id,document} of documents){
        const line=JSON.stringify({index:{_id:id}})+'\n'+JSON.stringify(document)+'\n';
        const size=Buffer.byteLength(line);if(size>4*1024*1024)throw new Error('Search document exceeds bulk limit');
        if(bytes+size>4*1024*1024)await flush();
        lines.push(line);bytes+=size;count++;
      }
      await flush();
    },
    /** Ranked passages for the principal. Natural-language questions and keywords both work
     * (see search/relevance.mjs); with embeddings configured, lexical and vector rankings are
     * fused. `text: false` omits passage text from hits for callers that hold it already. */
    async search(principal,{query='',limit=20,raw=false,text=true}={}) {
      sessionScope(principal);
      if(typeof query!=='string'||query.length>4000||!Number.isInteger(limit)||limit<1||limit>MAX_SEARCH_LIMIT)fail(400,'Invalid search query or limit');
      const filter=[{term:{tenantId:principal.tenantId}},{term:{userId:principal.userId}}];
      const source=text?{excludes:['embedding']}:{excludes:['embedding','text']};
      const lexical=request('/_search',{method:'POST',body:JSON.stringify({size:limit,track_total_hits:true,_source:source,
        query:{bool:{filter,must:query.trim()?[relevanceQuery(query)]:[{match_all:{}}]}},
        sort:query.trim()?['_score',{receivedAt:'desc'}]:[{receivedAt:'desc'},{sequence:'asc'}]})});
      const semantic=embed&&query.trim()&&!raw?embed([query]).then(([vector])=>request('/_search',{method:'POST',body:JSON.stringify({size:limit,_source:source,
        query:vectors.exact
          ?{script_score:{query:{bool:{filter}},script:{source:'knn_score',lang:'knn',params:{field:'embedding',query_value:Array.from(vector),space_type:'cosinesimil'}}}}
          :{knn:{embedding:{vector:Array.from(vector),k:limit,filter:{bool:{filter}}}}}})})):null;
      const [result,dense]=await Promise.all([lexical,semantic]);
      for(const response of [result,dense]){
        const hits=response?.hits?.hits;
        if(response&&(!Array.isArray(hits)||hits.some(hit=>hit._source?.tenantId!==principal.tenantId||hit._source?.userId!==principal.userId)))throw new Error('Search returned an invalid ownership scope');
      }
      if(raw)return result;
      const shape=hit=>({id:hit._id,score:hit._score,...hit._source});
      const hits=dense?fuseRankings([{hits:result.hits.hits.map(shape)},{hits:dense.hits.hits.map(shape)}]).slice(0,limit):result.hits.hits.map(shape);
      return {total:result.hits.total?.value??0,hits};
    },
    refresh:()=>request('/_refresh',{method:'POST'}),
  };
}
export function searchSettings(env=process.env) {
  if(!env.OPENCRAWL_OPENSEARCH_URL)return null;
  return {endpoint:env.OPENCRAWL_OPENSEARCH_URL,index:env.OPENCRAWL_OPENSEARCH_INDEX||'opencrawl-sessions-v2',
    username:env.OPENCRAWL_OPENSEARCH_USERNAME,password:env.OPENCRAWL_OPENSEARCH_PASSWORD};
}
