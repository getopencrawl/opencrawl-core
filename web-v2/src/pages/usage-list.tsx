import {useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {Button,EmptyState,LoadingState,Notice,Table} from '../design/components.js';

/**
 * A list that loads its first page when its key changes and later pages when its end
 * scrolls into view (or Load more is pressed). Rows stay in the order the server returns.
 */
export function PagedList<T,C>({resetKey,load,label,head,row,empty,className=''}:{
  resetKey:string; label:string; className?:string; empty:string;
  load:(cursor:C|undefined,signal:AbortSignal)=>Promise<{rows:T[];next:C|null}>;
  head:ReactNode; row:(item:T,index:number)=>ReactNode;
}){
  const [rows,setRows]=useState<T[]>([]);
  const [next,setNext]=useState<C|null|undefined>(undefined);
  const [state,setState]=useState<'loading'|'idle'|'error'>('loading');
  const reading=useRef<AbortController|null>(null);
  const end=useRef<HTMLDivElement>(null);
  const read=(cursor:C|undefined)=>{
    if(reading.current)return;
    const controller=new AbortController();
    reading.current=controller;
    setState('loading');
    load(cursor,controller.signal).then(page=>{
      if(controller.signal.aborted)return;
      setRows(previous=>cursor===undefined?page.rows:[...previous,...page.rows]);
      setNext(page.next);
      setState('idle');
    },()=>{if(!controller.signal.aborted)setState('error');}).finally(()=>{if(reading.current===controller)reading.current=null;});
  };
  useEffect(()=>{
    reading.current?.abort();reading.current=null;
    setRows([]);setNext(undefined);
    read(undefined);
    return ()=>{reading.current?.abort();reading.current=null;};
  },[resetKey]);
  useEffect(()=>{
    const element=end.current;
    if(!element||next==null||state!=='idle'||typeof IntersectionObserver==='undefined')return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))read(next);});
    observer.observe(element);
    return ()=>observer.disconnect();
  },[next,state,rows.length]);
  return <>
    {rows.length>0&&<Table label={label} className={className}><thead>{head}</thead><tbody>{rows.map(row)}</tbody></Table>}
    {state==='idle'&&!rows.length&&<EmptyState title={empty}/>}
    {state==='loading'&&<LoadingState spinner label={(rows.length?'Loading more ':'Loading ')+label.toLowerCase()+'…'}/>}
    {state==='error'&&<Notice tone="warning" actions={<Button onClick={()=>read(rows.length?next??undefined:undefined)}>Try again</Button>}>{label} couldn’t load.</Notice>}
    {state==='idle'&&next!=null&&<Button variant="quiet" onClick={()=>read(next)}>Load more</Button>}
    <div ref={end} aria-hidden="true"/>
  </>;
}
