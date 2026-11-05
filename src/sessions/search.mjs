import {signRequest} from './s3-store.mjs';
import {sessionScope} from './ingest.mjs';

export const sessionIndexMapping={dynamic:'strict',properties:{
  tenantId:{type:'keyword'},userId:{type:'keyword'},installationId:{type:'keyword'},sessionId:{type:'keyword'},
  harness:{type:'keyword'},origin:{type:'keyword'},eventId:{type:'keyword'},kind:{type:'keyword'},role:{type:'keyword'},
  timestamp:{type:'date',ignore_malformed:true},receivedAt:{type:'date'},sequence:{type:'long'},chunk:{type:'integer'},
  text:{type:'text'},sourceKey:{type:'keyword',index:false,doc_values:false},
  nativeId:{type:'keyword'},parentId:{type:'keyword'},turnId:{type:'keyword'},toolCallId:{type:'keyword'},
  toolNames:{type:'keyword'},attachments:{type:'object',enabled:false},host:{type:'keyword',ignore_above:256},
}};
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function createSessionSearch({endpoint,index,username,password,credentials,replicas=0,region='us-east-1',fetch:send=globalThis.fetch}) {
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
      try{await request('',{method:'PUT',body:JSON.stringify({settings:{number_of_shards:1,number_of_replicas:replicas},mappings:sessionIndexMapping})});}
      catch(error){if(error.status!==400||error.type!=='resource_already_exists_exception')throw error;}
      const mapping=await request('/_mapping');
      const actual=mapping?.[index]?.mappings;
      if(actual?.properties?.tenantId?.type!=='keyword'||actual?.properties?.userId?.type!=='keyword'||actual?.properties?.text?.type!=='text')throw new Error('Unexpected session index mapping; create a new versioned index');
    },
    async putDocuments(documents){
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
    async search(principal,{query='',limit=20,raw=false}={}) {
      sessionScope(principal);
      if(typeof query!=='string'||query.length>4000||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Invalid search query or limit');
      const result=await request('/_search',{method:'POST',body:JSON.stringify({size:limit,track_total_hits:true,
        query:{bool:{filter:[{term:{tenantId:principal.tenantId}},{term:{userId:principal.userId}}],must:query?[{match:{text:{query,operator:'and'}}}]:[{match_all:{}}]}},
        sort:query?['_score',{receivedAt:'desc'}]:[{receivedAt:'desc'},{sequence:'asc'}]})});
      const hits=result?.hits?.hits;
      if(!Array.isArray(hits)||hits.some(hit=>hit._source?.tenantId!==principal.tenantId||hit._source?.userId!==principal.userId))throw new Error('Search returned an invalid ownership scope');
      if(raw)return result;
      return {total:result.hits.total?.value??0,hits:hits.map(hit=>({id:hit._id,score:hit._score,...hit._source}))};
    },
    refresh:()=>request('/_refresh',{method:'POST'}),
  };
}
export function searchSettings(env=process.env) {
  if(!env.OPENCRAWL_OPENSEARCH_URL)return null;
  return {endpoint:env.OPENCRAWL_OPENSEARCH_URL,index:env.OPENCRAWL_OPENSEARCH_INDEX||'opencrawl-sessions-v1',
    username:env.OPENCRAWL_OPENSEARCH_USERNAME,password:env.OPENCRAWL_OPENSEARCH_PASSWORD};
}
