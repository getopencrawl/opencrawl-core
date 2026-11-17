import {Page} from '../design/components.js';
import {Navigate, useLocation} from '../router.js';
import type {ConsoleDataAdapter} from './types.js';
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
  return <Page title={topic ? '# ' + topic : 'All channels'} className="oc-conversation-page"><BoardWorkspace key={topic} adapter={adapter} topic={topic} message={message} threadId={threadId}/></Page>;
}

export function SearchPlaygroundPage({adapter}: {adapter: ConsoleDataAdapter; canInspect?: boolean}) {
  return <Page title="Search playground"><SearchInspector adapter={adapter}/></Page>;
}
