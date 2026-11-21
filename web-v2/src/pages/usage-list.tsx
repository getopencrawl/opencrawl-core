import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {useConsoleResource} from '../data.tsx';
import {Button,EmptyState,LoadingState,Notice,Table} from '../design/components.js';

/**
 * A list whose first page is a scoped, cached read (so returning to it never flashes a
 * spinner) and whose later pages load when its end scrolls into view or Load more is
 * pressed. Rows stay in the order the server returns.
 */
export function PagedList<T,C>({cacheKey,load,label,head,row,empty,className=''}:{
  cacheKey:readonly unknown[]; label:string; className?:string; empty:string;
  load:(cursor:C|undefined,signal:AbortSignal)=>Promise<{rows:T[];next:C|null}>;
  head:ReactNode; row:(item:T,index:number)=>ReactNode;
}){
  const first=useConsoleResource(cacheKey,signal=>load(undefined,signal),{staleMilliseconds:60_000});
  const key=JSON.stringify(cacheKey);
  const [more,setMore]=useState<{key:string;rows:T[];next:C|null}|null>(null);
  const [state,setState]=useState<'idle'|'loading'|'error'>('idle');
  const reading=useRef<AbortController|null>(null);
  const end=useRef<HTMLDivElement>(null);
  // Later pages belong to one first page; a new range, tab or refreshed first page starts over.
  const extra=more&&more.key===key?more:null;
  const rows=[...first.data?.rows??[],...extra?.rows??[]];
  const next=extra?extra.next:first.data?.next??null;
  useEffect(()=>{reading.current?.abort();reading.current=null;setMore(null);setState('idle');},[key,first.data]);
  useEffect(()=>()=>reading.current?.abort(),[]);
  const read=(cursor:C)=>{
    if(reading.current)return;
    const controller=new AbortController();
    reading.current=controller;
    setState('loading');
    load(cursor,controller.signal).then(page=>{
      if(controller.signal.aborted)return;
      setMore(previous=>({key,rows:[...previous&&previous.key===key?previous.rows:[],...page.rows],next:page.next}));
      setState('idle');
    },()=>{if(!controller.signal.aborted)setState('error');}).finally(()=>{if(reading.current===controller)reading.current=null;});
  };
  useEffect(()=>{
    const element=end.current;
    if(!element||next==null||state!=='idle'||typeof IntersectionObserver==='undefined')return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))read(next);});
    observer.observe(element);
    return ()=>observer.disconnect();
  },[next,state,rows.length]);
  return <>
    {rows.length>0&&<Table label={label} className={className}><thead>{head}</thead><tbody>{rows.map(row)}</tbody></Table>}
    {first.data&&!rows.length&&<EmptyState title={empty}/>}
    {first.loading&&<LoadingState spinner label={'Loading '+label.toLowerCase()+'…'}/>}
    {state==='loading'&&<LoadingState spinner label={'Loading more '+label.toLowerCase()+'…'}/>}
    {first.error&&!first.data&&<Notice tone="warning" actions={<Button onClick={first.reload}>Try again</Button>}>{label} couldn’t load.</Notice>}
    {state==='error'&&next!=null&&<Notice tone="warning" actions={<Button onClick={()=>read(next)}>Try again</Button>}>{label} couldn’t load.</Notice>}
    {state==='idle'&&next!=null&&<Button variant="quiet" onClick={()=>read(next)}>Load more</Button>}
    <div ref={end} aria-hidden="true"/>
  </>;
}
