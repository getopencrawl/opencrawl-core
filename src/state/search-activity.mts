import {createHash,randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import type {ApplicationDatabase} from './postgres.mjs';
import type {Principal} from '../identity/types.mjs';
import {historyRequest,type HistoryRequest,type SearchActivityPage,type CallTotals,type SearchActivityRow} from '../application/search-activity.mjs';
import {isSessionHarness} from '../sessions/types.mjs';
import {maskPatterns} from '../sessions/credential-patterns.mjs';

const windowStart = "((now() at time zone 'UTC')::date - 29)";
const pageSize=25;
const scope=(p:Principal)=>{
  if(!p?.tenantId || !p.userId) throw Error('Verified activity scope required');
  return [p.tenantId,p.userId];
};
function readScope(p:Principal){
  if(p?.captureAccess!==undefined)throw Object.assign(Error('Workspace membership required'),{status:403});
  return scope(p);
}
const record=(v:unknown):Record<string,unknown> => v && typeof v==='object' ? v as Record<string,unknown> : {};
const text=(s:unknown,limit:number)=>typeof s==='string'?maskPatterns(s.replaceAll('\0','')).slice(0,limit):null;
export function searchDetail(input:unknown){
  const args=record(input), current=record(args.currentSession);
  return {query:text(args.query,4000),harness:isSessionHarness(current.harness)?current.harness:null,
    sessionId:typeof current.sessionId==='string'&&current.sessionId.length<=200&&!current.sessionId.includes('\0')?current.sessionId:null};
}
export const checkEventKey=(harness:string,sessionId:string,eventId:string)=>createHash('sha256').update(JSON.stringify([harness,sessionId,eventId])).digest('hex');
export interface SearchEntry {
  kind:'agent'|'proactive'; operation:string; queries:string[]; harness?:string|null; sessionId?:string|null;
  eventKey?:string; messageId?:string; message?:string; returned?:number; failed?:boolean;
}
export function createSearchActivity(database:Pick<ApplicationDatabase,'pool'|'namespace'|'transaction'>) {
  const {pool,namespace}=database;
  let cursorKey:Buffer;
  function cursor(position:{at:string;id:string},audience:string){
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cursorKey,nonce);
    cipher.setAAD(Buffer.from(audience));
    const body=Buffer.concat([cipher.update(JSON.stringify([position.at,position.id])),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),body]).toString('base64url');
  }
  function position(token:string,audience:string):[string,string]{
    try{
      const bytes=Buffer.from(token,'base64url');
      const cipher=createDecipheriv('aes-256-gcm',cursorKey,bytes.subarray(0,12));
      cipher.setAAD(Buffer.from(audience));cipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
    }catch{throw Object.assign(Error('Invalid search history cursor'),{status:400,expose:true});}
  }
  const dayUpsert=`insert into opencrawl_call_days(namespace,tenant_id,day,calls)
    values ($1,$2,(now() at time zone 'UTC')::date,1)
    on conflict(namespace,tenant_id,day) do update set calls=opencrawl_call_days.calls+1`;
  const activity = {
    async ready(){
      await database.transaction(async db=>{
        await db.query("select pg_advisory_xact_lock(hashtextextended('oc:search-activity-schema',0))");
        await db.query(`create table if not exists opencrawl_activity_start(namespace text primary key,cursor_key bytea not null,started_at timestamptz not null default now());
          create table if not exists opencrawl_call_days(namespace text not null,tenant_id text not null,day date not null,calls bigint not null,primary key(namespace,tenant_id,day));
          create table if not exists opencrawl_activity_session_gates(namespace text not null,tenant_id text not null,user_id text not null,
            session_hash text not null,erased boolean not null default false,primary key(namespace,tenant_id,user_id,session_hash));
          create table if not exists opencrawl_search_history(namespace text not null,tenant_id text not null,user_id text not null,
            kind text not null, id uuid primary key, at timestamptz(3) not null default clock_timestamp(),
            operation text not null, queries text[] not null, harness text, session_id text, event_key text, message_id text, message text,
            returned integer, failed boolean not null, delivered boolean not null default false,
            unique(namespace,tenant_id,user_id,event_key));
          create index if not exists opencrawl_search_history_linked on opencrawl_search_history(namespace,tenant_id,kind,at desc,id desc) where session_id is not null and harness is not null;
          create index if not exists opencrawl_search_history_personal on opencrawl_search_history(namespace,tenant_id,user_id,kind,at desc,id desc) where session_id is null or harness is null;
          create index if not exists opencrawl_search_history_expiry on opencrawl_search_history(namespace,at);
          create index if not exists opencrawl_search_history_session on opencrawl_search_history(namespace,tenant_id,user_id,harness,session_id);
          create table if not exists opencrawl_search_days(namespace text not null,tenant_id text not null,day date not null,
            agent bigint not null default 0,proactive bigint not null default 0,non_silent bigint not null default 0,delivered bigint not null default 0,
            primary key(namespace,tenant_id,day));`);
        await db.query('insert into opencrawl_activity_start(namespace,cursor_key) values($1,$2) on conflict do nothing',[namespace,randomBytes(32)]);
        cursorKey=(await db.query('select cursor_key from opencrawl_activity_start where namespace=$1',[namespace])).rows[0].cursor_key;
      });
    },
    async agentCall(p:Principal,entry?:SearchEntry){
      if(entry)await activity.search(p,entry);
      else await pool.query(dayUpsert,[namespace,scope(p)[0]]);
    },
    async search(p:Principal,entry:SearchEntry){
      const args=[namespace,...scope(p),entry.kind,randomUUID(),entry.operation,entry.queries.slice(0,3).map(q=>text(q,4000)),
        entry.harness??null,entry.sessionId??null,entry.eventKey??null,text(entry.messageId,200),text(entry.message,500),entry.returned??null,entry.failed??false,
        entry.harness&&entry.sessionId?checkEventKey(entry.harness,entry.sessionId,''):null];
      // The receipt and its daily totals commit together. Native-event replays increment neither.
      await pool.query(`with session_gate as (
        insert into opencrawl_activity_session_gates(namespace,tenant_id,user_id,session_hash)
        select $1,$2,$3,$15::text where $15 is not null
        on conflict(namespace,tenant_id,user_id,session_hash) do update set erased=opencrawl_activity_session_gates.erased
        returning erased), counted as (
        insert into opencrawl_call_days(namespace,tenant_id,day,calls)
        select $1,$2,(now() at time zone 'UTC')::date,1 where $4='agent'
        on conflict(namespace,tenant_id,day) do update set calls=opencrawl_call_days.calls+1), added as (
        insert into opencrawl_search_history(namespace,tenant_id,user_id,kind,id,operation,queries,harness,session_id,event_key,message_id,message,returned,failed)
        select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 where not exists(select 1 from session_gate where erased)
        on conflict(namespace,tenant_id,user_id,event_key) do nothing returning at,kind,returned)
        insert into opencrawl_search_days(namespace,tenant_id,day,agent,proactive,non_silent)
        select $1,$2,(at at time zone 'UTC')::date,(kind='agent')::int,(kind='proactive')::int,
          (kind='proactive' and coalesce(returned,0)>0)::int from added
        on conflict(namespace,tenant_id,day) do update set agent=opencrawl_search_days.agent+excluded.agent,
          proactive=opencrawl_search_days.proactive+excluded.proactive,non_silent=opencrawl_search_days.non_silent+excluded.non_silent`,args);
    },
    async trackingStart():Promise<string>{
      const result=await pool.query('select started_at from opencrawl_activity_start where namespace=$1',[namespace]);
      return result.rows[0].started_at.toISOString();
    },
    /** Old completed checks may only retain counts and the native-event digest.
     * Without a verified source session these receipts are readable only by the owner. */
    async importChecks(tenantId:string,checks:PriorCheck[]){
      if(!tenantId||checks.length>256)throw Error('Invalid receipt batch');
      if(!checks.length)return;
      await pool.query(`with added as (
        insert into opencrawl_search_history(namespace,tenant_id,user_id,kind,id,at,operation,queries,event_key,returned,failed)
        select $1,$2,c.owner,'proactive',c.id,c.at,'Context check',array[]::text[],c.key,c.returned,false
        from jsonb_to_recordset($3::jsonb) as c(owner text,id uuid,at timestamptz,key text,returned int)
        where c.at>=${windowStart} at time zone 'UTC' and c.owner<>'' and c.key~'^[a-f0-9]{64}$'
          and c.returned between 0 and 5
        on conflict do nothing returning at,returned)
        insert into opencrawl_search_days(namespace,tenant_id,day,proactive,non_silent)
        select $1,$2,(at at time zone 'UTC')::date,count(*),count(*) filter(where returned>0) from added group by 3
        on conflict(namespace,tenant_id,day) do update set proactive=opencrawl_search_days.proactive+excluded.proactive,
          non_silent=opencrawl_search_days.non_silent+excluded.non_silent`,[namespace,tenantId,JSON.stringify(checks)]);
    },
    async handoffs(p:Principal,keys:string[]){
      if(!keys.length)return;
      await pool.query(`with marked as (
        update opencrawl_search_history set delivered=true where namespace=$1 and tenant_id=$2 and user_id=$3
        and kind='proactive' and returned>0 and event_key=any($4::text[]) and not delivered returning (at at time zone 'UTC')::date as day)
        update opencrawl_search_days d set delivered=d.delivered+m.n from (select day,count(*) n from marked group by day) m
        where d.namespace=$1 and d.tenant_id=$2 and d.day=m.day`,[namespace,...scope(p),keys]);
    },
    async totals(p:Principal):Promise<CallTotals>{
      const {rows}=await pool.query(`select greatest(started_at,${windowStart} at time zone 'UTC') as since,
        (select coalesce(sum(calls),0) from opencrawl_call_days where namespace=$1 and tenant_id=$2 and day>=${windowStart}) as calls,
        s.* from opencrawl_activity_start cross join lateral (select coalesce(sum(agent),0) as agent,coalesce(sum(proactive),0) as proactive,
          coalesce(sum(non_silent),0) as non_silent,coalesce(sum(delivered),0) as delivered from opencrawl_search_days
          where namespace=$1 and tenant_id=$2 and day>=${windowStart}) s where namespace=$1`,[namespace,readScope(p)[0]]);
      const r=rows[0];
      return {since:r.since.toISOString(),calls:Number(r.calls),agentSearches:Number(r.agent),proactiveChecks:Number(r.proactive),nonSilent:Number(r.non_silent),delivered:Number(r.delivered)};
    },
    async page(p:Principal,input:HistoryRequest,visible: (p:Principal,rows:SearchActivityRow[])=>Promise<SearchActivityRow[]>):Promise<SearchActivityPage>{
      const {kind,before}=historyRequest.parse(input);
      const owner=readScope(p);
      const audience=JSON.stringify([namespace,...owner,kind]);
      const window=`namespace=$1 and tenant_id=$2 and kind=$4 and at>=${windowStart} at time zone 'UTC'
        ${before?'and (at,id)<($5::timestamptz,$6::uuid)':''}`;
      const end=`order by at desc,id desc limit ${pageSize+1}`;
      // Two disjoint index seeks. A workspace's unlinked searches cannot force a
      // scan through someone else's private history to reach the caller's next page.
      const {rows}=await pool.query<SearchActivityRow>(`select id,at,user_id as "userId",operation,queries,harness,session_id as "sessionId",
        message_id as "messageId",message,returned,case when failed then 'failed' else 'complete' end as outcome, delivered
        from ((select * from opencrawl_search_history where ${window} and session_id is not null and harness is not null ${end})
          union all (select * from opencrawl_search_history where ${window} and user_id=$3 and (session_id is null or harness is null) ${end})) candidates
        ${end}`,[namespace,...owner,kind,...before?position(before,audience):[]]);
      const page=rows.slice(0,pageSize).map(row=>({...row,at:new Date(row.at).toISOString()}));
      const last=page.at(-1);
      return {rows:await visible(p,page),next:rows.length>pageSize&&last?cursor(last,audience):null};
    },
    async forget(p:Principal,key:{harness:string;sessionId:string}){
      const owner=[namespace,...scope(p)];
      await database.transaction(async db=>{
        await db.query(`insert into opencrawl_activity_session_gates(namespace,tenant_id,user_id,session_hash,erased) values($1,$2,$3,$4,true)
          on conflict(namespace,tenant_id,user_id,session_hash) do update set erased=true`,[...owner,checkEventKey(key.harness,key.sessionId,'')]);
        await db.query('delete from opencrawl_search_history where namespace=$1 and tenant_id=$2 and user_id=$3 and harness=$4 and session_id=$5',[...owner,key.harness,key.sessionId]);
      });
    },
    async prune(){
      await pool.query(`delete from opencrawl_search_history where id in (select id from opencrawl_search_history where namespace=$1 and at<${windowStart} at time zone 'UTC' order by at limit 2000 for update skip locked)`,[namespace]);
    },
  };
  return activity;
}
export interface PriorCheck {owner:string;id:string;at:string;key:string;returned:number}
export type SearchActivity=ReturnType<typeof createSearchActivity>;

export function startActivityRetention(activity:SearchActivity){
  let pass:Promise<void>|undefined;
  const sweep=()=>{pass??=activity.prune().catch(()=>console.error(JSON.stringify({event:'usage.retention_failed'}))).finally(()=>{pass=undefined;});};
  const timer=setInterval(sweep,60_000);timer.unref();sweep();
  return async()=>{clearInterval(timer);await pass;};
}
