import {useMemo} from 'react';
import {EmptyState, LoadingState, Page} from '../design/components.js';
import {Link, Navigate, useLocation} from '../router.js';
import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {boardPage,boardPath,type BoardLink} from '../../../src/application/board-links.mjs';
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
  if(link) return <BoardWorkspaceKey.Provider value={workspace}><LinkedBoard key={location.pathname} adapter={scoped} link={link} path={location.pathname} search={query.get('q')??''}/></BoardWorkspaceKey.Provider>;
  if (query.get('view') === 'search') return <Navigate to="/search" replace/>;
  const topic = query.get('view') === 'stream' ? '' : (query.get('channel')??query.get('topic'))?.trim() || '';
  const id = query.get('message') || '', parsed = /^\d+$/.test(id) ? Number(id) : NaN;
  const message = Number.isSafeInteger(parsed) && parsed > 0 && parsed < Number.MAX_SAFE_INTEGER ? parsed : undefined;
  const thread=Number(query.get('thread')),threadId=Number.isSafeInteger(thread)&&thread>0?thread:undefined;
  const search=query.get('q') ?? '';
  if(workspace && (message || threadId || topic)) {
    const path=message?boardPath(workspace,'posts',message):threadId?boardPath(workspace,'threads',threadId):boardPath(workspace,'channels',topic);
    return <Navigate replace to={{pathname:path,search:search?new URLSearchParams({q:search}).toString():'',hash:location.hash}}/>;
  }
  return <BoardWorkspaceKey.Provider value={workspace}><BoardView adapter={scoped} topic={topic} search={search} message={message} threadId={threadId}/></BoardWorkspaceKey.Provider>;
}

function MissingBoardTarget() {
  return <Page title="Message board"><EmptyState title="Board destination unavailable" description="This link could not be opened in this workspace." action={<Link to="/messages">Open message board</Link>}/></Page>;
}

function LinkedBoard({adapter,link,path,search}:{adapter:ConsoleDataAdapter;link:BoardLink;path:string;search:string}) {
  const location=useLocation();
  const {data,error}=useConsoleResource([...consoleResourceKey(adapter,'board-destination'),path],signal=>adapter.boardDestination!(path,signal));
  if(error) return <MissingBoardTarget/>;
  if(!data) return <Page title="Message board"><LoadingState label="Loading board destination"/></Page>;
  if(data.kind==='agents') {
    const canonical=boardPath(link.workspace,'agents',data.id);
    if(path!==canonical) return <Navigate replace to={{pathname:canonical,search:location.search,hash:location.hash}}/>;
    return <Page title={data.name} description={data.task}><p>{data.harness}</p><Link to="/messages">Open message board</Link></Page>;
  }
  const threadId=data.kind==='threads'||(data.kind==='posts' && (data.root!==data.id || search)) ? data.root : undefined;
  return <BoardView adapter={adapter} topic={data.channel} search={search} message={data.kind==='posts'?data.id:undefined} threadId={threadId}/>;
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
