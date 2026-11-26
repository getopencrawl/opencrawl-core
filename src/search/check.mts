import {executedCheckQuery} from './check-activity.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {plainTextTokens} from '../sessions/token-count.mjs';
import {currentSessionSchema} from './context.mjs';
import {sessionScope} from '../sessions/ingest.mjs';
import {fail} from '../errors.mjs';
import type {Principal} from '../sessions/types.mjs';

/** Public, provider-independent limits. A judgment adapter may impose tighter limits. */
export const CHECK_LIMITS = Object.freeze({searches:3,candidates:24,ranked:12,results:5,
  inputBytes:12000,passageChars:1600,quoteTokens:200,outputTokens:1600,deadlineMs:20000});
export const checkInputSchema = z.strictObject({
  eventId:z.string().min(1).max(200), currentSession:currentSessionSchema,
  message:z.string().min(1).max(8000), role:z.enum(['user','assistant']).default('user'),
  task:z.string().max(2000).default(''),
  context:z.array(z.strictObject({role:z.enum(['user','assistant']),text:z.string().max(2000)})).max(4).default([]),
  timestamp:z.iso.datetime().optional(),
}).refine(v=>Buffer.byteLength(JSON.stringify(v))<=CHECK_LIMITS.inputBytes,'Check input exceeds its byte budget');
export type CheckInput=z.infer<typeof checkInputSchema>;
export interface CheckHit {id:string;source:string;title:string;text:string;url?:string;provenance:Record<string,unknown>;excerpt?:{start:number;end:number;totalChars:number}}
export interface CheckSearch {
  search(principal:Principal,input:unknown):Promise<{results:unknown[];partial?:boolean}>;
  fetch(principal:Principal,input:unknown):Promise<{text:string}>;
}
export interface CheckQuery {query:string;match:'all'|'any'}
export interface CheckCandidate extends CheckHit {key:string;quotes:{text:string;offset:number}[]}
export interface CheckPick {key:string;quote:number;score:number}
export const checkReflexSchema = z.strictObject({
  id:z.string().min(1).max(300),
  text:z.string().min(1).max(8000),
  title:z.string().max(1000).optional(),
  kind:z.string().max(120).optional(),
  severity:z.string().max(120).optional(),
  intentId:z.string().max(120).optional(),
  url:z.string().max(2048).regex(/^https?:\/\//).refine(v=>{
    if(/[\r\n\x00]/.test(v))return false;
    try{const parsed=new URL(v);return parsed.protocol==='http:'||parsed.protocol==='https:';}
    catch{return false;}
  },'Invalid reflex URL').optional(),
});
export type CheckReflex=z.infer<typeof checkReflexSchema>;
export interface CheckJudgment {
  version:string;
  plan(input:CheckInput,signal:AbortSignal):Promise<CheckQuery[]>;
  shortlist(input:CheckInput,candidates:CheckCandidate[],signal:AbortSignal):Promise<string[]>;
  rank(input:CheckInput,candidates:CheckCandidate[],signal:AbortSignal):Promise<CheckPick[]>;
  reflexes?(input:CheckInput,signal:AbortSignal):Promise<CheckReflex[]>;
}
export interface CheckResult {
  policyVersion:string;results:{id:string;source:string;title:string;text:string;offset:number;url?:string;provenance:Record<string,unknown>;score:number}[];
  reflexes?:CheckReflex[];
  searched:number;candidates:number;partial:boolean;outputTokens:number;
}
const tokens=plainTextTokens;
/** Prefix selection preserves exact UTF-16 offsets and never changes source text. */
export function tokenPrefix(text:string,limit:number):string {
  if(tokens(text)<=limit)return text;
  let lo=0,hi=text.length;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(tokens(text.slice(0,mid))<=limit)lo=mid;else hi=mid-1;}
  if(lo&&/[\uD800-\uDBFF]/.test(text[lo-1]!))lo--;
  return text.slice(0,lo);
}
export function checkQuotes(text:string) {
  const out:{text:string;offset:number}[]=[];
  // Prefer complete paragraphs/sentences; arbitrary token boundaries can leave
  // an answer without the fact that made its source useful. Offsets stay exact.
  const boundaries=[0,...Array.from(text.matchAll(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z*])/g),m=>m.index+m[0].length),text.length];
  let start=0;
  for(let i=1;i<boundaries.length&&out.length<4;i++){
    const end=boundaries[i]!;
    if(i+1<boundaries.length&&tokens(text.slice(start,boundaries[i+1]))<=CHECK_LIMITS.quoteTokens)continue;
    const raw=text.slice(start,end),leading=raw.length-raw.trimStart().length;
    const trimmed=raw.trim();let consumed=0;
    do {
      const quote=tokenPrefix(trimmed.slice(consumed),CHECK_LIMITS.quoteTokens);if(!quote)break;
      if(tokens(quote)>=2)out.push({text:quote,offset:start+leading+consumed});
      consumed+=quote.length;
    }while(consumed<trimmed.length&&out.length<4);
    start=end;
  }
  return out;
}
export const checkFingerprint=(input:CheckInput)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');

const hitSchema=z.object({id:z.string().max(300),source:z.enum(['sessions','connectors','memories']),title:z.string(),text:z.string(),url:z.string().optional(),provenance:z.record(z.string(),z.unknown()),excerpt:z.object({start:z.number().int().nonnegative(),end:z.number(),totalChars:z.number()}).optional()});
export function createContextCheck({search,judge,authorize,now=Date.now}:{search:CheckSearch;judge:()=>CheckJudgment;authorize:(p:Principal)=>Promise<unknown>;now?:()=>number}) {
  return async (principal:Principal,raw:unknown,signal=AbortSignal.timeout(CHECK_LIMITS.deadlineMs)):Promise<CheckResult>=>{
    sessionScope(principal);if(principal.captureAccess==='write')fail(403,'Capture credentials cannot read context.');
    const parsed=checkInputSchema.safeParse(raw);if(!parsed.success)fail(400,'Invalid context check.');
    const input=parsed.data;await authorize(principal);signal.throwIfAborted();
    const at=Math.min(input.timestamp?Date.parse(input.timestamp):now(),now());
    const policy=judge(),queries=await policy.plan(input,signal);
    if(queries.length>CHECK_LIMITS.searches||queries.some(q=>!['all','any'].includes(q.match)||!q.query.trim()||q.query.length>500))throw Error('Invalid check queries');
    const hits:CheckHit[][]=[];let partial=false;
    for(const query of queries){
      signal.throwIfAborted();
      executedCheckQuery(query.query);
      const page=await search.search(principal,{...query,source:'all',limit:24,excerptChars:CHECK_LIMITS.passageChars,
        currentSession:input.currentSession,includeToolOutputs:false,groupBy:'resource',filters:{before:new Date(at).toISOString()}});
      if(page.results.length>24)throw Error('Invalid check candidate count');
      hits.push(page.results.map(h=>hitSchema.parse(h)));partial ||= Boolean(page.partial);
    }
    const candidates:CheckCandidate[]=[],ids=new Set<string>(),texts=new Set<string>(),chats=new Map<string,number>();
    for(let n=0;n<24&&candidates.length<CHECK_LIMITS.candidates;n++)for(const batch of hits){
      const hit=batch[n];if(!hit||ids.has(hit.id)||texts.has(hit.text)||!hit.text)continue;
      const p=hit.provenance,sid=String(p.sessionId??p.sourceSessionId??'');
      if(sid===input.currentSession.sessionId||sid&&(chats.get(sid)??0)>=3)continue;
      const date=p.timestamp??p.modifiedAt;
      const time=typeof date==='number'?date:Date.parse(String(date??''));
      if(hit.source==='sessions'&&(!['user','assistant'].includes(String(p.role))||!Number.isFinite(time)))continue;
      if(Number.isFinite(time)&&time>=at)continue;
      let end=Math.min(hit.text.length,CHECK_LIMITS.passageChars);
      while(Buffer.byteLength(hit.text.slice(0,end))>1600)end--;
      if(end&&/[\uD800-\uDBFF]/.test(hit.text[end-1]!))end--;
      const text=hit.text.slice(0,end);
      const quotes=checkQuotes(text);if(!quotes.length)continue;
      candidates.push({...hit,text,key:'c'+candidates.length,quotes});
      ids.add(hit.id);texts.add(hit.text);if(sid)chats.set(sid,(chats.get(sid)??0)+1);
      if(candidates.length===CHECK_LIMITS.candidates)break;
    }
    signal.throwIfAborted();
    if(partial&&!candidates.length)throw Error('Context search unavailable');
    const keys=candidates.length?await policy.shortlist(input,candidates,signal):[];
    if(keys.length>CHECK_LIMITS.ranked||new Set(keys).size!==keys.length||keys.some(k=>!candidates.some(c=>c.key===k)))throw Error('Invalid check shortlist');
    const selected=keys.map(k=>candidates.find(c=>c.key===k)!);
    const picks=selected.length?await policy.rank(input,selected,signal):[];
    if(picks.length>CHECK_LIMITS.ranked||new Set(picks.map(p=>p.key)).size!==picks.length)throw Error('Invalid check ranking');
    const results:CheckResult['results']=[];
    for(const pick of picks){
      signal.throwIfAborted();const hit=selected.find(c=>c.key===pick.key),quote=hit?.quotes[pick.quote];
      if(!hit||!Number.isInteger(pick.quote)||!quote||!Number.isFinite(pick.score)||pick.score<0||pick.score>1)throw Error('Invalid check selection');
      const offset=(hit.excerpt?.start??0)+quote.offset;
      // Fresh source authorization and exact quotation check before disclosing a result.
      const fresh=await search.fetch(principal,{id:hit.id,offset,length:quote.text.length});
      if(fresh.text!==quote.text){partial=true;continue;}
      const item={id:hit.id,source:hit.source,title:hit.title.slice(0,200),text:quote.text,offset,...hit.url?{url:hit.url}:{},provenance:hit.provenance,score:pick.score};
      if(tokens(JSON.stringify([...results,item]))>CHECK_LIMITS.outputTokens){partial=true;continue;}
      results.push(item);if(results.length===CHECK_LIMITS.results)break;
    }
    const rawReflexes=policy.reflexes?await policy.reflexes(input,signal):undefined;
    const reflexes=rawReflexes!==undefined?z.array(checkReflexSchema).max(CHECK_LIMITS.results).parse(rawReflexes):undefined;
    await authorize(principal);signal.throwIfAborted();
    return {policyVersion:policy.version,results,...(reflexes?.length?{reflexes}:{}),searched:queries.length,candidates:candidates.length,partial,outputTokens:tokens(JSON.stringify(results))};
  };
}

const stop=new Set('this that with from have just please what when where which about could would should your user assistant current work need want make check using'.split(' '));
export function checkTerms(input:CheckInput):string[]{
  const source=[input.message,...[...input.context].reverse().map(c=>c.text),input.task].join(' ');
  return [...new Set((source.match(/[\p{L}][\p{L}\p{N}._/-]{2,79}/gu)??[]).map(t=>t.toLowerCase()).filter(t=>!stop.has(t)))].slice(0,28);
}
/** Working local reference: no vendor account, model call, credit service or telemetry. */
export function lexicalCheckJudgment():CheckJudgment {
  return {version:'lexical-v1',
    async plan(input){const terms=checkTerms(input);return terms.length?[{query:terms.slice(0,6).join(' '),match:'any'}]:[];},
    async shortlist(_input,candidates){return candidates.slice(0,CHECK_LIMITS.ranked).map(c=>c.key);},
    async rank(input,candidates){const terms=checkTerms(input);return candidates.map(c=>{
      const scores=c.quotes.map(q=>terms.filter(t=>q.text.toLowerCase().includes(t)).length/Math.max(1,terms.length));
      return {key:c.key,quote:scores.indexOf(Math.max(...scores)),score:Math.max(...scores)};
    }).filter(p=>p.score>0).sort((a,b)=>b.score-a.score);},
  };
}
