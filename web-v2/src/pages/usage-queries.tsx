import {useState} from 'react';
import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import {AgentAvatar} from '../design/agent-avatar.tsx';
import {Button, Icon, LoadingState, Notice, Table} from '../design/components.tsx';
import type {SearchActivityPage, SearchActivityRow} from '../../../src/application/search-activity.mjs';
import {scoped, SessionLink, type ActivityAdapter, type MemberNames} from './search-activity.tsx';
import {PagedList} from './usage-list.tsx';

export type QueryRange = '7d' | '30d';
type HistoryProps = {adapter: ActivityAdapter; scope: string; range: QueryRange; names: MemberNames};
const time = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit', second: '2-digit'});
const zone = new Intl.DateTimeFormat('en-US', {timeZoneName: 'shortGeneric'}).formatToParts().find(part => part.type === 'timeZoneName')?.value;

function observedHistory({adapter, scope, range}: HistoryProps) {
  const cacheKey = [...consoleResourceKey(adapter, 'observed-query-history'), scope, range];
  async function load(before: string | undefined, signal: AbortSignal): Promise<SearchActivityPage> {
    const rows: SearchActivityRow[] = [];
    let next = before;
    // A privacy-filtered page can be empty even while more visible queries follow.
    do {
      const page = scoped(scope, await adapter.searchHistory({kind: 'agent', range, basis: 'events', withQuery: true, before: next}, signal));
      rows.push(...page.rows.filter(row => !row.withheld && row.queries.some(query => query.trim())));
      if (!page.next || page.next === next || rows.length >= (before ? 1 : 5)) return {rows, next: page.next === next ? null : page.next};
      next = page.next;
    } while (!signal.aborted);
    throw new DOMException('Search history request cancelled', 'AbortError');
  }
  return {cacheKey, load};
}

function searcher(row: SearchActivityRow, names: MemberNames) {
  return [names.get(row.userId), row.agentName].filter(Boolean).join(' / ') || 'Unidentified searcher';
}

function RecentQueryRow({row, names}: {row: SearchActivityRow; names: MemberNames}) {
  const [expanded, setExpanded] = useState(false);
  const identity = searcher(row, names);
  const query = row.queries.join('\n').trim();
  const at = new Date(row.at);
  const fullTimestamp = at.toLocaleString();
  return <>
    <tr className="usage-query-row" onClick={() => setExpanded(open => !open)}>
      <td><span className="usage-agent" role="img" aria-label={identity}>
        <AgentAvatar name={row.agentName || row.at}/>
      </span></td>
      <td className="usage-query">{query.split('\n')[0]}</td>
      <td><time dateTime={row.at} title={fullTimestamp}>{expanded ? fullTimestamp : time.format(at)}</time></td>
      <td><Button variant="quiet" aria-expanded={expanded} aria-label={'Details for ' + query}><Icon name="chevron-down" size={14}/></Button></td>
    </tr>
    {expanded && <tr><td colSpan={4} className="usage-query-detail">
      <p>{query}</p>
      <div className="usage-query-byline">{identity}</div>
      {row.sessionId && row.harness && <SessionLink {...row} label="View session"/>}
    </td></tr>}
  </>;
}

export function RecentQueries(props: HistoryProps & {onViewAll: (range: QueryRange) => void}) {
  const {cacheKey, load} = observedHistory(props);
  const recent = useConsoleResource(cacheKey, signal => load(undefined, signal), {staleMilliseconds: 60_000, autoRefreshMilliseconds: 60_000});
  const entries = recent.data?.rows ?? [];
  return <>
    {recent.error && <Notice tone="warning" actions={<Button onClick={recent.reload}>Try again</Button>}>Recent searches couldn’t update.</Notice>}
    {recent.loading && <LoadingState spinner label="Loading recent searches…"/>}
    {entries.length > 0 && <>
      <Table label="Recent agent queries" className="usage-query-table">
        <thead><tr><th scope="col" aria-label="Agent"/><th scope="col">Query</th><th scope="col">Time{zone && ` (${zone})`}</th><th scope="col" aria-label="Details"/></tr></thead>
        <tbody>{entries.slice(0, 5).map(row => <RecentQueryRow key={row.id} row={row} names={props.names}/>)}</tbody>
      </Table>
      <Button className="usage-view-all" variant="quiet" aria-label="View all searches" onClick={() => props.onViewAll(props.range)}>View all <Icon name="arrow-right" size={14}/></Button>
    </>}
    {recent.data && !entries.length && <p className="report-note">No recent searches visible to you.</p>}
  </>;
}

export function SearchesTab(props: HistoryProps) {
  return <PagedList<SearchActivityRow, string> {...observedHistory(props)} className="usage-query-history" label="Search history" empty="No recent searches visible to you."
    head={<tr><th scope="col" aria-label="Agent avatar"/><th scope="col">Query</th><th scope="col">Searcher</th><th scope="col">Date &amp; time{zone && ` (${zone})`}</th><th scope="col">Session</th></tr>}
    row={row => <tr key={row.id}>
      <td><span className="usage-agent"><AgentAvatar name={row.agentName || row.at}/></span></td>
      <td className="usage-history-query">{row.queries.join('\n').trim()}</td>
      <td>{searcher(row, props.names)}</td>
      <td><time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time></td>
      <td><SessionLink {...row} label="View session"/></td>
    </tr>}/>;
}
