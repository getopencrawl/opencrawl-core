import type {Principal} from './types.mjs';
import type {RealmOptions, DocumentItem, SearchInput, SearchResult, OpenSearchResponse, Passage} from '../search/types.mjs';
interface TermsAggregation {buckets: Array<{key: string; doc_count: number}>}
interface SessionCount {count: {value: number}}
interface ActivityAggregation {doc_count: number; sessions: SessionCount; subagentSessions: SessionCount; messages: {doc_count: number}; toolCalls: {value: number}; machines: {value: number}; opencrawl: {doc_count: number}; tools: TermsAggregation; harnesses: TermsAggregation; origins: TermsAggregation; first: {value_as_string?: string}; last: {value_as_string?: string}; daily: {buckets: Array<{key_as_string: string; doc_count: number; sessions: SessionCount}>}; people: {buckets: Array<{key: string; doc_count: number; sessions: SessionCount; subagentSessions: SessionCount; messages: {doc_count: number}; toolCalls: {value: number}; last: {value_as_string?: string}; week: {doc_count: number}}>}}
import {createRealmResolver,realmField} from '../search/realm.mjs';
import {sessionScope} from './ingest.mjs';
import {createMemorySearch} from '../memories/search.mjs';
import {visibleTo} from './controls.mjs';
import type {ResourceControl} from './controls.mjs';
import {applySessionControl} from './library.mjs';

import {sessionIndexMapping} from '../search/mapping.mjs';
import {textQuery,timeRange} from '../search/text-query.mjs';
export {sessionIndexMapping};
const UPSERT="if (ctx._source.session != null && (ctx._source.tenantId != params.doc.tenantId || ctx._source.session.userId != params.doc.session.userId)) { throw new IllegalArgumentException('Session document ownership mismatch'); } if (ctx._source.session == null || ctx._source.session.receivedAt == null || params.doc.session.receivedAt.compareTo(ctx._source.session.receivedAt) > 0) { ctx._source = params.doc; } else { ctx.op = 'none'; }";
function fail(status: number,message: string): never {throw Object.assign(new Error(message),{status});}
export function createSessionSearch(options: RealmOptions) {
  const resolve=createRealmResolver(options), f=(field: string)=>realmField('session',field);
  function search(principal: Principal, input: SearchInput & {raw: true}): Promise<OpenSearchResponse>;
  function search(principal: Principal, input?: SearchInput & {raw?: false}): Promise<SearchResult>;
  function search(principal: Principal, input: SearchInput): Promise<SearchResult | OpenSearchResponse>;
  async function search(principal: Principal,{query='',limit=20,raw=false,match='all',sessionId,id,after,before}: SearchInput={}): Promise<SearchResult | OpenSearchResponse> {
      sessionScope(principal);
      if(id!==undefined&&(typeof id!=='string'||!/^[A-Za-z0-9_:-]{1,256}$/.test(id)))fail(400,'Invalid passage id');
      if(!['all','any','phrase'].includes(match)||(sessionId!==undefined&&(typeof sessionId!=='string'||!sessionId||sessionId.length>200)))fail(400,'Invalid search filters');
      if(typeof query!=='string'||query.length>4000||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Invalid search query or limit');
      const result=await resolve(principal).collection('session').search(principal,{size:limit,track_total_hits:true,
        query:{bool:{filter:[{term:{tenantId:principal.tenantId}},visibleTo('session',principal),...(sessionId?[{term:{[f('sessionId')]:sessionId}}]:[]),...(id?[{term:{id}}]:[]),...timeRange(after,before)],must:query?[textQuery(query,match)]:[{match_all:{}}]}},
        sort:query?['_score',...['receivedAt','sessionId','eventId','chunk','userId','installationId'].map(key=>({[f(key)]:key==='receivedAt'?'desc':'asc'}))]:[{[f('receivedAt')]:'desc'},{[f('sequence')]:'asc'}]});
      const hits=result?.hits?.hits;
      if(!Array.isArray(hits)||hits.some(hit=>hit._source?.tenantId!==principal.tenantId||typeof hit._source?.userId!=='string'||!hit._source.userId))throw new Error('Search returned an invalid ownership scope');
      if(raw)return result;
      return {total:result.hits.total?.value??0,hits:hits.map(hit=>({id:hit._id,score:hit._score,...hit._source} as Passage))};
    }
  return {
    memories:createMemorySearch(options),
    identity:resolve.identity,
    ensureIndex:(principal: Principal)=>resolve(principal).ensureIndex(),
    async putDocuments(documents: DocumentItem[],principal: Principal){
      sessionScope(principal);
      const collection=resolve(principal).collection('session');
      let batch: DocumentItem[]=[],bytes=0;
      for(const item of documents){
        if(item.document?.tenantId!==principal.tenantId||item.document?.userId!==principal.userId)fail(403,'Session document owner does not match its authorized scope');
        const size=Buffer.byteLength(JSON.stringify(item));
        if(size>3*1024*1024)throw new Error('Search document exceeds bulk limit');
        if(bytes+size>3*1024*1024){await collection.bulk(principal,batch);batch=[];bytes=0;}
        if(typeof item.document?.receivedAt!=='string'||!Number.isFinite(Date.parse(item.document.receivedAt)))throw new Error('Session capture timestamp required');
        batch.push({...item,script:UPSERT});bytes+=size;
      }
      await collection.bulk(principal,batch);
    },
    search,
    /** Activity within the requested UTC calendar-day window, plus lifetimeEvents for
     * index inventory. Never returns transcript text. With team:true the caller
     * must already have authorized the principal for its whole tenant. */
    async usage(principal: Principal,{team=false,days=30,now=Date.now()}: {team?: boolean; days?: number; now?: number}={}) {
      sessionScope(principal);
      if(!Number.isInteger(days)||days<1||days>365||!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime()))fail(400,'Invalid usage window');
      const day=(t: number)=>new Date(t).toISOString().slice(0,10),since=day(now-(days-1)*86400000),today=day(now);
      const until=new Date(now).toISOString();
      const filter=[{term:{tenantId:principal.tenantId}},...(team?[]:[{term:{[f('userId')]:principal.userId}}]),{term:{[f('chunk')]:0}}];
      const messages={filter:{term:{[f('kind')]:'message'}}},toolCalls={value_count:{field:f('toolNames')}};
      // Sessions are the ones a person started; each spawned subagent has its own
      // session ID and is counted separately. 40000 keeps cardinality exact here.
      const count={cardinality:{field:f('sessionId'),precision_threshold:40000}},subagent={term:{[f('origin')]:'subagent'}};
      const sessions={filter:{bool:{must_not:[subagent]}},aggs:{count}},subagentSessions={filter:subagent,aggs:{count}};
      const result=await resolve(principal).collection('session').search(principal,{size:0,track_total_hits:true,query:{bool:{filter}},aggs:{
        activity:{filter:{range:{[f('timestamp')]:{gte:since+'T00:00:00.000Z',lte:until}}},aggs:{
        sessions,subagentSessions,messages,toolCalls,machines:{cardinality:{field:f('installationId')}},
        tools:{terms:{field:f('toolNames'),size:8}},opencrawl:{filter:{wildcard:{[f('toolNames')]:'*opencrawl*'}}},
        harnesses:{terms:{field:f('harness'),size:5}},origins:{terms:{field:f('origin'),size:6}},
        first:{min:{field:f('timestamp')}},last:{max:{field:f('timestamp')}},
        daily:{date_histogram:{field:f('timestamp'),calendar_interval:'day',format:'yyyy-MM-dd',min_doc_count:0,extended_bounds:{min:since,max:today}},aggs:{sessions}},
        people:{terms:{field:f('userId'),size:500},aggs:{sessions,subagentSessions,messages,toolCalls,last:{max:{field:f('timestamp')}},week:{filter:{range:{[f('timestamp')]:{gte:new Date(now-7*86400000).toISOString(),lte:until}}}}}},
      }}}});
      const a=result?.aggregations?.activity as unknown as ActivityAggregation | undefined;
      if(!a||!Number.isSafeInteger(a.doc_count)||result.hits.total?.relation!=='eq'||!Number.isSafeInteger(result.hits.total.value))throw new Error('Invalid usage response');
      const people=a.people.buckets.map(b=>({userId:b.key,events:b.doc_count,sessions:b.sessions.count.value,subagentSessions:b.subagentSessions.count.value,messages:b.messages.doc_count,toolCalls:b.toolCalls.value,lastAt:b.last.value_as_string??null,weekEvents:b.week.doc_count}));
      if(!team&&people.some(p=>p.userId!==principal.userId))throw new Error('Usage returned an invalid ownership scope');
      const terms=(agg: TermsAggregation)=>agg.buckets.map(b=>({name:b.key,count:b.doc_count}));
      return {events:a.doc_count,lifetimeEvents:result.hits.total.value,sessions:a.sessions.count.value,subagentSessions:a.subagentSessions.count.value,messages:a.messages.doc_count,toolCalls:a.toolCalls.value,
        machines:a.machines.value,opencrawlCalls:a.opencrawl.doc_count,tools:terms(a.tools),harnesses:terms(a.harnesses),origins:terms(a.origins),
        firstAt:a.first.value_as_string??null,lastAt:a.last.value_as_string??null,
        daily:a.daily.buckets.map(b=>({date:b.key_as_string,events:b.doc_count,sessions:b.sessions.count.value})),people};
    },
    refresh:(principal: Principal)=>resolve(principal).refresh(principal),
    applySessionControl:(principal: Principal,key: {harness: string; sessionId: string},control: ResourceControl)=>
      applySessionControl(resolve(principal).collection('session'),principal,{userId:principal.userId,...key},control),
  };
}
export function searchSettings(env=process.env) {
  if(!env.OPENCRAWL_OPENSEARCH_URL)return null;
  return {endpoint:env.OPENCRAWL_OPENSEARCH_URL,index:env.OPENCRAWL_OPENSEARCH_INDEX||undefined,environment:env.OPENCRAWL_SEARCH_ENVIRONMENT||'selfhost',
    username:env.OPENCRAWL_OPENSEARCH_USERNAME,password:env.OPENCRAWL_OPENSEARCH_PASSWORD};
}
