import {Notice, Page, Tabs} from '../design/components.js';
import {useLocation, useNavigate} from '../router.js';
import type {ConsoleDataAdapter} from './types.js';
import {BoardInspector} from './board.js';
import {SearchInspector} from './search.js';

export {SearchInspector, JsonDisclosure} from './search.js';
export {excerpt, searchGroups} from './search-model.js';

export function DiagnosticsPage({adapter, canInspect}: {adapter: ConsoleDataAdapter; canInspect: boolean}) {
  const location = useLocation(), navigate = useNavigate(), query = new URLSearchParams(location.search);
  const view = ['search','board','stream'].includes(query.get('view') || '') ? query.get('view')! : 'search';
  const topic = view === 'stream' ? '' : query.get('topic')?.trim() || '';
  const id = query.get('message') || '', parsed = /^\d+$/.test(id) ? Number(id) : NaN;
  const message = Number.isSafeInteger(parsed) && parsed > 0 && parsed < Number.MAX_SAFE_INTEGER ? parsed : undefined;
  return <Page title="Diagnostics" description="See what your agents can retrieve and how they coordinate work.">{!canInspect ? <Notice>Workspace admins can inspect raw search results and agent messages. Ask an admin for access.</Notice> : <><Tabs label="Diagnostics views" value={view} onChange={value => navigate('/diagnostics?view=' + value)} items={[{value:'search',label:'Search inspector'},{value:'board',label:'Topics'},{value:'stream',label:'Global stream'}]}/>{view === 'search' ? <SearchInspector adapter={adapter}/> : <BoardInspector key={JSON.stringify([view, topic, message])} adapter={adapter} stream={view === 'stream'} topic={topic} message={message}/>}</>}</Page>;
}
