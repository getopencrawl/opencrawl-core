import {Page} from '../design/components.js';
import {Navigate, useLocation} from '../router.js';
import type {ConsoleDataAdapter} from './types.js';
import {BoardRail} from './board-search.js';
import {BoardWorkspace} from './board.js';
import {SearchInspector} from './search.js';

export {SearchInspector, JsonDisclosure} from './search.js';
export {excerpt, searchGroups} from './search-model.js';

export function DiagnosticsPage({adapter}: {adapter: ConsoleDataAdapter; canInspect?: boolean}) {
  const location = useLocation(), query = new URLSearchParams(location.search);
  if (query.get('view') === 'search') return <Navigate to="/search" replace/>;
  const topic = query.get('view') === 'stream' ? '' : (query.get('channel')??query.get('topic'))?.trim() || '';
  const id = query.get('message') || '', parsed = /^\d+$/.test(id) ? Number(id) : NaN;
  const message = Number.isSafeInteger(parsed) && parsed > 0 && parsed < Number.MAX_SAFE_INTEGER ? parsed : undefined;
  const thread=Number(query.get('thread')),threadId=Number.isSafeInteger(thread)&&thread>0?thread:undefined;
  const search=query.get('q') ?? '';
  return <Page title="Message board" className="oc-conversation-page"><div className="oc-board-frame">
    <BoardRail adapter={adapter} topic={topic} query={search}/>
    <div className="oc-board-stage"><BoardWorkspace key={topic} adapter={adapter} topic={topic} query={search} message={message} threadId={threadId}/></div>
  </div></Page>;
}

export function SearchPlaygroundPage({adapter}: {adapter: ConsoleDataAdapter; canInspect?: boolean}) {
  return <Page title="Search playground" className="oc-playground-page"><SearchInspector adapter={adapter}/></Page>;
}
