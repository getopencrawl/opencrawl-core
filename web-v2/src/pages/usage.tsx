import {SearchActivity} from './search-activity.tsx';
import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import type {MetricItem} from '../design/components.js';
import {ActivityChart, BarList, Button, DailyLineChart, EmptyState, LoadingState, MetricGrid, Notice, Page, Section, IntegrationCard, Table} from '../design/components.js';
import {Link} from '../router.js';
import {CopyPromptButton} from '../onboarding/copy.tsx';
import type {ConsoleDataAdapter, UsageReport, UsageHighlights, UsageDetails} from './types.js';
import {ago, compact, count, harnessName, memberName, originName, plural, sortedMembers, sourceStatus, speciesLabel, topMember} from './usage-model.ts';
import type {UsageMember, UsageSource} from './usage-model.ts';
import type {UsageSection} from '../../../src/application/reports.mjs';
import {reconcileUsage, usageSectionFailed} from './usage-recovery.ts';

const refreshPolicy = {autoRefreshMilliseconds: 60_000, staleMilliseconds: 60_000, reconcile: reconcileUsage};

export function useUsage(adapter: ConsoleDataAdapter) {
  const resource = useConsoleResource<UsageReport>(consoleResourceKey(adapter, 'usage'), signal => adapter.usage(signal), refreshPolicy);
  return {...resource, refresh: resource.reload};
}

function UsageSourceCard({source, now, countsUnavailable}: {source: UsageSource; now: number; countsUnavailable: boolean}) {
  const status = sourceStatus(source.state);
  return <IntegrationCard name={source.name} icon={source.icon} status={status}
    metrics={source.indexedSpecies?.map(item => ({label: speciesLabel(item.name), count: item.count}))}
    emptyMessage={source.indexedSpecies ? 'No content yet.' : countsUnavailable ? 'Indexed item counts unavailable.' : 'Content breakdown unavailable.'}
    metadata={<span>{source.state === 'synced' && source.lastSyncedAt ? `Synced ${ago(source.lastSyncedAt, now)}` : status.label}</span>}/>;
}

function MeasurementStatus({report, section, label, now, retry}: {report: UsageReport; section: UsageSection; label: string; now: number; retry?: () => void}) {
  if (!usageSectionFailed(report, section)) return null;
  const previous = report.staleSections?.[section];
  return <Notice tone="warning" actions={retry && <Button onClick={retry}>Try again</Button>}>
    {label} couldn’t {previous ? 'update' : 'load'}.{previous && ` Showing data updated ${ago(previous, now)}.`} We’ll retry automatically.
  </Notice>;
}

function DataSourcesReport({report, now, retry}: {report: UsageReport; now: number; retry?: () => void}) {
  const data = report.ingestion;
  const countsUnavailable = report.failedSources?.includes('connectors') === true;
  const retryCounts = countsUnavailable && !usageSectionFailed(report, 'ingestion') && Boolean(data?.sources.length) && retry;
  return (
    <Section className="report-section" title="Data sources" description={data?.sources.length ? 'Items OpenCrawl has indexed from each connected integration.' : undefined}
      actions={retryCounts && <Button variant="quiet" onClick={retryCounts}>Retry counts</Button>}>
      <MeasurementStatus report={report} section="ingestion" label="Connected sources" now={now} retry={retry}/>
      {!data ? (usageSectionFailed(report, 'ingestion') ? null : <EmptyState title="Source reporting isn’t available on this deployment."/>) : data.sources.length ? (
        <div className="oc-integration-grid">
          {data.sources.map((source, index) => <UsageSourceCard key={`${source.name}:${source.account || index}`} source={source} now={now} countsUnavailable={countsUnavailable}/>)}
        </div>
      ) : <EmptyState title="No sources connected" actions={<Link to="/sources">Connect a source to start ingesting.</Link>}/>}
    </Section>
  );
}

function AgentReport({report, now, retry, pendingDetails = false,showActivity=false}: {showActivity?:boolean;report: UsageReport; now: number; retry?: () => void; pendingDetails?: boolean}) {
  const data = report.agents;
  const people = data?.people?.length;
  const daily = data?.daily || [];
  const activeDays = daily.filter(day => day.events > 0).length;
  const subagents = data?.subagentSessions || 0;
  const busiest = daily.reduce<(typeof daily)[number] | undefined>((best, day) => !best || day.sessions > best.sessions ? day : best, undefined);

  const captured: MetricItem | null = report.capture
    ? {label: 'Tokens captured', value: compact(report.capture.tokens), note: `since ${report.capture.since.slice(0, 10)}, from agent sessions`, title: count(report.capture.tokens)}
    : null;
  const sessions: MetricItem | null = data ? {label: 'Sessions', value: compact(data.sessions), note: `${activeDays} active ${activeDays === 1 ? 'day' : 'days'}${subagents ? `, plus ${plural(subagents, 'subagent session')}` : ''}`, title: count(data.sessions)} : null;
  const cards: MetricItem[] = data ? [
    sessions!,
    {label: 'Messages', value: compact(data.messages), note: 'prompts and replies captured', title: count(data.messages)},
    captured ?? {label: 'Tool calls', value: compact(data.toolCalls), note: 'tools used across captured sessions', title: count(data.toolCalls)},
    {label: showActivity?'Captured OpenCrawl events':'OpenCrawl calls', value: compact(data.opencrawlCalls), note: `from recorded sessions${people != null ? ` by ${plural(people, 'person', 'people')}` : ''}`, title: count(data.opencrawlCalls)},
  ] : pendingDetails && captured ? [captured] : [];
  const description = report.days ? `Captured activity over the last ${report.days} days.` : 'Captured agent activity.';

  return (
    <Section className="report-section" title="Agent sessions" description={description}>
      <MeasurementStatus report={report} section="agents" label="Session activity" now={now} retry={retry}/>
      <MeasurementStatus report={report} section="capture" label="Captured tokens" now={now} retry={retry}/>
      {cards.length > 0 && <MetricGrid items={cards}/>}
      {!data ? (pendingDetails || usageSectionFailed(report, 'agents') ? null : <EmptyState title="Agent reporting isn’t available on this deployment."/>) : <>
        <p className="report-note">
          Machines capturing: <strong>{count(data.machines)}</strong>. Last capture: <strong>{data.lastAt ? ago(data.lastAt, now) : 'Not yet'}</strong>
          {data.firstAt && <>. Capturing since {data.firstAt.slice(0, 10)}</>}
        </p>
        {data.events === 0 ? (
          <EmptyState title="No agent sessions captured yet." description="Once teammates install the OpenCrawl CLI, their Claude Code, Codex and Grok Bot sessions appear here."/>
        ) : <>
          <Section className="report-panel" headingLevel={3} title="Daily agent sessions" description={busiest && busiest.sessions > 0 ? `Busiest day: ${busiest.date} with ${plural(busiest.sessions, 'session')}.` : undefined}>
            <ActivityChart daily={data.daily}/>
          </Section>
          <OverlapReport report={report} now={now} retry={retry}/>
          <div className="report-split">
            <Section className="report-panel" headingLevel={3} title="Where agents run" description="Captured events by agent and surface.">
              <BarList rows={data.harnesses.map(row => ({...row, name: harnessName(row.name)}))} label="Captured events by agent"/>
              <BarList rows={data.origins.map(row => ({...row, name: originName(row.name)}))} label="Captured events by surface"/>
            </Section>
            <Section className="report-panel" headingLevel={3} title="Tools" description="Most used tools across captured sessions.">
              <BarList rows={data.tools.map(row => ({...row, name: row.name.replace(/^mcp__/, '').replace(/__/g, ': ')}))} label="Most used agent tools"/>
            </Section>
          </div>
        </>}
      </>}
      {!data && (report.overlap || usageSectionFailed(report, 'overlap')) && <OverlapReport report={report} now={now} retry={retry}/>}
    </Section>
  );
}

function OverlapReport({report, now, retry}: {report: UsageReport; now: number; retry?: () => void}) {
  return <Section className="report-panel" headingLevel={3} title="Main session overlap" description="Concurrent sessions by day.">
    <MeasurementStatus report={report} section="overlap" label="Session overlap" now={now} retry={retry}/>
    {report.overlap && <DailyLineChart daily={report.overlap.daily} label="Main session overlap"/>}
  </Section>;
}

function SetupDots({member}: {member: UsageMember}) {
  if (member.setup.shared) return <span title="Your administrator verified the shared installation.">Shared {member.setup.shared.name} setup</span>;
  const labels = {cli: 'CLI', mcp: 'MCP', session: 'Sessions'};
  return <>
    <span className="report-setup-dots">{(['cli', 'mcp', 'session'] as const).map(key => (
      <span key={key} className={`report-setup-dot${member.setup[key] ? ' is-complete' : ''}`} role="img"
        aria-label={`${labels[key]} ${member.setup[key] ? 'set up' : 'not set up'}`}
        title={`${labels[key]} ${member.setup[key] ? 'set up' : 'not set up'}`}/>
    ))}</span>
    {member.setup.client && <span className="report-email">{member.setup.client}</span>}
  </>;
}

function TeamReport({report, now, retry}: {report: UsageReport; now: number; retry?: () => void}) {
  const members = report.members;
  const user = topMember(members, 'sessions');
  const builder = topMember(members, 'toolCalls');
  const active = members.filter(member => member.weekEvents > 0).length;
  const unavailable = usageSectionFailed(report, 'members') && !report.staleSections?.members;
  const highlights = [
    {label: 'Most sessions', member: user, value: user && plural(user.sessions, 'session')},
    {label: 'Most tool calls', member: builder, value: builder && plural(builder.toolCalls, 'tool call')},
  ];

  return (
    <Section className="report-section" title="Team" description={members.length && !unavailable ? `${active} of ${plural(members.length, 'member')} active this week.` : undefined}>
      <MeasurementStatus report={report} section="members" label="Team activity" now={now} retry={retry}/>
      {unavailable ? null : !members.length ? <EmptyState title="Team reporting isn’t available on this deployment."/> : <>
        {highlights.some(item => item.member) && (
          <dl className="report-highlights">{highlights.map(item => item.member ? (
            <div key={item.label} className="report-highlight">
              <dt>{item.label}</dt><dd><strong>{memberName(item.member)}</strong><span>{item.value}</span></dd>
            </div>
          ) : null)}</dl>
        )}
        <Section className="report-panel" headingLevel={3} title="Member activity" description={`${report.days ? `Last ${report.days} days.` : 'All captured activity.'} Ranked by sessions, then tool calls; subagent sessions are counted separately. Setup: shared installation or individual CLI, MCP and sessions.`}>
          <Table label="Team usage" className="report-member-table report-leaderboard-table">
            <thead><tr>
              <th scope="col">Rank</th><th scope="col">Member</th><th scope="col">Sessions</th><th scope="col">Messages</th>
              <th scope="col">Tool calls</th><th scope="col">Sources</th><th scope="col">Setup</th><th scope="col">Last active</th>
            </tr></thead>
            <tbody>{sortedMembers(members).map((member, index) => (
              <tr key={member.email}>
                <td>{index + 1}</td>
                <th scope="row"><span className="report-member">{memberName(member)}{member.you && <em>you</em>}</span>{member.name && <span className="report-email">{member.email}</span>}</th>
                <td>{count(member.sessions)}{member.subagentSessions ? <span className="report-email">+{count(member.subagentSessions)} subagent</span> : null}</td><td>{count(member.messages)}</td><td>{count(member.toolCalls)}</td><td>{count(member.sources)}</td>
                <td><SetupDots member={member}/></td><td>{member.lastAt ? ago(member.lastAt, now) : 'not yet'}</td>
              </tr>
            ))}</tbody>
          </Table>
        </Section>
      </>}
    </Section>
  );
}

export function UsageReportView({data, now = Date.now(), retry,showActivity}: {showActivity?:boolean;data: UsageReport; now?: number; retry?: () => void}) {
  return <>
    <AgentReport showActivity={Boolean(showActivity)} report={data} now={now} retry={retry}/>
    <DataSourcesReport report={data} now={now} retry={retry}/>
    <TeamReport report={data} now={now} retry={retry}/>
  </>;
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
  const retry = () => {void summary.reload(); void activity.reload();};
  return <Page title="Usage" description={usageDescription(report, now)} bodyClassName="usage-report" actions={setupPrompt ? <CopyPromptButton text={setupPrompt}/> : undefined}>
    {showActivity && adapter.callTotals && adapter.searchHistory && <SearchActivity scope={showActivity} adapter={adapter as Required<Pick<ConsoleDataAdapter,'callTotals'|'searchHistory'>>}/>}
    {summary.error && <Notice tone="warning" actions={<Button onClick={summary.reload}>Try again</Button>}>Usage highlights couldn’t update.</Notice>}
    {activity.error && <Notice tone="warning" actions={<Button onClick={activity.reload}>Try again</Button>}>Usage details couldn’t update.</Notice>}
    {report && (activity.data || summary.data?.capture || summary.data?.failedSources?.length) ?
      <AgentReport showActivity={Boolean(showActivity)} report={report} now={now} retry={retry} pendingDetails={!activity.data}/> : null}

    {(activity.loading || summary.loading && !activity.data) && <LoadingState label={report ? 'Loading usage details' : 'Loading usage'}/>}
    {activity.data && report && <>
      <DataSourcesReport report={report} now={now} retry={activity.reload}/>
      <TeamReport report={report} now={now} retry={activity.reload}/>
    </>}
  </Page>;
}

function usageDescription(data: UsageReport | null, now: number) {
  return data ? [data.workspace, data.days ? `last ${data.days} days` : '', `updated ${ago(data.generatedAt, now)}`].filter(Boolean).join(', ') : 'Workspace usage';
}

function CompleteUsage({adapter, setupPrompt,showActivity}: PageProps) {
  const {data, error, loading, refresh} = useUsage(adapter);
  const now = Date.now();
  const scope = usageDescription(data, now);
  return (
    <Page title="Usage" description={scope} bodyClassName="usage-report" actions={setupPrompt ? <CopyPromptButton text={setupPrompt}/> : undefined}>
      {error && <Notice tone={data ? 'warning' : 'danger'} actions={!data && <Button onClick={refresh} disabled={loading}>Try again</Button>}>{data ? 'Usage couldn’t update. We’ll try again automatically while you’re viewing this page.' : error}</Notice>}
      {loading && <LoadingState label="Loading usage"/>}
      {showActivity && adapter.callTotals && adapter.searchHistory && <SearchActivity scope={showActivity} adapter={adapter as Required<Pick<ConsoleDataAdapter,'callTotals'|'searchHistory'>>}/>}
      {data && <UsageReportView showActivity={Boolean(showActivity)} data={data} now={now} retry={refresh}/>}
    </Page>
  );
}
