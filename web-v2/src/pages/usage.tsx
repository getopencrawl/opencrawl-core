import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import type {MetricItem} from '../design/components.js';
import {ActivityChart, BarList, Button, DailyLineChart, EmptyState, LoadingState, MetricGrid, Notice, Page, Section, StatusBadge, Table} from '../design/components.js';
import {Link} from '../router.js';
import {CopyPromptButton} from '../onboarding/copy.tsx';
import type {ConsoleDataAdapter, UsageReport, ValueReport} from './types.js';
import {ago, compact, count, harnessName, memberName, originName, plural, sortedMembers, sourceStatus, speciesLabel, topMember} from './usage-model.ts';
import type {UsageMember, UsageSource} from './usage-model.ts';

export {count} from './usage-model.ts';

export function date(value: string | number | null | undefined) {
  if (value == null) return 'Not yet';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
}

export function useUsage(adapter: ConsoleDataAdapter) {
  const resource = useConsoleResource<UsageReport>(consoleResourceKey(adapter, 'usage'), signal => adapter.usage(signal), {autoRefreshMilliseconds: 60_000, staleMilliseconds: 60_000});
  return {...resource, refresh: resource.reload};
}

/** Compact source table retained for existing non-report consumers. */
export function SourcesSummary({data}: {data: UsageReport}) {
  if (!data.ingestion) return <Notice tone="warning">Source reporting is unavailable. Refresh to try again.</Notice>;
  if (!data.ingestion.sources.length) {
    return <EmptyState title="Connect your first source" description="Give your agents access to your team’s knowledge." actions={<Link to="/sources">Connect a source</Link>}/>;
  }
  return (
    <Table label="Connected source status">
      <thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Imported</th><th scope="col">Indexed</th><th scope="col">Last sync</th></tr></thead>
      <tbody>{data.ingestion.sources.map(source => (
        <tr key={source.name}>
          <th scope="row">{source.name}{source.account && <span className="muted block">{source.account}</span>}</th>
          <td><StatusBadge tone={source.state === 'synced' ? 'success' : source.state === 'error' ? 'danger' : 'neutral'}>{source.state}</StatusBadge></td>
          <td>{count(source.records)}</td><td>{count(source.indexed)}</td><td>{date(source.lastSyncedAt)}</td>
        </tr>
      ))}</tbody>
    </Table>
  );
}

function SourceCard({source, now}: {source: UsageSource; now: number}) {
  const status = sourceStatus(source.state);
  const species = source.indexedSpecies;

  return (
    <article className="report-source-card" aria-label={source.name}>
      <header className="report-source-header">
        <img src={source.icon} alt="" width={28} height={28}/>
        <div className="report-source-identity"><h3>{source.name}</h3>{source.account && <p>{source.account}</p>}</div>
        <StatusBadge variant="pill" tone={status.tone}>{status.label}</StatusBadge>
      </header>
      {species ? species.length ? (
        <ul className="report-source-rows report-indexed-species" aria-label={`Content in ${source.name}`}>
          {species.map(item => <li key={item.name}><span>{speciesLabel(item.name)}</span><span>{count(item.count)}</span></li>)}
        </ul>
      ) : <p className="report-note">No content yet.</p> : <p className="report-note">Content breakdown unavailable.</p>}
      <p className="report-source-meta">
        <span>{source.lastSyncedAt ? `Synced ${ago(source.lastSyncedAt, now)}` : 'Not synced yet'}</span>
        {source.connectedBy && <span>Connected by {source.connectedBy}</span>}
      </p>
    </article>
  );
}

/** Three cards of things OpenCrawl did for this workspace's agents; each counts something that happened. */
function alignmentCards(value: ValueReport): MetricItem[] {
  const {drift, usage} = value;
  const found = ([['teammateWork', 'what teammates’ agents were doing'], ['whereThingsLive', 'where things live'], ['pastDecisions', 'past decisions'], ['pastFixes', 'past fixes']] as const)
    .map(([key, label]) => ({label, count: value.value.found[key]})).filter(item => item.count > 0).sort((x, y) => y.count - x.count);
  return [
    {label: 'Drift saves', value: count(drift.conflictsAvoided + drift.duplicatesAvoided), note: `${plural(drift.conflictsAvoided, 'conflict')}, ${plural(drift.duplicatesAvoided, 'duplicate')} avoided`,
      help: 'Times a message from another agent reached an agent through OpenCrawl and it changed course: it held off work another agent owned, or dropped work already done. Counted only when the agent’s next actions show the change, and repeats within 30 minutes count once.'},
    {label: 'OpenCrawl uses', value: compact(usage.searches + usage.boardMessages), note: `${plural(usage.searches, 'search', 'searches')}, ${plural(usage.boardMessages, 'board message')}`, title: count(usage.searches + usage.boardMessages),
      help: `${plural(usage.searches, 'search', 'searches')} your agents ran against your team’s memory while doing real work. ${plural(usage.boardMessages, 'message')} from other agents reached an agent’s context through the board.`},
    {label: 'Answers agents used', value: count(value.value.searchesUsed + value.value.fixesReused), note: `${plural(value.value.searchesUsed, 'search result')}, ${plural(value.value.fixesReused, 'board fix', 'board fixes')}`,
      help: `${plural(value.value.searchesUsed, 'search result')} the agent’s next message went on to use, plus ${plural(value.value.fixesReused, 'fix or decision', 'fixes and decisions')} picked up from another agent on the board.${found.length ? ` Searches most often found ${found.slice(0, 3).map(item => `${item.label} (${count(item.count)})`).join(', ')}.` : ''}`},
  ];
}

function DataSourcesReport({report, now}: {report: UsageReport; now: number}) {
  const data = report.ingestion;
  return (
    <Section className="report-section" title="Data sources">
      {!data ? <EmptyState title="Source reporting isn’t available on this deployment."/> : data.sources.length ? (
        <div className="report-source-grid">
          {data.sources.map((source, index) => <SourceCard key={`${source.name}:${source.account || index}`} source={source} now={now}/>)}
        </div>
      ) : <EmptyState title="No sources connected" actions={<Link to="/sources">Connect a source to start ingesting.</Link>}/>}
    </Section>
  );
}

function AgentReport({report, now}: {report: UsageReport; now: number}) {
  const data = report.agents;
  const people = data?.people?.length;
  const daily = data?.daily || [];
  const activeDays = daily.filter(day => day.events > 0).length;
  const subagents = data?.subagentSessions || 0;
  const busiest = daily.reduce<(typeof daily)[number] | undefined>((best, day) => !best || day.sessions > best.sessions ? day : best, undefined);

  const value = report.value;
  const captured: MetricItem | null = report.capture
    ? {label: 'Tokens captured', value: compact(report.capture.tokens), note: value ? `captured since ${report.capture.since.slice(0, 10)}` : `since ${report.capture.since.slice(0, 10)}, from agent sessions`, title: count(report.capture.tokens),
      ...(value ? {help: `The text of your agents’ sessions that OpenCrawl has stored since ${report.capture.since.slice(0, 10)}, counted in tokens. This is what OpenCrawl billing is based on.`} : {})}
    : null;
  const sessions: MetricItem | null = data ? {label: 'Sessions', value: compact(data.sessions), note: `${activeDays} active ${activeDays === 1 ? 'day' : 'days'}${subagents ? `, plus ${plural(subagents, 'subagent session')}` : ''}`, title: count(data.sessions)} : null;
  // With a measured report the section is one row: what OpenCrawl captured, then what it did for the agents.
  const first = captured ?? sessions;
  const cards: MetricItem[] = value ? [...(first ? [first] : []), ...alignmentCards(value)] : data ? [
    sessions!,
    {label: 'Messages', value: compact(data.messages), note: 'prompts and replies captured', title: count(data.messages)},
    captured ?? {label: 'Tool calls', value: compact(data.toolCalls), note: 'tools used across captured sessions', title: count(data.toolCalls)},
    {label: 'OpenCrawl calls', value: compact(data.opencrawlCalls), note: `searches and board reads${people != null ? ` by ${plural(people, 'person', 'people')}` : ''}`, title: count(data.opencrawlCalls)},
  ] : [];
  const description = value ? `How OpenCrawl kept your agents on track since ${value.window.from}, across ${plural(value.work.sessions, 'session')} and ${plural(value.work.tasks, 'task')}.`
    : report.days ? `Captured activity over the last ${report.days} days.` : 'Captured agent activity.';

  return (
    <Section className="report-section" title={value ? 'Agent alignment' : 'Agent sessions'} description={description}>
      {cards.length > 0 && <MetricGrid items={cards}/>}
      {!data ? (value ? null : <EmptyState title="Agent reporting isn’t available on this deployment."/>) : <>
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
          <Section className="report-panel" headingLevel={3} title="Main session overlap" description="Concurrent sessions by day.">
            <DailyLineChart daily={report.overlap.daily} label="Main session overlap"/>
          </Section>
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
    </Section>
  );
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

function TeamReport({report, now}: {report: UsageReport; now: number}) {
  const members = report.members;
  const user = topMember(members, 'sessions');
  const builder = topMember(members, 'toolCalls');
  const active = members.filter(member => member.weekEvents > 0).length;
  const highlights = [
    {label: 'Most sessions', member: user, value: user && plural(user.sessions, 'session')},
    {label: 'Most tool calls', member: builder, value: builder && plural(builder.toolCalls, 'tool call')},
  ];

  return (
    <Section className="report-section" title="Team" description={members.length ? `${active} of ${plural(members.length, 'member')} active this week.` : undefined}>
      {!members.length ? <EmptyState title="Team reporting isn’t available on this deployment."/> : <>
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

export function UsageReportView({data, now = Date.now()}: {data: UsageReport; now?: number}) {
  return <>
    <AgentReport report={data} now={now}/>
    <DataSourcesReport report={data} now={now}/>
    <TeamReport report={data} now={now}/>
  </>;
}

export function UsagePage({adapter, setupPrompt}: {adapter: ConsoleDataAdapter; setupPrompt?: string}) {
  const {data, error, loading, refresh} = useUsage(adapter);
  const now = Date.now();
  const scope = data ? [data.workspace, data.days ? `last ${data.days} days` : '', `updated ${ago(data.generatedAt, now)}`].filter(Boolean).join(', ') : 'Workspace usage';
  return (
    <Page title="Usage" description={scope} bodyClassName="usage-report" actions={setupPrompt ? <CopyPromptButton text={setupPrompt}/> : undefined}>
      {error && <Notice tone={data ? 'warning' : 'danger'}>{data ? 'Usage couldn’t update. We’ll try again automatically while you’re viewing this page.' : error}{!data && <Button onClick={refresh} disabled={loading}>Try again</Button>}</Notice>}
      {loading && <LoadingState label="Loading usage"/>}
      {data && <UsageReportView data={data} now={now}/>}
    </Page>
  );
}
