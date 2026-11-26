import {useEffect, useState} from 'react';
import {PageNavigation} from '../app.js';
import {Button, Dialog, Input, LoadingState, Notice} from '../design/components.js';
import {AgentAvatar} from '../design/agent-avatar.js';
import {agentIdentity} from '../design/identity.js';
import {Icon} from '../design/icons.js';
import {Link, useNavigate} from '../router.js';
import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import {useBoard} from './use-board.js';
import type {ConsoleDataAdapter} from './types.js';

type Adapter = Pick<ConsoleDataAdapter, 'board'>;
import {topicHref,useBoardLinks} from './board-navigation.ts';
export {topicHref};
export const searchHref = (topic:string, query:string) => topicHref(topic) + (query ? '&q=' + encodeURIComponent(query) : '');
const noCapture = () => {};

export function BoardRail({adapter, topic, query}:{adapter:Adapter; topic:string; query:string}) {
  const {channel:topicHref,search:searchHref}=useBoardLinks();
  const navigate = useNavigate();
  const [open,setOpen] = useState(false);
  const {report,busy,error,retry} = useBoard(adapter,'',true,noCapture);
  const topics = new Set(report?.channelSummaries?.map(item=>item.channel) ?? ['opencrawl',...(report?.topicSummaries.map(item=>item.topic)??[])]);
  if (topic) topics.add(topic);
  const term = query.trim().replace(/^#/,'').toLowerCase();
  const matches = (name:string) => Boolean(term) && name.toLowerCase().includes(term);
  const channels = [...topics].sort((a,b)=>Number(matches(b))-Number(matches(a)));
  const list = <PageNavigation className="oc-board-nav" label="Message board channels">
    <Link className={'oc-nav-link oc-board-all'+(!topic && !term?' oc-nav-active':'')} to={topicHref()} onClick={()=>setOpen(false)} aria-current={!topic && !term?'page':undefined}>
      <Icon name="diagnostics"/><span>All channels</span>
    </Link>
    <div className="oc-board-list-label">Channels</div>
    {channels.map(name=><Link key={name} to={topicHref(name)} onClick={()=>setOpen(false)} aria-current={name===topic && !term?'page':undefined}
      className={'oc-nav-link oc-board-channel-link'+(name===topic && !term?' oc-nav-active':'')+(matches(name)?' oc-board-match':'')}>
      <span aria-hidden="true">#</span><span>{name}</span>
    </Link>)}
    {!report && busy && <LoadingState label="Loading channels"/>}
    {error && <><Notice tone="warning">Channels couldn’t update.</Notice><Button disabled={busy} onClick={()=>void retry()}>Retry channels</Button></>}
  </PageNavigation>;
  function change(value:string) {void navigate(searchHref(topic,value),{replace:Boolean(query)});}
  return <div className="oc-board-rail">
    <div className="oc-board-tools">
      <Button className="oc-board-picker" variant="secondary" aria-label="Browse channels" aria-haspopup="dialog" onClick={()=>setOpen(true)}><Icon name="menu"/></Button>
      <div className="oc-search-input" role="search" aria-label="Message board"><Icon name="search"/>
        <Input type="search" value={query} maxLength={500} aria-label="Search channels and messages" placeholder="Search board"
          onChange={event=>change(event.target.value)} onKeyDown={event=>{if(event.key==='Escape' && query){event.preventDefault();event.stopPropagation();change('');}}}/>
      </div>
    </div>
    <div className="oc-board-rail-list">{list}</div>
    {open && <Dialog open title="Browse channels" className="oc-board-sheet" onClose={()=>setOpen(false)}>{list}</Dialog>}
  </div>;
}

function excerpt(text:string, terms:string[], limit:number) {
  const words=text.trim().split(/\s+/);
  if(words.length<=limit)return text;
  const hit=words.findIndex(word=>terms.some(term=>word.toLowerCase().includes(term)));
  const start=hit<limit?0:Math.min(words.length-limit,hit-Math.floor(limit/3));
  return (start?'… ':'')+words.slice(start,start+limit).join(' ')+(start+limit<words.length?'…':'');
}
export function BoardResults({adapter,topic,query,selected}:{adapter:Adapter;topic:string;query:string;selected?:number}) {
  const links=useBoardLinks();
  const [ready,setReady]=useState(false);
  useEffect(()=>{const timer=window.setTimeout(()=>setReady(true),200);return ()=>window.clearTimeout(timer);},[]);
  const [cursors,setCursors]=useState<string[]>([]);
  const cursor=cursors.at(-1);
  const {data,error,loading,reload}=useConsoleResource(consoleResourceKey(adapter,'board-search:'+JSON.stringify([query,cursor])),
    signal=>adapter.board(cursor?{query,cursor}:{query},signal),{enabled:ready});
  const terms=[...new Set(query.toLowerCase().split(/\s+/))];
  const pattern=new RegExp('('+terms.map(term=>term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).sort((a,b)=>b.length-a.length).join('|')+')','gi');
  const marked=(text:string)=>text.split(pattern).map((part,i)=>i%2?<mark key={i}>{part}</mark>:part);
  const total=data?.searchPage?.total;
  return <section className="oc-board-results" aria-label="Matching messages" aria-busy={!ready || loading}>
    {(!ready || loading) && <LoadingState label="Searching messages"/>}
    {error && <><Notice tone="warning">{error}</Notice><Button onClick={()=>cursor?setCursors([]):void reload()}>{cursor?'Restart search':'Try again'}</Button></>}
    {total!==undefined && <h2 aria-live="polite">{total ? total.toLocaleString()+(total===1?' message':' messages') : 'No matching messages'}</h2>}
    {data?.messages.map(post=>{
      const name=post.name||post.agent, root=post.threadId??post.id, at=new Date(post.timestamp);
      return <Link key={post.id} className="oc-board-result oc-board-message-group" aria-current={selected===post.id?'true':undefined}
        to={links.scope ? (root===post.id?links.thread(post.topic,root):links.post(post.topic,post.id,root))+'?'+new URLSearchParams({q:query}) : searchHref(topic,query)+'&thread='+root+(root===post.id?'':'&message='+post.id)}>
        <AgentAvatar name={name}/>
        <div><div className="oc-board-result-head"><div className="oc-board-byline"><strong className={agentIdentity(name).colorClass}>{marked(name)}</strong>
          <span className="oc-board-message-topic">#{post.topic}</span></div>
          <time dateTime={at.toISOString()} title={at.toLocaleString()}>{at.toLocaleDateString(undefined,{month:'short',day:'numeric'})}<span> at {at.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</span></time></div>
          <p className="oc-board-post-body"><span className="oc-board-excerpt-wide">{marked(excerpt(post.text,terms,46))}</span><span className="oc-board-excerpt-narrow">{marked(excerpt(post.text,terms,22))}</span></p>
        </div>
      </Link>;
    })}
    {data && (cursor || data.searchPage?.cursor) && <div className="action-row">
      {cursor && <Button onClick={()=>setCursors(cursors.slice(0,-1))}>Previous results</Button>}
      {data.searchPage?.cursor && <Button onClick={()=>setCursors([...cursors,data.searchPage!.cursor!])}>Next results</Button>}
    </div>}
  </section>;
}
