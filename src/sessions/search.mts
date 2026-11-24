import {memberUsage, ownerUsage, type OwnerBucket, type UsageMember} from './member-usage.mjs';
import {lexicalQuery} from '../search/lexical.mjs';
import {sessionSearchExclusions} from '../search/context.mjs';
import type {Principal, ObjectStore} from './types.mjs';
import {serviceError} from './types.mjs';
import type {RealmOptions, DocumentItem, SearchInput, SearchResult, OpenSearchResponse, Passage} from '../search/types.mjs';
interface TermsAggregation {buckets: Array<{key: string; doc_count: number}>}
interface SessionCount {count: {value: number}}
interface ActivityAggregation {doc_count: number; sessions: SessionCount; subagentSessions: SessionCount; messages: {doc_count: number}; toolCalls: {value: number}; machines: {value: number}; opencrawl: {doc_count: number}; tools: TermsAggregation; harnesses: TermsAggregation; origins: TermsAggregation; first: {value_as_string?: string}; last: {value_as_string?: string}; daily: {buckets: Array<{key_as_string: string; doc_count: number; sessions: SessionCount}>}; people: {buckets: OwnerBucket[]}}
import {createRealmResolver,realmField} from '../search/realm.mjs';
import {sessionScope,createSessionIngest} from './ingest.mjs';
import {digest,sourceBatchIdentity} from './event-identity.mjs';
import {messageFingerprint,type CaptureFingerprints} from './capture-matches.mjs';
import {createMemorySearch} from '../memories/search.mjs';
import {visibleTo, createControls} from './controls.mjs';
import type {ResourceControl} from './controls.mjs';
import {applySessionControl, createSessionLibrary} from './library.mjs';
import {searchFilters,searchSort} from '../search/controls.mjs';
import {sessionOverlap} from './overlap.mjs';
import {sessionContext} from './context.mjs';
import type {SessionContextInput} from '../search/types.mjs';

import {sessionIndexMapping} from '../search/mapping.mjs';
import {fail} from '../errors.mjs';
export {sessionIndexMapping};

export function createSessionSearch(options: RealmOptions & {store?: ObjectStore; prefix?: string}) {
  const resolve=createRealmResolver(options), f=(field: string)=>realmField('session',field);
  const controls=options.store && options.prefix ? createControls({store:options.store,prefix:options.prefix}) : null;
  const original=options.store&&options.prefix?createSessionIngest({store:options.store,prefix:options.prefix}):undefined;
  const captureFingerprints:CaptureFingerprints=async(principal,hits)=>{
    const hashes=new Map<string,string>(),batches=new Map<string,Passage[]>();
    if(!original||!options.prefix)return hashes;
    for(const hit of hits){
      const key=hit.sourceKey,scope=key&&sourceBatchIdentity(options.prefix,key);
      if(!scope||hit.tenantId!==principal.tenantId||scope.tenantHash!==digest(principal.tenantId)||scope.harness!==hit.harness||
        scope.userHash!==digest(hit.userId??'')||scope.sessionHash!==digest(hit.sessionId??'')||scope.installationHash!==digest(hit.installationId??''))continue;
      const same=batches.get(key!)??[];same.push(hit);batches.set(key!,same);
    }
    const entries=[...batches];
    for(let i=0;i<entries.length;i+=4)await Promise.all(entries.slice(i,i+4).map(async([key,rows])=>{
      const hit=rows[0]!,batch=await original.getBatch(principal,{userId:hit.userId,sessionId:hit.sessionId,harness:hit.harness,
        installationId:hit.installationId,batchId:sourceBatchIdentity(options.prefix!,key)!.batchId});
      if(!batch)return;
      const events=new Map(batch.events.map(event=>[event.id,event]));
      for(const row of rows){
        const event=events.get(row.eventId??''),hash=event&&messageFingerprint(event);
        if(hash)hashes.set(row.id,hash);
      }
    }));
    return hashes;
  };
  async function readableHits(principal:Principal,docs:Passage[]){
    sessionScope(principal);
    if(principal.captureAccess!==undefined||!controls)fail(403,'Session read access required');
    const resources=new Map<string,Passage>(),allowedByResource=new Map<string,boolean>();
    const resourceKey=(doc:Passage)=>JSON.stringify([doc.userId,doc.harness,doc.sessionId]);
    for(const doc of docs){
      if(doc.tenantId!==principal.tenantId||!doc.userId||typeof doc.harness!=='string'||typeof doc.sessionId!=='string')throw new Error('Invalid session search identity');
      resources.set(resourceKey(doc),doc);
    }
    const entries=[...resources];
    // One authoritative read per resource per request, with bounded fanout.
    // Never retain this permission result across requests or fetches.
    for(let start=0;start<entries.length;start+=8)await Promise.all(entries.slice(start,start+8).map(async([key,doc])=>{
      const control=await controls.read({...principal,userId:doc.userId!},'sessions',doc.harness!,doc.sessionId!);
      allowedByResource.set(key,!control?.deletedAt&&(control?.visibility!=='private'||doc.userId===principal.userId));
    }));
    return docs.map(doc=>allowedByResource.get(resourceKey(doc))===true);
  }
  function search(principal: Principal, input: SearchInput & {raw: true}): Promise<OpenSearchResponse>;
  function search(principal: Principal, input?: SearchInput & {raw?: false}): Promise<SearchResult>;
  function search(principal: Principal, input: SearchInput): Promise<SearchResult | OpenSearchResponse>;
  async function search(principal: Principal,{query='',limit=20,raw=false,match='all',sessionId,id,filters,order,currentSession,currentCapture,includeCurrentSession,includeToolOutputs}: SearchInput={}): Promise<SearchResult | OpenSearchResponse> {
      sessionScope(principal);
      if (principal.captureAccess !== undefined) fail(403, 'Session read access required');
      if (!controls) fail(503, 'Session search requires authoritative resource controls');
      if(id!==undefined&&(typeof id!=='string'||!/^[A-Za-z0-9_:-]{1,256}$/.test(id)))fail(400,'Invalid passage id');
      if(!['all','any','phrase'].includes(match)||(sessionId!==undefined&&(typeof sessionId!=='string'||!sessionId||sessionId.length>200)))fail(400,'Invalid search filters');
      if(typeof query!=='string'||query.length>4000||!Number.isInteger(limit)||limit<1||limit>100)fail(400,'Invalid search query or limit');
      const result=await resolve(principal).collection('session').search(principal,{size:limit,track_total_hits:true,
        query:{bool:{filter:[{term:{tenantId:principal.tenantId}},visibleTo('session',principal),...searchFilters('session',filters),...(!id?sessionSearchExclusions(principal,{currentSession,currentCapture,includeCurrentSession,includeToolOutputs}):[]),...(sessionId?[{term:{[f('sessionId')]:sessionId}}]:[]),...(id?[{term:{id}}]:[])],must:[lexicalQuery(query,match)]}},
        sort:[...searchSort('session',order),...(query?['_score',...['receivedAt','sessionId','eventId','chunk','userId','installationId'].map(key=>({[f(key)]:key==='receivedAt'?'desc':'asc'}))]:[{[f('receivedAt')]:'desc'},{[f('sequence')]:'asc'},{id:'asc'}])]});
      const hits=result?.hits?.hits;
      if(!Array.isArray(hits)||hits.some(hit=>hit._source?.tenantId!==principal.tenantId||typeof hit._source?.userId!=='string'||!hit._source.userId))throw new Error('Search returned an invalid ownership scope');
      // The index is a projection, never the authority for deletion/privacy.
      // Recheck after retrieval, including fetch-by-ID and raw diagnostics.
      const allowed=await readableHits(principal,hits.map(hit=>hit._source as Passage));
      result.hits.hits=hits.filter((_,i)=>allowed[i]);
      const filtered=result.hits.hits.length!==hits.length;
      if(filtered)result.hits.total={value:result.hits.hits.length,relation:'gte'};
      if(raw)return result;
      return {total:result.hits.total?.value??0,...(filtered?{truncated:true}:{}),hits:result.hits.hits.map(hit=>({id:hit._id,score:hit._score,...hit._source} as Passage))};
    }
  return {
    resultTitles: options.store && options.prefix
      ? createSessionLibrary({...options, store: options.store, prefix: options.prefix}).resultTitles : undefined,
    memories:createMemorySearch(options),
    identity:resolve.identity,
    ensureIndex:(principal: Principal)=>resolve(principal).ensureIndex(),
    async putDocuments(documents: DocumentItem[],principal: Principal){
      sessionScope(principal);
      const collection=resolve(principal).collection('session');
      const prepared=documents.map(item=>{
        if(item.document?.tenantId!==principal.tenantId||item.document?.userId!==principal.userId)fail(403,'Session document owner does not match its authorized scope');
        if(typeof item.document?.receivedAt!=='string'||!Number.isFinite(Date.parse(item.document.receivedAt)))throw new Error('Session capture timestamp required');
        return {...item,policy:'session' as const};
      });
      await collection.bulk(principal,prepared);
    },
    search,captureFingerprints,readableHits,
    context: (principal: Principal, anchor: Passage, input: SessionContextInput) => sessionContext(resolve(principal).collection('session'), controls, principal, anchor, input),
    async overlap(principal: Principal, window?: {days?: number; now?: number}) {
      sessionScope(principal);
      if (principal.captureAccess !== undefined) fail(403, 'Session read access required');
      return sessionOverlap(resolve(principal).collection('session'), controls, principal, window);
    },
    /** Activity within the requested UTC calendar-day window, plus lifetimeEvents for
     * index inventory. Never returns transcript text. With team:true the caller
     * must already have authorized the principal for its whole tenant. */
    /** days:null reads every captured day up to now. */
    async usage(principal: Principal,{team=false,days=30,now=Date.now(),members}: {team?: boolean; days?: number | null; now?: number; members?: UsageMember[]}={}) {
      sessionScope(principal);
      const {since,today,until,window}=usageWindow(days,now);
      const filter=[{term:{tenantId:principal.tenantId}},...(team?[]:[{term:{[f('userId')]:principal.userId}}]),{term:{[f('chunk')]:0}}];
      const messages={filter:{term:{[f('kind')]:'message'}}},toolCalls={value_count:{field:f('toolNames')}};
      // Sessions are the ones a person started; each spawned subagent has its own
      // session ID and is counted separately. 40000 keeps cardinality exact here.
      const count={cardinality:{field:f('sessionId'),precision_threshold:40000}},subagent={term:{[f('origin')]:'subagent'}};
      const sessions={filter:{bool:{must_not:[subagent]}},aggs:{count}},subagentSessions={filter:subagent,aggs:{count}};
      if (members && !team) fail(403, 'Team usage required for member reporting');
      const collection = resolve(principal).collection('session');
      const activityMetrics = {last:{max:{field:f('timestamp')}},week:{filter:{range:{[f('timestamp')]:{gte:new Date(now-7*86400000).toISOString(),lte:until}}}}};
      const ownerMetrics = {sessions,subagentSessions,messages,toolCalls,...activityMetrics};
      const result = await collection.search(principal,{size:0,track_total_hits:true,query:{bool:{filter}},aggs:{
        activity:{filter:window,aggs:{
        sessions,subagentSessions,messages,toolCalls,machines:{cardinality:{field:f('installationId')}},
        tools:{terms:{field:f('toolNames'),size:8}},opencrawl:{filter:{wildcard:{[f('toolNames')]:'*opencrawl*'}}},
        harnesses:{terms:{field:f('harness'),size:5}},origins:{terms:{field:f('origin'),size:6}},
        first:{min:{field:f('timestamp')}},last:{max:{field:f('timestamp')}},
        daily:{date_histogram:{field:f('timestamp'),calendar_interval:'day',format:'yyyy-MM-dd',min_doc_count:0,...since?{extended_bounds:{min:since,max:today}}:{}},aggs:{sessions}},
        ...(members ? {} : {people:{terms:{field:f('userId'),size:500},aggs:ownerMetrics}}),
      }}}});
      const a=result?.aggregations?.activity as unknown as ActivityAggregation | undefined;
      if(!a||!Number.isSafeInteger(a.doc_count)||result.hits.total?.relation!=='eq'||!Number.isSafeInteger(result.hits.total.value))throw new Error('Invalid usage response');
      const people = members ? await memberUsage(collection,principal,members,window,ownerMetrics,activityMetrics) : a.people.buckets.map(ownerUsage);
      if(!team&&people.some(p=>p.userId!==principal.userId))throw new Error('Usage returned an invalid ownership scope');
      const terms=(agg: TermsAggregation)=>agg.buckets.map(b=>({name:b.key,count:b.doc_count}));
      return {events:a.doc_count,lifetimeEvents:result.hits.total.value,sessions:a.sessions.count.value,subagentSessions:a.subagentSessions.count.value,messages:a.messages.doc_count,toolCalls:a.toolCalls.value,
        machines:a.machines.value,opencrawlCalls:a.opencrawl.doc_count,tools:terms(a.tools),harnesses:terms(a.harnesses),origins:terms(a.origins),
        firstAt:a.first.value_as_string??null,lastAt:a.last.value_as_string??null,
        daily:throughToday(a.daily.buckets.map(b=>({date:b.key_as_string,events:b.doc_count,sessions:b.sessions.count.value})),today,date=>({date,events:0,sessions:0})),people};
    },
    /** Attribute all canonical indexed text in a session to its earliest event, including imported history. */
    async tokensBySessionStart(principal: Principal, {team = false, days = 30, now = Date.now()}: {team?: boolean; days?: number | null; now?: number} = {}) {
      sessionScope(principal);
      if (principal.captureAccess !== undefined) fail(403, 'Session read access required');
      const {since, today, until} = usageWindow(days, now);
      const filter = [{term: {tenantId: principal.tenantId}}, ...(team ? [] : [{term: {[f('userId')]: principal.userId}}]),
        {term: {[f('chunk')]: 0}}, {range: {[f('timestamp')]: {lte: until}}}];
      // A single search view keeps concurrent indexing from moving a session across pages.
      const result = await resolve(principal).collection('session').search(principal, {size: 0, track_total_hits: true, query: {bool: {filter}},
        aggs: {sessions: {multi_terms: {terms: ['userId','harness','sessionId'].map(key => ({field: f(key)})), size: 50000, order: {_key: 'asc'}},
          aggs: {start: {min: {field: f('timestamp')}}, tokens: {sum: {field: f('capturedTokens')}}, counted: {value_count: {field: f('capturedTokens')}}}}}});
      const grouped = result.aggregations?.sessions;
      if (result.timed_out || result._shards?.failed || result.hits.total?.relation !== 'eq' || grouped?.sum_other_doc_count !== 0 || !Array.isArray(grouped.buckets)) {
        throw new Error('Incomplete session token inventory');
      }
      type Bucket = {doc_count: number; start: {value: number}; tokens: {value: number}; counted: {value: number}};
      const byDay = new Map<string, number>();
      let events = 0, total = 0;
      for (const bucket of grouped.buckets as unknown as Bucket[]) {
        if (!Number.isFinite(bucket.start?.value) || !Number.isSafeInteger(bucket.tokens?.value) || bucket.tokens.value < 0 || bucket.counted?.value !== bucket.doc_count) {
          throw new Error('Incomplete indexed session');
        }
        events += bucket.doc_count;
        const date = dayOf(bucket.start.value);
        if (since && date < since) continue;
        byDay.set(date, (byDay.get(date) ?? 0) + bucket.tokens.value);
        total += bucket.tokens.value;
      }
      if (events !== result.hits.total.value || !Number.isSafeInteger(total)) throw new Error('Incomplete session token inventory');
      const start = since ?? [...byDay.keys()].sort()[0];
      const daily = [];
      for (let at = start ? Date.parse(start) : Infinity; at <= Date.parse(today); at += 86400000) {
        const date = dayOf(at);
        daily.push({date, count: byDay.get(date) ?? 0});
      }
      return {total, daily};
    },
    /** Captured tokens of session events in the window, by the UTC day each event happened. */
    async tokenTotals(principal: Principal,{team=false,days=30,now=Date.now()}: {team?: boolean; days?: number | null; now?: number}={}) {
      sessionScope(principal);
      const {since,today,window}=usageWindow(days,now);
      const filter=[{term:{tenantId:principal.tenantId}},...(team?[]:[{term:{[f('userId')]:principal.userId}}]),{term:{[f('chunk')]:0}},window];
      const tokens={sum:{field:f('capturedTokens')}};
      const result=await resolve(principal).collection('session').search(principal,{size:0,query:{bool:{filter}},aggs:{tokens,first:{min:{field:f('timestamp')}},
        daily:{date_histogram:{field:f('timestamp'),calendar_interval:'day',format:'yyyy-MM-dd',min_doc_count:0,...since?{extended_bounds:{min:since,max:today}}:{}},aggs:{tokens}}}});
      const a=result?.aggregations as unknown as {tokens:{value:number};first:{value_as_string?:string};daily:{buckets:Array<{key_as_string:string;tokens:{value:number}}>}}|undefined;
      if(!a?.daily||!Array.isArray(a.daily.buckets))throw new Error('Invalid token usage response');
      const daily=throughToday(a.daily.buckets.map(b=>({date:b.key_as_string,count:tokenValue(b.tokens)})),today,date=>({date,count:0}));
      return {total:tokenValue(a.tokens),first:a.first?.value_as_string??null,daily};
    },
    /** Sessions with captured tokens in the window, most recently active first. Never returns text. */
    async tokenSessions(principal: Principal,{team=false,days=30,now=Date.now(),offset=0}: {team?: boolean; days?: number | null; now?: number; offset?: number}={}) {
      sessionScope(principal);
      if(!Number.isInteger(offset)||offset<0||offset>tokenSessionLimit)fail(400,'Invalid session page');
      const {window}=usageWindow(days,now);
      const filter=[{term:{tenantId:principal.tenantId}},...(team?[]:[{term:{[f('userId')]:principal.userId}}]),{term:{[f('chunk')]:0}},window];
      const result=await resolve(principal).collection('session').search(principal,{size:0,query:{bool:{filter}},aggs:{sessions:{
        multi_terms:{terms:['userId','harness','sessionId'].map(key=>({field:f(key)})),size:offset+tokenSessionPage+1,order:[{last:'desc'},{_key:'asc'}]},
        aggs:{last:{max:{field:f('timestamp')}},tokens:{sum:{field:f('capturedTokens')}}}}}});
      type Bucket={key:string[];last:{value_as_string?:string};tokens:{value:number}};
      const buckets=result?.aggregations?.sessions?.buckets as unknown as Bucket[]|undefined;
      if(!Array.isArray(buckets))throw new Error('Invalid token session response');
      const rows=buckets.slice(offset,offset+tokenSessionPage).map(b=>({userId:b.key[0]!,harness:b.key[1]!,sessionId:b.key[2]!,tokens:tokenValue(b.tokens),lastAt:b.last?.value_as_string??null}));
      return {rows,more:buckets.length>offset+tokenSessionPage&&offset+tokenSessionPage<tokenSessionLimit};
    },
    refresh:(principal: Principal)=>resolve(principal).refresh(principal),
    applySessionControl:(principal: Principal,key: {harness: string; sessionId: string},control: ResourceControl)=>
      applySessionControl(resolve(principal).collection('session'),principal,{userId:principal.userId,...key},control),
  };
}
const tokenSessionPage=25,tokenSessionLimit=1000;
const dayOf=(t: number)=>new Date(t).toISOString().slice(0,10);
/** Calendar-day UTC window ending now; days:null has no lower bound. */
function usageWindow(days: number | null | undefined,now: number) {
  if((days!=null&&(!Number.isInteger(days)||days<1||days>365))||!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime()))fail(400,'Invalid usage window');
  const until=new Date(now).toISOString(),today=dayOf(now),since=days==null?null:dayOf(now-(days-1)*86400000);
  return {since,today,until,window:{range:{['session.timestamp']:{...since?{gte:since+'T00:00:00.000Z'}:{},lte:until}}}};
}
/** A histogram without a lower bound stops at its last event; days after it measured zero. */
function throughToday<T extends {date: string}>(days: T[],today: string,empty: (date: string)=>T) {
  const result=days.filter(day=>day.date<=today);
  for(let at=result.length?Date.parse(result.at(-1)!.date+'T00:00:00Z')+86400000:Infinity;at<=Date.parse(today+'T00:00:00Z');at+=86400000)result.push(empty(dayOf(at)));
  return result;
}
/** OpenSearch sums are doubles; a negative or unsafe sum is a bad read, not a count. */
function tokenValue(agg: {value: number} | undefined) {
  const value=Math.round(agg?.value ?? 0);
  if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid token aggregation');
  return value;
}
export function searchSettings(env=process.env) {
  const endpoint=env.OPENCRAWL_SEARCH_URL||env.OPENCRAWL_OPENSEARCH_URL;
  if(!endpoint)return null;
  return {endpoint,index:env.OPENCRAWL_OPENSEARCH_INDEX||undefined,environment:env.OPENCRAWL_SEARCH_ENVIRONMENT||'selfhost',
    username:env.OPENCRAWL_OPENSEARCH_USERNAME,password:env.OPENCRAWL_OPENSEARCH_PASSWORD};
}
