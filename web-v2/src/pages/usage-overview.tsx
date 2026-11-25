import {useState} from 'react';
import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import {Button, DailyBarChart, Icon, LoadingState, MetricGrid, Notice, Section} from '../design/components.tsx';
import type {ConsoleDataAdapter} from './types.ts';
import {scoped, type ActivityAdapter, type MemberNames} from './search-activity.tsx';
import {RecentQueries, type QueryRange} from './usage-queries.tsx';
import {count, plural} from './usage-model.ts';

const periods = ['7d', '30d', '90d', 'all'] as const;
export type OverviewPeriod = typeof periods[number];
const dayLength = 86_400_000;
const shortDate = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
const formatMtok = new Intl.NumberFormat('en-US', {maximumFractionDigits: 2});
const refresh = {staleMilliseconds: 60_000, autoRefreshMilliseconds: 60_000};

export function UsageOverview({adapter, activity, scope, names, period, setPeriod, onViewAll}: {adapter: ConsoleDataAdapter; activity?: ActivityAdapter; scope: string; names: MemberNames; period: OverviewPeriod; setPeriod: (period: OverviewPeriod) => void; onViewAll: (range: QueryRange) => void}) {
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
          {activity ? <RecentQueries adapter={activity} scope={scope} names={names} range={period === '7d' ? '7d' : '30d'} onViewAll={onViewAll}/> : <p className="report-note">Search activity unavailable.</p>}
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
