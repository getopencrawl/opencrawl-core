import {useState} from 'react';
import {ProactiveTab, SearchesTab, From, SessionLink, scoped} from './search-activity.tsx';
import type {ActivityAdapter, MemberNames} from './search-activity.tsx';
import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import type {MetricItem} from '../design/components.js';
import {BarList, Button, DailyBarChart, DailyLineChart, EmptyState, IntegrationCard, LoadingState, MetricGrid, Notice, Page, Section, Select, Table, Tabs} from '../design/components.js';
import {Link} from '../router.js';
import {CopyPromptButton} from '../onboarding/copy.tsx';
import type {ConsoleDataAdapter, UsageReport} from './types.js';
import {ago, compact, count, harnessName, memberName, originName, plural, sortedMembers, sourceStatus, speciesLabel, topMember} from './usage-model.ts';
import type {UsageMember, UsageSource} from './usage-model.ts';
import type {UsageSection} from '../../../src/application/reports.mjs';
import type {TokenSession, UsageRange} from '../../../src/application/usage-range.mjs';
import {reconcileUsage, usageSectionFailed} from './usage-recovery.ts';
import {PagedList} from './usage-list.tsx';

const refreshPolicy = {autoRefreshMilliseconds: 60_000, staleMilliseconds: 60_000, reconcile: reconcileUsage};
const tokenRefresh = {autoRefreshMilliseconds: 60_000, staleMilliseconds: 60_000};
type Tab = 'overview' | 'searches' | 'proactive' | 'team' | 'activity' | 'sources';
type TokenAdapter = Required<Pick<ConsoleDataAdapter, 'usageTokens' | 'tokenSessions'>>;
const ranges: ReadonlyArray<{value: UsageRange; label: string}> = [{value: '30d', label: 'Last 30 days'}, {value: '7d', label: 'Last 7 days'}, {value: 'all', label: 'All time'}];
const tokens = (value: number) => plural(value, 'token');

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

/** Team tab: totals, sessions per day, the leaders, then every member's activity. */
export function UsageReportView({data: report, now = Date.now(), retry}: {data: UsageReport; now?: number; retry?: () => void}) {
  const members = report.members;
  const agents = report.agents;
  const unavailable = usageSectionFailed(report, 'members') && !report.staleSections?.members;
  const user = topMember(members, 'sessions');
  const builder = topMember(members, 'toolCalls');
  const highlights = [
    {label: 'Most sessions', member: user, value: user && plural(user.sessions, 'session')},
    {label: 'Most tool calls', member: builder, value: builder && plural(builder.toolCalls, 'tool call')},
  ];
  const cards: MetricItem[] = agents ? [
    {label: 'Sessions', value: compact(agents.sessions), title: count(agents.sessions)},
    ...unavailable ? [] : [{label: 'Active members', value: `${count(members.filter(member => member.sessions > 0 || member.toolCalls > 0).length)} of ${count(members.length)}`}],
    {label: 'Tool calls', value: compact(agents.toolCalls), title: count(agents.toolCalls)},
  ] : [];
  return <>
    <MeasurementStatus report={report} section="agents" label="Session activity" now={now} retry={retry}/>
    <MeasurementStatus report={report} section="members" label="Team activity" now={now} retry={retry}/>
    {cards.length > 0 && <MetricGrid items={cards}/>}
    {agents && <Section className="report-panel" headingLevel={3} title="Agent sessions per day">
      {agents.events === 0 ? <EmptyState title="No agent sessions captured yet." description="Once teammates install the OpenCrawl CLI, their agent sessions appear here."/>
        : <DailyBarChart days={agents.daily.map(day => ({date: day.date, value: day.sessions}))} label="Agent sessions per day" unit={n => plural(n, 'session')}/>}
    </Section>}
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
  </>;
}

/** Activity tab: concurrent main sessions, where agents run and the tools they call. */
function AgentActivity({report, now, retry}: {report: UsageReport; now: number; retry?: () => void}) {
  const agents = report.agents;
  return <>
    <MeasurementStatus report={report} section="agents" label="Session activity" now={now} retry={retry}/>
    <Section className="report-panel" headingLevel={3} title="Main session overlap" description={report.days == null ? 'Concurrent sessions by day, last 365 days.' : 'Concurrent sessions by day.'}>
      <MeasurementStatus report={report} section="overlap" label="Session overlap" now={now} retry={retry}/>
      {report.overlap && <DailyLineChart daily={report.overlap.daily} label="Main session overlap"/>}
    </Section>
    {agents && <div className="report-split">
      <Section className="report-panel" headingLevel={3} title="Where agents run" description="Captured events by agent and surface.">
        <BarList rows={agents.harnesses.map(row => ({...row, name: harnessName(row.name)}))} label="Captured events by agent"/>
        <BarList rows={agents.origins.map(row => ({...row, name: originName(row.name)}))} label="Captured events by surface"/>
      </Section>
      <Section className="report-panel" headingLevel={3} title="Tools" description="Most used tools across captured sessions.">
        <BarList rows={agents.tools.map(row => ({...row, name: row.name.replace(/^mcp__/, '').replace(/__/g, ': ')}))} label="Most used agent tools"/>
      </Section>
    </div>}
  </>;
}

function SourceCard({source, now, countsUnavailable}: {source: UsageSource; now: number; countsUnavailable: boolean}) {
  const status = sourceStatus(source.state);
  return <IntegrationCard name={source.name} icon={source.icon} status={status}
    metrics={source.indexedSpecies?.map(item => ({label: speciesLabel(item.name), count: item.count}))}
    emptyMessage={source.indexedSpecies ? 'No content yet.' : countsUnavailable ? 'Indexed item counts unavailable.' : 'Content breakdown unavailable.'}
    metadata={<span>{source.state === 'synced' && source.lastSyncedAt ? `Synced ${ago(source.lastSyncedAt, now)}` : status.label}</span>}/>;
}

/** Sources tab: everything indexed so far from each connected integration. Not limited by the date range. */
function DataSources({report, now, retry}: {report: UsageReport; now: number; retry?: () => void}) {
  const data = report.ingestion;
  const countsUnavailable = report.failedSources?.includes('connectors') === true;
  const total = data?.index?.connectorDocuments;
  const bySource = [...data?.index?.sources ?? []].sort((left, right) => right.count - left.count);
  return <>
    <MeasurementStatus report={report} section="ingestion" label="Connected sources" now={now} retry={retry}/>
    {!data ? (usageSectionFailed(report, 'ingestion') ? null : <EmptyState title="Source reporting isn’t available on this deployment."/>)
      : !data.sources.length ? <EmptyState title="No sources connected" actions={<Link to="/sources">Connect a source to start ingesting.</Link>}/>
      : <>
        <Section className="report-panel" headingLevel={3} title="Items indexed by source" description="Everything indexed so far; the date range does not apply."
          actions={<span className="report-chart-total" title={count(total)}>{countsUnavailable ? 'Unavailable' : compact(total)}</span>}>
          {countsUnavailable ? <p className="report-note">Indexed item counts unavailable.</p> : <BarList rows={bySource} label="Items indexed by source"/>}
        </Section>
        <div className="oc-integration-grid">
          {data.sources.map((source, index) => <SourceCard key={`${source.name}:${source.account || index}`} source={source} now={now} countsUnavailable={countsUnavailable}/>)}
        </div>
      </>}
  </>;
}

/** Overview: session tokens (with the other billed counts beside them), tokens per day, then sessions. */
function OverviewTab({adapter, scope, range, names}: {adapter: TokenAdapter; scope: string; range: UsageRange; names: MemberNames}) {
  const {data, error, loading, reload} = useConsoleResource([...consoleResourceKey(adapter, 'usage-tokens'), range], async signal => scoped(scope, await adapter.usageTokens(range, signal)), tokenRefresh);
  return <>
    {error && <Notice tone="warning" actions={<Button onClick={reload}>Try again</Button>}>Session tokens couldn’t update.</Notice>}
    {loading && !data && <LoadingState spinner label="Loading session tokens…"/>}
    {data && <Section className="report-panel" headingLevel={3} title={data.source === 'meter' ? 'Tokens stored' : 'Session tokens indexed'} actions={<span className="report-chart-total" title={count(data.total)}>{compact(data.total)}</span>}>
      <DailyBarChart days={data.daily.map(day => ({date: day.date, value: day.count}))} label={data.source === 'meter' ? 'Tokens stored each day' : 'Session tokens indexed per day'}
        unit={data.source === 'meter' ? value => `${count(value)} tokens stored` : tokens}/>
    </Section>}
    <Section className="report-panel" headingLevel={3} title="Sessions">
      <PagedList<TokenSession, number> resetKey={JSON.stringify([scope, range])} label="Sessions" className="usage-search-history" empty="No sessions in this period."
        load={async (offset, signal) => scoped(scope, await adapter.tokenSessions({range, ...offset ? {offset} : {}}, signal))}
        head={<tr><th scope="col">Session</th><th scope="col">From</th><th scope="col">Tokens</th><th scope="col">Last active</th></tr>}
        row={(row, index) => <tr key={`${row.userId}:${row.harness}:${row.sessionId}:${index}`}>
          <td><SessionLink userId={row.userId} harness={row.harness} sessionId={row.sessionId}/></td>
          <td><From userId={row.userId} harness={row.harness} names={names}/></td>
          <td title={count(row.tokens)}>{compact(row.tokens)}</td>
          <td>{row.lastAt ? <time dateTime={row.lastAt} title={row.lastAt}>{ago(row.lastAt)}</time> : 'Unavailable'}</td>
        </tr>}/>
      <p className="report-note">The list shows sessions you can see. The total includes every session.</p>
    </Section>
  </>;
}

type PageProps = {showActivity?: string; adapter: ConsoleDataAdapter; setupPrompt?: string; reportScope?: string};

function useTeamReport(adapter: ConsoleDataAdapter, scope: string | undefined, range: UsageRange) {
  const ranged = Boolean(scope && adapter.usageDetails);
  const details = useConsoleResource<UsageReport>([...consoleResourceKey(adapter, ranged ? 'usage-details' : 'usage'), ...ranged ? [range] : []], async signal => {
    if (!ranged) return adapter.usage(signal);
    const result = scoped(scope!, await adapter.usageDetails!(signal, range));
    return {workspace: null, ...result};
  }, refreshPolicy);
  return details;
}

export function UsagePage({adapter, setupPrompt, reportScope, showActivity}: PageProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<UsageRange>('30d');
  const scope = reportScope ?? showActivity;
  const activity = showActivity && adapter.callTotals && adapter.searchHistory ? {adapter: adapter as ActivityAdapter, scope: showActivity} : undefined;
  const tokenAdapter = scope && adapter.usageTokens && adapter.tokenSessions ? adapter as TokenAdapter : undefined;
  const team = useTeamReport(adapter, scope, range);
  const names: MemberNames = new Map((team.data?.members ?? []).flatMap(member => member.userId ? [[member.userId, memberName(member)] as const] : []));
  const tabs: Array<{value: Tab; label: string}> = [
    ...tokenAdapter ? [{value: 'overview' as const, label: 'Overview'}] : [],
    ...activity ? [{value: 'searches' as const, label: 'Searches'}, {value: 'proactive' as const, label: 'Proactive context'}] : [],
    {value: 'team', label: 'Team'},
    {value: 'activity', label: 'Activity'},
    {value: 'sources', label: 'Sources'},
  ];
  const current: Tab = tabs.some(item => item.value === tab) ? tab : tabs[0]!.value;
  return <Page title="Usage" bodyClassName="usage-report" actions={setupPrompt ? <CopyPromptButton text={setupPrompt}/> : undefined}>
    <div className="usage-toolbar">
      <Tabs label="Usage" items={tabs} value={current} onChange={value => setTab(value as Tab)}/>
      <Select aria-label="Date range" value={range} onChange={event => setRange(event.target.value as UsageRange)}>
        {ranges.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </Select>
    </div>
    {current === 'overview' && tokenAdapter && scope && <OverviewTab adapter={tokenAdapter} scope={scope} range={range} names={names}/>}
    {current === 'searches' && activity && <SearchesTab adapter={activity.adapter} scope={activity.scope} range={range} names={names}/>}
    {current === 'proactive' && activity && <ProactiveTab adapter={activity.adapter} scope={activity.scope} range={range} names={names}/>}
    {(current === 'activity' || current === 'sources') && <>
      {team.error && <Notice tone={team.data ? 'warning' : 'danger'} actions={!team.data && <Button onClick={team.reload} disabled={team.loading}>Try again</Button>}>{team.data ? 'Usage couldn’t update. We’ll try again automatically while you’re viewing this page.' : team.error}</Notice>}
      {team.loading && !team.data && <LoadingState spinner label="Loading usage…"/>}
      {team.data && (current === 'activity' ? <AgentActivity report={team.data} now={Date.now()} retry={team.reload}/> : <DataSources report={team.data} now={Date.now()} retry={team.reload}/>)}
    </>}
    {current === 'team' && <>
      {team.error && <Notice tone={team.data ? 'warning' : 'danger'} actions={!team.data && <Button onClick={team.reload} disabled={team.loading}>Try again</Button>}>{team.data ? 'Usage couldn’t update. We’ll try again automatically while you’re viewing this page.' : team.error}</Notice>}
      {team.loading && !team.data && <LoadingState spinner label="Loading usage…"/>}
      {team.data && <UsageReportView data={team.data} retry={team.reload}/>}
    </>}
  </Page>;
}
