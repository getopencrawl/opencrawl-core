import {createRealmResolver,realmField} from '../search/realm.mjs';
import {sessionScope} from './ingest.mjs';

import {sessionIndexMapping} from '../search/mapping.mjs';
export {sessionIndexMapping};
const UPSERT="if (ctx._source.session == null || ctx._source.session.receivedAt == null || params.doc.session.receivedAt.compareTo(ctx._source.session.receivedAt) > 0) { ctx._source = params.doc; } else { ctx.op = 'none'; }";
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function createSessionSearch(options) {
  const resolve=createRealmResolver(options), f=field=>realmField('session',field);
  return {
    identity:resolve.identity,
    ensureIndex:principal=>resolve(principal).ensureIndex(),
    async putDocuments(documents,principal){
      sessionScope(principal);
      const collection=resolve(principal).collection('session');
      let batch=[],bytes=0;
      for(const item of documents){
        const size=Buffer.byteLength(JSON.stringify(item));
        if(size>3*1024*1024)throw new Error('Search document exceeds bulk limit');
        if(bytes+size>3*1024*1024){await collection.bulk(principal,batch);batch=[];bytes=0;}
        if(typeof item.document?.receivedAt!=='string'||!Number.isFinite(Date.parse(item.document.receivedAt)))throw new Error('Session capture timestamp required');
        batch.push({...item,script:UPSERT});bytes+=size;
      }
      await collection.bulk(principal,batch);
    },
    async search(principal,{query='',limit=20,raw=false,match='all',sessionId,id}={}) {
      sessionScope(principal);
      if(id!==undefined&&(typeof id!=='string'||!/^[A-Za-z0-9_:-]{1,256}$/.test(id)))fail(400,'Invalid passage id');
      if(!['all','any','phrase'].includes(match)||(sessionId!==undefined&&(typeof sessionId!=='string'||!sessionId||sessionId.length>200)))fail(400,'Invalid search filters');
      if(typeof query!=='string'||query.length>4000||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Invalid search query or limit');
      const result=await resolve(principal).collection('session').search(principal,{size:limit,track_total_hits:true,
        query:{bool:{filter:[{term:{tenantId:principal.tenantId}},...(sessionId?[{term:{[f('sessionId')]:sessionId}}]:[]),...(id?[{term:{id}}]:[])],must:query?[match==='phrase'?{match_phrase:{text:query}}:{match:{text:{query,operator:match==='all'?'and':'or'}}}]:[{match_all:{}}]}},
        sort:query?['_score',...['receivedAt','sessionId','eventId','chunk','userId','installationId'].map(key=>({[f(key)]:key==='receivedAt'?'desc':'asc'}))]:[{[f('receivedAt')]:'desc'},{[f('sequence')]:'asc'}]});
      const hits=result?.hits?.hits;
      if(!Array.isArray(hits)||hits.some(hit=>hit._source?.tenantId!==principal.tenantId||typeof hit._source?.userId!=='string'||!hit._source.userId))throw new Error('Search returned an invalid ownership scope');
      if(raw)return result;
      return {total:result.hits.total?.value??0,hits:hits.map(hit=>({id:hit._id,score:hit._score,...hit._source}))};
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
