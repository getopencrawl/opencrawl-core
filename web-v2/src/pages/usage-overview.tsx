import {useState} from 'react';
import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import {Button, DailyBarChart, Dialog, Icon, LoadingState, MetricGrid, Notice, Section, Table} from '../design/components.tsx';
import {AgentAvatar} from '../design/agent-avatar.tsx';
import type {ConsoleDataAdapter} from './types.ts';
import type {SearchActivityPage, SearchActivityRow} from '../../../src/application/search-activity.mjs';
import {scoped, SessionLink, type ActivityAdapter, type MemberNames} from './search-activity.tsx';
import {PagedList} from './usage-list.tsx';
import {count, plural} from './usage-model.ts';

const periods = ['7d', '30d', '90d', 'all'] as const;
type Period = typeof periods[number];
const dayLength = 86_400_000;
const shortDate = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
const time = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit', second: '2-digit'});
const zone = new Intl.DateTimeFormat('en-US', {timeZoneName: 'shortGeneric'}).formatToParts().find(part=>part.type==='timeZoneName')?.value;
const formatMtok = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});
const refresh = {staleMilliseconds: 60_000, autoRefreshMilliseconds: 60_000};

function QueryRow({row, names, showDate = false}: {row: SearchActivityRow; names: MemberNames; showDate?: boolean}) {
  const [expanded, setExpanded] = useState(false);
  const human = names.get(row.userId);
  const identity = [human, row.agentName].filter(Boolean).join(' / ') || 'Unidentified searcher';
  const query = row.queries.join('\n').trim();
  const at = new Date(row.at);
  const fullTimestamp = at.toLocaleString();
  return <>
    <tr className="usage-query-row" onClick={() => setExpanded(open => !open)}>
      <td><span className="usage-agent" role="img" aria-label={identity}>
        <AgentAvatar name={row.agentName || row.at}/>
      </span></td>
      <td className="usage-query">{query.split('\n')[0]}</td>
      <td><time dateTime={row.at} title={fullTimestamp}>{expanded || showDate ? fullTimestamp : time.format(at)}</time></td>
      <td><Button variant="quiet" aria-expanded={expanded} aria-label={'Details for ' + query}><Icon name="chevron-down" size={14}/></Button></td>
    </tr>
    {expanded && <tr><td colSpan={4} className="usage-query-detail">
      <p>{query}</p>
      <div className="usage-query-byline">{identity}</div>
      {row.sessionId && row.harness && <SessionLink {...row} label="View session"/>}
    </td></tr>}
  </>;
}

const columns = (label: string) => <tr><th scope="col" aria-label="Agent"/><th scope="col">Query</th><th scope="col">{label}{zone && ` (${zone})`}</th><th scope="col" aria-label="Details"/></tr>;

function RecentQueries({adapter, scope, period, names}: {adapter: ActivityAdapter; scope: string; period: Period; names: MemberNames}) {
  const [open, setOpen] = useState(false);
  const range = period === '7d' ? '7d' : '30d'; // Query text is retained for 30 days.
  const key = [...consoleResourceKey(adapter, 'observed-query-history'), scope, range];
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
  const recent = useConsoleResource(key, signal => load(undefined, signal), refresh);
  const entries = recent.data?.rows ?? [];
  return <>
    {recent.error && <Notice tone="warning" actions={<Button onClick={recent.reload}>Try again</Button>}>Recent searches couldn’t update.</Notice>}
    {recent.loading && <LoadingState spinner label="Loading recent searches…"/>}
    {entries.length > 0 && <Table label="Recent agent queries" className="usage-query-table"><thead>{columns('Time')}</thead><tbody>{entries.slice(0,5).map(row => <QueryRow key={row.id} row={row} names={names}/>)}</tbody></Table>}
    {recent.data && !entries.length && <p className="report-note">No recent searches visible to you.</p>}
    {(entries.length > 5 || recent.data?.next) && <Button className="usage-view-all" variant="quiet" aria-label="View all searches" onClick={() => setOpen(true)}>View all{!recent.data?.next && ' '+count(entries.length)} <Icon name="arrow-right" size={14}/></Button>}
    {open && <Dialog open onClose={() => setOpen(false)} title="Recent agent queries" className="usage-history-dialog">
      <PagedList<SearchActivityRow,string> cacheKey={key} load={load} head={columns('Date & time')} className="usage-query-table" label="Agent queries" empty="No recent searches visible to you."
        row={row => <QueryRow key={row.id} row={row} names={names} showDate/>}/>
    </Dialog>}
  </>;
}

export function UsageOverview({adapter, activity, scope, names}: {adapter: ConsoleDataAdapter; activity?: ActivityAdapter; scope: string; names: MemberNames}) {
  const [period, setPeriod] = useState<Period>('30d');
  const [cumulative, setCumulative] = useState(false);
  // The historic inventory is grouped once. All four ranges share this authorized read.
  const indexed = useConsoleResource([...consoleResourceKey(adapter, 'session-start-tokens'),scope], async signal => {
    const data = scoped(scope, await adapter.usageTokens!('all', signal, 'session-start'));
    if (data.source !== 'index') throw new Error('Indexed session tokens unavailable.');
    return data;
  }, {staleMilliseconds: 300_000, autoRefreshMilliseconds: 300_000});
  const calls = useConsoleResource([...consoleResourceKey(adapter, 'observed-calls'),scope], async signal => {
    const data = scoped(scope, await activity!.callTotals('all', signal, 'events'));
    if (data.charged || !data.daily) throw new Error('Observed searches unavailable.');
    return data;
  }, {...refresh, enabled: Boolean(activity)});
  const today = new Date().toISOString().slice(0,10);
  const first = period === 'all' ? [indexed.data?.daily[0]?.date, calls.data?.daily?.[0]?.date, today].filter((value): value is string => Boolean(value)).sort()[0]!
    : new Date(Date.parse(today) - (parseInt(period,10) - 1) * dayLength).toISOString().slice(0,10);
  const tokens = new Map(indexed.data?.daily.map(day => [day.date,day.count]));
  const events = new Map(calls.data?.daily?.map(day => [day.date,day]));
  const searches = [], tokenDays = [];
  let searchCount = 0, edits = 0, tokenCount = 0;
  for (let ms = Date.parse(first); ms <= Date.parse(today); ms += dayLength) {
    const date = new Date(ms).toISOString().slice(0,10), day = events.get(date), value = tokens.get(date) ?? 0;
    const search = day?.agentSearches ?? null;
    tokenCount += value;
    searchCount += search ?? 0;
    edits += day?.nonSilent ?? 0;
    searches.push({date, value: search});
    tokenDays.push({date, value: cumulative ? tokenCount : value});
  }
  const known = calls.data && searches.some(day => day.value !== null);
  function reading(available: boolean, loading: boolean, value: string) {
    return available ? value : loading ? '…' : 'Unavailable';
  }
  return <div className="usage-overview">
    <MetricGrid items={[
      {label:'Agent searches', value:reading(Boolean(known),calls.loading,count(searchCount)), note:'Keyword searches run by your agents.'},
      {label:'OpenCrawl context edits', value:reading(Boolean(known),calls.loading,count(edits)), note:'Automatic searches with a match.'},
      {label:'Session tokens indexed', value:<>{reading(Boolean(indexed.data),indexed.loading,tokenCount > 0 && tokenCount < 5000 ? '<0.01' : formatMtok.format(tokenCount/1e6))}{indexed.data && <small> Mtok</small>}</>, title:indexed.data ? count(tokenCount)+' tokens' : undefined, note:'Searchable agent session text.'},
    ]}/>
    <Section className="report-panel usage-charts" aria-label="Usage charts">
      <div className="usage-period"><span><Icon name="clock" size={15}/>{shortDate.formatRange(new Date(first), new Date(today))} <small>UTC</small></span>
        <div className="usage-segments" role="group" aria-label="Chart date range">{periods.map(p => <Button variant="plain" key={p} aria-label={p==='all'?'All time':parseInt(p,10)+' days'} aria-pressed={p===period} onClick={()=>setPeriod(p)}>{p==='all'?'All':p.toUpperCase()}</Button>)}</div>
      </div>
      <div className="usage-panes">
        <Section className="usage-pane" title="Recent searches">
          {calls.error && <Notice tone="warning" actions={<Button onClick={calls.reload}>Try again</Button>}>Search activity couldn’t update.</Notice>}
          {calls.data && <DailyBarChart days={searches} label="Agent searches per day" unit={n=>plural(n,'search','searches')} height={118} shortDates/>}
          {activity ? <RecentQueries adapter={activity} scope={scope} names={names} period={period}/> : <p className="report-note">Search activity unavailable.</p>}
        </Section>
        <Section className="usage-pane usage-token-pane" title="Indexed session tokens" actions={<div className="usage-segments" role="group" aria-label="Token chart display">
          {[false,true].map(mode=><Button variant="plain" key={String(mode)} aria-pressed={cumulative===mode} onClick={()=>setCumulative(mode)}>{mode?'Cumulative':'Daily'}</Button>)}</div>}>
          {indexed.error && <Notice tone="warning" actions={<Button onClick={indexed.reload}>Try again</Button>}>Indexed session tokens couldn’t update.</Notice>}
          {indexed.loading && <LoadingState spinner label="Loading indexed session tokens…"/>}
          {indexed.data && <DailyBarChart days={tokenDays} label={cumulative?'Cumulative indexed session tokens':'Session tokens indexed per day'} unit={n=>count(n)+' tokens'} line={cumulative} shortDates/>}
        </Section>
      </div>
    </Section>
  </div>;
}
