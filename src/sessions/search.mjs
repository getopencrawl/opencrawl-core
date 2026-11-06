import {createRealmResolver,realmField} from '../search/realm.mjs';
import {sessionScope} from './ingest.mjs';
import {fuseRankings,relevanceQuery} from '../search/relevance.mjs';

import {sessionIndexMapping} from '../search/mapping.mjs';
export {sessionIndexMapping};
const UPSERT="if (ctx._source.session == null || ctx._source.session.receivedAt == null || params.doc.session.receivedAt.compareTo(ctx._source.session.receivedAt) > 0) { ctx._source = params.doc; } else { ctx.op = 'none'; }";
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export const MAX_SEARCH_LIMIT=500;
/** `embed(texts) -> Promise<number[][]>` (unit vectors) with `vectors: {dimensions}` enables hybrid
 * search: passages are embedded on write, and each query fuses lexical and vector rankings. */
export function createSessionSearch({embed,...options}) {
  if(Boolean(embed)!==Boolean(options.vectors))throw new Error('Configure embed together with vectors.dimensions');
  const resolve=createRealmResolver(options), f=field=>realmField('session',field);
  return {
    identity:resolve.identity,
    ensureIndex:principal=>resolve(principal).ensureIndex(),
    async putDocuments(documents,principal){
      sessionScope(principal);
      const collection=resolve(principal).collection('session');
      const pages=[];let page=[],bytes=0;
      for(const item of documents){
        const size=Buffer.byteLength(JSON.stringify(item));
        if(size>3*1024*1024)throw new Error('Search document exceeds bulk limit');
        if(typeof item.document?.receivedAt!=='string'||!Number.isFinite(Date.parse(item.document.receivedAt)))throw new Error('Session capture timestamp required');
        if(bytes+size>3*1024*1024&&page.length){pages.push(page);page=[];bytes=0;}
        page.push({...item,script:UPSERT});bytes+=size;
      }
      if(page.length)pages.push(page);
      for(const items of pages){
        if(!embed){await collection.bulk(principal,items);continue;}
        // Embed one bulk page at a time; vectors add ~12 bytes of JSON per dimension, so split writes.
        const vectors=await embed(items.map(({document})=>document.text??''));
        if(vectors.length!==items.length)throw new Error('Embedding count mismatch');
        const embedded=items.map((item,i)=>({...item,document:{...item.document,embedding:Array.from(vectors[i])}}));
        for(let i=0;i<embedded.length;i+=100)await collection.bulk(principal,embedded.slice(i,i+100));
      }
    },
    /** Ranked passages. Natural-language questions and keywords both work (search/relevance.mjs).
     * `text: false` omits passage text for callers that render it from their own copy. */
    async search(principal,{query='',limit=20,raw=false,text=true}={}) {
      sessionScope(principal);
      if(typeof query!=='string'||query.length>4000||!Number.isInteger(limit)||limit<1||limit>MAX_SEARCH_LIMIT)fail(400,'Invalid search query or limit');
      const collection=resolve(principal).collection('session'),excludes=text?['embedding']:['embedding','text'];
      const lexical=collection.search(principal,{size:limit,track_total_hits:true,_source:{excludes},
        query:{bool:{filter:[{term:{tenantId:principal.tenantId}}],must:query?[relevanceQuery(query)]:[{match_all:{}}]}},
        sort:query?['_score',{[f('receivedAt')]:'desc'}]:[{[f('receivedAt')]:'desc'},{[f('sequence')]:'asc'}]});
      const semantic=embed&&query.trim()&&!raw?embed([query]).then(([vector])=>collection.search(principal,{size:limit,_source:{excludes},
        query:{knn:{embedding:{vector:Array.from(vector),k:limit}}}})):null;
      const [result,dense]=await Promise.all([lexical,semantic]);
      for(const response of [result,dense]){
        const hits=response?.hits?.hits;
        if(response&&(!Array.isArray(hits)||hits.some(hit=>hit._source?.tenantId!==principal.tenantId||typeof hit._source?.userId!=='string'||!hit._source.userId)))throw new Error('Search returned an invalid ownership scope');
      }
      if(raw)return result;
      const shape=hit=>({id:hit._id,score:hit._score,...hit._source});
      const hits=dense?fuseRankings([{hits:result.hits.hits.map(shape)},{hits:dense.hits.hits.map(shape)}]).slice(0,limit):result.hits.hits.map(shape);
      return {total:result.hits.total?.value??0,hits};
    },
    /** Activity counts for reporting. Never returns transcript text. With team:true the caller
     * must already have authorized the principal for its whole tenant. */
    async usage(principal,{team=false,days=30,now=Date.now()}={}) {
      sessionScope(principal);
      if(!Number.isInteger(days)||days<1||days>365)fail(400,'Invalid usage window');
      const day=t=>new Date(t).toISOString().slice(0,10),since=day(now-(days-1)*86400000),today=day(now);
      const filter=[{term:{tenantId:principal.tenantId}},...(team?[]:[{term:{[f('userId')]:principal.userId}}]),{term:{[f('chunk')]:0}}];
      const messages={filter:{term:{[f('kind')]:'message'}}},toolCalls={value_count:{field:f('toolNames')}},sessions={cardinality:{field:f('sessionId')}};
      const result=await resolve(principal).collection('session').search(principal,{size:0,track_total_hits:true,query:{bool:{filter}},aggs:{
        sessions,messages,toolCalls,machines:{cardinality:{field:f('installationId')}},
        tools:{terms:{field:f('toolNames'),size:8}},opencrawl:{filter:{wildcard:{[f('toolNames')]:'*opencrawl*'}}},
        harnesses:{terms:{field:f('harness'),size:5}},origins:{terms:{field:f('origin'),size:6}},
        first:{min:{field:f('timestamp')}},last:{max:{field:f('timestamp')}},
        daily:{filter:{range:{[f('timestamp')]:{gte:since,lte:today,format:'yyyy-MM-dd'}}},aggs:{days:{date_histogram:{field:f('timestamp'),calendar_interval:'day',format:'yyyy-MM-dd',min_doc_count:0,extended_bounds:{min:since,max:today}},aggs:{sessions}}}},
        people:{terms:{field:f('userId'),size:500},aggs:{sessions,messages,toolCalls,last:{max:{field:f('timestamp')}},week:{filter:{range:{[f('timestamp')]:{gte:'now-7d'}}}}}},
      }});
      const a=result?.aggregations;
      if(!a)throw new Error('Invalid usage response');
      const people=a.people.buckets.map(b=>({userId:b.key,events:b.doc_count,sessions:b.sessions.value,messages:b.messages.doc_count,toolCalls:b.toolCalls.value,lastAt:b.last.value_as_string??null,weekEvents:b.week.doc_count}));
      if(!team&&people.some(p=>p.userId!==principal.userId))throw new Error('Usage returned an invalid ownership scope');
      const terms=agg=>agg.buckets.map(b=>({name:b.key,count:b.doc_count}));
      return {events:result.hits.total?.value??0,sessions:a.sessions.value,messages:a.messages.doc_count,toolCalls:a.toolCalls.value,
        machines:a.machines.value,opencrawlCalls:a.opencrawl.doc_count,tools:terms(a.tools),harnesses:terms(a.harnesses),origins:terms(a.origins),
        firstAt:a.first.value_as_string??null,lastAt:a.last.value_as_string??null,
        daily:a.daily.days.buckets.map(b=>({date:b.key_as_string,events:b.doc_count,sessions:b.sessions.value})),people};
    },
    refresh:principal=>resolve(principal).refresh(principal),
  };
}
export function searchSettings(env=process.env) {
  if(!env.OPENCRAWL_OPENSEARCH_URL)return null;
  return {endpoint:env.OPENCRAWL_OPENSEARCH_URL,index:env.OPENCRAWL_OPENSEARCH_INDEX||undefined,environment:env.OPENCRAWL_SEARCH_ENVIRONMENT||'selfhost',
    username:env.OPENCRAWL_OPENSEARCH_USERNAME,password:env.OPENCRAWL_OPENSEARCH_PASSWORD};
}
