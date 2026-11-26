import {useEffect,useMemo,useState} from 'react';
import {EmptyState, LoadingState, Page} from '../design/components.js';
import {Link, Navigate, useLocation} from '../router.js';
import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {boardPage,boardPath,type BoardDestination,type BoardLink} from '../../../src/application/board-links.mjs';
import {BoardWorkspaceKey} from './board-navigation.ts';
import type {ConsoleDataAdapter} from './types.js';
import {BoardRail} from './board-search.js';
import {BoardWorkspace} from './board.js';
import {SearchInspector} from './search.js';

export {SearchInspector, JsonDisclosure} from './search.js';
export {excerpt, searchGroups} from './search-model.js';

export function DiagnosticsPage({adapter,workspace}: {adapter: ConsoleDataAdapter; workspace?:string; canInspect?: boolean}) {
  const location = useLocation(), query = new URLSearchParams(location.search);
  const link=boardPage(location.pathname);
  const scoped=useMemo(()=>workspace?{...adapter,board:(input:Parameters<ConsoleDataAdapter['board']>[0],signal:AbortSignal)=>adapter.board({...input,workspaceKey:workspace},signal)}:adapter,[adapter,workspace]);
  if(link && (link.workspace!==workspace || !adapter.boardDestination)) return <MissingBoardTarget/>;
  if (!link && query.get('view') === 'search') return <Navigate to="/search" replace/>;
  const topic = query.get('view') === 'stream' ? '' : (query.get('channel')??query.get('topic'))?.trim() || '';
  const id = query.get('message') || '', parsed = /^\d+$/.test(id) ? Number(id) : NaN;
  const message = Number.isSafeInteger(parsed) && parsed > 0 && parsed < Number.MAX_SAFE_INTEGER ? parsed : undefined;
  const thread=Number(query.get('thread')),threadId=Number.isSafeInteger(thread)&&thread>0?thread:undefined;
  const search=query.get('q') ?? '';
  if(!link && workspace && (message || threadId || topic)) {
    const path=message?boardPath(workspace,'posts',message):threadId?boardPath(workspace,'threads',threadId):boardPath(workspace,'channels',topic);
    return <Navigate replace to={{pathname:path,search:search?new URLSearchParams({q:search}).toString():'',hash:location.hash}}/>;
  }
  if(workspace) return <BoardWorkspaceKey.Provider value={workspace}><LinkedBoard key={workspace} adapter={scoped} link={link} path={location.pathname} search={search}/></BoardWorkspaceKey.Provider>;
  return <BoardWorkspaceKey.Provider value={workspace}><BoardView adapter={scoped} topic={topic} search={search} message={message} threadId={threadId}/></BoardWorkspaceKey.Provider>;
}

function MissingBoardTarget() {
  return <Page title="Message board"><EmptyState title="Board destination unavailable" description="This link could not be opened in this workspace." action={<Link to="/messages">Open message board</Link>}/></Page>;
}

function LinkedBoard({adapter,link,path,search}:{adapter:ConsoleDataAdapter;link:BoardLink|null;path:string;search:string}) {
  const location=useLocation();
  const {data,error}=useConsoleResource([...consoleResourceKey(adapter,'board-destination'),path],
    signal=>adapter.boardDestination!(path,signal),{enabled:Boolean(link && adapter.boardDestination)});
  const [previous,setPrevious]=useState<{adapter:ConsoleDataAdapter;destination:BoardDestination}|null>(null);
  useEffect(()=>{
    if(error) setPrevious(null);
    else if(!link) setPrevious({adapter,destination:{kind:'channels',channel:''}});
    else if(data) setPrevious({adapter,destination:data});
  },[adapter,data,error,path,Boolean(link)]);
  if(!link)return <BoardView adapter={adapter} topic="" search={search}/>;
  if(error) return <MissingBoardTarget/>;
  const resolved=data ?? (previous?.adapter===adapter ? previous.destination : null);
  if(!resolved) return <Page title="Message board"><LoadingState label="Loading board destination"/></Page>;
  if(data && resolved.kind==='channels' && path!==boardPath(link.workspace,'channels',resolved.channel))
    return <Navigate replace to={{pathname:boardPath(link.workspace,'channels',resolved.channel),search:location.search,hash:location.hash}}/>;
  const threadId=resolved.kind==='threads'||(resolved.kind==='posts' && (resolved.root!==resolved.id || search)) ? resolved.root : undefined;
  const from=new URLSearchParams(location.search).get('from') ?? location.state?.boardChannel;
  const topic=threadId!==undefined && typeof from==='string' && from.length<=80 ? from : resolved.channel;
  return <BoardView adapter={adapter} topic={topic} search={search} message={resolved.kind==='posts'?resolved.id:undefined} threadId={threadId}/>;
}

function BoardView({adapter,topic,search,message,threadId}:{adapter:ConsoleDataAdapter;topic:string;search:string;message?:number;threadId?:number}) {
  return <Page title="Message board" className="oc-conversation-page"><div className="oc-board-frame">
    <BoardRail adapter={adapter} topic={topic} query={search}/>
    <div className="oc-board-stage"><BoardWorkspace key={topic} adapter={adapter} topic={topic} query={search} message={message} threadId={threadId}/></div>
  </div></Page>;
}

export function SearchPlaygroundPage({adapter}: {adapter: ConsoleDataAdapter; canInspect?: boolean}) {
  return <Page title="Search playground" className="oc-playground-page"><SearchInspector adapter={adapter}/></Page>;
}
