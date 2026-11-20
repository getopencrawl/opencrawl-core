import {useState} from 'react';
import {AgentQueries, useCallTotals} from './search-activity.tsx';
import type {ActivityAdapter, MemberNames} from './search-activity.tsx';
import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import type {MetricItem} from '../design/components.js';
import {ActivityChart, BarList, Button, DailyBarChart, EmptyState, LoadingState, MetricGrid, Notice, Page, Section, Select, Table} from '../design/components.js';
import {Link} from '../router.js';
import {CopyPromptButton} from '../onboarding/copy.tsx';
import type {ConsoleDataAdapter, UsageReport, UsageHighlights, UsageDetails} from './types.js';
import {ago, compact, count, memberName, plural, sortedMembers} from './usage-model.ts';
import type {UsageSection} from '../../../src/application/reports.mjs';
import type {CallTotals} from '../../../src/application/search-activity.mjs';
import {reconcileUsage, usageSectionFailed} from './usage-recovery.ts';

const refreshPolicy = {autoRefreshMilliseconds: 60_000, staleMilliseconds: 60_000, reconcile: reconcileUsage};
type Range = 'month' | 'all';

export function useUsage(adapter: ConsoleDataAdapter) {
  const resource = useConsoleResource<UsageReport>(consoleResourceKey(adapter, 'usage'), signal => adapter.usage(signal), refreshPolicy);
  return {...resource, refresh: resource.reload};
}

function MeasurementStatus({report, section, label, now, retry}: {report: UsageReport; section: UsageSection; label: string; now: number; retry?: () => void}) {
  if (!usageSectionFailed(report, section)) return null;
  const previous = report.staleSections?.[section];
  return <Notice tone="warning" actions={retry && <Button onClick={retry}>Try again</Button>}>
    {label} couldn’t {previous ? 'update' : 'load'}.{previous && ` Showing data updated ${ago(previous, now)}.`} We’ll retry automatically.
  </Notice>;
}

/** UTC days from the first indexed session (or the report window) through the last reported day. */
function dateAxis(report: UsageReport, range: Range) {
  const window = report.agents?.daily.map(day => day.date) ?? [];
  const history = report.agents?.tokenHistory ?? [];
  if (range === 'month' || !history.length) return window;
  const first = history[0]!.date, last = window.at(-1) ?? history.at(-1)!.date;
  const days: string[] = [];
  for (let at = Date.parse(first + 'T00:00:00Z'); at <= Date.parse(last + 'T00:00:00Z'); at += 86_400_000) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

function sessionTokens(report: UsageReport, axis: string[], range: Range) {
  const agents = report.agents;
  if (!agents) return null;
  const byDate = new Map(range === 'all' ? (agents.tokenHistory ?? []).map(day => [day.date, day.tokens]) : agents.daily.map(day => [day.date, day.tokens ?? null]));
  const days = axis.map(date => ({date, value: byDate.get(date) ?? (range === 'all' ? 0 : null)}));
  const total = range === 'all' ? agents.indexedTokens ?? null : days.every(day => day.value != null) ? days.reduce((sum, day) => sum + (day.value ?? 0), 0) : null;
  return {days, total};
}

type OverviewProps = {report: UsageReport; now: number; retry?: () => void; range: Range; onRange: (range: Range) => void};
type Activity = {adapter: ActivityAdapter; scope: string};

function Overview(props: OverviewProps & {activity?: Activity}) {
  return props.activity ? <TrackedOverview {...props} activity={props.activity}/> : <OverviewBody {...props}/>;
}

function TrackedOverview(props: OverviewProps & {activity: Activity}) {
  const {data} = useCallTotals(props.activity.adapter, props.activity.scope);
  return <OverviewBody {...props} totals={data ?? undefined}/>;
}

function OverviewBody({report, now, retry, activity, totals, range, onRange}: OverviewProps & {activity?: Activity; totals?: CallTotals}) {
  const axis = dateAxis(report, range);
  const tokens = sessionTokens(report, axis, range);
  const sources = report.ingestion?.index?.sources ?? [];
  const sourceItems = report.ingestion?.index?.connectorDocuments;
  const names: MemberNames = new Map(report.members.flatMap(member => member.userId ? [[member.userId, memberName(member)] as const] : []));
  const cards: MetricItem[] = [
    ...tokens ? [{label: 'Session tokens indexed', value: compact(tokens.total), title: count(tokens.total)}] : [],
    ...report.ingestion ? [{label: 'Source items indexed', value: compact(sourceItems), title: count(sourceItems)}] : [],
    ...totals ? [{label: 'OpenCrawl context edits', value: compact(totals.nonSilent), title: count(totals.nonSilent)}] : [],
  ];
  return <Section className="report-section" title="Overview" actions={report.agents?.tokenHistory?.length ? <Select aria-label="Date range" value={range} onChange={event => onRange(event.target.value as Range)}>
    <option value="month">Last 30 days</option><option value="all">All time</option>
  </Select> : undefined}>
    <MeasurementStatus report={report} section="agents" label="Session activity" now={now} retry={retry}/>
    {cards.length > 0 && <MetricGrid items={cards}/>}
    {tokens && <Section className="report-panel" headingLevel={3} title="Indexed session tokens">
      <DailyBarChart days={tokens.days} label="Indexed session tokens per day" unit={value => `${count(value)} tokens`}/>
    </Section>}
    {activity && <AgentQueries adapter={activity.adapter} scope={activity.scope} names={names} axis={axis} totals={totals}/>}
    <DataSources report={report} now={now} retry={retry} sources={sources}/>
  </Section>;
}

function DataSources({report, now, retry, sources}: {report: UsageReport; now: number; retry?: () => void; sources: ReadonlyArray<{name: string; count: number}>}) {
  const data = report.ingestion;
  return <Section className="report-panel" headingLevel={3} title="Indexed items by source" actions={data?.sources.length ? <Link to="/integrations">Manage</Link> : undefined}>
    <MeasurementStatus report={report} section="ingestion" label="Connected sources" now={now} retry={retry}/>
    {!data ? (usageSectionFailed(report, 'ingestion') ? null : <EmptyState title="Source reporting isn’t available on this deployment."/>)
      : !data.sources.length ? <EmptyState title="No sources connected" actions={<Link to="/sources">Connect a source to start ingesting.</Link>}/>
      : report.failedSources?.includes('connectors') ? <p className="report-note">Indexed item counts unavailable.</p>
      : <BarList rows={[...sources].sort((left, right) => right.count - left.count)} label="Indexed items by source"/>}
  </Section>;
}

function TeamReport({report, now, retry}: {report: UsageReport; now: number; retry?: () => void}) {
  const members = report.members;
  const agents = report.agents;
  const unavailable = usageSectionFailed(report, 'members') && !report.staleSections?.members;
  return (
    <Section className="report-section" title="Team">
      <MeasurementStatus report={report} section="members" label="Team activity" now={now} retry={retry}/>
      {agents && agents.events > 0 && <Section className="report-panel" headingLevel={3} title="Agent sessions per day">
        <ActivityChart daily={agents.daily}/>
      </Section>}
      {agents?.events === 0 && <EmptyState title="No agent sessions captured yet." description="Once teammates install the OpenCrawl CLI, their agent sessions appear here."/>}
      {unavailable ? null : !members.length ? <EmptyState title="Team reporting isn’t available on this deployment."/> :
        <Table label="Team usage" className="report-member-table">
          <thead><tr><th scope="col">Member</th><th scope="col">Sessions</th><th scope="col">Messages</th><th scope="col">Tool calls</th><th scope="col">Last active</th></tr></thead>
          <tbody>{sortedMembers(members).map(member => (
            <tr key={member.email}>
              <th scope="row"><span className="report-member">{memberName(member)}{member.you && <em>you</em>}</span></th>
              <td>{count(member.sessions)}{member.subagentSessions ? <span className="report-email">+{plural(member.subagentSessions, 'subagent')}</span> : null}</td>
              <td>{count(member.messages)}</td><td>{count(member.toolCalls)}</td>
              <td>{member.lastAt ? ago(member.lastAt, now) : 'Not yet'}</td>
            </tr>
          ))}</tbody>
        </Table>}
    </Section>
  );
}

export function UsageReportView({data, now = Date.now(), retry, activity}: {data: UsageReport; now?: number; retry?: () => void; activity?: Activity}) {
  const [range, setRange] = useState<Range>('month');
  return <>
    <Overview report={data} now={now} retry={retry} activity={activity} range={range} onRange={setRange}/>
    <TeamReport report={data} now={now} retry={retry}/>
  </>;
}

function activityFor(adapter: ConsoleDataAdapter, scope?: string) {
  return scope && adapter.callTotals && adapter.searchHistory ? {adapter: adapter as ActivityAdapter, scope} : undefined;
}

type PageProps = {showActivity?:string; adapter: ConsoleDataAdapter; setupPrompt?: string; reportScope?: string};

export function UsagePage({adapter, setupPrompt, reportScope,showActivity}: PageProps) {
  if (reportScope && adapter.usageHighlights && adapter.usageDetails) {
    return <ProgressiveUsage showActivity={showActivity} reportScope={reportScope} adapter={adapter} highlights={adapter.usageHighlights} details={adapter.usageDetails} setupPrompt={setupPrompt}/>;
  }
  return <CompleteUsage showActivity={showActivity} adapter={adapter} setupPrompt={setupPrompt}/>;
}

function ProgressiveUsage({adapter, setupPrompt, highlights, details, reportScope,showActivity}: PageProps & {
  reportScope: string;
  highlights: (signal: AbortSignal) => Promise<UsageHighlights & {cacheScope: string}>;
  details: (signal: AbortSignal) => Promise<UsageDetails & {cacheScope: string}>;
}) {
  async function scoped<T extends {cacheScope: string}>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
    const result = await read(signal);
    if (result.cacheScope !== reportScope) throw Object.assign(new Error('Your workspace changed. Reload this page.'), {status: 403});
    return result;
  }
  const summary = useConsoleResource(consoleResourceKey(adapter, 'usage-highlights'), signal => scoped(highlights, signal), refreshPolicy);
  const activity = useConsoleResource(consoleResourceKey(adapter, 'usage-details'), signal => scoped(details, signal), refreshPolicy);
  const timestamp = activity.data ?? summary.data;
  const report: UsageReport | null = timestamp && {
    workspace: null, members: [], agents: null, overlap: null, ingestion: null,
    ...summary.data, ...activity.data, days: timestamp.days, generatedAt: timestamp.generatedAt,
    failedSources: [...summary.data?.failedSources ?? [], ...activity.data?.failedSources ?? []],
    staleSections: {...summary.data?.staleSections, ...activity.data?.staleSections},
  };
  const now = Date.now();
  return <Page title="Usage" bodyClassName="usage-report" actions={setupPrompt ? <CopyPromptButton text={setupPrompt}/> : undefined}>
    {summary.error && <Notice tone="warning" actions={<Button onClick={summary.reload}>Try again</Button>}>Usage highlights couldn’t update.</Notice>}
    {activity.error && <Notice tone="warning" actions={<Button onClick={activity.reload}>Try again</Button>}>Usage details couldn’t update.</Notice>}
    {(activity.loading || summary.loading && !activity.data) && <LoadingState label={report ? 'Loading usage details' : 'Loading usage'}/>}
    {activity.data && report && <UsageReportView data={report} now={now} retry={activity.reload} activity={activityFor(adapter, showActivity)}/>}
  </Page>;
}

function CompleteUsage({adapter, setupPrompt, showActivity}: PageProps) {
  const {data, error, loading, refresh} = useUsage(adapter);
  return (
    <Page title="Usage" bodyClassName="usage-report" actions={setupPrompt ? <CopyPromptButton text={setupPrompt}/> : undefined}>
      {error && <Notice tone={data ? 'warning' : 'danger'} actions={!data && <Button onClick={refresh} disabled={loading}>Try again</Button>}>{data ? 'Usage couldn’t update. We’ll try again automatically while you’re viewing this page.' : error}</Notice>}
      {loading && <LoadingState label="Loading usage"/>}
      {data && <UsageReportView data={data} now={Date.now()} retry={refresh} activity={activityFor(adapter, showActivity)}/>}
    </Page>
  );
}
