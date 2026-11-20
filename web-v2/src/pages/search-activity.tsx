import {useEffect,useRef,useState} from 'react';
import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {Button,DailyBarChart,Dialog,EmptyState,LoadingState,Notice,Section,Table} from '../design/components.js';
import type {ConsoleDataAdapter} from './types.js';
import type {CallTotals,HistoryRequest,SearchActivityRow} from '../../../src/application/search-activity.mjs';
import {harnessName,plural} from './usage-model.ts';

const refresh={autoRefreshMilliseconds:60_000,staleMilliseconds:60_000};
const dateFormat=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
export type ActivityAdapter=Required<Pick<ConsoleDataAdapter,'callTotals'|'searchHistory'>>;
/** Signed-in names by WorkOS user ID; queries from people outside the list show their agent only. */
export type MemberNames=ReadonlyMap<string,string>;
const shown=5;

function scoped<T extends {cacheScope:string}>(scope:string,result:T){
  if(scope!==result.cacheScope)throw Object.assign(new Error('Your workspace changed. Reload this page.'),{status:403});
  return result;
}

export function useCallTotals(adapter:ActivityAdapter,scope:string){
  return useConsoleResource(consoleResourceKey(adapter,'call-totals'),async signal=>scoped(scope,await adapter.callTotals(signal)),refresh);
}

function QueryRows({rows,names}:{rows:SearchActivityRow[];names:MemberNames}){
  return <Table label="Agent queries" className="usage-search-history"><thead><tr><th scope="col">Query</th><th scope="col">From</th><th scope="col">Time</th></tr></thead>
    <tbody>{rows.map(row=><tr key={row.id}>
      <td>{row.queries.length?row.queries.join('\n'):<span className="report-email">No query text</span>}</td>
      <td>{names.get(row.userId)??'Workspace member'}{row.harness&&<span className="report-email">{harnessName(row.harness)}</span>}</td>
      <td><time dateTime={row.at} title={row.at}>{dateFormat.format(new Date(row.at))}</time></td>
    </tr>)}</tbody></Table>;
}

/** Every visible agent query, newest first; older pages load as the end of the list scrolls into view. */
function QueryHistory({adapter,scope,names,open,onClose}:{adapter:ActivityAdapter;scope:string;names:MemberNames;open:boolean;onClose:()=>void}){
  const [rows,setRows]=useState<SearchActivityRow[]>([]);
  const [next,setNext]=useState<HistoryRequest['before']|null|undefined>(undefined);
  const [state,setState]=useState<'idle'|'loading'|'error'>('idle');
  const end=useRef<HTMLDivElement>(null);
  const reading=useRef<AbortController|null>(null);
  useEffect(()=>{if(!open){reading.current?.abort();setRows([]);setNext(undefined);setState('idle');}},[open]);
  function load(before?:HistoryRequest['before']){
    if(reading.current)return;
    const controller=new AbortController();
    reading.current=controller;
    setState('loading');
    adapter.searchHistory({kind:'agent',...before?{before}:{}},controller.signal).then(page=>{
      const result=scoped(scope,page);
      setRows(previous=>[...previous,...result.rows]);
      setNext(result.next);
      setState('idle');
    },()=>{if(!controller.signal.aborted)setState('error');}).finally(()=>{if(reading.current===controller)reading.current=null;});
  }
  useEffect(()=>{if(open&&next===undefined)load();},[open,next]);
  useEffect(()=>{
    const element=end.current;
    if(!open||!element||!next)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))load(next);});
    observer.observe(element);
    return ()=>observer.disconnect();
  },[open,next,rows.length]);
  useEffect(()=>()=>reading.current?.abort(),[]);
  return <Dialog open={open} onClose={onClose} title="Agent queries" className="usage-query-dialog">
    {rows.length>0&&<QueryRows rows={rows} names={names}/>}
    {state==='loading'&&<LoadingState label="Loading agent queries"/>}
    {state==='error'&&<Notice tone="warning" actions={<Button onClick={()=>load(next??undefined)}>Try again</Button>}>Queries couldn’t load.</Notice>}
    {next===null&&!rows.length&&<EmptyState title="No visible agent queries."/>}
    <div ref={end} aria-hidden="true"/>
  </Dialog>;
}

/** Agent search tool calls by day on the page's shared date axis, above the newest queries. */
export function AgentQueries({adapter,scope,names,axis,totals}:{adapter:ActivityAdapter;scope:string;names:MemberNames;axis:string[];totals:CallTotals|undefined}){
  const [open,setOpen]=useState(false);
  const {data,error,loading,reload}=useConsoleResource([...consoleResourceKey(adapter,'search-history'),'agent'],
    async signal=>scoped(scope,await adapter.searchHistory({kind:'agent'},signal)),{...refresh,staleMilliseconds:0});
  const tracked=totals&&new Map((totals.daily??[]).map(day=>[day.date,day.agentSearches]));
  const since=totals?.since.slice(0,10);
  const days=axis.map(date=>({date,value:tracked&&since&&date>=since?tracked.get(date)??0:null}));
  const more=Boolean(data&&(data.rows.length>shown||data.next));
  return <Section className="report-panel" headingLevel={3} title="Agent queries" actions={more&&<Button variant="quiet" onClick={()=>setOpen(true)}>View all</Button>}>
    {tracked&&<DailyBarChart days={days} label="Agent search tool calls per day" unit={value=>plural(value,'query','queries')}/>}
    {error&&<Notice tone="warning" actions={<Button onClick={reload}>Try again</Button>}>Queries couldn’t update.</Notice>}
    {loading&&<LoadingState label="Loading agent queries"/>}
    {data&&!error&&(data.rows.length?<QueryRows rows={data.rows.slice(0,shown)} names={names}/>:<EmptyState title="No agent queries in the last 30 days."/>)}
    <QueryHistory adapter={adapter} scope={scope} names={names} open={open} onClose={()=>setOpen(false)}/>
  </Section>;
}
